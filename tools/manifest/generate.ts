import { createHash } from 'node:crypto'
import {
  closeSync,
  constants as fileSystemConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { DependencyManifest, GeneratedToolEntry, OperationEffect } from '../../src/mcp/manifest/types.js'
import { parseDependencyManifest } from '../../src/mcp/manifest/types.js'
import { snapshotReviewedPackageTrees } from '../../src/mcp/manifest/packageTree.js'
import { analyzeAgentSdk } from './analyzeAgentSdk.js'
import { analyzeDiscord, type DiscordExcludedAction, type DiscordIncludedAction } from './analyzeDiscord.js'
import { analyzeTelegram, type TelegramExcludedAction, type TelegramIncludedAction } from './analyzeTelegram.js'
import {
  analyzeViemActions,
  packageNameFromLockKey,
  resolveLockedPackage,
  type ExcludedAction,
  type IncludedAction,
  type ReviewedPackageMetadata,
  type TrustedDependencyMetadata,
  type ViemSourceProfile,
} from './analyzeViem.js'
import { canonicalJson } from './canonicalJson.js'
import { projectViemActionSchemas, type ActionSchemaProjection } from './schemaEncoder.js'

export const viemManifestFileNames = [
  'viem-public.v1.json',
  'viem-wallet.v1.json',
  'viem-report.v1.json',
] as const

export type ViemManifestFileName = typeof viemManifestFileNames[number]
export type ViemManifestArtifacts = Readonly<Record<ViemManifestFileName, string>>

export const agentSdkManifestFileNames = [
  'agent-sdk.v1.json',
  'agent-sdk-report.v1.json',
] as const

export const chatManifestFileNames = [
  'telegram.v1.json',
  'telegram-report.v1.json',
  'discord.v1.json',
  'discord-report.v1.json',
] as const

export const allManifestFileNames = [...viemManifestFileNames, ...agentSdkManifestFileNames, ...chatManifestFileNames] as const

export type AgentSdkManifestFileName = typeof agentSdkManifestFileNames[number]
export type AgentSdkManifestArtifacts = Readonly<Record<AgentSdkManifestFileName, string>>
export type ChatManifestFileName = typeof chatManifestFileNames[number]
export type ChatManifestArtifacts = Readonly<Record<ChatManifestFileName, string>>

export const viemArtifactDigestSourceRelativePath = 'src/mcp/manifest/generatedViemArtifactDigests.ts' as const
export const agentSdkArtifactDigestSourceRelativePath = 'src/mcp/manifest/generatedAgentSdkArtifactDigests.ts' as const
export const chatArtifactDigestSourceRelativePath = 'src/mcp/manifest/generatedChatArtifactDigests.ts' as const
export type ViemGeneratedOutputName = ViemManifestFileName | typeof viemArtifactDigestSourceRelativePath
export type GeneratedOutputName = ViemGeneratedOutputName
  | AgentSdkManifestFileName
  | ChatManifestFileName
  | typeof agentSdkArtifactDigestSourceRelativePath
  | typeof chatArtifactDigestSourceRelativePath

interface GeneratorInput {
  readonly cwd?: string
}

interface ArtifactDirectoryInput extends GeneratorInput {
  readonly outputDirectory: string
}

interface WriteArtifactsInput extends ArtifactDirectoryInput {
  /** Conformance-only fault injection. This option is not accepted by the generator CLI. */
  readonly testOnlyFailPublicationAfter?: number
  readonly testOnlyFailRestorationFor?: GeneratedOutputName
}

interface ViemGeneratedOutputsInput extends WriteArtifactsInput {
  readonly artifactDigestSourcePath: string
}

interface GeneratedOutputsInput extends ViemGeneratedOutputsInput {
  readonly agentSdkArtifactDigestSourcePath: string
  readonly chatArtifactDigestSourcePath: string
}

interface SourceDigest {
  readonly entrypoint: '.'
  readonly exported_types_path: string
  readonly exported_types_sha256: `sha256:${string}`
}

export interface AgentSdkSourceDigest {
  readonly entrypoint: string
  readonly exported_types_path: string
  readonly exported_runtime_path: string
  readonly exported_types_sha256: `sha256:${string}`
}

export interface ReviewedDeclarationDigestEntry {
  readonly package_name: string
  readonly package_version: string
  readonly package_relative_path: string
  readonly sha256: `sha256:${string}`
}

export interface ReviewedPackageDigestEntry {
  readonly package_name: string
  readonly package_version: string
  readonly package_integrity: string
  readonly package_tree_sha256: `sha256:${string}`
  readonly package_file_count: number
  readonly package_total_bytes: number
}

export interface ReviewedRuntimeFileDigestEntry {
  readonly package_name: string
  readonly package_version: string
  readonly package_relative_path: string
  readonly sha256: `sha256:${string}`
}

export interface ViemEntrypointDigestInput {
  readonly packageVersion: string
  readonly packageIntegrity: string
  readonly reviewedEntrypoints: readonly SourceDigest[]
  readonly trustedDependencies: readonly TrustedDependencyMetadata[]
  readonly reviewedPackages: readonly ReviewedPackageDigestEntry[]
  readonly reviewedDeclarations: readonly ReviewedDeclarationDigestEntry[]
}

interface GenerationSource {
  readonly package: 'viem'
  readonly version: string
  readonly package_integrity: string
  readonly entrypoint_digest: `sha256:${string}`
  readonly entrypoints: readonly ['.']
}

interface AgentSdkGenerationSource {
  readonly package: '@trustless-ai/agent-sdk'
  readonly version: string
  readonly package_integrity: string
  readonly entrypoint_digest: `sha256:${string}`
  readonly entrypoints: readonly string[]
}

interface IncludedReportEntry {
  readonly source_profile: ViemSourceProfile
  readonly source_name: string
  readonly result: 'included'
  readonly tool_name: string
  readonly operation: GeneratedToolEntry['operation']
}

interface ExcludedReportEntry {
  readonly source_profile: ViemSourceProfile
  readonly source_name: string
  readonly result: 'excluded'
  readonly reason_code: ExcludedAction['reasonCode']
  readonly reason: string
}

const generatorName = '@trustless-ai/tas-manifest' as const
const typescriptVersion = '7.0.2' as const
const manifestCanonicalNodeBudget = 100_000

function sha256(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export function computeViemEntrypointDigest(input: ViemEntrypointDigestInput): `sha256:${string}` {
  return sha256(canonicalJson({
    package: 'viem',
    version: input.packageVersion,
    package_integrity: input.packageIntegrity,
    entrypoints: input.reviewedEntrypoints,
    trusted_dependencies: input.trustedDependencies,
    reviewed_packages: input.reviewedPackages,
    reviewed_declarations: input.reviewedDeclarations,
  }, { maxExpandedNodes: manifestCanonicalNodeBudget }))
}

export interface AgentSdkEntrypointDigestInput {
  readonly packageVersion: string
  readonly packageIntegrity: string
  readonly reviewedEntrypoints: readonly AgentSdkSourceDigest[]
  readonly trustedDependencies: readonly TrustedDependencyMetadata[]
  readonly reviewedPackages: readonly ReviewedPackageDigestEntry[]
  readonly reviewedDeclarations: readonly ReviewedDeclarationDigestEntry[]
  readonly reviewedRuntimeFiles: readonly ReviewedRuntimeFileDigestEntry[]
}

export function computeAgentSdkEntrypointDigest(input: AgentSdkEntrypointDigestInput): `sha256:${string}` {
  return sha256(canonicalJson({
    package: '@trustless-ai/agent-sdk',
    version: input.packageVersion,
    package_integrity: input.packageIntegrity,
    entrypoints: input.reviewedEntrypoints,
    trusted_dependencies: input.trustedDependencies,
    reviewed_packages: input.reviewedPackages,
    reviewed_declarations: input.reviewedDeclarations,
    reviewed_runtime_files: input.reviewedRuntimeFiles,
  }, { maxExpandedNodes: manifestCanonicalNodeBudget }))
}

function readJsonRecord(path: string, label: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function requiredString(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label}.${field} must be a non-empty string`)
  return value
}

function resolveReviewedPackageRoots(
  cwd: string,
  reviewedPackages: readonly ReviewedPackageMetadata[],
): readonly { readonly packageName: string; readonly packageRoot: string }[] {
  const lockPath = join(cwd, 'package-lock.json')
  const lock = readJsonRecord(lockPath, 'package-lock.json')
  if (lock.lockfileVersion !== 3) throw new Error('package-lock.json must use lockfileVersion 3')
  const packages = lock.packages
  if (packages === null || typeof packages !== 'object' || Array.isArray(packages)) {
    throw new Error('package-lock.json packages must be an object')
  }
  const packageEntries = packages as Record<string, unknown>
  const keysByName = new Map<string, string[]>()
  for (const packageKey of Object.keys(packageEntries)) {
    const segments = packageKey.split('/')
    if (!segments.includes('node_modules')) continue
    const packageName = packageNameFromLockKey(packageKey)
    const keys = keysByName.get(packageName) ?? []
    keys.push(packageKey)
    keysByName.set(packageName, keys)
  }

  return reviewedPackages.map((reviewed) => {
    const matchingKeys = (keysByName.get(reviewed.packageName) ?? []).filter((packageKey) => {
      const entry = readJsonRecordFromValue(
        packageEntries[packageKey],
        `package-lock.json packages[${JSON.stringify(packageKey)}]`,
      )
      return entry.version === reviewed.packageVersion && entry.integrity === reviewed.packageIntegrity
    })
    if (matchingKeys.length !== 1) {
      throw new Error(`reviewed package ${reviewed.packageName} must resolve to one exact installed lock entry`)
    }
    const packageKey = matchingKeys[0] as string
    const resolved = resolveLockedPackage(
      reviewed.packageName,
      join(cwd, packageKey, 'package.json'),
      cwd,
      packageEntries,
    )
    if (resolved.packageVersion !== reviewed.packageVersion
      || resolved.packageIntegrity !== reviewed.packageIntegrity) {
      throw new Error(`reviewed package ${reviewed.packageName} identity changed before tree hashing`)
    }
    return { packageName: reviewed.packageName, packageRoot: resolved.packageRoot }
  })
}

function readJsonRecordFromValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

function reviewedPackageDigests(
  cwd: string,
  reviewedPackages: readonly ReviewedPackageMetadata[],
): readonly ReviewedPackageDigestEntry[] {
  const roots = resolveReviewedPackageRoots(cwd, reviewedPackages)
  const snapshots = new Map(snapshotReviewedPackageTrees(roots).map((snapshot) => [snapshot.packageName, snapshot]))
  return reviewedPackages.map((package_) => {
    const snapshot = snapshots.get(package_.packageName)
    if (snapshot === undefined) throw new Error(`reviewed package tree is missing: ${package_.packageName}`)
    return {
      package_name: package_.packageName,
      package_version: package_.packageVersion,
      package_integrity: package_.packageIntegrity,
      package_tree_sha256: snapshot.packageTreeSha256,
      package_file_count: snapshot.packageFileCount,
      package_total_bytes: snapshot.packageTotalBytes,
    }
  })
}

function reviewedRuntimeFileDigests(
  cwd: string,
  runtimeFiles: readonly {
    readonly packageName: string
    readonly packageVersion: string
    readonly packageRelativePath: string
    readonly sha256: `sha256:${string}`
  }[],
  reviewedPackages: readonly ReviewedPackageMetadata[],
): readonly ReviewedRuntimeFileDigestEntry[] {
  const roots = new Map(resolveReviewedPackageRoots(cwd, reviewedPackages)
    .map(({ packageName, packageRoot }) => [packageName, packageRoot]))
  const versions = new Map(reviewedPackages.map(({ packageName, packageVersion }) => [packageName, packageVersion]))
  const results = runtimeFiles.map((runtimeFile): ReviewedRuntimeFileDigestEntry => {
    const packageRoot = roots.get(runtimeFile.packageName)
    if (packageRoot === undefined || versions.get(runtimeFile.packageName) !== runtimeFile.packageVersion) {
      throw new Error(`reviewed runtime file package identity changed: ${runtimeFile.packageName}`)
    }
    const segments = runtimeFile.packageRelativePath.split('/')
    if (runtimeFile.packageRelativePath === '' || runtimeFile.packageRelativePath.includes('\\')
      || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new Error(`reviewed runtime file has an unsafe package-relative path: ${runtimeFile.packageRelativePath}`)
    }
    const absolutePath = resolve(packageRoot, ...segments)
    const packageRelative = relative(packageRoot, absolutePath)
    if (packageRelative === '' || packageRelative === '..' || packageRelative.startsWith(`..${sep}`)) {
      throw new Error(`reviewed runtime file escapes its package: ${runtimeFile.packageRelativePath}`)
    }
    const status = lstatSync(absolutePath)
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new Error(`reviewed runtime file must remain a regular non-symlink file: ${runtimeFile.packageRelativePath}`)
    }
    if (status.size > 4 * 1_024 * 1_024) {
      throw new Error(`reviewed runtime file exceeds the package snapshot file limit: ${runtimeFile.packageRelativePath}`)
    }
    const bytes = readExactRegularFile(absolutePath, status.size)
    if (bytes.byteLength !== status.size || sha256(bytes) !== runtimeFile.sha256) {
      throw new Error(`reviewed runtime file changed after package-tree snapshot: ${runtimeFile.packageRelativePath}`)
    }
    return {
      package_name: runtimeFile.packageName,
      package_version: runtimeFile.packageVersion,
      package_relative_path: runtimeFile.packageRelativePath,
      sha256: runtimeFile.sha256,
    }
  }).toSorted((left, right) => {
    const leftKey = `${left.package_name}:${left.package_relative_path}`
    const rightKey = `${right.package_name}:${right.package_relative_path}`
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
  const keys = results.map(({ package_name, package_relative_path }) => `${package_name}:${package_relative_path}`)
  if (keys.length === 0 || new Set(keys).size !== keys.length) {
    throw new Error('reviewed runtime file closure is empty or duplicated')
  }
  return results
}

function generatorVersion(cwd: string): string {
  const packageJson = readJsonRecord(join(cwd, 'package.json'), 'TAS package.json')
  return requiredString(packageJson, 'version', 'TAS package.json')
}

function resolveSourceDigest(
  cwd: string,
  packageVersion: string,
  packageIntegrity: string,
  trustedDependencies: readonly TrustedDependencyMetadata[],
  reviewedDeclarations: readonly ReviewedDeclarationDigestEntry[],
  reviewedPackages: readonly ReviewedPackageDigestEntry[],
): {
  readonly source: GenerationSource
  readonly reviewedEntrypoints: readonly SourceDigest[]
  readonly reviewedDeclarations: readonly ReviewedDeclarationDigestEntry[]
} {
  const require = createRequire(join(cwd, 'package.json'))
  const packageJsonPath = require.resolve('viem/package.json')
  const packageRoot = dirname(packageJsonPath)
  const packageJson = readJsonRecord(packageJsonPath, 'viem package.json')
  if (requiredString(packageJson, 'version', 'viem package.json') !== packageVersion) {
    throw new Error('analyzer viem version does not match the resolved package')
  }
  const exportsValue = packageJson.exports
  if (exportsValue === null || typeof exportsValue !== 'object' || Array.isArray(exportsValue)) {
    throw new Error('viem package.json exports must be an object')
  }
  const rootExport = (exportsValue as Record<string, unknown>)['.']
  if (rootExport === null || typeof rootExport !== 'object' || Array.isArray(rootExport)) {
    throw new Error('viem package.json root export must be an object')
  }
  const exportedTypesPath = requiredString(rootExport as Record<string, unknown>, 'types', 'viem root export')
  const absoluteTypesPath = resolve(packageRoot, exportedTypesPath)
  const packageRelative = relative(packageRoot, absoluteTypesPath)
  if (packageRelative.startsWith(`..${sep}`) || packageRelative === '..' || !existsSync(absoluteTypesPath)) {
    throw new Error('viem exported types path must resolve inside the installed package')
  }
  const reviewedEntrypoints: readonly SourceDigest[] = [{
    entrypoint: '.',
    exported_types_path: exportedTypesPath.split(sep).join('/'),
    exported_types_sha256: sha256(readFileSync(absoluteTypesPath)),
  }]
  const entrypointDigest = computeViemEntrypointDigest({
    packageVersion,
    packageIntegrity,
    reviewedEntrypoints,
    trustedDependencies,
    reviewedPackages,
    reviewedDeclarations,
  })
  return {
    source: {
      package: 'viem',
      version: packageVersion,
      package_integrity: packageIntegrity,
      entrypoint_digest: entrypointDigest,
      entrypoints: ['.'],
    },
    reviewedEntrypoints,
    reviewedDeclarations,
  }
}

function resolveAgentSdkPackageRoot(cwd: string): string {
  const require = createRequire(join(cwd, 'package.json'))
  let current = dirname(require.resolve('@trustless-ai/agent-sdk'))
  while (true) {
    const packageJsonPath = join(current, 'package.json')
    if (existsSync(packageJsonPath)) {
      const packageJson = readJsonRecord(packageJsonPath, 'agent-sdk package.json')
      if (packageJson.name === '@trustless-ai/agent-sdk') return current
    }
    const parent = dirname(current)
    if (parent === current) throw new Error('installed @trustless-ai/agent-sdk package root was not found')
    current = parent
  }
}

interface ReviewedAgentSdkEntrypointInput {
  readonly entrypoint: string
  readonly typesPackageRelativePath: string
  readonly runtimePackageRelativePath: string
}

export interface ReviewAgentSdkEntrypointsInput {
  readonly packageRoot: string
  readonly reviewedEntrypoints: readonly ReviewedAgentSdkEntrypointInput[]
  readonly reviewedRuntimeFiles: readonly ReviewedRuntimeFileDigestEntry[]
}

function normalizedPackageExportPath(value: string, label: string): string {
  if (!value.startsWith('./') || value.includes('\\')) {
    throw new Error(`${label} must be a normalized package-relative path`)
  }
  const segments = value.slice(2).split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${label} must be a normalized package-relative path`)
  }
  return segments.join('/')
}

