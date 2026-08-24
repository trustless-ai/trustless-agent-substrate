import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { isProxy } from 'node:util/types'

import { getAddress, keccak256 } from 'viem'

import type { EvmAddress } from '../../local/config/types.js'
import { TasError, type TasErrorCode } from '../errors.js'
import type {
  ProfileJsonObject,
  ProfileJsonValue,
  ProfileResolver,
  ProfileProjection,
  ResolvedProfile,
} from '../profile/resolver.js'
import type { ChainSelector } from '../profile/types.js'
import type { RepositoryContentClient, RepositoryFile, RepositoryReadOptions } from '../repository/client.js'
import { parseGitHubLocator } from '../repository/locator.js'
import type { RepositoryCredential, RepositorySource } from '../repository/types.js'

const fullCommit = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const blockHash = /^0x[0-9a-fA-F]{64}$/
const address = /^0x[0-9a-fA-F]{40}$/
const sourceKeccak = /^0x[0-9a-f]{64}$/
const compilerVersion = /^\d+\.\d+\.\d+\+commit\.[0-9a-f]{8}$/
const maxFileBytes = 1_048_576
const maxTotalSourceBytes = 4_194_304
const maxSourceUnits = 256
const maxPathCharacters = 4_096
const maxMetadataDepth = 64
const maxMetadataNodes = 20_000
const maxMetadataEntries = 20_000

type WorkflowSourceErrorCode = Extract<
  TasErrorCode,
  'WORKFLOW_METADATA_INVALID' | 'WORKFLOW_SOURCE_UNAVAILABLE'
>

export interface WorkflowSourceResolverOptions {
  readonly profileResolver: Pick<ProfileResolver, 'binding' | 'get'>
  readonly contentClient: Pick<RepositoryContentClient, 'readFile'>
}

export interface ResolvedWorkflowSourceUnit {
  readonly path: string
  readonly bytes: Uint8Array
  readonly text: string
  readonly keccak256: `0x${string}`
  readonly expectedKeccak256: `0x${string}`
}

export interface ResolvedWorkflowMetadataFile {
  readonly bytes: Uint8Array
  readonly text: string
  readonly sha256: string
}

export interface ResolvedWorkflowCompilerMetadata extends ProfileJsonObject {
  readonly compiler: ProfileJsonObject & { readonly version: string }
  readonly language: 'Solidity'
  readonly settings: ProfileJsonObject
  readonly sources: ProfileJsonObject
  readonly version: 1
}

export interface WorkflowSourceDescriptor {
  readonly chainId: string
  readonly blockSelector: { readonly kind: 'block_hash'; readonly blockHash: `0x${string}` }
  readonly profile: {
    readonly blockNumber: string
    readonly blockHash: `0x${string}`
    readonly version: string
  }
  readonly workflowAddress: EvmAddress
  readonly repository: RepositorySource
  readonly commit: string
  readonly sourcePath: string
  readonly metadataPath: string
}

export interface ResolvedWorkflowSource extends WorkflowSourceDescriptor {
  readonly contractName: string
  readonly compiler: { readonly version: string }
  readonly metadata: ResolvedWorkflowCompilerMetadata
  readonly settings: ProfileJsonObject
  readonly metadataFile: ResolvedWorkflowMetadataFile
  readonly source: ResolvedWorkflowSourceUnit
  readonly sourceUnits: Readonly<Record<string, ResolvedWorkflowSourceUnit>>
}

export interface WorkflowSourceResolver {
  discover(
    selector: ChainSelector,
    options?: RepositoryReadOptions,
  ): Promise<WorkflowSourceDescriptor>
  materialize(
    descriptor: WorkflowSourceDescriptor,
    credential?: RepositoryCredential,
    options?: RepositoryReadOptions,
  ): Promise<ResolvedWorkflowSource>
  resolve(
    selector: ChainSelector,
    credential?: RepositoryCredential,
    options?: RepositoryReadOptions,
  ): Promise<ResolvedWorkflowSource>
}

function fail(code: WorkflowSourceErrorCode, message: string): never {
  throw new TasError(code, message)
}

function invalidMetadata(): never {
  return fail(
    'WORKFLOW_METADATA_INVALID',
    'The Profile-selected Workflow source metadata is invalid.',
  )
}

function sourceUnavailable(): never {
  return fail(
    'WORKFLOW_SOURCE_UNAVAILABLE',
    'The Profile-selected Workflow source is unavailable.',
  )
}

