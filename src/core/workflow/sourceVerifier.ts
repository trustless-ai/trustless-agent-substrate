import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import { keccak256, toHex } from 'viem'

import type {
  SolidityCompiler,
  SolidityContractOutput,
  SolidityStandardJsonInput,
} from '../../clients/workflow/solcCompiler.js'
import type { EvmAddress } from '../../local/config/types.js'
import { TasError } from '../errors.js'
import type { ResolvedWorkflowSource } from './sourceResolver.js'

export interface WorkflowCodeReader {
  readCode(request: {
    readonly chainId: string
    readonly address: EvmAddress
    readonly blockHash: `0x${string}`
    readonly requireCanonical: true
    readonly signal?: AbortSignal
  }): Promise<`0x${string}` | undefined>
}

export interface WorkflowSourceVerifierOptions {
  readonly codeReader: WorkflowCodeReader
  readonly compiler: SolidityCompiler
}

export type WorkflowVerificationReason = 'verified' | 'source_mismatch' | 'metadata_mismatch' | 'runtime_mismatch'

export interface WorkflowVerificationIdentity {
  readonly fingerprint: `sha256:${string}`
  readonly compiler: {
    readonly version: string
    readonly settingsHash: `sha256:${string}`
  }
  readonly source: {
    readonly keccak256: `0x${string}`
    readonly closureHash: `sha256:${string}`
    readonly metadataSha256: string
  }
  readonly deployedCodeHash: `0x${string}`
  readonly context: {
    readonly chainId: string
    readonly blockNumber: string
    readonly blockHash: `0x${string}`
    readonly profileVersion: string
    readonly workflowAddress: EvmAddress
    readonly repository: string
    readonly commit: string
    readonly sourcePath: string
    readonly metadataPath: string
  }
}

export type WorkflowVerificationResult = WorkflowVerificationIdentity & (
  | { readonly valid: true; readonly reason: 'verified' }
  | { readonly valid: false; readonly reason: Exclude<WorkflowVerificationReason, 'verified'> }
)

export interface WorkflowDeploymentIdentity {
  readonly deployedCodeHash: `0x${string}`
}

export interface WorkflowSourceVerifier {
  identifyDeployment(
    input: {
      readonly chainId: string
      readonly workflowAddress: EvmAddress
      readonly blockHash: `0x${string}`
    },
    options?: { readonly signal?: AbortSignal },
  ): Promise<WorkflowDeploymentIdentity>
  identify(source: ResolvedWorkflowSource, options?: { readonly signal?: AbortSignal }): Promise<WorkflowVerificationIdentity>
  verify(source: ResolvedWorkflowSource, options?: { readonly signal?: AbortSignal }): Promise<WorkflowVerificationResult>
}

interface RuntimeParts {
  readonly executable: Uint8Array
  readonly trailer: Uint8Array
}

interface RuntimeReference {
  readonly key: string
  readonly kind: 'immutable' | 'link'
  readonly start: number
  readonly length: number
}

const maxRuntimeBytes = 1_048_576
const maxReferences = 4_096
const outputSelection = [
  'metadata',
  'evm.deployedBytecode.object',
  'evm.deployedBytecode.linkReferences',
  'evm.deployedBytecode.immutableReferences',
] as const

function compileFailed(): never {
  throw new TasError('WORKFLOW_COMPILE_FAILED', 'The Workflow Solidity compilation failed.')
}

function sourceUnavailable(): never {
  throw new TasError('WORKFLOW_SOURCE_UNAVAILABLE', 'The deployed Workflow source is unavailable.')
}

function deploymentUnsupported(): never {
  throw new TasError(
    'WORKFLOW_DEPLOYMENT_UNSUPPORTED',
    'The deployed Workflow uses an unsupported deployment form.',
  )
}

function aborted(): never {
  const error = new Error('The Workflow verification request was aborted.')
  error.name = 'AbortError'
  throw error
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) return aborted()
}

function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor
      ? descriptor.value
      : undefined
  } catch {
    return undefined
  }
}