export function reviewAgentSdkEntrypoints(input: ReviewAgentSdkEntrypointsInput): readonly AgentSdkSourceDigest[] {
  const packageRoot = resolve(input.packageRoot)
  const packageJson = readJsonRecord(join(packageRoot, 'package.json'), 'agent-sdk package.json')
  const exportsValue = readJsonRecordFromValue(packageJson.exports, 'agent-sdk package.json exports')
  const publicEntrypoints = Object.keys(exportsValue).toSorted()
  const analyzerEntrypoints = input.reviewedEntrypoints.map(({ entrypoint }) => entrypoint).toSorted()
  if (publicEntrypoints.length !== analyzerEntrypoints.length
    || publicEntrypoints.some((entrypoint, index) => entrypoint !== analyzerEntrypoints[index])) {
    throw new Error('analyzer agent-sdk entrypoints do not match the installed exports map')
  }
  const reviewedRuntimePaths = new Set(input.reviewedRuntimeFiles
    .filter(({ package_name }) => package_name === '@trustless-ai/agent-sdk')
    .map(({ package_relative_path }) => package_relative_path))

  return input.reviewedEntrypoints.map((reviewed): AgentSdkSourceDigest => {
    const export_ = readJsonRecordFromValue(
      exportsValue[reviewed.entrypoint],
      `agent-sdk package.json exports[${JSON.stringify(reviewed.entrypoint)}]`,
    )
    const exportedTypesPath = requiredString(export_, 'types', `agent-sdk export ${reviewed.entrypoint}`)
    const exportedRuntimePath = requiredString(export_, 'default', `agent-sdk export ${reviewed.entrypoint}`)
    const typesPackageRelativePath = normalizedPackageExportPath(
      exportedTypesPath,
      `agent-sdk types export ${reviewed.entrypoint}`,
    )
    const runtimePackageRelativePath = normalizedPackageExportPath(
      exportedRuntimePath,
      `agent-sdk runtime export ${reviewed.entrypoint}`,
    )
    if (typesPackageRelativePath !== reviewed.typesPackageRelativePath) {
      throw new Error(`agent-sdk types export no longer matches analyzer metadata: ${reviewed.entrypoint}`)
    }
    if (runtimePackageRelativePath !== reviewed.runtimePackageRelativePath) {
      throw new Error(`agent-sdk runtime export no longer matches analyzer metadata: ${reviewed.entrypoint}`)
    }
    if (!reviewedRuntimePaths.has(runtimePackageRelativePath)) {
      throw new Error(`agent-sdk runtime export is absent from reviewed runtime files: ${reviewed.entrypoint}`)
    }
    const absoluteTypesPath = resolve(packageRoot, ...typesPackageRelativePath.split('/'))
    const packageRelative = relative(packageRoot, absoluteTypesPath)
    if (packageRelative === '' || packageRelative === '..' || packageRelative.startsWith(`..${sep}`)) {
      throw new Error(`agent-sdk exported types path escapes the installed package: ${reviewed.entrypoint}`)
    }
    const status = lstatSync(absoluteTypesPath)
    if (status.isSymbolicLink() || !status.isFile() || status.size > 4 * 1_024 * 1_024) {
      throw new Error(`agent-sdk exported types path must remain a bounded regular non-symlink file: ${reviewed.entrypoint}`)
    }
    const bytes = readExactRegularFile(absoluteTypesPath, status.size)
    if (bytes.byteLength !== status.size) {
      throw new Error(`agent-sdk exported types changed while being read: ${reviewed.entrypoint}`)
    }
    return {
      entrypoint: reviewed.entrypoint,
      exported_types_path: exportedTypesPath,
      exported_runtime_path: exportedRuntimePath,
      exported_types_sha256: sha256(bytes),
    }
  })
}

