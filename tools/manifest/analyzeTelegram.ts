import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

import { API, SignatureKind, TypeFlags, type Checker, type Signature, type Symbol as TypeScriptSymbol, type Type } from 'typescript/unstable/sync'

import { isCanonicalSha512Integrity, resolveLockedPackage, type TrustedDependencyMetadata } from './analyzeViem.js'
import { encodeTypeSchema, type JsonSchema } from './schemaEncoder.js'

export type TelegramExclusionReason =
  | 'ambiguous_overload'
  | 'callback_input'
  | 'callback_output'
  | 'injected_target_collision'
  | 'non_callable_member'
  | 'non_json_input'
  | 'non_json_output'
  | 'not_target_scoped'
  | 'projection_failure'
  | 'subscription'
  | 'unsupported_signature'

export interface TelegramProjection {
  readonly input_schema: JsonSchema
  readonly output_schema: JsonSchema
}

export interface TelegramIncludedAction {
  readonly sourceName: string
  readonly toolName: string
  readonly signature: string
  readonly projection: TelegramProjection
  readonly runtimeDependencies: readonly ['chat_source', 'chat_target']
  readonly credential: 'telegram_bot_token'
}

export interface TelegramExcludedAction {
  readonly sourceName: string
  readonly reasonCode: TelegramExclusionReason
  readonly reason: string
}

export interface TelegramAnalysis {
  readonly packageName: 'grammy'
  readonly packageVersion: string
  readonly packageIntegrity: string
  readonly entrypoint: string
  readonly entrypointSha256: `sha256:${string}`
  readonly trustedDependencies: readonly TrustedDependencyMetadata[]
  readonly included: readonly TelegramIncludedAction[]
  readonly excluded: readonly TelegramExcludedAction[]
}

export interface AnalyzeTelegramInput {
  readonly cwd?: string
  readonly project?: (context: {
    readonly sourceName: string
    readonly toolName: string
    readonly checker: Checker
    readonly input_schema: JsonSchema
    readonly output_schema: JsonSchema
  }) => void
}

interface TelegramMetadata {
  readonly packageVersion: string
  readonly packageIntegrity: string
  readonly entrypoint: string
  readonly entrypointPath: string
}

const schemaVersion = 'https://json-schema.org/draft/2020-12/schema'
const sourceRuntimeDependencies = ['chat_source', 'chat_target'] as const

