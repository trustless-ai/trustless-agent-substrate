import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { ComputedPropertyName } from 'typescript/unstable/ast'
import { isComputedPropertyName } from 'typescript/unstable/ast/is'
import { API, SignatureKind, TypeFlags, type Checker, type Signature, type Symbol as TypeScriptSymbol, type Type } from 'typescript/unstable/sync'

import { isCanonicalSha512Integrity, resolveLockedPackage, type TrustedDependencyMetadata } from './analyzeViem.js'
import { encodeTypeSchema, type JsonSchema } from './schemaEncoder.js'

export type DiscordExclusionReason =
  | 'ambiguous_overload'
  | 'callback_input'
  | 'callback_output'
  | 'non_callable_member'
  | 'non_json_input'
  | 'non_json_output'
  | 'not_target_scoped'
  | 'projection_failure'
  | 'unsupported_signature'

export interface DiscordProjection {
  readonly input_schema: JsonSchema
  readonly output_schema: JsonSchema
}

export interface DiscordIncludedAction {
  readonly sourceName: string
  readonly toolName: string
  readonly signature: string
  readonly projection: DiscordProjection
  readonly runtimeDependencies: readonly ['chat_source', 'chat_target', 'chat_context']
  readonly credential: 'discord_bot_token'
}

export interface DiscordExcludedAction {
  readonly sourceName: string
  readonly reasonCode: DiscordExclusionReason
  readonly reason: string
}

export interface DiscordAnalysis {
  readonly packageName: 'discord.js'
  readonly packageVersion: string
  readonly packageIntegrity: string
  readonly entrypoint: string
  readonly entrypointSha256: `sha256:${string}`
  readonly trustedDependencies: readonly TrustedDependencyMetadata[]
  readonly included: readonly DiscordIncludedAction[]
  readonly excluded: readonly DiscordExcludedAction[]
}

export interface AnalyzeDiscordInput {
  readonly cwd?: string
  readonly project?: (context: {
    readonly sourceName: string
    readonly toolName: string
    readonly checker: Checker
    readonly input_schema: JsonSchema
    readonly output_schema: JsonSchema
  }) => void
}

interface DiscordMetadata {
  readonly packageVersion: string
  readonly packageIntegrity: string
  readonly entrypoint: string
  readonly entrypointPath: string
}

const schemaVersion = 'https://json-schema.org/draft/2020-12/schema'
const sourceRuntimeDependencies = ['chat_source', 'chat_target', 'chat_context'] as const
const syntheticSymbolName = /^(__@.+)@\d+$/

function stableDeclarationPath(cwd: string, fileName: string): string {
  const absoluteCwd = resolve(cwd)
  const absoluteFile = isAbsolute(fileName) ? resolve(fileName) : resolve(absoluteCwd, fileName)
  const relativeFile = relative(absoluteCwd, absoluteFile)
  if (!isAbsolute(relativeFile) && relativeFile !== '..' && !relativeFile.startsWith(`..${sep}`)) {
    return relativeFile.split(sep).join('/')
  }
  const normalized = absoluteFile.split(sep).join('/')
  const nodeModulesMarker = '/node_modules/'
  const nodeModulesIndex = normalized.lastIndexOf(nodeModulesMarker)
  if (nodeModulesIndex >= 0) return `node_modules/${normalized.slice(nodeModulesIndex + nodeModulesMarker.length)}`
  throw new Error('discord.js synthetic member has no deterministic declaration identity')
}

function syntheticDeclarationIdentity(member: TypeScriptSymbol, cwd: string): string {
  if (member.declarations.length === 0) {
    throw new Error('discord.js synthetic member has no deterministic declaration identity')
  }
  const identities = member.declarations.map((handle) => {
    const declaration = handle.resolve()
    if (declaration === undefined) {
      throw new Error('discord.js synthetic member has no deterministic declaration identity')
    }
    const computedNames: ComputedPropertyName[] = []
    declaration.forEachChild((node) => {
      if (isComputedPropertyName(node)) computedNames.push(node)
      return undefined
    })
    if (computedNames.length !== 1 || computedNames[0] === undefined) {
      throw new Error('discord.js synthetic member has no deterministic declaration identity')
    }
    const sourceFile = declaration.getSourceFile()
    const expression = computedNames[0].expression.getText(sourceFile).trim().replace(/\s+/g, ' ')
    if (expression.length === 0) {
      throw new Error('discord.js synthetic member has no deterministic declaration identity')
    }
    return `${stableDeclarationPath(cwd, sourceFile.fileName)}\0${declaration.getStart(sourceFile)}\0${expression}`
  }).toSorted()
  return createHash('sha256').update(identities.join('\0')).digest('hex')
}