function resolveAgentSdkSourceDigest(
  cwd: string,
  packageVersion: string,
  packageIntegrity: string,
  analyzedEntrypoints: readonly string[],
  reviewedEntrypointMetadata: readonly ReviewedAgentSdkEntrypointInput[],
  trustedDependencies: readonly TrustedDependencyMetadata[],
  reviewedDeclarations: readonly ReviewedDeclarationDigestEntry[],
  reviewedPackages: readonly ReviewedPackageDigestEntry[],
  reviewedRuntimeFiles: readonly ReviewedRuntimeFileDigestEntry[],
): {
  readonly source: AgentSdkGenerationSource
  readonly reviewedEntrypoints: readonly AgentSdkSourceDigest[]
} {
  const packageRoot = resolveAgentSdkPackageRoot(cwd)
  const packageJson = readJsonRecord(join(packageRoot, 'package.json'), 'agent-sdk package.json')
  if (requiredString(packageJson, 'version', 'agent-sdk package.json') !== packageVersion) {
    throw new Error('analyzer agent-sdk version does not match the resolved package')
  }
  const metadataEntrypoints = reviewedEntrypointMetadata.map(({ entrypoint }) => entrypoint).toSorted()
  if (analyzedEntrypoints.length !== metadataEntrypoints.length
    || analyzedEntrypoints.some((entrypoint, index) => entrypoint !== metadataEntrypoints[index])) {
    throw new Error('agent-sdk analyzer entrypoint lists are inconsistent')
  }
  const reviewedEntrypoints = reviewAgentSdkEntrypoints({
    packageRoot,
    reviewedEntrypoints: reviewedEntrypointMetadata,
    reviewedRuntimeFiles,
  })
  return {
    source: {
      package: '@trustless-ai/agent-sdk',
      version: packageVersion,
      package_integrity: packageIntegrity,
      entrypoint_digest: computeAgentSdkEntrypointDigest({
        packageVersion,
        packageIntegrity,
        reviewedEntrypoints,
        trustedDependencies,
        reviewedPackages,
        reviewedDeclarations,
        reviewedRuntimeFiles,
      }),
      entrypoints: analyzedEntrypoints,
    },
    reviewedEntrypoints,
  }
}