function compilerInput(source: ResolvedWorkflowSource): SolidityStandardJsonInput {
  const settings = Object.create(null) as Record<string, unknown>
  for (const [key, value] of Object.entries(source.settings)) {
    if (key !== 'compilationTarget' && key !== 'outputSelection') settings[key] = value
  }
  settings.outputSelection = {
    [source.sourcePath]: { [source.contractName]: [...outputSelection] },
  }

  const sources = Object.create(null) as Record<string, { content: string }>
  for (const [path, unit] of Object.entries(source.sourceUnits)) {
    if (unit.path !== path || typeof unit.text !== 'string') return compileFailed()
    sources[path] = { content: unit.text }
  }
  return { language: 'Solidity', sources, settings }
}

function compiledContract(
  source: ResolvedWorkflowSource,
  output: unknown,
): SolidityContractOutput {
  const contracts = own(output, 'contracts')
  const bySource = own(contracts, source.sourcePath)
  const contract = own(bySource, source.contractName)
  if (contract === undefined) return compileFailed()
  return contract as SolidityContractOutput
}

function parseHex(
  value: unknown,
  origin: 'compiler' | 'deployment',
  allowLibraryPlaceholders = false,
): Uint8Array {
  if (typeof value !== 'string') return origin === 'compiler' ? compileFailed() : sourceUnavailable()
  let normalized = value.startsWith('0x') ? value.slice(2) : value
  if (allowLibraryPlaceholders) {
    normalized = normalized.replace(/__\$[0-9a-fA-F]{34}\$__/g, '0'.repeat(40))
  }
  if (normalized.length === 0 || normalized.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(normalized)) {
    return origin === 'compiler' ? compileFailed() : sourceUnavailable()
  }
  const bytes = Uint8Array.from(Buffer.from(normalized, 'hex'))
  if (bytes.byteLength > maxRuntimeBytes) return origin === 'compiler' ? compileFailed() : deploymentUnsupported()
  return bytes
}

function hasLinkReferences(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  for (const libraries of Object.values(value as object)) {
    if (libraries === null || typeof libraries !== 'object' || Array.isArray(libraries)) continue
    for (const ranges of Object.values(libraries as object)) {
      if (Array.isArray(ranges) && ranges.length > 0) return true
    }
  }
  return false
}

function cborLength(bytes: Uint8Array, offset: number, expectedMajor: number): { length: number; offset: number } {
  const head = bytes[offset]
  if (head === undefined || head >> 5 !== expectedMajor) return deploymentUnsupported()
  const additional = head & 0x1f
  if (additional < 24) return { length: additional, offset: offset + 1 }
  if (additional === 24) {
    const length = bytes[offset + 1]
    if (length === undefined || length < 24) return deploymentUnsupported()
    return { length, offset: offset + 2 }
  }
  return deploymentUnsupported()
}

function supportedMetadataBody(body: Uint8Array): boolean {
  let cursor = 0
  let entries: number
  try {
    const map = cborLength(body, cursor, 5)
    entries = map.length
    cursor = map.offset
  } catch {
    return false
  }
  let commitment = false
  let compiler = false
  for (let index = 0; index < entries; index += 1) {
    let keyLength: { length: number; offset: number }
    try { keyLength = cborLength(body, cursor, 3) } catch { return false }
    const keyEnd = keyLength.offset + keyLength.length
    if (keyEnd > body.byteLength) return false
    const key = Buffer.from(body.subarray(keyLength.offset, keyEnd)).toString('utf8')
    cursor = keyEnd

    const valueHead = body[cursor]
    if (valueHead === 0xf4 || valueHead === 0xf5) {
      cursor += 1
      continue
    }
    let valueLength: { length: number; offset: number }
    try { valueLength = cborLength(body, cursor, 2) } catch { return false }
    const valueEnd = valueLength.offset + valueLength.length
    if (valueEnd > body.byteLength) return false
    const value = body.subarray(valueLength.offset, valueEnd)
    if (key === 'ipfs') commitment ||= value.byteLength === 34 && value[0] === 0x12 && value[1] === 0x20
    if (key === 'bzzr1') commitment ||= value.byteLength === 32
    if (key === 'solc') compiler ||= value.byteLength === 3
    cursor = valueEnd
  }
  return cursor === body.byteLength && commitment && compiler
}