/** Replaces a program-local id only on a genuine TypeScript computed-symbol name. */
export function canonicalDiscordMemberName(
  member: TypeScriptSymbol,
  cwd: string,
): string {
  const escapedName = String(member.escapedName)
  if (escapedName !== member.name) return member.name
  const match = syntheticSymbolName.exec(escapedName)
  if (match === null || match[1] === undefined) return member.name
  return `${match[1]}$${syntheticDeclarationIdentity(member, cwd)}`
}

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

function resolveMetadata(cwd: string): DiscordMetadata {
  const require = createRequire(join(cwd, 'package.json'))
  const packageJsonPath = resolvePackageJson(require, 'discord.js')
  const packageRoot = dirname(packageJsonPath)
  const packageJson = asRecord(JSON.parse(readFileSync(packageJsonPath, 'utf8')) as unknown, 'discord.js package.json')
  const packageVersion = requiredString(packageJson, 'version', 'discord.js package.json')
  const entrypoint = requiredString(packageJson, 'types', 'discord.js package.json')
  const entrypointPath = resolve(packageRoot, entrypoint)
  if (!entrypointPath.startsWith(`${packageRoot}/`) || !existsSync(entrypointPath)) {
    throw new Error('discord.js public types export must resolve inside the installed package')
  }
  const lockPath = findLock(cwd)
  const lockRoot = dirname(lockPath)
  const lock = asRecord(JSON.parse(readFileSync(lockPath, 'utf8')) as unknown, 'package-lock.json')
  const locked = resolveLockedPackage('discord.js', packageJsonPath, lockRoot, asRecord(lock.packages, 'package-lock.json packages'))
  if (locked.packageVersion !== packageVersion || !isCanonicalSha512Integrity(locked.packageIntegrity)) {
    throw new Error('discord.js package identity is inconsistent with package-lock')
  }
  return { packageVersion, packageIntegrity: locked.packageIntegrity, entrypoint, entrypointPath }
}

function findExport(exports: ReadonlyMap<unknown, TypeScriptSymbol>, name: string): TypeScriptSymbol | undefined {
  return [...exports.values()].find((symbol) => symbol.name === name)
}

function hasCallback(type: Type, checker: Checker, active = new Set<number>(), depth = 0): boolean {
  if (depth > 16 || active.has(type.id)) return false
  if ((type.flags & (TypeFlags.String | TypeFlags.Number | TypeFlags.Boolean | TypeFlags.BigInt | TypeFlags.Null | TypeFlags.Undefined | TypeFlags.Void | TypeFlags.Never)) !== 0) return false
  if (type.isUnionType() || type.isIntersectionType()) return type.getTypes().some((part) => hasCallback(part, checker, active, depth + 1))
  if (checker.getSignaturesOfType(type, SignatureKind.Call).length > 0) return true
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
  const promise = type.getSymbol()?.name === 'Promise' && type.isTypeReference()
    ? checker.getTypeArguments(type)[0]
    : undefined
  const resolved = promise ?? type
  if ((resolved.flags & TypeFlags.Void) !== 0) return { $schema: schemaVersion, type: 'null' }
  return encodeTypeSchema(resolved, checker, { position: 'output' })
}

function acceptsUndefined(type: Type): boolean {
  return (type.flags & TypeFlags.Undefined) !== 0
    || (type.isUnionType() && type.getTypes().some((part) => acceptsUndefined(part)))
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
  for (const parameter of signature.getParameters()) {
    if (parameter.name === 'channel' || parameter.name === 'client' || parameter.name === 'context') continue
    const type = checker.getTypeOfSymbol(parameter)
    if (type === undefined) throw new Error(`parameter ${parameter.name} is unresolved`)
    properties[parameter.name] = parameterSchema(type, checker)
    if (!acceptsUndefined(type)) required.push(parameter.name)
  }
  return { $schema: schemaVersion, type: 'object', properties, required, additionalProperties: false }
}

function exclusion(sourceName: string, reasonCode: DiscordExclusionReason, reason: string): DiscordExcludedAction {
  return { sourceName, reasonCode, reason }
}