function operationEffect(action: IncludedAction<ActionSchemaProjection>): OperationEffect {
  if (action.sourceProfile === 'viem-wallet') return 'side_effect'
  return action.completion === 'external_handle' ? 'side_effect' : 'read'
}

function description(action: IncludedAction<ActionSchemaProjection>, effect: OperationEffect): string {
  const target = `${action.sourceProfile === 'viem-public' ? 'PublicActions' : 'WalletActions'}.${action.sourceName}`
  if (action.sourceProfile === 'viem-wallet') {
    return action.completion === 'external_handle'
      ? `Invoke viem ${target} with one inline credential; it may modify chain state or incur cost, and the Agent must track the returned handle.`
      : `Invoke viem ${target} with one inline credential; it may modify chain state or incur cost.`
  }
  return effect === 'read'
    ? `Read open Chain state with viem ${target}.`
    : `Submit an open Chain operation with viem ${target}; the Agent must track the returned handle.`
}

function toolEntry(action: IncludedAction<ActionSchemaProjection>): GeneratedToolEntry {
  const effect = operationEffect(action)
  const sourceExport = action.sourceProfile === 'viem-public' ? 'PublicActions' : 'WalletActions'
  return {
    name: action.toolName,
    description: description(action, effect),
    source: { entrypoint: '.', export: sourceExport, member: action.sourceName },
    binding: { kind: 'client_action', target: `${sourceExport}.${action.sourceName}` },
    input_schema: action.sourceProfile === 'viem-wallet'
      ? withCredentialSecretLimit(action.projection.input_schema)
      : action.projection.input_schema,
    output_schema: action.projection.output_schema,
    operation: { effect, completion: action.completion },
    runtime_dependencies: action.sourceProfile === 'viem-public'
      ? ['chain_client']
      : ['chain_client', 'account'],
    credential: action.sourceProfile === 'viem-public' ? 'none' : 'evm_private_key',
    annotations: {
      readOnlyHint: effect === 'read',
      destructiveHint: effect === 'side_effect',
      idempotentHint: effect === 'read',
      openWorldHint: true,
    },
  }
}

function manifest(
  profile: ViemSourceProfile,
  source: GenerationSource,
  version: string,
  included: readonly IncludedAction<ActionSchemaProjection>[],
): DependencyManifest {
  const tools = included.filter(({ sourceProfile }) => sourceProfile === profile)
    .map(toolEntry)
    .toSorted((left, right) => left.name.localeCompare(right.name))
  const value: DependencyManifest = {
    schema_version: 'tas-manifest/v1',
    manifest_id: profile,
    kind: 'dependency',
    source_profile: profile,
    source,
    generator: { name: generatorName, version, typescript_version: typescriptVersion },
    tools,
  }
  parseDependencyManifest(value)
  return value
}

function reportEntry(action: IncludedAction<ActionSchemaProjection> | ExcludedAction): IncludedReportEntry | ExcludedReportEntry {
  if ('toolName' in action) {
    return {
      source_profile: action.sourceProfile,
      source_name: action.sourceName,
      result: 'included',
      tool_name: action.toolName,
      operation: { effect: operationEffect(action), completion: action.completion },
    }
  }
  return {
    source_profile: action.sourceProfile,
    source_name: action.sourceName,
    result: 'excluded',
    reason_code: action.reasonCode,
    reason: action.reason,
  }
}

export function generateViemManifestArtifacts(input: GeneratorInput = {}): ViemManifestArtifacts {
  const cwd = resolve(input.cwd ?? process.cwd())
  const analysis = analyzeViemActions<ActionSchemaProjection>({ cwd, project: projectViemActionSchemas })
  const version = generatorVersion(cwd)
  const reviewedDeclarations = analysis.reviewedDeclarations.map((declaration) => ({
    package_name: declaration.packageName,
    package_version: declaration.packageVersion,
    package_relative_path: declaration.packageRelativePath,
    sha256: declaration.sha256,
  }))
  const reviewedPackages = reviewedPackageDigests(cwd, analysis.reviewedPackages)
  const { source, reviewedEntrypoints } = resolveSourceDigest(
    cwd,
    analysis.packageVersion,
    analysis.packageIntegrity,
    analysis.trustedDependencies,
    reviewedDeclarations,
    reviewedPackages,
  )
  const publicManifest = manifest('viem-public', source, version, analysis.included)
  const walletManifest = manifest('viem-wallet', source, version, analysis.included)
  const entries = [...analysis.included, ...analysis.excluded]
    .map(reportEntry)
    .toSorted((left, right) => `${left.source_profile}:${left.source_name}`.localeCompare(`${right.source_profile}:${right.source_name}`))
  const classified = new Set(entries.map(({ source_profile, source_name }) => `${source_profile}:${source_name}`))
  if (classified.size !== entries.length || entries.filter(({ result }) => result === 'included').length
    !== publicManifest.tools.length + walletManifest.tools.length) {
    throw new Error('viem generation accounting is incomplete or duplicated')
  }
  const report = {
    schema_version: 'tas-manifest-report/v1',
    source,
    reviewed_entrypoints: reviewedEntrypoints,
    reviewed_declarations: reviewedDeclarations,
    trusted_dependencies: analysis.trustedDependencies,
    reviewed_packages: reviewedPackages,
    generator: { name: generatorName, version, typescript_version: typescriptVersion },
    entries,
    provider_adapter_claims: [],
    failures: [],
  }
  return {
    'viem-public.v1.json': canonicalJson(publicManifest, { maxExpandedNodes: manifestCanonicalNodeBudget }),
    'viem-wallet.v1.json': canonicalJson(walletManifest, { maxExpandedNodes: manifestCanonicalNodeBudget }),
    'viem-report.v1.json': canonicalJson(report, { maxExpandedNodes: manifestCanonicalNodeBudget }),
  }
}

type AgentSdkIncluded = ReturnType<typeof analyzeAgentSdk>['included'][number]
type AgentSdkExcluded = ReturnType<typeof analyzeAgentSdk>['excluded'][number]

function withCredentialSecretLimit(inputSchema: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const properties = inputSchema.properties
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new Error('credential-bearing input schema must expose an object properties map')
  }
  const credential = (properties as Record<string, unknown>).credential
  if (credential === null || typeof credential !== 'object' || Array.isArray(credential)) {
    throw new Error('credential-bearing input schema must expose the common credential object')
  }
  const credentialProperties = (credential as Record<string, unknown>).properties
  if (credentialProperties === null || typeof credentialProperties !== 'object' || Array.isArray(credentialProperties)) {
    throw new Error('common credential schema must expose an object properties map')
  }
  const secret = (credentialProperties as Record<string, unknown>).secret
  if (secret === null || typeof secret !== 'object' || Array.isArray(secret)) {
    throw new Error('common credential schema must expose a secret string')
  }
  return {
    ...inputSchema,
    properties: {
      ...properties,
      credential: {
        ...credential,
        properties: {
          ...credentialProperties,
          secret: { ...secret, maxLength: 4_096 },
        },
      },
    },
  }
}