function sha256(value: Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label}.${key} must be a non-empty string`)
  return value
}

function findLock(start: string): string {
  let current = resolve(start)
  while (true) {
    const candidate = join(current, 'package-lock.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) throw new Error(`package-lock.json not found from ${start}`)
    current = parent
  }
}

function resolvePackageJson(require: NodeRequire, packageName: string): string {
  let current = dirname(require.resolve(packageName))
  while (true) {
    const candidate = join(current, 'package.json')
    if (existsSync(candidate) && JSON.parse(readFileSync(candidate, 'utf8')).name === packageName) return candidate
    const parent = dirname(current)
    if (parent === current) throw new Error(`cannot resolve ${packageName} package.json`)
    current = parent
  }
}

function resolveMetadata(cwd: string): TelegramMetadata {
  const require = createRequire(join(cwd, 'package.json'))
  const packageJsonPath = resolvePackageJson(require, 'grammy')
  const packageRoot = dirname(packageJsonPath)
  const packageJson = asRecord(JSON.parse(readFileSync(packageJsonPath, 'utf8')) as unknown, 'grammy package.json')
  const packageVersion = requiredString(packageJson, 'version', 'grammy package.json')
  const exports_ = asRecord(packageJson.exports, 'grammy package.json exports')
  const rootExport = asRecord(exports_['.'], 'grammy package.json exports["."]')
  const entrypoint = requiredString(rootExport, 'types', 'grammy root export')
  const entrypointPath = resolve(packageRoot, entrypoint)
  if (!entrypointPath.startsWith(`${packageRoot}/`) || !existsSync(entrypointPath)) {
    throw new Error('grammy public types export must resolve inside the installed package')
  }
  const lockPath = findLock(cwd)
  const lockRoot = dirname(lockPath)
  const lock = asRecord(JSON.parse(readFileSync(lockPath, 'utf8')) as unknown, 'package-lock.json')
  const packages = asRecord(lock.packages, 'package-lock.json packages')
  const locked = resolveLockedPackage('grammy', packageJsonPath, lockRoot, packages)
  if (locked.packageVersion !== packageVersion || !isCanonicalSha512Integrity(locked.packageIntegrity)) {
    throw new Error('grammy package identity is inconsistent with package-lock')
  }
  return { packageVersion, packageIntegrity: locked.packageIntegrity, entrypoint, entrypointPath }
}

function findExport(exports: ReadonlyMap<unknown, TypeScriptSymbol>, name: string): TypeScriptSymbol | undefined {
  return [...exports.values()].find((symbol) => symbol.name === name)
}

function isCallback(type: Type, checker: Checker): boolean {
  if (type.isUnionType() || type.isIntersectionType()) return type.getTypes().some((part) => isCallback(part, checker))
  if ((type.flags & (TypeFlags.String | TypeFlags.Number | TypeFlags.Boolean | TypeFlags.BigInt | TypeFlags.Null | TypeFlags.Undefined | TypeFlags.Void | TypeFlags.Never)) !== 0) return false
  if (checker.getSignaturesOfType(type, SignatureKind.Call).length > 0) return true
  return false
}

function hasCallback(type: Type, checker: Checker, active = new Set<number>(), depth = 0): boolean {
  if (depth > 16 || active.has(type.id)) return false
  if ((type.flags & (TypeFlags.String | TypeFlags.Number | TypeFlags.Boolean | TypeFlags.BigInt | TypeFlags.Null | TypeFlags.Undefined | TypeFlags.Void | TypeFlags.Never)) !== 0) return false
  if (isCallback(type, checker)) return true
  if (checker.isArrayLikeType(type) && type.isTypeReference()) {
    return checker.getTypeArguments(type).some((part) => hasCallback(part, checker, active, depth + 1))
  }
  active.add(type.id)
  try {
    return checker.getPropertiesOfType(type).some((property) => {
      const propertyType = checker.getTypeOfSymbol(property)
      return propertyType !== undefined && hasCallback(propertyType, checker, active, depth + 1)
    })
  } finally {
    active.delete(type.id)
  }
}

function isAbortSignal(parameter: TypeScriptSymbol, checker: Checker): boolean {
  const type = checker.getTypeOfSymbol(parameter)
  return type !== undefined && (type.getSymbol()?.name === 'AbortSignal' || /\bAbortSignal\b/.test(checker.typeToString(type)))
}

function parameterSchema(type: Type, checker: Checker): JsonSchema {
  try {
    return encodeTypeSchema(type, checker, { position: 'input' })
  } catch (error) {
    if (!type.isUnionType()) throw error
    const finite = type.getTypes().flatMap((part) => {
      try {
        return [encodeTypeSchema(part, checker, { position: 'input' })]
      } catch {
        return []
      }
    })
    if (finite.length === 0) throw error
    return finite.length === 1 ? finite[0] as JsonSchema : { $schema: schemaVersion, oneOf: finite }
  }
}

function outputSchema(type: Type, checker: Checker): JsonSchema {
  if ((type.flags & TypeFlags.Void) !== 0) return { $schema: schemaVersion, type: 'null' }
  const promise = type.getSymbol()?.name === 'Promise' && type.isTypeReference()
    ? checker.getTypeArguments(type)[0]
    : undefined
  if (promise === undefined) return encodeTypeSchema(type, checker, { position: 'output' })
  return encodeTypeSchema(promise, checker, { position: 'output' })
}

function acceptsUndefined(type: Type): boolean {
  return (type.flags & TypeFlags.Undefined) !== 0
    || (type.isUnionType() && type.getTypes().some((part) => acceptsUndefined(part)))
}

function injectedTargetCollision(schema: JsonSchema, identifiers: ReadonlySet<string>, path = '$'): string | undefined {
  const properties = schema.properties
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [name, value] of Object.entries(properties)) {
      const propertyPath = `${path}.properties.${name}`
      if (identifiers.has(name)) return propertyPath
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const collision = injectedTargetCollision(value as JsonSchema, identifiers, propertyPath)
        if (collision !== undefined) return collision
      }
    }
  }
  for (const [name, value] of Object.entries(schema)) {
    if (name === 'properties' || value === null || typeof value !== 'object') continue
    const values = Array.isArray(value) ? value : [value]
    for (const nested of values) {
      if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) continue
      const collision = injectedTargetCollision(nested as JsonSchema, identifiers, `${path}.${name}`)
      if (collision !== undefined) return collision
    }
  }
  return undefined
}

function inputSchema(signature: Signature, checker: Checker): JsonSchema {
  const properties: Record<string, JsonSchema> = {
    credential: {
      type: 'object',
      properties: {
        type: { const: 'inline' },
        secret: { type: 'string', minLength: 1, maxLength: 4_096, writeOnly: true },
      },
      required: ['secret', 'type'],
      additionalProperties: false,
    },
    target: { type: 'string', minLength: 1 },
  }
  const required = ['target']
  const parameters = signature.getParameters()
  for (const [index, parameter] of parameters.entries()) {
    if ((index === 0 && parameter.name === 'chat_id') || isAbortSignal(parameter, checker)) continue
    const type = checker.getTypeOfSymbol(parameter)
    if (type === undefined) throw new Error(`parameter ${parameter.name} is unresolved`)
    properties[parameter.name] = parameterSchema(type, checker)
    if (!acceptsUndefined(type)) required.push(parameter.name)
  }
  return { $schema: schemaVersion, type: 'object', properties, required, additionalProperties: false }
}

function exclusion(sourceName: string, reasonCode: TelegramExclusionReason, reason: string): TelegramExcludedAction {
  return { sourceName, reasonCode, reason }
}

function analyzeApiMember(
  member: TypeScriptSymbol,
  checker: Checker,
  project: AnalyzeTelegramInput['project'],
): TelegramIncludedAction | TelegramExcludedAction {
  const sourceName = member.name
  const memberType = checker.getTypeOfSymbol(member)
  if (memberType === undefined) return exclusion(sourceName, 'unsupported_signature', 'selected Api member type is unresolved')
  const signatures = checker.getSignaturesOfType(memberType, SignatureKind.Call)
  if (signatures.length === 0) return exclusion(sourceName, 'non_callable_member', 'selected Api member is not a callable operation')
  if (signatures.length !== 1 || signatures[0] === undefined) return exclusion(sourceName, 'ambiguous_overload', 'selected Api member has no single deterministic invocation signature')
  const signature = signatures[0]
  const parameters = signature.getParameters()
  if (parameters[0]?.name !== 'chat_id') {
    return exclusion(sourceName, 'not_target_scoped', 'selected Api operation has no target chat_id injection slot')
  }
  for (const [index, parameter] of parameters.entries()) {
    if (index === 0 && parameter.name === 'chat_id') continue
    const type = checker.getTypeOfSymbol(parameter)
    if (type !== undefined && hasCallback(type, checker)) {
      return exclusion(sourceName, 'callback_input', `parameter ${parameter.name} contains a callback or stream value`)
    }
  }
  const returnType = checker.getReturnTypeOfSignature(signature)
  if (returnType === undefined) return exclusion(sourceName, 'unsupported_signature', 'operation return type is unresolved')
  let input_schema: JsonSchema
  try {
    input_schema = inputSchema(signature, checker)
  } catch (error) {
    return exclusion(sourceName, 'non_json_input', error instanceof Error ? error.message : String(error))
  }
  const collision = injectedTargetCollision(input_schema, new Set(['chat_id']))
  if (collision !== undefined) {
    return exclusion(sourceName, 'injected_target_collision', `caller schema exposes injected chat_id at ${collision}`)
  }
  let output_schema: JsonSchema
  try {
    output_schema = outputSchema(returnType, checker)
  } catch (error) {
    return exclusion(sourceName, 'non_json_output', error instanceof Error ? error.message : String(error))
  }
  const toolName = `chat.telegram.api.${sourceName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}`
  try {
    project?.({ sourceName, toolName, checker, input_schema, output_schema })
  } catch (error) {
    return exclusion(sourceName, 'projection_failure', error instanceof Error ? error.message : String(error))
  }
  return {
    sourceName,
    toolName,
    signature: checker.typeToString(memberType),
    projection: { input_schema, output_schema },
    runtimeDependencies: sourceRuntimeDependencies,
    credential: 'telegram_bot_token',
  }
}

export function analyzeTelegram(input: AnalyzeTelegramInput = {}): TelegramAnalysis {
  const cwd = resolve(input.cwd ?? process.cwd())
  const metadata = resolveMetadata(cwd)
  const probePath = resolve(cwd, '.tas-telegram-manifest-probe.ts')
  const source = 'import type { Api } from "grammy"\nexport type TASApi = Api\n'
  const api = new API({
    cwd,
    fs: {
      readFile: (path) => path === probePath ? source : undefined,
      fileExists: (path) => path === probePath ? true : undefined,
      directoryExists: () => undefined,
      getAccessibleEntries: () => undefined,
      realpath: () => undefined,
    },
  })
  let snapshot: ReturnType<API['updateSnapshot']> | undefined
  try {
    snapshot = api.updateSnapshot({ openFiles: [probePath] })
    const project = snapshot.getDefaultProjectForFile(probePath)
    const sourceFile = project?.program.getSourceFile(probePath)
    if (project === undefined || sourceFile === undefined) throw new Error('TypeScript did not resolve the grammY analyzer probe')
    const diagnostics = project.program.getSemanticDiagnostics(probePath)
    if (diagnostics.length > 0) throw new Error(`grammY analyzer probe has semantic diagnostics: ${diagnostics.map(({ text }) => text).join('; ')}`)
    const exports = project.checker.getSymbolAtLocation(sourceFile)?.getExports()
    const apiSymbol = exports === undefined ? undefined : findExport(exports, 'TASApi')
    if (apiSymbol === undefined) throw new Error('grammY Api export is unresolved')
    const included: TelegramIncludedAction[] = []
    const excluded: TelegramExcludedAction[] = []
    const names = new Set<string>()
    for (const member of project.checker.getPropertiesOfType(project.checker.getDeclaredTypeOfSymbol(apiSymbol))
      .toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (names.has(member.name)) throw new Error(`duplicate grammY member classification: ${member.name}`)
      names.add(member.name)
      const result = analyzeApiMember(member, project.checker, input.project)
      if ('toolName' in result) included.push(result)
      else excluded.push(result)
    }
    return {
      packageName: 'grammy',
      packageVersion: metadata.packageVersion,
      packageIntegrity: metadata.packageIntegrity,
      entrypoint: metadata.entrypoint,
      entrypointSha256: sha256(readFileSync(metadata.entrypointPath)),
      trustedDependencies: [],
      included: included.toSorted((left, right) => left.sourceName.localeCompare(right.sourceName)),
      excluded: excluded.toSorted((left, right) => left.sourceName.localeCompare(right.sourceName)),
    }
  } finally {
    try {
      snapshot?.dispose()
    } finally {
      api.close()
    }
  }
}