function aborted(): never {
  const error = new Error('The Workflow source request was aborted.')
  error.name = 'AbortError'
  throw error
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) return aborted()
}

function ownData(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return invalidMetadata()
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return invalidMetadata()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return invalidMetadata()
    return descriptor.value
  } catch {
    return invalidMetadata()
  }
}

function requireString(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : invalidMetadata()
}

function requirePlainObject(value: unknown): ProfileJsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return invalidMetadata()
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
      ? value as ProfileJsonObject
      : invalidMetadata()
  } catch {
    return invalidMetadata()
  }
}

function requireCanonicalPath(value: unknown): string {
  const path = requireString(value)
  if (
    path.length > maxPathCharacters
    || path.includes('\\')
    || path.includes('\0')
    || posix.isAbsolute(path)
    || posix.normalize(path) !== path
  ) return invalidMetadata()
  const segments = path.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return invalidMetadata()
  return path
}

function requireCommit(value: unknown): string {
  return typeof value === 'string' && fullCommit.test(value) ? value : invalidMetadata()
}

interface MetadataBudget {
  entries: number
  nodes: number
}

function clonePlainJson(value: unknown): ProfileJsonValue {
  const budget: MetadataBudget = { entries: 0, nodes: 0 }
  const active = new Set<object>()

  function clone(input: unknown, depth: number): ProfileJsonValue {
    if (depth > maxMetadataDepth || ++budget.nodes > maxMetadataNodes) return invalidMetadata()
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input
    if (typeof input === 'number') return Number.isFinite(input) ? input : invalidMetadata()
    if (typeof input !== 'object' || isProxy(input) || active.has(input)) return invalidMetadata()

    let prototype: object | null
    let descriptors: PropertyDescriptorMap
    let keys: readonly PropertyKey[]
    try {
      prototype = Object.getPrototypeOf(input)
      descriptors = Object.getOwnPropertyDescriptors(input)
      keys = Reflect.ownKeys(input)
    } catch {
      return invalidMetadata()
    }
    const array = Array.isArray(input)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return invalidMetadata()
    if ((budget.entries += keys.length) > maxMetadataEntries || keys.some((key) => typeof key !== 'string')) return invalidMetadata()
    active.add(input)

    if (array) {
      const length = input.length
      if (keys.length !== length + 1 || keys[length] !== 'length') return invalidMetadata()
      const output: ProfileJsonValue[] = []
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)]
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return invalidMetadata()
        output.push(clone(descriptor.value, depth + 1))
      }
      active.delete(input)
      return Object.freeze(output)
    }

    const output = Object.create(null) as Record<string, ProfileJsonValue>
    for (const property of keys as string[]) {
      const descriptor = descriptors[property]
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return invalidMetadata()
      Object.defineProperty(output, property, {
        configurable: false,
        enumerable: true,
        value: clone(descriptor.value, depth + 1),
        writable: false,
      })
    }
    active.delete(input)
    return Object.freeze(output)
  }

  return clone(value, 0)
}

function parseMetadata(bytes: Uint8Array): ResolvedWorkflowCompilerMetadata {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return invalidMetadata()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return invalidMetadata()
  }
  const metadata = clonePlainJson(parsed)
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return invalidMetadata()
  return metadata as ResolvedWorkflowCompilerMetadata
}