function splitRuntime(bytes: Uint8Array, origin: 'compiler' | 'deployment'): RuntimeParts {
  if (bytes.byteLength < 3) return origin === 'compiler' ? compileFailed() : deploymentUnsupported()
  const encodedLength = (bytes[bytes.byteLength - 2]! << 8) | bytes[bytes.byteLength - 1]!
  const trailerLength = encodedLength + 2
  const start = bytes.byteLength - trailerLength
  if (encodedLength === 0 || start < 0) return origin === 'compiler' ? compileFailed() : deploymentUnsupported()
  const body = bytes.subarray(start, bytes.byteLength - 2)
  if (!supportedMetadataBody(body)) return origin === 'compiler' ? compileFailed() : deploymentUnsupported()
  return { executable: bytes.subarray(0, start), trailer: bytes.subarray(start) }
}

function referenceRange(value: unknown, key: string, kind: RuntimeReference['kind']): RuntimeReference {
  const start = own(value, 'start')
  const length = own(value, 'length')
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length)
    || (start as number) < 0 || (length as number) <= 0) return compileFailed()
  return { key, kind, start: start as number, length: length as number }
}

function referenceArray(value: unknown, key: string, kind: RuntimeReference['kind']): RuntimeReference[] {
  if (!Array.isArray(value)) return compileFailed()
  return value.map((range) => referenceRange(range, key, kind))
}

function references(contract: SolidityContractOutput, executableLength: number): readonly RuntimeReference[] {
  const deployed = own(own(contract, 'evm'), 'deployedBytecode')
  const immutableValue = own(deployed, 'immutableReferences')
  const linkValue = own(deployed, 'linkReferences')
  if (immutableValue === null || typeof immutableValue !== 'object' || Array.isArray(immutableValue)
    || linkValue === null || typeof linkValue !== 'object' || Array.isArray(linkValue)) return compileFailed()

  const output: RuntimeReference[] = []
  for (const [id, ranges] of Object.entries(immutableValue as object)) {
    output.push(...referenceArray(ranges, id, 'immutable'))
  }
  for (const [path, libraries] of Object.entries(linkValue as object)) {
    if (libraries === null || typeof libraries !== 'object' || Array.isArray(libraries)) return compileFailed()
    for (const [library, ranges] of Object.entries(libraries as object)) {
      output.push(...referenceArray(ranges, `${path}:${library}`, 'link'))
    }
  }
  if (output.length > maxReferences) return compileFailed()
  output.sort((left, right) => left.start - right.start || left.length - right.length)
  let previousEnd = 0
  for (const range of output) {
    const end = range.start + range.length
    if (!Number.isSafeInteger(end) || end > executableLength || range.start < previousEnd) return compileFailed()
    previousEnd = end
  }
  return output
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}

function immutableValuesAgree(deployed: Uint8Array, ranges: readonly RuntimeReference[]): boolean {
  const values = new Map<string, Uint8Array>()
  for (const range of ranges) {
    if (range.kind !== 'immutable') continue
    const value = deployed.subarray(range.start, range.start + range.length)
    const prior = values.get(range.key)
    if (prior !== undefined && !sameBytes(prior, value)) return false
    values.set(range.key, value)
  }
  return true
}

function executableMatches(
  compiled: Uint8Array,
  deployed: Uint8Array,
  ranges: readonly RuntimeReference[],
): boolean {
  if (compiled.byteLength !== deployed.byteLength || !immutableValuesAgree(deployed, ranges)) return false
  let rangeIndex = 0
  for (let offset = 0; offset < compiled.byteLength; offset += 1) {
    while (ranges[rangeIndex] !== undefined
      && offset >= ranges[rangeIndex]!.start + ranges[rangeIndex]!.length) rangeIndex += 1
    const range = ranges[rangeIndex]
    if (range !== undefined && offset >= range.start && offset < range.start + range.length) continue
    if (compiled[offset] !== deployed[offset]) return false
  }
  return true
}

