import { createHash } from 'node:crypto'
import {
  closeSync,
  constants as fileSystemConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { z } from 'zod'

import { bundledViemArtifactDigests } from './generatedViemArtifactDigests.js'
import { bundledAgentSdkArtifactDigests } from './generatedAgentSdkArtifactDigests.js'
import { bundledChatArtifactDigests } from './generatedChatArtifactDigests.js'
import { findInstallationRoot } from './installationRoot.js'
import { snapshotReviewedPackageTrees } from './packageTree.js'
import { parseDependencyManifest, type DependencyManifest, type GeneratedToolEntry } from './types.js'

const artifactNames = [
  'viem-public.v1.json',
  'viem-wallet.v1.json',
  'viem-report.v1.json',
] as const
const agentSdkArtifactNames = [
  'agent-sdk.v1.json',
  'agent-sdk-report.v1.json',
] as const
const chatArtifactNames = [
  'telegram.v1.json',
  'telegram-report.v1.json',
  'discord.v1.json',
  'discord-report.v1.json',
] as const
const MAX_ARTIFACT_BYTES = 1_048_576
const MAX_METADATA_BYTES = 1_048_576
const MAX_DECLARATION_BYTES = 1_048_576
const MAX_DECLARATION_COUNT = 10_000
const MAX_DECLARATION_TOTAL_BYTES = 67_108_864
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/
const sha256Digest = /^sha256:[0-9a-f]{64}$/
const sha512Integrity = /^sha512-([A-Za-z0-9+/]+={0,2})$/
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/
const sourceMember = /^[A-Za-z_$][A-Za-z0-9_$]*$/

type ArtifactName = (typeof artifactNames)[number]
type AgentSdkArtifactName = (typeof agentSdkArtifactNames)[number]
type ChatArtifactName = (typeof chatArtifactNames)[number]

type ViemManifestArtifactBytes = Readonly<Record<ArtifactName, Buffer | undefined>>
type AgentSdkManifestArtifactBytes = Readonly<Record<AgentSdkArtifactName, Buffer | undefined>>
type ChatManifestArtifactBytes = Readonly<Record<ChatArtifactName, Buffer | undefined>>

const sourceSchema = z.object({
  package: z.literal('viem'),
  version: z.string().regex(exactVersion),
  package_integrity: z.string().refine(isCanonicalSha512),
  entrypoint_digest: z.string().regex(sha256Digest),
  entrypoints: z.array(z.string().min(1)).min(1),
}).strict()

const agentSdkSourceSchema = z.object({
  package: z.literal('@trustless-ai/agent-sdk'),
  version: z.string().regex(exactVersion),
  package_integrity: z.string().refine(isCanonicalSha512),
  entrypoint_digest: z.string().regex(sha256Digest),
  entrypoints: z.array(z.string().min(1)).min(1).max(64),
}).strict()

const generatorSchema = z.object({
  name: z.literal('@trustless-ai/tas-manifest'),
  version: z.string().regex(exactVersion),
  typescript_version: z.literal('7.0.2'),
}).strict()

const reviewedEntrypointSchema = z.object({
  entrypoint: z.string().min(1),
  exported_types_path: z.string().min(1),
  exported_types_sha256: z.string().regex(sha256Digest),
}).strict()

const reviewedAgentSdkEntrypointSchema = reviewedEntrypointSchema.extend({
  exported_runtime_path: z.string().min(1),
}).strict()

const reviewedDeclarationSchema = z.object({
  package_name: z.string().regex(packageName),
  package_version: z.string().regex(exactVersion),
  package_relative_path: z.string().min(1),
  sha256: z.string().regex(sha256Digest),
}).strict()

const reviewedRuntimeFileSchema = reviewedDeclarationSchema

const reviewedPackageSchema = z.object({
  package_name: z.string().regex(packageName),
  package_version: z.string().regex(exactVersion),
  package_integrity: z.string().refine(isCanonicalSha512),
  package_tree_sha256: z.string().regex(sha256Digest),
  package_file_count: z.number().int().positive().safe(),
  package_total_bytes: z.number().int().positive().safe(),
}).strict()

const trustedDependencySchema = z.object({
  packageName: z.string().regex(packageName),
  packageVersion: z.string().regex(exactVersion),
  packageIntegrity: z.string().refine(isCanonicalSha512),
}).strict()

const operationSchema = z.object({
  effect: z.enum(['read', 'side_effect']),
  completion: z.enum(['synchronous', 'bounded_wait', 'external_handle']),
}).strict()

const includedReportEntrySchema = z.object({
  source_profile: z.enum(['viem-public', 'viem-wallet']),
  source_name: z.string().regex(sourceMember),
  result: z.literal('included'),
  tool_name: z.string().min(1),
  operation: operationSchema,
}).strict()

const excludedReportEntrySchema = z.object({
  source_profile: z.enum(['viem-public', 'viem-wallet']),
  source_name: z.string().regex(sourceMember),
  result: z.literal('excluded'),
  reason_code: z.enum([
    'callback_input',
    'callback_output',
    'subscription',
    'opaque_runtime_object',
    'non_finite_request',
    'non_finite_response',
    'account_not_injectable',
    'authenticated_write_not_bound',
  ]),
  reason: z.string().min(1),
}).strict()

const reviewSchema = z.object({
  schema_version: z.literal('tas-manifest-report/v1'),
  source: sourceSchema,
  reviewed_entrypoints: z.array(reviewedEntrypointSchema).min(1).max(64),
  reviewed_declarations: z.array(reviewedDeclarationSchema).min(1).max(MAX_DECLARATION_COUNT),
  trusted_dependencies: z.array(trustedDependencySchema).max(128),
  reviewed_packages: z.array(reviewedPackageSchema).min(1).max(128),
  generator: generatorSchema,
  entries: z.array(z.discriminatedUnion('result', [includedReportEntrySchema, excludedReportEntrySchema])).min(1).max(10_000),
  provider_adapter_claims: z.tuple([]),
  failures: z.tuple([]),
}).strict()

const includedAgentSdkReportEntrySchema = z.object({
  entrypoint: z.string().min(1),
  export_name: z.string().regex(sourceMember),
  member: z.string().regex(sourceMember).optional(),
  result: z.literal('included'),
  tool_name: z.string().min(1),
  operation: operationSchema,
}).strict()

const excludedAgentSdkReportEntrySchema = z.object({
  entrypoint: z.string().min(1),
  export_name: z.string().regex(sourceMember),
  result: z.literal('excluded'),
  reason_code: z.enum(['non_callable_export', 'shadowed_by_canonical_entrypoint']),
  reason: z.string().min(1),
}).strict()

const agentSdkReviewSchema = z.object({
  schema_version: z.literal('tas-manifest-report/v1'),
  source: agentSdkSourceSchema,
  reviewed_entrypoints: z.array(reviewedAgentSdkEntrypointSchema).min(1).max(64),
  reviewed_declarations: z.array(reviewedDeclarationSchema).min(1).max(MAX_DECLARATION_COUNT),
  trusted_dependencies: z.array(trustedDependencySchema).max(128),
  reviewed_packages: z.array(reviewedPackageSchema).min(1).max(128),
  reviewed_runtime_files: z.array(reviewedRuntimeFileSchema).min(1).max(MAX_DECLARATION_COUNT),
  generator: generatorSchema,
  entries: z.array(z.discriminatedUnion('result', [
    includedAgentSdkReportEntrySchema,
    excludedAgentSdkReportEntrySchema,
  ])).min(1).max(10_000),
  provider_adapter_claims: z.tuple([]),
  failures: z.tuple([]),
}).strict()

const chatSourceSchema = z.object({
  package: z.enum(['grammy', 'discord.js']),
  version: z.string().regex(exactVersion),
  package_integrity: z.string().refine(isCanonicalSha512),
  entrypoint_digest: z.string().regex(sha256Digest),
  entrypoints: z.tuple([z.literal('.')]),
}).strict()

const includedChatReportEntrySchema = z.object({
  source_profile: z.enum(['telegram', 'discord']),
  source_name: z.string().regex(sourceMember),
  result: z.literal('included'),
  tool_name: z.string().min(1),
  operation: operationSchema,
}).strict()

const excludedChatReportEntrySchema = z.object({
  source_profile: z.enum(['telegram', 'discord']),
  source_name: z.string().min(1),
  result: z.literal('excluded'),
  reason_code: z.enum([
    'ambiguous_overload', 'callback_input', 'callback_output', 'injected_target_collision',
    'non_callable_member', 'non_json_input', 'non_json_output', 'not_target_scoped',
    'projection_failure', 'subscription', 'unsupported_signature',
  ]),
  reason: z.string().min(1),
}).strict()

const chatReviewSchema = z.object({
  schema_version: z.literal('tas-manifest-report/v1'),
  source: chatSourceSchema,
  generator: generatorSchema,
  entries: z.array(z.discriminatedUnion('result', [
    includedChatReportEntrySchema,
    excludedChatReportEntrySchema,
  ])).min(1).max(10_000),
  failures: z.tuple([]),
}).strict()

export type ViemManifestReview = z.infer<typeof reviewSchema>
export type AgentSdkManifestReview = z.infer<typeof agentSdkReviewSchema>
export type ChatManifestReview = z.infer<typeof chatReviewSchema>

export interface LoadedViemManifests {
  readonly public: DependencyManifest
  readonly wallet: DependencyManifest
  readonly review: ViemManifestReview
}

export interface LoadedAgentSdkManifest {
  readonly manifest: DependencyManifest
  readonly review: AgentSdkManifestReview
}

export interface LoadedChatManifest {
  readonly manifest: DependencyManifest
  readonly review: ChatManifestReview
}

export interface LoadedChatManifests {
  readonly telegram: LoadedChatManifest
  readonly discord: LoadedChatManifest
}

class ManifestValidationFailure extends Error {}

export class TasManifestLoadError extends Error {
  readonly code = 'TAS_MANIFEST_INVALID'

  constructor() {
    super('TAS_MANIFEST_INVALID: bundled Manifest validation failed')
    this.name = 'TasManifestLoadError'
  }
}

function invalid(): never {
  throw new ManifestValidationFailure()
}

function isCanonicalSha512(value: string): boolean {
  const match = sha512Integrity.exec(value)
  if (match === null) return false
  const encoded = match[1] as string
  const decoded = Buffer.from(encoded, 'base64')
  return decoded.byteLength === 64 && decoded.toString('base64') === encoded
}

function safeJsonParse(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    return invalid()
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) return invalid()
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return invalid()
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value !== 'object') return invalid()
  const record = value as Record<string, unknown>
  const keys = Reflect.ownKeys(record)
  if (keys.some((key) => typeof key !== 'string')) return invalid()
  const sorted = (keys as string[]).toSorted()
  if (sorted.some(hasLoneSurrogate)) return invalid()
  return `{${sorted.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1)
      if (!(following >= 0xdc00 && following <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

function parseCanonicalArtifact(bytes: Buffer | undefined): unknown {
  if (bytes === undefined || bytes.byteLength === 0 || bytes.byteLength >= MAX_ARTIFACT_BYTES) return invalid()
  const parsed = safeJsonParse(bytes)
  if (Buffer.byteLength(canonicalJson(parsed), 'utf8') !== bytes.byteLength
    || canonicalJson(parsed) !== bytes.toString('utf8')) return invalid()
  return parsed
}

function readBoundedRegularFile(path: string, maximumBytes: number): Buffer {
  let descriptor: number | undefined
  try {
    descriptor = openSync(
      path,
      fileSystemConstants.O_RDONLY | fileSystemConstants.O_NOFOLLOW | fileSystemConstants.O_NONBLOCK,
    )
    const status = fstatSync(descriptor)
    if (!status.isFile() || status.size < 1 || status.size > maximumBytes) return invalid()
    const bytes = Buffer.alloc(status.size + 1)
    let total = 0
    while (total < bytes.byteLength) {
      const count = readSync(descriptor, bytes, total, bytes.byteLength - total, null)
      if (count === 0) break
      total += count
    }
    if (total !== status.size) return invalid()
    return bytes.subarray(0, total)
  } catch (error) {
    if (error instanceof ManifestValidationFailure) throw error
    return invalid()
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function readJsonRecord(path: string, maximumBytes = MAX_METADATA_BYTES): Record<string, unknown> {
  const value = safeJsonParse(readBoundedRegularFile(path, maximumBytes))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}

function ownString(record: Record<string, unknown>, field: string): string {
  const descriptor = Object.getOwnPropertyDescriptor(record, field)
  if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'string' || descriptor.value.length === 0) {
    return invalid()
  }
  return descriptor.value
}

function isSafeRelativePath(value: string, allowLeadingDotSlash = false): boolean {
  if (value.includes('\\') || value.includes('\0') || isAbsolute(value)) return false
  const normalized = allowLeadingDotSlash && value.startsWith('./') ? value.slice(2) : value
  if (normalized.length === 0 || normalized.startsWith('/')) return false
  return normalized.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

function assertNoSymlinkPath(root: string, relativePath: string, finalKind: 'file' | 'directory'): string {
  if (!isSafeRelativePath(relativePath)) return invalid()
  let current = root
  const segments = relativePath.split('/')
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment)
    let status
    try {
      status = lstatSync(current)
    } catch {
      return invalid()
    }
    if (status.isSymbolicLink()) return invalid()
    const final = index === segments.length - 1
    if (final ? (finalKind === 'file' ? !status.isFile() : !status.isDirectory()) : !status.isDirectory()) return invalid()
  }
  return current
}

function assertRootDirectory(path: string): void {
  try {
    const status = lstatSync(path)
    if (status.isSymbolicLink() || !status.isDirectory()) return invalid()
  } catch (error) {
    if (error instanceof ManifestValidationFailure) throw error
    return invalid()
  }
}

function assertInside(root: string, path: string): void {
  let rootReal: string
  let pathReal: string
  try {
    rootReal = realpathSync(root)
    pathReal = realpathSync(path)
  } catch {
    return invalid()
  }
  const child = relative(rootReal, pathReal)
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) return invalid()
}

function statusIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return invalid()
  }
}

function validateNearestPackageBoundary(
  declarationPath: string,
  expected: ResolvedReviewedPackage,
  installation: ResolvedInstallation,
): void {
  let current = dirname(resolve(declarationPath))
  const boundary = resolve(installation.lockRoot)
  while (true) {
    const child = relative(boundary, current)
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) return invalid()
    const packageJsonPath = join(current, 'package.json')
    const status = statusIfPresent(packageJsonPath)
    if (status !== undefined) {
      if (status.isSymbolicLink() || !status.isFile()) return invalid()
      const marker = readJsonRecord(packageJsonPath)
      const hasName = Object.hasOwn(marker, 'name')
      const hasVersion = Object.hasOwn(marker, 'version')
      if (hasName !== hasVersion) return invalid()
      if (hasName) {
        if (resolve(current) !== resolve(expected.root)
          || ownString(marker, 'name') !== expected.identity.package_name
          || ownString(marker, 'version') !== expected.identity.package_version) return invalid()
        const lockKey = relative(installation.lockRoot, current).split(sep).join('/')
        const lockEntry = installation.lockPackages[lockKey]
        if (lockEntry === null || typeof lockEntry !== 'object' || Array.isArray(lockEntry)) return invalid()
        const record = lockEntry as Record<string, unknown>
        if (record.version !== expected.identity.package_version
          || record.integrity !== expected.identity.package_integrity
          || lockPackageName(lockKey) !== expected.identity.package_name) return invalid()
        return
      }
    }
    if (current === boundary) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return invalid()
}

function validateViemTypesExport(
  viem: ResolvedReviewedPackage,
  review: ViemManifestReview,
): void {
  const exportsField = viem.packageJson.exports
  if (exportsField === null || typeof exportsField !== 'object' || Array.isArray(exportsField)) return invalid()
  const rootExport = (exportsField as Record<string, unknown>)['.']
  if (rootExport === null || typeof rootExport !== 'object' || Array.isArray(rootExport)) return invalid()
  const types = ownString(rootExport as Record<string, unknown>, 'types')
  const reviewed = review.reviewed_entrypoints.find(({ entrypoint }) => entrypoint === '.')
  if (reviewed === undefined || types !== reviewed.exported_types_path || !isSafeRelativePath(types, true)) return invalid()
  const absolute = resolve(viem.root, types)
  assertInside(viem.root, absolute)
}

function lockPackageName(lockKey: string): string | undefined {
  if (lockKey === '' || !isSafeRelativePath(lockKey)) return undefined
  const marker = 'node_modules/'
  const index = lockKey.lastIndexOf(marker)
  if (index < 0) return undefined
  const candidate = lockKey.slice(index + marker.length)
  return packageName.test(candidate) ? candidate : undefined
}

interface ResolvedReviewedPackage {
  readonly root: string
  readonly identity: ViemManifestReview['reviewed_packages'][number]
  readonly packageJson: Readonly<Record<string, unknown>>
}

interface ResolvedInstallation {
  readonly packages: ReadonlyMap<string, ResolvedReviewedPackage>
  readonly lockPackages: Readonly<Record<string, unknown>>
  readonly lockRoot: string
}

function resolveReviewedPackages(
  installationRoot: string,
  review: { readonly reviewed_packages: readonly z.infer<typeof reviewedPackageSchema>[] },
): ResolvedInstallation {
  const nodeModules = assertNoSymlinkPath(installationRoot, 'node_modules', 'directory')
  const lock = readJsonRecord(assertNoSymlinkPath(nodeModules, '.package-lock.json', 'file'))
  if (lock.lockfileVersion !== 3 || lock.packages === null || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) {
    return invalid()
  }
  const packages = lock.packages as Record<string, unknown>
  const candidates = new Map<string, string[]>()
  for (const lockKey of Object.keys(packages)) {
    if (lockKey !== '' && !isSafeRelativePath(lockKey)) return invalid()
    const name = lockPackageName(lockKey)
    if (name === undefined) continue
    const existing = candidates.get(name) ?? []
    existing.push(lockKey)
    candidates.set(name, existing)
  }

  const resolved = new Map<string, ResolvedReviewedPackage>()
  for (const identity of review.reviewed_packages) {
    const matches = candidates.get(identity.package_name)
    if (matches === undefined || matches.length !== 1 || resolved.has(identity.package_name)) return invalid()
    const lockKey = matches[0] as string
    const lockEntry = packages[lockKey]
    if (lockEntry === null || typeof lockEntry !== 'object' || Array.isArray(lockEntry)) return invalid()
    const lockRecord = lockEntry as Record<string, unknown>
    if (lockRecord.version !== identity.package_version || lockRecord.integrity !== identity.package_integrity) return invalid()
    if (!isCanonicalSha512(identity.package_integrity)) return invalid()
    if (lockRecord.name !== undefined && lockRecord.name !== identity.package_name) return invalid()

    const root = assertNoSymlinkPath(installationRoot, lockKey, 'directory')
    assertInside(nodeModules, root)
    const packageJsonPath = assertNoSymlinkPath(root, 'package.json', 'file')
    assertInside(root, packageJsonPath)
    const packageJson = readJsonRecord(packageJsonPath)
    if (ownString(packageJson, 'name') !== identity.package_name
      || ownString(packageJson, 'version') !== identity.package_version) return invalid()
    resolved.set(identity.package_name, { root, identity, packageJson })
  }
  return { packages: resolved, lockPackages: packages, lockRoot: installationRoot }
}

function sha256(bytes: Buffer | string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function validateArtifactDigests(
  artifacts: ViemManifestArtifactBytes,
): void {
  for (const name of artifactNames) {
    const bytes = artifacts[name]
    const expectedDigest = bundledViemArtifactDigests[name]
    if (bytes === undefined || expectedDigest === undefined || sha256(bytes) !== expectedDigest) return invalid()
  }
}

function validateAgentSdkArtifactDigests(artifacts: AgentSdkManifestArtifactBytes): void {
  for (const name of agentSdkArtifactNames) {
    const bytes = artifacts[name]
    const expectedDigest = bundledAgentSdkArtifactDigests[name]
    if (bytes === undefined || expectedDigest === undefined || sha256(bytes) !== expectedDigest) return invalid()
  }
}

function validateChatArtifactDigests(artifacts: ChatManifestArtifactBytes): void {
  for (const name of chatArtifactNames) {
    const bytes = artifacts[name]
    const expectedDigest = bundledChatArtifactDigests[name]
    if (bytes === undefined || expectedDigest === undefined || sha256(bytes) !== expectedDigest) return invalid()
  }
}

function sortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] as string) < value)
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function validateAnnotations(tool: GeneratedToolEntry, profile: 'viem-public' | 'viem-wallet'): void {
  const effect = profile === 'viem-wallet' || tool.operation.completion === 'external_handle' ? 'side_effect' : 'read'
  if (tool.operation.effect !== effect
    || tool.annotations.readOnlyHint !== (effect === 'read')
    || tool.annotations.destructiveHint !== (effect === 'side_effect')
    || tool.annotations.idempotentHint !== (effect === 'read')
    || tool.annotations.openWorldHint !== true) return invalid()
}

function validateAgentSdkAnnotations(tool: GeneratedToolEntry): void {
  const readOnly = tool.operation.effect === 'read'
  if (tool.annotations.readOnlyHint !== readOnly
    || tool.annotations.destructiveHint !== !readOnly
    || tool.annotations.idempotentHint !== readOnly
    || tool.annotations.openWorldHint !== true) return invalid()
}

function validateManifestRelationships(
  publicManifest: DependencyManifest,
  walletManifest: DependencyManifest,
  review: ViemManifestReview,
  packageVersion: string,
): void {
  if (publicManifest.source_profile !== 'viem-public' || publicManifest.manifest_id !== 'viem-public'
    || walletManifest.source_profile !== 'viem-wallet' || walletManifest.manifest_id !== 'viem-wallet'
    || publicManifest.tools.length === 0 || walletManifest.tools.length === 0) return invalid()
  if (!sameJson(publicManifest.source, walletManifest.source)
    || !sameJson(publicManifest.source, review.source)
    || !sameJson(publicManifest.generator, walletManifest.generator)
    || !sameJson(publicManifest.generator, review.generator)
    || review.generator.version !== packageVersion) return invalid()

  const names = new Set<string>()
  const included = new Map<string, GeneratedToolEntry>()
  for (const [profile, manifest] of [['viem-public', publicManifest], ['viem-wallet', walletManifest]] as const) {
    for (const tool of manifest.tools) {
      validateAnnotations(tool, profile)
      if (names.has(tool.name)) return invalid()
      names.add(tool.name)
      included.set(`${profile}:${tool.source.member}`, tool)
    }
  }

  const entryKeys = review.entries.map((entry) => `${entry.source_profile}:${entry.source_name}`)
  if (!sortedUnique(entryKeys)) return invalid()
  const reportedIncluded = new Set<string>()
  for (const entry of review.entries) {
    const key = `${entry.source_profile}:${entry.source_name}`
    if (entry.result === 'excluded') {
      if (included.has(key)) return invalid()
      continue
    }
    const tool = included.get(key)
    if (tool === undefined || reportedIncluded.has(key) || entry.tool_name !== tool.name
      || !sameJson(entry.operation, tool.operation)) return invalid()
    reportedIncluded.add(key)
  }
  if (reportedIncluded.size !== included.size) return invalid()
}

function agentSdkReportEntryKey(entry: AgentSdkManifestReview['entries'][number]): string {
  const member = 'member' in entry ? entry.member ?? '' : ''
  return `${entry.entrypoint}:${entry.export_name}:${member}`
}

function agentSdkToolEntryKey(tool: GeneratedToolEntry): string {
  const member = tool.binding.kind === 'class_method' ? tool.source.member : ''
  return `${tool.source.entrypoint}:${tool.source.export}:${member}`
}

function validateAgentSdkManifestRelationships(
  manifest: DependencyManifest,
  review: AgentSdkManifestReview,
  packageVersion: string,
): void {
  if (manifest.source_profile !== 'agent-sdk' || manifest.manifest_id !== 'agent-sdk'
    || !sameJson(manifest.source, review.source)
    || !sameJson(manifest.generator, review.generator)
    || review.generator.version !== packageVersion) return invalid()

  const included = new Map<string, GeneratedToolEntry>()
  for (const tool of manifest.tools) {
    validateAgentSdkAnnotations(tool)
    const key = agentSdkToolEntryKey(tool)
    if (included.has(key)) return invalid()
    included.set(key, tool)
  }

  const entryKeys = review.entries.map(agentSdkReportEntryKey)
  if (!sortedUnique(entryKeys)) return invalid()
  const reportedIncluded = new Set<string>()
  for (const entry of review.entries) {
    const key = agentSdkReportEntryKey(entry)
    if (entry.result === 'excluded') {
      if (included.has(key)) return invalid()
      continue
    }
    const tool = included.get(key)
    if (tool === undefined || reportedIncluded.has(key)
      || entry.tool_name !== tool.name
      || !sameJson(entry.operation, tool.operation)) return invalid()
    reportedIncluded.add(key)
  }
  if (reportedIncluded.size !== included.size) return invalid()
}

function validateChatManifestRelationships(
  profile: 'telegram' | 'discord',
  manifest: DependencyManifest,
  review: ChatManifestReview,
  packageVersion: string,
): void {
  const expectedPackage = profile === 'telegram' ? 'grammy' : 'discord.js'
  if (manifest.manifest_id !== profile || manifest.source_profile !== profile
    || manifest.source.package !== expectedPackage || manifest.tools.length === 0
    || !sameJson(manifest.source, review.source)
    || !sameJson(manifest.generator, review.generator)
    || review.generator.version !== packageVersion) return invalid()

  const tools = new Map(manifest.tools.map((tool) => [tool.source.member, tool]))
  const keys = review.entries.map(({ source_name }) => source_name)
  if (new Set(keys).size !== keys.length
    || !keys.every((key, index) => index === 0
      || (keys[index - 1] as string).localeCompare(key) < 0)) return invalid()
  const included = new Set<string>()
  for (const entry of review.entries) {
    if (entry.source_profile !== profile) return invalid()
    const tool = tools.get(entry.source_name)
    if (entry.result === 'excluded') {
      if (tool !== undefined) return invalid()
      continue
    }
    if (tool === undefined || included.has(entry.source_name)
      || entry.tool_name !== tool.name || !sameJson(entry.operation, tool.operation)) return invalid()
    included.add(entry.source_name)
  }
  if (included.size !== tools.size) return invalid()
}

function validateChatInstalledSource(
  installationRoot: string,
  source: ChatManifestReview['source'],
): void {
  const nodeModules = assertNoSymlinkPath(installationRoot, 'node_modules', 'directory')
  const hiddenLock = readJsonRecord(assertNoSymlinkPath(nodeModules, '.package-lock.json', 'file'))
  if (hiddenLock.lockfileVersion !== 3
    || hiddenLock.packages === null || typeof hiddenLock.packages !== 'object' || Array.isArray(hiddenLock.packages)) {
    return invalid()
  }
  const lockKey = `node_modules/${source.package}`
  const lockEntry = (hiddenLock.packages as Record<string, unknown>)[lockKey]
  if (lockEntry === null || typeof lockEntry !== 'object' || Array.isArray(lockEntry)) return invalid()
  const lockRecord = lockEntry as Record<string, unknown>
  if (lockRecord.version !== source.version || lockRecord.integrity !== source.package_integrity) return invalid()

  const packageRoot = assertNoSymlinkPath(installationRoot, lockKey, 'directory')
  assertInside(nodeModules, packageRoot)
  const packageJson = readJsonRecord(assertNoSymlinkPath(packageRoot, 'package.json', 'file'))
  if (ownString(packageJson, 'name') !== source.package || ownString(packageJson, 'version') !== source.version) return invalid()
  const entrypoint = source.package === 'grammy'
    ? (() => {
        const exports_ = packageJson.exports
        if (exports_ === null || typeof exports_ !== 'object' || Array.isArray(exports_)) return invalid()
        const rootExport = (exports_ as Record<string, unknown>)['.']
        if (rootExport === null || typeof rootExport !== 'object' || Array.isArray(rootExport)) return invalid()
        return ownString(rootExport as Record<string, unknown>, 'types')
      })()
    : ownString(packageJson, 'types')
  if (!isSafeRelativePath(entrypoint, true)) return invalid()
  const entrypointPath = assertNoSymlinkPath(packageRoot, entrypoint.slice(2), 'file')
  assertInside(packageRoot, entrypointPath)
  const entrypointSha256 = sha256(readBoundedRegularFile(entrypointPath, MAX_DECLARATION_BYTES))
  const digest = sha256(canonicalJson({
    package: source.package,
    version: source.version,
    package_integrity: source.package_integrity,
    entrypoints: [{
      entrypoint: '.',
      exported_types_path: entrypoint,
      exported_types_sha256: entrypointSha256,
    }],
  }))
  if (digest !== source.entrypoint_digest) return invalid()
}

function validateReviewClosure(
  installationRoot: string,
  manifests: readonly [DependencyManifest, DependencyManifest],
  review: ViemManifestReview,
): void {
  const packageKeys = review.reviewed_packages.map(({ package_name }) => package_name)
  const declarationKeys = review.reviewed_declarations.map(({ package_name, package_relative_path }) => `${package_name}:${package_relative_path}`)
  const trustedKeys = review.trusted_dependencies.map(({ packageName }) => packageName)
  if (!sortedUnique(packageKeys) || !sortedUnique(declarationKeys) || !sortedUnique(trustedKeys)) return invalid()
  const installation = resolveReviewedPackages(installationRoot, review)
  const resolvedPackages = installation.packages
  const snapshots = new Map(snapshotReviewedPackageTrees(
    [...resolvedPackages].map(([packageName, package_]) => ({ packageName, packageRoot: package_.root })),
  ).map((snapshot) => [snapshot.packageName, snapshot]))
  for (const package_ of review.reviewed_packages) {
    const snapshot = snapshots.get(package_.package_name)
    if (snapshot === undefined
      || snapshot.packageTreeSha256 !== package_.package_tree_sha256
      || snapshot.packageFileCount !== package_.package_file_count
      || snapshot.packageTotalBytes !== package_.package_total_bytes) return invalid()
  }
  const usedPackages = new Set<string>()
  let totalBytes = 0

  for (const declaration of review.reviewed_declarations) {
    const package_ = resolvedPackages.get(declaration.package_name)
    if (package_ === undefined || declaration.package_version !== package_.identity.package_version
      || !isSafeRelativePath(declaration.package_relative_path)) return invalid()
    const path = assertNoSymlinkPath(package_.root, declaration.package_relative_path, 'file')
    assertInside(package_.root, path)
    validateNearestPackageBoundary(path, package_, installation)
    const bytes = readBoundedRegularFile(path, MAX_DECLARATION_BYTES)
    totalBytes += bytes.byteLength
    if (totalBytes > MAX_DECLARATION_TOTAL_BYTES || sha256(bytes) !== declaration.sha256) return invalid()
    usedPackages.add(declaration.package_name)
  }
  if (usedPackages.size !== resolvedPackages.size) return invalid()

  const reviewedByName = new Map(review.reviewed_packages.map((package_) => [package_.package_name, package_]))
  for (const dependency of review.trusted_dependencies) {
    const reviewed = reviewedByName.get(dependency.packageName)
    if (reviewed === undefined || reviewed.package_version !== dependency.packageVersion
      || reviewed.package_integrity !== dependency.packageIntegrity) return invalid()
  }
  const viem = reviewedByName.get('viem')
  if (viem === undefined || viem.package_version !== review.source.version
    || viem.package_integrity !== review.source.package_integrity) return invalid()
  const resolvedViem = resolvedPackages.get('viem')
  if (resolvedViem === undefined) return invalid()
  validateViemTypesExport(resolvedViem, review)

  const entrypointKeys = review.reviewed_entrypoints.map(({ entrypoint }) => entrypoint)
  if (!sortedUnique(entrypointKeys) || !sameJson(entrypointKeys, review.source.entrypoints)) return invalid()
  for (const entrypoint of review.reviewed_entrypoints) {
    if (!isSafeRelativePath(entrypoint.exported_types_path, true)) return invalid()
    const path = entrypoint.exported_types_path.startsWith('./')
      ? entrypoint.exported_types_path.slice(2)
      : entrypoint.exported_types_path
    const declaration = review.reviewed_declarations.find((candidate) => candidate.package_name === 'viem'
      && candidate.package_relative_path === path)
    if (declaration === undefined || declaration.sha256 !== entrypoint.exported_types_sha256) return invalid()
  }

  const digest = sha256(canonicalJson({
    package: 'viem',
    version: review.source.version,
    package_integrity: review.source.package_integrity,
    entrypoints: review.reviewed_entrypoints,
    trusted_dependencies: review.trusted_dependencies,
    reviewed_packages: review.reviewed_packages,
    reviewed_declarations: review.reviewed_declarations,
  }))
  if (digest !== review.source.entrypoint_digest
    || manifests.some((manifest) => manifest.source.entrypoint_digest !== digest)) return invalid()
}

function validateAgentSdkExports(
  package_: ResolvedReviewedPackage,
  review: AgentSdkManifestReview,
): void {
  const exportsField = package_.packageJson.exports
  if (exportsField === null || typeof exportsField !== 'object' || Array.isArray(exportsField)) return invalid()
  const exportsRecord = exportsField as Record<string, unknown>
  const runtimeFiles = new Map(review.reviewed_runtime_files
    .filter(({ package_name }) => package_name === '@trustless-ai/agent-sdk')
    .map((file) => [file.package_relative_path, file]))
  const declarations = new Map(review.reviewed_declarations
    .filter(({ package_name }) => package_name === '@trustless-ai/agent-sdk')
    .map((file) => [file.package_relative_path, file]))

  for (const entrypoint of review.reviewed_entrypoints) {
    if (entrypoint.entrypoint !== '.'
      && (!entrypoint.entrypoint.startsWith('./') || !isSafeRelativePath(entrypoint.entrypoint.slice(2)))) return invalid()
    const export_ = exportsRecord[entrypoint.entrypoint]
    if (export_ === null || typeof export_ !== 'object' || Array.isArray(export_)) return invalid()
    const exportRecord = export_ as Record<string, unknown>
    const types = ownString(exportRecord, 'types')
    const runtime = ownString(exportRecord, 'default')
    if (types !== entrypoint.exported_types_path
      || runtime !== entrypoint.exported_runtime_path
      || !isSafeRelativePath(types, true)
      || !isSafeRelativePath(runtime, true)) return invalid()
    const typesPath = types.startsWith('./') ? types.slice(2) : types
    const runtimePath = runtime.startsWith('./') ? runtime.slice(2) : runtime
    const declaration = declarations.get(typesPath)
    if (declaration === undefined || declaration.sha256 !== entrypoint.exported_types_sha256
      || runtimeFiles.get(runtimePath) === undefined) return invalid()
  }
}

function validateAgentSdkReviewClosure(
  installationRoot: string,
  manifest: DependencyManifest,
  review: AgentSdkManifestReview,
): void {
  const packageKeys = review.reviewed_packages.map(({ package_name }) => package_name)
  const declarationKeys = review.reviewed_declarations
    .map(({ package_name, package_relative_path }) => `${package_name}:${package_relative_path}`)
  const runtimeKeys = review.reviewed_runtime_files
    .map(({ package_name, package_relative_path }) => `${package_name}:${package_relative_path}`)
  const trustedKeys = review.trusted_dependencies.map(({ packageName }) => packageName)
  if (!sortedUnique(packageKeys) || !sortedUnique(declarationKeys)
    || !sortedUnique(runtimeKeys) || !sortedUnique(trustedKeys)) return invalid()

  const installation = resolveReviewedPackages(installationRoot, review)
  const resolvedPackages = installation.packages
  const snapshots = new Map(snapshotReviewedPackageTrees(
    [...resolvedPackages].map(([packageName, package_]) => ({ packageName, packageRoot: package_.root })),
  ).map((snapshot) => [snapshot.packageName, snapshot]))
  for (const package_ of review.reviewed_packages) {
    const snapshot = snapshots.get(package_.package_name)
    if (snapshot === undefined
      || snapshot.packageTreeSha256 !== package_.package_tree_sha256
      || snapshot.packageFileCount !== package_.package_file_count
      || snapshot.packageTotalBytes !== package_.package_total_bytes) return invalid()
  }

  const usedPackages = new Set<string>()
  let totalBytes = 0
  for (const declaration of review.reviewed_declarations) {
    const package_ = resolvedPackages.get(declaration.package_name)
    if (package_ === undefined || declaration.package_version !== package_.identity.package_version
      || !isSafeRelativePath(declaration.package_relative_path)) return invalid()
    const path = assertNoSymlinkPath(package_.root, declaration.package_relative_path, 'file')
    assertInside(package_.root, path)
    validateNearestPackageBoundary(path, package_, installation)
    const bytes = readBoundedRegularFile(path, MAX_DECLARATION_BYTES)
    totalBytes += bytes.byteLength
    if (totalBytes > MAX_DECLARATION_TOTAL_BYTES || sha256(bytes) !== declaration.sha256) return invalid()
    usedPackages.add(declaration.package_name)
  }
  if (usedPackages.size !== resolvedPackages.size) return invalid()

  for (const runtimeFile of review.reviewed_runtime_files) {
    const package_ = resolvedPackages.get(runtimeFile.package_name)
    if (package_ === undefined || runtimeFile.package_version !== package_.identity.package_version
      || !isSafeRelativePath(runtimeFile.package_relative_path)) return invalid()
    const path = assertNoSymlinkPath(package_.root, runtimeFile.package_relative_path, 'file')
    assertInside(package_.root, path)
    validateNearestPackageBoundary(path, package_, installation)
    const bytes = readBoundedRegularFile(path, MAX_DECLARATION_BYTES)
    totalBytes += bytes.byteLength
    if (totalBytes > MAX_DECLARATION_TOTAL_BYTES || sha256(bytes) !== runtimeFile.sha256) return invalid()
  }

  const reviewedByName = new Map(review.reviewed_packages.map((package_) => [package_.package_name, package_]))
  for (const dependency of review.trusted_dependencies) {
    const reviewed = reviewedByName.get(dependency.packageName)
    if (reviewed === undefined || reviewed.package_version !== dependency.packageVersion
      || reviewed.package_integrity !== dependency.packageIntegrity) return invalid()
  }
  const agentSdk = reviewedByName.get('@trustless-ai/agent-sdk')
  if (agentSdk === undefined || agentSdk.package_version !== review.source.version
    || agentSdk.package_integrity !== review.source.package_integrity) return invalid()
  const resolvedAgentSdk = resolvedPackages.get('@trustless-ai/agent-sdk')
  if (resolvedAgentSdk === undefined) return invalid()
  validateAgentSdkExports(resolvedAgentSdk, review)

  const entrypointKeys = review.reviewed_entrypoints.map(({ entrypoint }) => entrypoint)
  if (!sortedUnique(entrypointKeys) || !sameJson(entrypointKeys, review.source.entrypoints)) return invalid()
  const digest = sha256(canonicalJson({
    package: '@trustless-ai/agent-sdk',
    version: review.source.version,
    package_integrity: review.source.package_integrity,
    entrypoints: review.reviewed_entrypoints,
    trusted_dependencies: review.trusted_dependencies,
    reviewed_packages: review.reviewed_packages,
    reviewed_declarations: review.reviewed_declarations,
    reviewed_runtime_files: review.reviewed_runtime_files,
  }))
  if (digest !== review.source.entrypoint_digest || manifest.source.entrypoint_digest !== digest) return invalid()
}

function deepFreeze<T>(root: T): T {
  const stack: object[] = []
  if (root !== null && typeof root === 'object') stack.push(root)
  const visited = new Set<object>()
  while (stack.length > 0) {
    const value = stack.pop() as object
    if (visited.has(value)) continue
    visited.add(value)
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor !== undefined && 'value' in descriptor && descriptor.value !== null && typeof descriptor.value === 'object') {
        stack.push(descriptor.value as object)
      }
    }
    Object.freeze(value)
  }
  return root
}

function validateBundle(
  artifactRoot: string,
  installationRoot: string,
  artifacts: ViemManifestArtifactBytes,
): LoadedViemManifests {
  assertRootDirectory(artifactRoot)
  assertRootDirectory(installationRoot)
  validateArtifactDigests(artifacts)
  const publicManifest = parseDependencyManifest(parseCanonicalArtifact(artifacts['viem-public.v1.json']))
  const walletManifest = parseDependencyManifest(parseCanonicalArtifact(artifacts['viem-wallet.v1.json']))
  const review = reviewSchema.parse(parseCanonicalArtifact(artifacts['viem-report.v1.json']))
  const packageJson = readJsonRecord(assertNoSymlinkPath(artifactRoot, 'package.json', 'file'))
  if (ownString(packageJson, 'name') !== '@trustless-ai/tas') return invalid()
  const packageVersion = ownString(packageJson, 'version')
  validateManifestRelationships(publicManifest, walletManifest, review, packageVersion)
  validateReviewClosure(installationRoot, [publicManifest, walletManifest], review)
  return deepFreeze({ public: publicManifest, wallet: walletManifest, review })
}

function validateAgentSdkBundle(
  artifactRoot: string,
  installationRoot: string,
  artifacts: AgentSdkManifestArtifactBytes,
): LoadedAgentSdkManifest {
  assertRootDirectory(artifactRoot)
  assertRootDirectory(installationRoot)
  validateAgentSdkArtifactDigests(artifacts)
  const manifest = parseDependencyManifest(parseCanonicalArtifact(artifacts['agent-sdk.v1.json']))
  const review = agentSdkReviewSchema.parse(parseCanonicalArtifact(artifacts['agent-sdk-report.v1.json']))
  const packageJson = readJsonRecord(assertNoSymlinkPath(artifactRoot, 'package.json', 'file'))
  if (ownString(packageJson, 'name') !== '@trustless-ai/tas') return invalid()
  validateAgentSdkManifestRelationships(manifest, review, ownString(packageJson, 'version'))
  validateAgentSdkReviewClosure(installationRoot, manifest, review)
  return deepFreeze({ manifest, review })
}

function validateChatBundle(
  artifactRoot: string,
  installationRoot: string,
  artifacts: ChatManifestArtifactBytes,
): LoadedChatManifests {
  assertRootDirectory(artifactRoot)
  assertRootDirectory(installationRoot)
  validateChatArtifactDigests(artifacts)
  const telegramManifest = parseDependencyManifest(parseCanonicalArtifact(artifacts['telegram.v1.json']))
  const telegramReview = chatReviewSchema.parse(parseCanonicalArtifact(artifacts['telegram-report.v1.json']))
  const discordManifest = parseDependencyManifest(parseCanonicalArtifact(artifacts['discord.v1.json']))
  const discordReview = chatReviewSchema.parse(parseCanonicalArtifact(artifacts['discord-report.v1.json']))
  const packageJson = readJsonRecord(assertNoSymlinkPath(artifactRoot, 'package.json', 'file'))
  if (ownString(packageJson, 'name') !== '@trustless-ai/tas') return invalid()
  const version = ownString(packageJson, 'version')
  validateChatManifestRelationships('telegram', telegramManifest, telegramReview, version)
  validateChatManifestRelationships('discord', discordManifest, discordReview, version)
  validateChatInstalledSource(installationRoot, telegramReview.source)
  validateChatInstalledSource(installationRoot, discordReview.source)
  return deepFreeze({
    telegram: { manifest: telegramManifest, review: telegramReview },
    discord: { manifest: discordManifest, review: discordReview },
  })
}

function loadFixedArtifacts(artifactRoot: string): ViemManifestArtifactBytes {
  const manifestRoot = assertNoSymlinkPath(artifactRoot, 'manifests', 'directory')
  return Object.freeze(Object.fromEntries(artifactNames.map((name) => [
    name,
    readBoundedRegularFile(assertNoSymlinkPath(manifestRoot, name, 'file'), MAX_ARTIFACT_BYTES - 1),
  ])) as unknown as ViemManifestArtifactBytes)
}

function loadFixedAgentSdkArtifacts(artifactRoot: string): AgentSdkManifestArtifactBytes {
  const manifestRoot = assertNoSymlinkPath(artifactRoot, 'manifests', 'directory')
  return Object.freeze(Object.fromEntries(agentSdkArtifactNames.map((name) => [
    name,
    readBoundedRegularFile(assertNoSymlinkPath(manifestRoot, name, 'file'), MAX_ARTIFACT_BYTES - 1),
  ])) as unknown as AgentSdkManifestArtifactBytes)
}

function loadFixedChatArtifacts(artifactRoot: string): ChatManifestArtifactBytes {
  const manifestRoot = assertNoSymlinkPath(artifactRoot, 'manifests', 'directory')
  return Object.freeze(Object.fromEntries(chatArtifactNames.map((name) => [
    name,
    readBoundedRegularFile(assertNoSymlinkPath(manifestRoot, name, 'file'), MAX_ARTIFACT_BYTES - 1),
  ])) as unknown as ChatManifestArtifactBytes)
}

function guardedLoad<T>(load: () => T): T {
  try {
    return load()
  } catch {
    throw new TasManifestLoadError()
  }
}

/** Production entry: paths are fixed to the installed TAS package and cannot be configured. */
export function loadBundledViemManifests(): LoadedViemManifests {
  return guardedLoad(() => {
    const artifactRoot = resolve(import.meta.dirname, '../../..')
    return validateBundle(
      artifactRoot,
      findInstallationRoot(artifactRoot) ?? invalid(),
      loadFixedArtifacts(artifactRoot),
    )
  })
}

/** Validates the complete reviewed dependency closure before agent-sdk may be imported. */
export function loadBundledAgentSdkManifest(): LoadedAgentSdkManifest {
  return guardedLoad(() => {
    const artifactRoot = resolve(import.meta.dirname, '../../..')
    return validateAgentSdkBundle(
      artifactRoot,
      findInstallationRoot(artifactRoot) ?? invalid(),
      loadFixedAgentSdkArtifacts(artifactRoot),
    )
  })
}


/** Validates both reviewed Chat platform inventories before either Client implementation may be imported. */
export function loadBundledChatManifests(): LoadedChatManifests {
  return guardedLoad(() => {
    const artifactRoot = resolve(import.meta.dirname, '../../..')
    return validateChatBundle(
      artifactRoot,
      findInstallationRoot(artifactRoot) ?? invalid(),
      loadFixedChatArtifacts(artifactRoot),
    )
  })
}