function validateMetadata(
  metadata: ResolvedWorkflowCompilerMetadata,
  sourcePath: string,
): { compilerVersion: string; contractName: string; sourceEntries: Readonly<Record<string, `0x${string}`>> } {
  if (ownData(metadata, 'language') !== 'Solidity' || ownData(metadata, 'version') !== 1) return invalidMetadata()

  const compiler = ownData(metadata, 'compiler')
  const version = ownData(compiler, 'version')
  if (typeof version !== 'string' || !compilerVersion.test(version)) return invalidMetadata()
  requirePlainObject(ownData(metadata, 'output'))

  const settings = ownData(metadata, 'settings')
  const target = requirePlainObject(ownData(settings, 'compilationTarget'))
  const targetKeys = Object.keys(target)
  if (targetKeys.length !== 1 || targetKeys[0] !== sourcePath) return invalidMetadata()
  const contractName = requireString(ownData(target, sourcePath))

  const metadataSettings = requirePlainObject(ownData(settings, 'metadata'))
  const bytecodeHash = ownData(metadataSettings, 'bytecodeHash')
  if (bytecodeHash !== 'ipfs' && bytecodeHash !== 'bzzr1') return invalidMetadata()
  if (Object.hasOwn(metadataSettings, 'appendCBOR') && ownData(metadataSettings, 'appendCBOR') !== true) {
    return invalidMetadata()
  }

  const sources = requirePlainObject(ownData(metadata, 'sources'))
  const sourcePaths = Object.keys(sources)
  if (sourcePaths.length === 0 || sourcePaths.length > maxSourceUnits || !sourcePaths.includes(sourcePath)) return invalidMetadata()
  const sourceEntries = Object.create(null) as Record<string, `0x${string}`>
  for (const path of sourcePaths) {
    requireCanonicalPath(path)
    const digest = ownData(ownData(sources, path), 'keccak256')
    if (typeof digest !== 'string' || !sourceKeccak.test(digest)) return invalidMetadata()
    sourceEntries[path] = digest as `0x${string}`
  }
  return { compilerVersion: version, contractName, sourceEntries }
}

function exactBlockHash(value: unknown): `0x${string}` {
  return typeof value === 'string' && blockHash.test(value) ? value as `0x${string}` : invalidMetadata()
}

function workflowAddress(value: unknown): EvmAddress {
  if (typeof value !== 'string' || !address.test(value)) return invalidMetadata()
  try {
    return getAddress(value)
  } catch {
    return invalidMetadata()
  }
}

function checkedBytes(file: RepositoryFile, path: string, commit: string): Uint8Array {
  try {
    if (file.path !== path || file.commit !== commit || !(file.bytes instanceof Uint8Array) || isProxy(file.bytes)) {
      return invalidMetadata()
    }
    if (file.bytes.byteLength > maxFileBytes) return invalidMetadata()
    return Uint8Array.from(file.bytes)
  } catch {
    return invalidMetadata()
  }
}

async function readFile(
  client: Pick<RepositoryContentClient, 'readFile'>,
  source: RepositorySource,
  commit: string,
  path: string,
  credential?: RepositoryCredential,
  options?: RepositoryReadOptions,
): Promise<Uint8Array> {
  throwIfAborted(options?.signal)
  let file: RepositoryFile
  try {
    file = await client.readFile(source, commit, path, credential, options)
  } catch (error) {
    if (options?.signal?.aborted) return aborted()
    if (error instanceof TasError && (error.code === 'CREDENTIAL_REQUIRED' || error.code === 'REPOSITORY_RATE_LIMITED')) throw error
    return sourceUnavailable()
  }
  throwIfAborted(options?.signal)
  return checkedBytes(file, path, commit)
}

function decodeSource(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return invalidMetadata()
  }
}

function immutableSourceUnit(
  path: string,
  bytes: Uint8Array,
  digest: `0x${string}`,
  expectedDigest: `0x${string}`,
): ResolvedWorkflowSourceUnit {
  const snapshot = Uint8Array.from(bytes)
  return Object.freeze({
    path,
    get bytes() { return Uint8Array.from(snapshot) },
    text: decodeSource(snapshot),
    keccak256: digest,
    expectedKeccak256: expectedDigest,
  })
}

function immutableMetadataFile(
  bytes: Uint8Array,
  text: string,
): ResolvedWorkflowMetadataFile {
  const snapshot = Uint8Array.from(bytes)
  return Object.freeze({
    get bytes() { return Uint8Array.from(snapshot) },
    text,
    sha256: createHash('sha256').update(snapshot).digest('hex'),
  })
}

function profileSource(resolved: ResolvedProfile<ProfileProjection>): {
  repository: string
  commit: string
  sourcePath: string
  metadataPath: string
} {
  const workflow = ownData(resolved.data, 'workflow')
  const workflowData = ownData(workflow, 'data')
  const source = ownData(workflowData, 'source')
  return {
    repository: requireString(ownData(source, 'repository')),
    commit: requireCommit(ownData(source, 'commit')),
    sourcePath: requireCanonicalPath(ownData(source, 'sourcePath')),
    metadataPath: requireCanonicalPath(ownData(source, 'metadataPath')),
  }
}

