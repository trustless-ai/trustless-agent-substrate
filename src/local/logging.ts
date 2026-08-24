import pino, { type Bindings, type Logger } from 'pino'

const redactedValue = '[REDACTED]'
const circularValue = '[Circular]'
const unsafeValue = '[UNSAFE]'
const maxProjectionDepth = 64
const maxProjectionNodes = 20_000
const maxProjectionEntries = 30_000

function isSensitiveKey(key: string): boolean {
  const normalized = key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase()
  return ['credential', 'secret', 'privatekey', 'token', 'authorization', 'rpcurl']
    .some((sensitive) => normalized.includes(sensitive))
}

function isError(value: object): boolean | undefined {
  try {
    return value instanceof Error
  } catch {
    return undefined
  }
}

function ownEnumerableKeys(value: object): string[] | undefined {
  try {
    return Object.keys(value)
  } catch {
    return undefined
  }
}

function ownDataValue(value: object, key: string): unknown | typeof unsafeValue {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor) return unsafeValue
    if (!('value' in descriptor)) return redactedValue
    return descriptor.value
  } catch {
    return unsafeValue
  }
}

function defineSafe(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { configurable: true, enumerable: true, value, writable: true })
}

function redact(value: unknown, ancestors: WeakSet<object>, depth: number, budget: { nodes: number; entries: number }): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value
  if (typeof value !== 'object') return unsafeValue
  if (depth > maxProjectionDepth || ++budget.nodes > maxProjectionNodes) return unsafeValue
  const error = isError(value)
  if (error === undefined) return unsafeValue
  if (error) return Object.assign(Object.create(null), { name: 'Error', message: redactedValue })
  if (ancestors.has(value)) return circularValue

  const keys = ownEnumerableKeys(value)
  if (!keys) return unsafeValue

  ancestors.add(value)
  try {
    const output: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(null) as Record<string, unknown>
    budget.entries += keys.length
    if (budget.entries > maxProjectionEntries) return unsafeValue
    for (const key of keys) {
      if (key === '__proto__' || key === 'toJSON' || key === 'constructor' || key === 'prototype') continue
      const candidate = ownDataValue(value, key)
      const projected = isSensitiveKey(key) ? redactedValue : candidate === unsafeValue ? unsafeValue : redact(candidate, ancestors, depth + 1, budget)
      defineSafe(output, key, projected)
    }
    return output
  } catch {
    return unsafeValue
  } finally {
    ancestors.delete(value)
  }
}

/** Creates a failure-safe diagnostic projection that cannot execute caller-owned serialization hooks. */
export function redactForLogging(value: unknown): unknown {
  try {
    return redact(value, new WeakSet(), 0, { nodes: 0, entries: 0 })
  } catch {
    return unsafeValue
  }
}

function loggingBindings(value: unknown): Bindings {
  const projected = redactForLogging(value)
  if (typeof projected !== 'object' || projected === null || Array.isArray(projected)) return {}

  const bindings: Bindings = {}
  for (const key of Object.keys(projected)) {
    const candidate = ownDataValue(projected, key)
    if (candidate !== unsafeValue) defineSafe(bindings, key, candidate)
  }
  return bindings
}

function redactLogArgument(argument: unknown): unknown {
  return typeof argument === 'string' ? redactedValue : redactForLogging(argument)
}

function wrapChildLoggers(logger: Logger): Logger {
  const child = logger.child.bind(logger)
  logger.child = ((bindings: Bindings, options?: Parameters<Logger['child']>[1]) => {
    if (options !== undefined) throw new Error('TAS logger child options are disabled.')
    return wrapChildLoggers(child(loggingBindings(bindings), options) as unknown as Logger)
  }) as unknown as Logger['child']
  return logger
}

/** Creates the TAS logger with a synchronous stderr-only Pino destination. */
export function createTasLogger(): Logger {
  return wrapChildLoggers(pino({
    base: undefined,
    formatters: {
      bindings: (bindings) => loggingBindings(bindings),
      log: (object) => redactForLogging(object) as Bindings,
    },
    serializers: {
      err: (error) => redactForLogging(error),
    },
    hooks: {
      logMethod(args, method) {
        method.apply(this, args.map(redactLogArgument) as typeof args)
      },
    },
  }, pino.destination({ dest: 2, sync: true })))
}