function rejectDelegation(executable: Uint8Array): void {
  for (let offset = 0; offset < executable.byteLength; offset += 1) {
    const opcode = executable[offset]!
    if (opcode === 0xf2 || opcode === 0xf4) return deploymentUnsupported()
    if (opcode >= 0x60 && opcode <= 0x7f) {
      const pushBytes = opcode - 0x5f
      if (offset + pushBytes >= executable.byteLength) return deploymentUnsupported()
      offset += pushBytes
    }
  }
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function resultBase(source: ResolvedWorkflowSource, deployedCodeHash: `0x${string}`) {
  const settingsHash = sha256(JSON.stringify(source.settings))
  const sourceClosureHash = sha256(JSON.stringify(
    Object.entries(source.sourceUnits)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, unit]) => [path, unit.keccak256]),
  ))
  const fingerprint = sha256(JSON.stringify({
    chainId: source.chainId,
    workflowAddress: source.workflowAddress.toLowerCase(),
    deployedCodeHash,
    repository: source.repository.locator,
    commit: source.commit,
    sourcePath: source.sourcePath,
    sourceHash: source.source.keccak256,
    sourceClosureHash,
    metadataPath: source.metadataPath,
    metadataHash: source.metadataFile.sha256,
    compilerVersion: source.compiler.version,
    settingsHash,
  }))
  return Object.freeze({
    fingerprint,
    compiler: Object.freeze({ version: source.compiler.version, settingsHash }),
    source: Object.freeze({
      keccak256: source.source.keccak256,
      closureHash: sourceClosureHash,
      metadataSha256: source.metadataFile.sha256,
    }),
    deployedCodeHash,
    context: Object.freeze({
      chainId: source.chainId,
      blockNumber: source.profile.blockNumber,
      blockHash: source.profile.blockHash,
      profileVersion: source.profile.version,
      workflowAddress: source.workflowAddress,
      repository: source.repository.locator,
      commit: source.commit,
      sourcePath: source.sourcePath,
      metadataPath: source.metadataPath,
    }),
  } as const)
}

function verificationResult(
  valid: boolean,
  reason: WorkflowVerificationReason,
  base: WorkflowVerificationIdentity,
): WorkflowVerificationResult {
  if (valid) {
    if (reason !== 'verified') return compileFailed()
    return Object.freeze({ valid: true, reason, ...base })
  }
  if (reason === 'verified') return compileFailed()
  return Object.freeze({ valid: false, reason, ...base })
}

function validateResolutionContext(source: ResolvedWorkflowSource): void {
  const blockHash = source.blockSelector.blockHash.toLowerCase()
  if (source.blockSelector.kind !== 'block_hash'
    || source.profile.blockHash.toLowerCase() !== blockHash
    || source.repository.profile.blockHash.toLowerCase() !== blockHash
    || source.repository.profile.blockNumber !== source.profile.blockNumber
    || source.repository.profile.version !== source.profile.version) return compileFailed()
}

async function identifyWorkflow(
  codeReader: WorkflowCodeReader,
  source: ResolvedWorkflowSource,
  signal: AbortSignal | undefined,
): Promise<{
  readonly identity: WorkflowVerificationIdentity
  readonly deployedBytes: Uint8Array
}> {
  throwIfAborted(signal)
  validateResolutionContext(source)
  const deployment = await readDeployment(codeReader, {
    chainId: source.chainId,
    workflowAddress: source.workflowAddress,
    blockHash: source.blockSelector.blockHash,
  }, signal)
  return Object.freeze({
    identity: resultBase(source, deployment.identity.deployedCodeHash),
    deployedBytes: deployment.deployedBytes,
  })
}