export function createWorkflowSourceResolver(options: WorkflowSourceResolverOptions): WorkflowSourceResolver {
  const profileResolver = options.profileResolver
  const contentClient = options.contentClient
  const issuedDescriptors = new WeakSet<WorkflowSourceDescriptor>()

  async function discover(
    selector: ChainSelector,
    options?: RepositoryReadOptions,
  ): Promise<WorkflowSourceDescriptor> {
    throwIfAborted(options?.signal)
    const resolved = await profileResolver.get(selector, options)
    throwIfAborted(options?.signal)
    const selected = profileSource(resolved)
    const workflow = ownData(resolved.data, 'workflow')
    const charter = ownData(resolved.data, 'charter')
    const charterRepository = requireString(ownData(charter, 'repository'))
    let locator: ReturnType<typeof parseGitHubLocator>
    try {
      locator = parseGitHubLocator(charterRepository)
      const workflowLocator = parseGitHubLocator(selected.repository)
      if (workflowLocator.locator !== locator.locator) return invalidMetadata()
    } catch {
      return invalidMetadata()
    }

    const profileBlockHash = exactBlockHash(resolved.resolution.chain.block_hash)
    const profileVersion = requireString(resolved.resolution.profile.version)
    const blockNumber = requireString(resolved.resolution.chain.block_number)
    const charterCommit = requireCommit(ownData(charter, 'commit'))
    if (ownData(charter, 'path') !== 'charter/') return invalidMetadata()
    const profile = Object.freeze({ blockNumber, blockHash: profileBlockHash, version: profileVersion })
    const repository: RepositorySource = Object.freeze({
      provider: 'github',
      locator: locator.locator,
      owner: locator.owner,
      repository: locator.repository,
      profile,
      charter: Object.freeze({ commit: charterCommit, path: 'charter/' }),
    })

    const descriptor = Object.freeze({
      chainId: profileResolver.binding.chainId,
      blockSelector: Object.freeze({ kind: 'block_hash' as const, blockHash: profileBlockHash }),
      profile,
      workflowAddress: workflowAddress(ownData(workflow, 'address')),
      repository,
      commit: selected.commit,
      sourcePath: selected.sourcePath,
      metadataPath: selected.metadataPath,
    })
    issuedDescriptors.add(descriptor)
    return descriptor
  }

  async function materialize(
    descriptor: WorkflowSourceDescriptor,
    credential?: RepositoryCredential,
    options?: RepositoryReadOptions,
  ): Promise<ResolvedWorkflowSource> {
    throwIfAborted(options?.signal)
    if (!issuedDescriptors.has(descriptor)) return invalidMetadata()

    const metadataBytes = await readFile(
      contentClient,
      descriptor.repository,
      descriptor.commit,
      descriptor.metadataPath,
      credential,
      options,
    )
    const metadata = parseMetadata(metadataBytes)
    const parsed = validateMetadata(metadata, descriptor.sourcePath)
    let totalBytes = metadataBytes.byteLength
    const sourceUnits = Object.create(null) as Record<string, ResolvedWorkflowSourceUnit>
    for (const [path, expectedDigest] of Object.entries(parsed.sourceEntries)) {
      const bytes = await readFile(contentClient, descriptor.repository, descriptor.commit, path, credential, options)
      totalBytes += bytes.byteLength
      if (totalBytes > maxTotalSourceBytes) return invalidMetadata()
      const digest = keccak256(bytes)
      const unit = immutableSourceUnit(path, bytes, digest, expectedDigest)
      Object.defineProperty(sourceUnits, path, { enumerable: true, value: unit })
    }
    const source = sourceUnits[descriptor.sourcePath]
    if (source === undefined) return invalidMetadata()
    const metadataText = decodeSource(metadataBytes)

    return Object.freeze({
      ...descriptor,
      contractName: parsed.contractName,
      compiler: Object.freeze({ version: parsed.compilerVersion }),
      metadata,
      settings: ownData(metadata, 'settings') as ProfileJsonObject,
      metadataFile: immutableMetadataFile(metadataBytes, metadataText),
      source,
      sourceUnits: Object.freeze(sourceUnits),
    })
  }

  return Object.freeze({
    discover,
    materialize,
    async resolve(
      selector: ChainSelector,
      credential?: RepositoryCredential,
      options?: RepositoryReadOptions,
    ): Promise<ResolvedWorkflowSource> {
      const descriptor = await discover(selector, options)
      return materialize(descriptor, credential, options)
    },
  })
}