function withInlineCredential(inputSchema: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const properties = inputSchema.properties
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new Error('agent-sdk side-effect input schema must expose an object properties map')
  }
  if (Object.hasOwn(properties, 'credential')) {
    throw new Error('agent-sdk source input credential conflicts with the TAS common credential')
  }
  const required = inputSchema.required
  if (required !== undefined && (!Array.isArray(required) || required.some((value) => typeof value !== 'string'))) {
    throw new Error('agent-sdk side-effect input schema has an invalid required array')
  }
  return withCredentialSecretLimit({
    ...inputSchema,
    properties: {
      ...properties,
      credential: {
        type: 'object',
        properties: {
          type: { const: 'inline' },
          secret: { type: 'string', minLength: 1, writeOnly: true },
        },
        required: ['secret', 'type'],
        additionalProperties: false,
      },
    },
  })
}

function agentSdkToolEntry(action: AgentSdkIncluded): GeneratedToolEntry {
  const member = action.member ?? action.exportName
  const target = action.bindingKind === 'class_method'
    ? `${action.exportName}.${member}`
    : action.exportName
  return {
    name: action.toolName,
    description: action.effect === 'read'
      ? `Invoke the read-only agent-sdk callable ${target}.`
      : `Invoke the agent-sdk callable ${target}; it may modify external state or incur cost.`,
    source: { entrypoint: action.entrypoint, export: action.exportName, member },
    binding: { kind: action.bindingKind, target, arguments: action.invocationArguments },
    input_schema: action.credential === 'evm_private_key'
      ? withInlineCredential(action.projection.input_schema)
      : action.projection.input_schema,
    output_schema: action.projection.output_schema,
    operation: { effect: action.effect, completion: action.completion },
    runtime_dependencies: action.runtimeDependencies,
    credential: action.credential,
    annotations: {
      readOnlyHint: action.effect === 'read',
      destructiveHint: action.effect === 'side_effect',
      idempotentHint: action.effect === 'read',
      openWorldHint: true,
    },
  }
}

function agentSdkReportEntry(action: AgentSdkIncluded | AgentSdkExcluded): Record<string, unknown> {
  const identity = {
    entrypoint: action.entrypoint,
    export_name: action.exportName,
    ...('member' in action && action.member !== undefined ? { member: action.member } : {}),
  }
  if ('toolName' in action) {
    return {
      ...identity,
      result: 'included',
      tool_name: action.toolName,
      operation: { effect: action.effect, completion: action.completion },
    }
  }
  return {
    ...identity,
    result: 'excluded',
    reason_code: action.reasonCode,
    reason: action.reason,
  }
}

export function generateAgentSdkManifestArtifacts(input: GeneratorInput = {}): AgentSdkManifestArtifacts {
  const cwd = resolve(input.cwd ?? process.cwd())
  const analysis = analyzeAgentSdk({ cwd })
  if (analysis.packageName !== '@trustless-ai/agent-sdk') {
    throw new Error('agent-sdk analyzer resolved an unexpected package')
  }
  const reviewedDeclarations = analysis.reviewedDeclarations.map((declaration) => ({
    package_name: declaration.packageName,
    package_version: declaration.packageVersion,
    package_relative_path: declaration.packageRelativePath,
    sha256: declaration.sha256,
  }))
  const reviewedPackages = reviewedPackageDigests(cwd, analysis.reviewedPackages)
  // Re-read every runtime file only after the complete package-tree snapshot.
  // A same-process mutation therefore fails generation before any artifact is published.
  const reviewedRuntimeFiles = reviewedRuntimeFileDigests(
    cwd,
    analysis.reviewedRuntimeFiles,
    analysis.reviewedPackages,
  )
  const { source, reviewedEntrypoints } = resolveAgentSdkSourceDigest(
    cwd,
    analysis.packageVersion,
    analysis.packageIntegrity,
    analysis.entrypoints,
    analysis.reviewedEntrypoints,
    analysis.trustedDependencies,
    reviewedDeclarations,
    reviewedPackages,
    reviewedRuntimeFiles,
  )
  const tools = analysis.included.map(agentSdkToolEntry)
    .toSorted((left, right) => left.name.localeCompare(right.name))
  const value: DependencyManifest = {
    schema_version: 'tas-manifest/v1',
    manifest_id: 'agent-sdk',
    kind: 'dependency',
    source_profile: 'agent-sdk',
    source,
    generator: { name: generatorName, version: generatorVersion(cwd), typescript_version: typescriptVersion },
    tools,
  }
  // Validate the exact generator value, but retain its normal Array prototypes for
  // canonical serialization. The parser deliberately returns hardened JSON Schema
  // projections whose arrays have null prototypes and are not a serialization input.
  parseDependencyManifest(value)
  const manifest = value
  const entries = [...analysis.included, ...analysis.excluded]
    .map(agentSdkReportEntry)
    .toSorted((left, right) => {
      const leftKey = `${String(left.entrypoint)}:${String(left.export_name)}:${String(left.member ?? '')}`
      const rightKey = `${String(right.entrypoint)}:${String(right.export_name)}:${String(right.member ?? '')}`
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    })
  const keys = entries.map((entry) => `${String(entry.entrypoint)}:${String(entry.export_name)}:${String(entry.member ?? '')}`)
  if (new Set(keys).size !== keys.length
    || entries.filter(({ result }) => result === 'included').length !== manifest.tools.length) {
    throw new Error('agent-sdk generation accounting is incomplete or duplicated')
  }
  const report = {
    schema_version: 'tas-manifest-report/v1',
    source,
    reviewed_entrypoints: reviewedEntrypoints,
    reviewed_declarations: reviewedDeclarations,
    trusted_dependencies: analysis.trustedDependencies,
    reviewed_packages: reviewedPackages,
    reviewed_runtime_files: reviewedRuntimeFiles,
    generator: { name: generatorName, version: generatorVersion(cwd), typescript_version: typescriptVersion },
    entries,
    provider_adapter_claims: [],
    failures: [],
  }
  return {
    'agent-sdk.v1.json': canonicalJson(manifest, { maxExpandedNodes: manifestCanonicalNodeBudget }),
    'agent-sdk-report.v1.json': canonicalJson(report, { maxExpandedNodes: manifestCanonicalNodeBudget }),
  }
}

type ChatIncluded = TelegramIncludedAction | DiscordIncludedAction
type ChatExcluded = TelegramExcludedAction | DiscordExcludedAction
type ChatProfile = 'telegram' | 'discord'

interface ChatManifestSource {
  readonly package: 'grammy' | 'discord.js'
  readonly version: string
  readonly package_integrity: string
  readonly entrypoint_digest: `sha256:${string}`
  readonly entrypoints: readonly ['.']
}

function chatSource(
  package_: 'grammy' | 'discord.js',
  packageVersion: string,
  packageIntegrity: string,
  entrypoint: string,
  entrypointSha256: `sha256:${string}`,
): ChatManifestSource {
  return {
    package: package_,
    version: packageVersion,
    package_integrity: packageIntegrity,
    entrypoint_digest: sha256(canonicalJson({
      package: package_,
      version: packageVersion,
      package_integrity: packageIntegrity,
      entrypoints: [{ entrypoint: '.', exported_types_path: entrypoint, exported_types_sha256: entrypointSha256 }],
    }, { maxExpandedNodes: manifestCanonicalNodeBudget })),
    entrypoints: ['.'],
  }
}

function chatTool(profile: ChatProfile, action: ChatIncluded): Record<string, unknown> {
  const sourceExport = profile === 'telegram' ? 'Api' : 'MessageManager'
  return {
    name: action.toolName,
    description: `Invoke the configured ${profile} chat operation ${sourceExport}.${action.sourceName} with one inline credential.`,
    source: { entrypoint: '.', export: sourceExport, member: action.sourceName },
    binding: { kind: 'chat_operation', target: `${sourceExport}.${action.sourceName}` },
    input_schema: action.projection.input_schema,
    output_schema: action.projection.output_schema,
    operation: { effect: 'side_effect', completion: 'synchronous' },
    runtime_dependencies: action.runtimeDependencies,
    credential: action.credential,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  }
}