async function readDeployment(
  codeReader: WorkflowCodeReader,
  input: {
    readonly chainId: string
    readonly workflowAddress: EvmAddress
    readonly blockHash: `0x${string}`
  },
  signal: AbortSignal | undefined,
): Promise<{
  readonly identity: WorkflowDeploymentIdentity
  readonly deployedBytes: Uint8Array
}> {
  throwIfAborted(signal)
  let deployedHex: `0x${string}` | undefined
  try {
    deployedHex = await codeReader.readCode({
      chainId: input.chainId,
      address: input.workflowAddress,
      blockHash: input.blockHash,
      requireCanonical: true,
      signal,
    })
  } catch (error) {
    if (signal?.aborted) return aborted()
    return sourceUnavailable()
  }
  throwIfAborted(signal)
  if (deployedHex === undefined || deployedHex === '0x') return sourceUnavailable()
  const deployedBytes = parseHex(deployedHex, 'deployment')
  return Object.freeze({
    identity: Object.freeze({ deployedCodeHash: keccak256(toHex(deployedBytes)) }),
    deployedBytes,
  })
}

export function createWorkflowSourceVerifier(options: WorkflowSourceVerifierOptions): WorkflowSourceVerifier {
  const codeReader = options.codeReader
  const compiler = options.compiler
  return Object.freeze({
    async identifyDeployment(
      input: {
        readonly chainId: string
        readonly workflowAddress: EvmAddress
        readonly blockHash: `0x${string}`
      },
      verificationOptions?: { readonly signal?: AbortSignal },
    ): Promise<WorkflowDeploymentIdentity> {
      return (await readDeployment(codeReader, input, verificationOptions?.signal)).identity
    },
    async identify(
      source: ResolvedWorkflowSource,
      verificationOptions?: { readonly signal?: AbortSignal },
    ): Promise<WorkflowVerificationIdentity> {
      return (await identifyWorkflow(codeReader, source, verificationOptions?.signal)).identity
    },
    async verify(
      source: ResolvedWorkflowSource,
      verificationOptions?: { readonly signal?: AbortSignal },
    ): Promise<WorkflowVerificationResult> {
      const signal = verificationOptions?.signal
      const identified = await identifyWorkflow(codeReader, source, signal)
      const base = identified.identity

      if (Object.values(source.sourceUnits).some((unit) => unit.keccak256 !== unit.expectedKeccak256)) {
        return verificationResult(false, 'source_mismatch', base)
      }

      const compilation = await compiler.compile(compilerInput(source), source.compiler.version, signal)
      throwIfAborted(signal)
      if (compilation.compilerVersion !== source.compiler.version) return compileFailed()
      const contract = compiledContract(source, compilation.output)
      const compiledMetadata = own(contract, 'metadata')
      if (typeof compiledMetadata !== 'string') return compileFailed()

      const deployedOutput = own(own(contract, 'evm'), 'deployedBytecode')
      const deployedObject = own(deployedOutput, 'object')
      const unresolvedLinks = hasLinkReferences(own(deployedOutput, 'linkReferences'))
      const compiledBytes = parseHex(deployedObject, 'compiler', unresolvedLinks)
      const compiledParts = splitRuntime(compiledBytes, 'compiler')
      const runtimeReferences = references(contract, compiledParts.executable.byteLength)
      if (runtimeReferences.some((reference) => reference.kind === 'link')) return deploymentUnsupported()
      const deployedParts = splitRuntime(identified.deployedBytes, 'deployment')
      rejectDelegation(deployedParts.executable)

      const committedMetadata = source.metadataFile.text.endsWith('\n')
        ? source.metadataFile.text.slice(0, -1)
        : source.metadataFile.text
      if (compiledMetadata !== committedMetadata || !sameBytes(compiledParts.trailer, deployedParts.trailer)) {
        return verificationResult(false, 'metadata_mismatch', base)
      }

      if (!executableMatches(compiledParts.executable, deployedParts.executable, runtimeReferences)) {
        return verificationResult(false, 'runtime_mismatch', base)
      }
      return verificationResult(true, 'verified', base)
    },
  })
}