function analyzeMessageManagerMember(
  member: TypeScriptSymbol,
  checker: Checker,
  cwd: string,
  project: AnalyzeDiscordInput['project'],
): DiscordIncludedAction | DiscordExcludedAction {
  const sourceName = canonicalDiscordMemberName(member, cwd)
  const memberType = checker.getTypeOfSymbol(member)
  if (memberType === undefined) return exclusion(sourceName, 'unsupported_signature', 'selected message manager member type is unresolved')
  const signatures = checker.getSignaturesOfType(memberType, SignatureKind.Call)
  if (signatures.length === 0) return exclusion(sourceName, 'non_callable_member', 'selected message manager member is not a callable operation')
  if (signatures.length !== 1 || signatures[0] === undefined) return exclusion(sourceName, 'ambiguous_overload', 'selected message manager member has no single deterministic invocation signature')
  const signature = signatures[0]
  const returnType = checker.getReturnTypeOfSignature(signature)
  if (returnType === undefined) return exclusion(sourceName, 'unsupported_signature', 'operation return type is unresolved')
  let input_schema: JsonSchema
  try {
    input_schema = inputSchema(signature, checker)
  } catch (error) {
    return exclusion(sourceName, 'non_json_input', error instanceof Error ? error.message : String(error))
  }
  let output_schema: JsonSchema
  try {
    output_schema = outputSchema(returnType, checker)
  } catch (error) {
    return exclusion(sourceName, 'non_json_output', error instanceof Error ? error.message : String(error))
  }
  const toolName = `chat.discord.message_manager.${sourceName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}`
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
    credential: 'discord_bot_token',
  }
}

function analyzeClientMember(member: TypeScriptSymbol, checker: Checker, cwd: string): DiscordExcludedAction {
  const sourceName = `client.${canonicalDiscordMemberName(member, cwd)}`
  const memberType = checker.getTypeOfSymbol(member)
  if (memberType === undefined) return exclusion(sourceName, 'unsupported_signature', 'selected Client member type is unresolved')
  const signatures = checker.getSignaturesOfType(memberType, SignatureKind.Call)
  if (signatures.length === 0) return exclusion(sourceName, 'non_callable_member', 'selected Client member is not a callable operation')
  if (signatures.some((signature) => signature.getParameters().some((parameter) => {
    const type = checker.getTypeOfSymbol(parameter)
    return type !== undefined && hasCallback(type, checker)
  }))) return exclusion(sourceName, 'callback_input', 'Client event or callback registration is not a finite request-response operation')
  return exclusion(sourceName, 'not_target_scoped', 'Client plumbing is outside the configured target-bound message manager projection')
}

export function analyzeDiscord(input: AnalyzeDiscordInput = {}): DiscordAnalysis {
  const cwd = resolve(input.cwd ?? process.cwd())
  const metadata = resolveMetadata(cwd)
  const probePath = resolve(cwd, '.tas-discord-manifest-probe.ts')
  const source = 'import type { Client, MessageManager } from "discord.js"\nexport type TASClient = Client\nexport type TASMessageManager = MessageManager\n'
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
    if (project === undefined || sourceFile === undefined) throw new Error('TypeScript did not resolve the discord.js analyzer probe')
    const diagnostics = project.program.getSemanticDiagnostics(probePath)
    if (diagnostics.length > 0) throw new Error(`discord.js analyzer probe has semantic diagnostics: ${diagnostics.map(({ text }) => text).join('; ')}`)
    const exports = project.checker.getSymbolAtLocation(sourceFile)?.getExports()
    const managerSymbol = exports === undefined ? undefined : findExport(exports, 'TASMessageManager')
    const clientSymbol = exports === undefined ? undefined : findExport(exports, 'TASClient')
    if (managerSymbol === undefined || clientSymbol === undefined) throw new Error('discord.js selected public exports are unresolved')
    const included: DiscordIncludedAction[] = []
    const excluded: DiscordExcludedAction[] = []
    const names = new Set<string>()
    for (const member of project.checker.getPropertiesOfType(project.checker.getDeclaredTypeOfSymbol(managerSymbol))
      .toSorted((left, right) => canonicalDiscordMemberName(left, cwd).localeCompare(canonicalDiscordMemberName(right, cwd)))) {
      const sourceName = canonicalDiscordMemberName(member, cwd)
      if (names.has(sourceName)) throw new Error(`duplicate discord.js message manager classification: ${sourceName}`)
      names.add(sourceName)
      const result = analyzeMessageManagerMember(member, project.checker, cwd, input.project)
      if ('toolName' in result) included.push(result)
      else excluded.push(result)
    }
    for (const member of project.checker.getPropertiesOfType(project.checker.getDeclaredTypeOfSymbol(clientSymbol))
      .toSorted((left, right) => canonicalDiscordMemberName(left, cwd).localeCompare(canonicalDiscordMemberName(right, cwd)))) {
      const sourceName = `client.${canonicalDiscordMemberName(member, cwd)}`
      if (names.has(sourceName)) throw new Error(`duplicate discord.js Client classification: ${sourceName}`)
      names.add(sourceName)
      excluded.push(analyzeClientMember(member, project.checker, cwd))
    }
    return {
      packageName: 'discord.js',
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