function chatReportEntry(profile: ChatProfile, action: ChatIncluded | ChatExcluded): Record<string, unknown> {
  if ('toolName' in action) {
    return {
      source_profile: profile,
      source_name: action.sourceName,
      result: 'included',
      tool_name: action.toolName,
      operation: { effect: 'side_effect', completion: 'synchronous' },
    }
  }
  return {
    source_profile: profile,
    source_name: action.sourceName,
    result: 'excluded',
    reason_code: action.reasonCode,
    reason: action.reason,
  }
}

function chatArtifacts(
  profile: ChatProfile,
  source: ChatManifestSource,
  included: readonly ChatIncluded[],
  excluded: readonly ChatExcluded[],
  version: string,
): readonly [string, string] {
  const tools = included.map((action) => chatTool(profile, action)).toSorted((left, right) =>
    String(left.name).localeCompare(String(right.name)))
  const entries = [...included, ...excluded].map((action) => chatReportEntry(profile, action))
    .toSorted((left, right) => String(left.source_name).localeCompare(String(right.source_name)))
  const classified = entries.map((entry) => String(entry.source_name))
  if (new Set(classified).size !== classified.length || tools.length === 0
    || entries.filter(({ result }) => result === 'included').length !== tools.length) {
    throw new Error(`${profile} chat generation accounting is incomplete, duplicated, or empty`)
  }
  const manifest = {
    schema_version: 'tas-manifest/v1',
    manifest_id: profile,
    kind: 'dependency',
    source_profile: profile,
    source,
    generator: { name: generatorName, version, typescript_version: typescriptVersion },
    tools,
  }
  const report = {
    schema_version: 'tas-manifest-report/v1',
    source,
    generator: { name: generatorName, version, typescript_version: typescriptVersion },
    entries,
    failures: [],
  }
  return [
    canonicalJson(manifest, { maxExpandedNodes: manifestCanonicalNodeBudget }),
    canonicalJson(report, { maxExpandedNodes: manifestCanonicalNodeBudget }),
  ]
}

export function generateChatManifestArtifacts(input: GeneratorInput = {}): ChatManifestArtifacts {
  const cwd = resolve(input.cwd ?? process.cwd())
  const telegram = analyzeTelegram({ cwd })
  const discord = analyzeDiscord({ cwd })
  const version = generatorVersion(cwd)
  const [telegramManifest, telegramReport] = chatArtifacts(
    'telegram',
    chatSource('grammy', telegram.packageVersion, telegram.packageIntegrity, telegram.entrypoint, telegram.entrypointSha256),
    telegram.included,
    telegram.excluded,
    version,
  )
  const [discordManifest, discordReport] = chatArtifacts(
    'discord',
    chatSource('discord.js', discord.packageVersion, discord.packageIntegrity, discord.entrypoint, discord.entrypointSha256),
    discord.included,
    discord.excluded,
    version,
  )
  return {
    'telegram.v1.json': telegramManifest,
    'telegram-report.v1.json': telegramReport,
    'discord.v1.json': discordManifest,
    'discord-report.v1.json': discordReport,
  }
}

export function generateViemArtifactDigestSource(artifacts: ViemManifestArtifacts): string {
  const entries = viemManifestFileNames.map((fileName) =>
    `  '${fileName}': '${sha256(Buffer.from(artifacts[fileName], 'utf8'))}',`).join('\n')
  return [
    '// Generated by tools/manifest/generate.ts. Do not edit.',
    'export const bundledViemArtifactDigests = Object.freeze({',
    entries,
    '} as const)',
    '',
  ].join('\n')
}

export function generateAgentSdkArtifactDigestSource(artifacts: AgentSdkManifestArtifacts): string {
  const entries = agentSdkManifestFileNames.map((fileName) =>
    `  '${fileName}': '${sha256(Buffer.from(artifacts[fileName], 'utf8'))}',`).join('\n')
  return [
    '// Generated by tools/manifest/generate.ts. Do not edit.',
    'export const bundledAgentSdkArtifactDigests = Object.freeze({',
    entries,
    '} as const)',
    '',
  ].join('\n')
}

export function generateChatArtifactDigestSource(artifacts: ChatManifestArtifacts): string {
  const entries = chatManifestFileNames.map((fileName) =>
    `  '${fileName}': '${sha256(Buffer.from(artifacts[fileName], 'utf8'))}',`).join('\n')
  return [
    '// Generated by tools/manifest/generate.ts. Do not edit.',
    'export const bundledChatArtifactDigests = Object.freeze({',
    entries,
    '} as const)',
    '',
  ].join('\n')
}

function removePublishedFile(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function statusIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function requireSafeOutputDirectory(outputDirectory: string, create: boolean): boolean {
  if (statusIfPresent(outputDirectory) === undefined) {
    if (!create) return false
    mkdirSync(outputDirectory, { recursive: true })
  }
  const status = lstatSync(outputDirectory)
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error('Manifest output directory must be a regular non-symlink directory')
  }
  return true
}

function requireSafeArtifactDestination(path: string): ReturnType<typeof lstatSync> | undefined {
  const status = statusIfPresent(path)
  if (status !== undefined && (status.isSymbolicLink() || !status.isFile())) {
    throw new Error(`Manifest artifact destination must be a regular non-symlink file or absent: ${basename(path)}`)
  }
  return status
}

function readExactRegularFile(path: string, expectedSize: number): Buffer {
  const descriptor = openSync(
    path,
    fileSystemConstants.O_RDONLY | fileSystemConstants.O_NOFOLLOW | fileSystemConstants.O_NONBLOCK,
  )
  try {
    const status = fstatSync(descriptor)
    if (!status.isFile() || status.size !== expectedSize) return Buffer.alloc(0)
    const bounded = Buffer.alloc(expectedSize + 1)
    let total = 0
    while (total < bounded.byteLength) {
      const read = readSync(descriptor, bounded, total, bounded.byteLength - total, null)
      if (read === 0) break
      total += read
    }
    return bounded.subarray(0, total)
  } finally {
    closeSync(descriptor)
  }
}

interface PublicationItem {
  readonly name: GeneratedOutputName
  readonly destination: string
  readonly transactionName: string
  readonly contents: string
}

