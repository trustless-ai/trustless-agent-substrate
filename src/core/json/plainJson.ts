import { types as utilTypes } from 'node:util'

export type PlainJsonPrimitive = null | boolean | number | string
export type PlainJsonValue = PlainJsonPrimitive | PlainJsonValue[] | { readonly [key: string]: PlainJsonValue }

export interface PlainJsonCloneOptions {
  readonly maxExpandedNodes?: number
}

type VisitFrame = {
  readonly kind: 'visit'
  readonly value: unknown
  readonly assign: (value: PlainJsonValue) => void
}

type ExitFrame = {
  readonly kind: 'exit'
  readonly value: object
}

type Frame = VisitFrame | ExitFrame

export const DEFAULT_PLAIN_JSON_MAX_EXPANDED_NODES = 10_000

const invalidPlainJsonMessage = 'Value must be a bounded plain JSON tree.'
const arrayIndex = /^(?:0|[1-9][0-9]*)$/

function invalidPlainJson(): never {
  throw new TypeError(invalidPlainJsonMessage)
}

function ownKeys(value: object): readonly PropertyKey[] {
  try {
    return Reflect.ownKeys(value)
  } catch {
    return invalidPlainJson()
  }
}

function ownDataDescriptor(value: object, key: PropertyKey): PropertyDescriptor {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !('value' in descriptor)) return invalidPlainJson()
    return descriptor
  } catch {
    return invalidPlainJson()
  }
}

function prototypeOf(value: object): object | null {
  try {
    return Object.getPrototypeOf(value)
  } catch {
    return invalidPlainJson()
  }
}

function createStack<T>(): { readonly size: () => number; readonly push: (value: T) => void; readonly pop: () => T } {
  const values = Object.create(null) as Record<string, T>
  let size = 0
  return {
    size: () => size,
    push: (value) => {
      Object.defineProperty(values, String(size), {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      })
      size += 1
    },
    pop: () => {
      size -= 1
      const key = String(size)
      const descriptor = Object.getOwnPropertyDescriptor(values, key)
      if (descriptor === undefined || !('value' in descriptor)) return invalidPlainJson()
      delete values[key]
      return descriptor.value
    },
  }
}

export function clonePlainJson(
  root: unknown,
  options: PlainJsonCloneOptions = {},
): PlainJsonValue {
  const maxExpandedNodes = options.maxExpandedNodes ?? DEFAULT_PLAIN_JSON_MAX_EXPANDED_NODES
  if (!Number.isSafeInteger(maxExpandedNodes) || maxExpandedNodes < 1) invalidPlainJson()

  const active = new WeakSet<object>()
  let expandedNodes = 0
  let result: PlainJsonValue | undefined
  const frames = createStack<Frame>()
  frames.push({ kind: 'visit', value: root, assign: (value) => { result = value } })

  while (frames.size() > 0) {
    const frame = frames.pop()
    if (frame.kind === 'exit') {
      active.delete(frame.value)
      continue
    }

    expandedNodes += 1
    if (expandedNodes > maxExpandedNodes) invalidPlainJson()
    const value = frame.value
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
      frame.assign(value)
      continue
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalidPlainJson()
      frame.assign(value)
      continue
    }
    if (typeof value !== 'object') invalidPlainJson()
    if (utilTypes.isProxy(value)) invalidPlainJson()
    if (active.has(value)) invalidPlainJson()

    const isArray = Array.isArray(value)
    const prototype = prototypeOf(value)
    if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalidPlainJson()
    const keys = ownKeys(value)
    active.add(value)
    frames.push({ kind: 'exit', value })

    if (isArray) {
      const length = ownDataDescriptor(value, 'length').value as unknown
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1) invalidPlainJson()
      if (expandedNodes + length > maxExpandedNodes) invalidPlainJson()
      const clone: PlainJsonValue[] = new Array<PlainJsonValue>(length)
      Object.setPrototypeOf(clone, null)
      frame.assign(clone)
      let childCount = 0
      let sawLength = false
      for (let keyIndex = keys.length - 1; keyIndex >= 0; keyIndex -= 1) {
        const key = keys[keyIndex] as PropertyKey
        if (key === 'length') {
          sawLength = true
          continue
        }
        if (typeof key !== 'string' || !arrayIndex.test(key)) invalidPlainJson()
        const index = Number(key)
        if (index >= length) invalidPlainJson()
        const descriptor = ownDataDescriptor(value, key)
        if (!descriptor.enumerable) invalidPlainJson()
        childCount += 1
        frames.push({
          kind: 'visit',
          value: descriptor.value,
          assign: (cloned) => {
            Object.defineProperty(clone, key, {
              value: cloned,
              enumerable: true,
              configurable: true,
              writable: true,
            })
          },
        })
      }
      if (!sawLength || childCount !== length) invalidPlainJson()
      continue
    }

    if (expandedNodes + keys.length > maxExpandedNodes) invalidPlainJson()
    const clone = Object.create(null) as Record<string, PlainJsonValue>
    frame.assign(clone)
    for (let keyIndex = keys.length - 1; keyIndex >= 0; keyIndex -= 1) {
      const key = keys[keyIndex] as PropertyKey
      if (typeof key !== 'string') invalidPlainJson()
      const descriptor = ownDataDescriptor(value, key)
      if (!descriptor.enumerable) invalidPlainJson()
      frames.push({
        kind: 'visit',
        value: descriptor.value,
        assign: (cloned) => {
          Object.defineProperty(clone, key, {
            value: cloned,
            enumerable: true,
            configurable: true,
            writable: true,
          })
        },
      })
    }
  }

  if (result === undefined) invalidPlainJson()
  return result
}