function publicationItems(
  input: WriteArtifactsInput,
  artifacts: ViemManifestArtifacts,
  artifactDigestSourcePath?: string,
  agentSdkArtifacts?: AgentSdkManifestArtifacts,
  agentSdkArtifactDigestSourcePath?: string,
  chatArtifacts?: ChatManifestArtifacts,
  chatArtifactDigestSourcePath?: string,
): readonly PublicationItem[] {
  const outputDirectory = resolve(input.outputDirectory)
  requireSafeOutputDirectory(outputDirectory, true)
  const items: PublicationItem[] = viemManifestFileNames.map((fileName) => ({
    name: fileName,
    destination: join(outputDirectory, fileName),
    transactionName: fileName,
    contents: artifacts[fileName],
  }))
  if (agentSdkArtifacts !== undefined) {
    items.push(...agentSdkManifestFileNames.map((fileName) => ({
      name: fileName,
      destination: join(outputDirectory, fileName),
      transactionName: fileName,
      contents: agentSdkArtifacts[fileName],
    })))
  }
  if (chatArtifacts !== undefined) {
    items.push(...chatManifestFileNames.map((fileName) => ({
      name: fileName,
      destination: join(outputDirectory, fileName),
      transactionName: fileName,
      contents: chatArtifacts[fileName],
    })))
  }
  if (artifactDigestSourcePath !== undefined) {
    const destination = resolve(artifactDigestSourcePath)
    const parent = dirname(destination)
    if (!requireSafeOutputDirectory(parent, false)) {
      throw new Error('Manifest artifact-digest source parent directory must already exist')
    }
    if (lstatSync(parent).dev !== lstatSync(outputDirectory).dev) {
      throw new Error('Manifest publication destinations must share one filesystem')
    }
    items.push({
      name: viemArtifactDigestSourceRelativePath,
      destination,
      transactionName: basename(viemArtifactDigestSourceRelativePath),
      contents: generateViemArtifactDigestSource(artifacts),
    })
  }
  if (agentSdkArtifactDigestSourcePath !== undefined) {
    if (agentSdkArtifacts === undefined) {
      throw new Error('agent-sdk artifact-digest source requires agent-sdk artifacts')
    }
    const destination = resolve(agentSdkArtifactDigestSourcePath)
    const parent = dirname(destination)
    if (!requireSafeOutputDirectory(parent, false)) {
      throw new Error('Manifest artifact-digest source parent directory must already exist')
    }
    if (lstatSync(parent).dev !== lstatSync(outputDirectory).dev) {
      throw new Error('Manifest publication destinations must share one filesystem')
    }
    items.push({
      name: agentSdkArtifactDigestSourceRelativePath,
      destination,
      transactionName: basename(agentSdkArtifactDigestSourceRelativePath),
      contents: generateAgentSdkArtifactDigestSource(agentSdkArtifacts),
    })
  }
  if (chatArtifactDigestSourcePath !== undefined) {
    if (chatArtifacts === undefined) throw new Error('Chat artifact-digest source requires Chat artifacts')
    const destination = resolve(chatArtifactDigestSourcePath)
    const parent = dirname(destination)
    if (!requireSafeOutputDirectory(parent, false)) {
      throw new Error('Manifest artifact-digest source parent directory must already exist')
    }
    if (lstatSync(parent).dev !== lstatSync(outputDirectory).dev) {
      throw new Error('Manifest publication destinations must share one filesystem')
    }
    items.push({
      name: chatArtifactDigestSourceRelativePath,
      destination,
      transactionName: basename(chatArtifactDigestSourceRelativePath),
      contents: generateChatArtifactDigestSource(chatArtifacts),
    })
  }
  if (new Set(items.map(({ destination }) => destination)).size !== items.length
    || new Set(items.map(({ transactionName }) => transactionName)).size !== items.length) {
    throw new Error('Manifest publication destinations are duplicated')
  }
  for (const item of items) requireSafeArtifactDestination(item.destination)
  return items
}

function publishManifestArtifacts(
  input: WriteArtifactsInput,
  artifacts: ViemManifestArtifacts,
  artifactDigestSourcePath?: string,
  agentSdkArtifacts?: AgentSdkManifestArtifacts,
  agentSdkArtifactDigestSourcePath?: string,
  chatArtifacts?: ChatManifestArtifacts,
  chatArtifactDigestSourcePath?: string,
): void {
  const outputDirectory = resolve(input.outputDirectory)
  const items = publicationItems(
    input,
    artifacts,
    artifactDigestSourcePath,
    agentSdkArtifacts,
    agentSdkArtifactDigestSourcePath,
    chatArtifacts,
    chatArtifactDigestSourcePath,
  )
  const transactionDirectory = mkdtempSync(join(outputDirectory, '.tas-manifest-transaction-'))
  const stagedDirectory = join(transactionDirectory, 'staged')
  const backupDirectory = join(transactionDirectory, 'backup')
  mkdirSync(stagedDirectory)
  mkdirSync(backupDirectory)
  const backedUp = new Set<GeneratedOutputName>()
  const published = new Set<GeneratedOutputName>()
  const byName = new Map(items.map((item) => [item.name, item]))
  let cleanupTransaction = true

  try {
    for (const item of items) {
      writeFileSync(join(stagedDirectory, item.transactionName), item.contents, { encoding: 'utf8', flag: 'wx' })
    }
    for (const item of items) {
      if (requireSafeArtifactDestination(item.destination) !== undefined) {
        renameSync(item.destination, join(backupDirectory, item.transactionName))
        backedUp.add(item.name)
      }
    }
    for (const [index, item] of items.entries()) {
      if (input.testOnlyFailPublicationAfter === index) throw new Error('injected Manifest publication failure')
      renameSync(join(stagedDirectory, item.transactionName), item.destination)
      published.add(item.name)
    }
  } catch (error) {
    const rollbackFailures: unknown[] = []
    for (const name of [...published].reverse()) {
      const item = byName.get(name) as PublicationItem
      try {
        removePublishedFile(item.destination)
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError)
      }
    }
    for (const name of backedUp) {
      const item = byName.get(name) as PublicationItem
      try {
        if (input.testOnlyFailRestorationFor === name) {
          throw new Error(`injected Manifest restoration failure for ${name}`)
        }
        renameSync(join(backupDirectory, item.transactionName), item.destination)
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError)
      }
    }
    if (rollbackFailures.length > 0) {
      cleanupTransaction = false
      throw new AggregateError(
        [error, ...rollbackFailures],
        `Manifest publication rollback failed; recovery retained at ${transactionDirectory}`,
      )
    }
    throw error
  } finally {
    if (cleanupTransaction) rmSync(transactionDirectory, { recursive: true, force: true })
  }
}

export function writeViemManifestArtifacts(input: WriteArtifactsInput): void {
  publishManifestArtifacts(input, generateViemManifestArtifacts(input))
}

export function writeViemGeneratedOutputs(input: ViemGeneratedOutputsInput): void {
  publishManifestArtifacts(
    input,
    generateViemManifestArtifacts(input),
    input.artifactDigestSourcePath,
  )
}

export function writeGeneratedOutputs(input: GeneratedOutputsInput): void {
  // Precompute and validate both dependency generations before moving any destination.
  const viemArtifacts = generateViemManifestArtifacts(input)
  const agentSdkArtifacts = generateAgentSdkManifestArtifacts(input)
  const chatArtifacts = generateChatManifestArtifacts(input)
  publishManifestArtifacts(
    input,
    viemArtifacts,
    input.artifactDigestSourcePath,
    agentSdkArtifacts,
    input.agentSdkArtifactDigestSourcePath,
    chatArtifacts,
    input.chatArtifactDigestSourcePath,
  )
}

function changedViemManifestArtifacts(
  input: ArtifactDirectoryInput,
  artifacts: ViemManifestArtifacts,
): ViemManifestFileName[] {
  const outputDirectory = resolve(input.outputDirectory)
  if (!requireSafeOutputDirectory(outputDirectory, false)) return [...viemManifestFileNames]
  return viemManifestFileNames.filter((fileName) => {
    const path = join(outputDirectory, fileName)
    const status = requireSafeArtifactDestination(path)
    if (status === undefined) return true
    const expected = Buffer.from(artifacts[fileName], 'utf8')
    if (status.size !== expected.byteLength) return true
    const actual = readExactRegularFile(path, expected.byteLength)
    return actual.byteLength !== expected.byteLength || !actual.equals(expected)
  })
}

export function checkViemManifestArtifacts(input: ArtifactDirectoryInput): ViemManifestFileName[] {
  return changedViemManifestArtifacts(input, generateViemManifestArtifacts(input))
}

export function checkViemArtifactDigestSource(path: string, artifacts: ViemManifestArtifacts): boolean {
  const expected = Buffer.from(generateViemArtifactDigestSource(artifacts), 'utf8')
  const destination = resolve(path)
  const status = requireSafeArtifactDestination(destination)
  if (status === undefined || status.size !== expected.byteLength) return false
  const actual = readExactRegularFile(destination, expected.byteLength)
  return actual.byteLength === expected.byteLength && actual.equals(expected)
}

export function checkAgentSdkArtifactDigestSource(path: string, artifacts: AgentSdkManifestArtifacts): boolean {
  const expected = Buffer.from(generateAgentSdkArtifactDigestSource(artifacts), 'utf8')
  const destination = resolve(path)
  const status = requireSafeArtifactDestination(destination)
  if (status === undefined || status.size !== expected.byteLength) return false
  const actual = readExactRegularFile(destination, expected.byteLength)
  return actual.byteLength === expected.byteLength && actual.equals(expected)
}

export function checkChatArtifactDigestSource(path: string, artifacts: ChatManifestArtifacts): boolean {
  const expected = Buffer.from(generateChatArtifactDigestSource(artifacts), 'utf8')
  const destination = resolve(path)
  const status = requireSafeArtifactDestination(destination)
  if (status === undefined || status.size !== expected.byteLength) return false
  const actual = readExactRegularFile(destination, expected.byteLength)
  return actual.byteLength === expected.byteLength && actual.equals(expected)
}

export function checkViemGeneratedOutputs(input: ViemGeneratedOutputsInput): ViemGeneratedOutputName[] {
  const artifacts = generateViemManifestArtifacts(input)
  const changed: ViemGeneratedOutputName[] = changedViemManifestArtifacts(input, artifacts)
  if (!checkViemArtifactDigestSource(input.artifactDigestSourcePath, artifacts)) {
    changed.push(viemArtifactDigestSourceRelativePath)
  }
  return changed
}

export function writeAgentSdkManifestArtifacts(input: ArtifactDirectoryInput): void {
  const artifacts = generateAgentSdkManifestArtifacts(input)
  const outputDirectory = resolve(input.outputDirectory)
  requireSafeOutputDirectory(outputDirectory, true)
  const transactionDirectory = mkdtempSync(join(outputDirectory, '.tas-agent-sdk-manifest-transaction-'))
  const stagedDirectory = join(transactionDirectory, 'staged')
  const backupDirectory = join(transactionDirectory, 'backup')
  mkdirSync(stagedDirectory)
  mkdirSync(backupDirectory)
  const backedUp: AgentSdkManifestFileName[] = []
  const published: AgentSdkManifestFileName[] = []
  let cleanupTransaction = true
  try {
    for (const fileName of agentSdkManifestFileNames) {
      requireSafeArtifactDestination(join(outputDirectory, fileName))
      writeFileSync(join(stagedDirectory, fileName), artifacts[fileName], { encoding: 'utf8', flag: 'wx' })
    }
    for (const fileName of agentSdkManifestFileNames) {
      const destination = join(outputDirectory, fileName)
      if (requireSafeArtifactDestination(destination) !== undefined) {
        renameSync(destination, join(backupDirectory, fileName))
        backedUp.push(fileName)
      }
    }
    for (const fileName of agentSdkManifestFileNames) {
      renameSync(join(stagedDirectory, fileName), join(outputDirectory, fileName))
      published.push(fileName)
    }
  } catch (error) {
    const rollbackFailures: unknown[] = []
    for (const fileName of [...published].reverse()) {
      try {
        removePublishedFile(join(outputDirectory, fileName))
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError)
      }
    }
    for (const fileName of backedUp) {
      try {
        renameSync(join(backupDirectory, fileName), join(outputDirectory, fileName))
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError)
      }
    }
    if (rollbackFailures.length > 0) {
      cleanupTransaction = false
      throw new AggregateError(
        [error, ...rollbackFailures],
        `agent-sdk Manifest publication rollback failed; recovery retained at ${transactionDirectory}`,
      )
    }
    throw error
  } finally {
    if (cleanupTransaction) rmSync(transactionDirectory, { recursive: true, force: true })
  }
}

export function checkAgentSdkManifestArtifacts(input: ArtifactDirectoryInput): AgentSdkManifestFileName[] {
  const artifacts = generateAgentSdkManifestArtifacts(input)
  const outputDirectory = resolve(input.outputDirectory)
  if (!requireSafeOutputDirectory(outputDirectory, false)) return [...agentSdkManifestFileNames]
  return agentSdkManifestFileNames.filter((fileName) => {
    const path = join(outputDirectory, fileName)
    const status = requireSafeArtifactDestination(path)
    if (status === undefined) return true
    const expected = Buffer.from(artifacts[fileName], 'utf8')
    if (status.size !== expected.byteLength) return true
    const actual = readExactRegularFile(path, expected.byteLength)
    return actual.byteLength !== expected.byteLength || !actual.equals(expected)
  })
}

function changedChatManifestArtifacts(input: ArtifactDirectoryInput, artifacts: ChatManifestArtifacts): ChatManifestFileName[] {
  const outputDirectory = resolve(input.outputDirectory)
  if (!requireSafeOutputDirectory(outputDirectory, false)) return [...chatManifestFileNames]
  return chatManifestFileNames.filter((fileName) => {
    const path = join(outputDirectory, fileName)
    const status = requireSafeArtifactDestination(path)
    if (status === undefined) return true
    const expected = Buffer.from(artifacts[fileName], 'utf8')
    if (status.size !== expected.byteLength) return true
    const actual = readExactRegularFile(path, expected.byteLength)
    return actual.byteLength !== expected.byteLength || !actual.equals(expected)
  })
}

export function checkChatManifestArtifacts(input: ArtifactDirectoryInput): ChatManifestFileName[] {
  return changedChatManifestArtifacts(input, generateChatManifestArtifacts(input))
}

function runCli(): void {
  const repositoryRoot = resolve(import.meta.dirname, '../..')
  const outputDirectory = join(repositoryRoot, 'manifests')
  const artifactDigestSourcePath = join(repositoryRoot, viemArtifactDigestSourceRelativePath)
  const agentSdkArtifactDigestSourcePath = join(repositoryRoot, agentSdkArtifactDigestSourceRelativePath)
  const chatArtifactDigestSourcePath = join(repositoryRoot, chatArtifactDigestSourceRelativePath)
  const arguments_ = process.argv.slice(2)
  if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== '--check')) {
    throw new Error('usage: npm run manifest:generate | npm run manifest:check')
  }
  if (arguments_[0] === '--check') {
    const changed: string[] = checkViemGeneratedOutputs({
      cwd: repositoryRoot,
      outputDirectory,
      artifactDigestSourcePath,
    })
    changed.push(...checkAgentSdkManifestArtifacts({ cwd: repositoryRoot, outputDirectory }))
    changed.push(...checkChatManifestArtifacts({ cwd: repositoryRoot, outputDirectory }))
    const agentSdkArtifacts = generateAgentSdkManifestArtifacts({ cwd: repositoryRoot })
    if (!checkAgentSdkArtifactDigestSource(agentSdkArtifactDigestSourcePath, agentSdkArtifacts)) {
      changed.push(agentSdkArtifactDigestSourceRelativePath)
    }
    const chatArtifacts = generateChatManifestArtifacts({ cwd: repositoryRoot })
    if (!checkChatArtifactDigestSource(chatArtifactDigestSourcePath, chatArtifacts)) {
      changed.push(chatArtifactDigestSourceRelativePath)
    }
    if (changed.length > 0) throw new Error(`Manifest artifacts differ: ${changed.join(', ')}`)
    process.stdout.write(`Manifest artifacts are current: ${[
      ...viemManifestFileNames,
      ...agentSdkManifestFileNames,
      ...chatManifestFileNames,
      viemArtifactDigestSourceRelativePath,
      agentSdkArtifactDigestSourceRelativePath,
      chatArtifactDigestSourceRelativePath,
    ].join(', ')}\n`)
    return
  }
  writeGeneratedOutputs({
    cwd: repositoryRoot,
    outputDirectory,
    artifactDigestSourcePath,
    agentSdkArtifactDigestSourcePath,
    chatArtifactDigestSourcePath,
  })
  process.stdout.write(`Generated Manifest artifacts: ${[
    ...viemManifestFileNames,
    ...agentSdkManifestFileNames,
    ...chatManifestFileNames,
    viemArtifactDigestSourceRelativePath,
    agentSdkArtifactDigestSourceRelativePath,
    chatArtifactDigestSourceRelativePath,
  ].join(', ')}\n`)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  try {
    runCli()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${basename(invokedPath)}: ${detail}\n`)
    process.exitCode = 1
  }
}
