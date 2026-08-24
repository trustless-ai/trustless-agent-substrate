import { Buffer } from 'node:buffer'
import { getAddress } from 'viem'

import { TasError } from '../errors.js'
import type { CanonicalDecimal, EvmAddress } from '../../local/config/types.js'
import type { ProfileReader, ProfileReadOptions } from './reader.js'
import type { ChainSelector, ProfileSnapshot, RawAgentSnapshot } from './types.js'

const decimal = /^(?:0|[1-9][0-9]*)$/
const blockHash = /^0x[0-9a-fA-F]{64}$/
const commitHash = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const dataKey = /^[a-z][a-z0-9._-]{0,63}$/
const maxUint256 = 2n ** 256n - 1n
const zeroAddress = `0x${'0'.repeat(40)}`
const maxProjectionDepth = 64
const maxProjectionNodes = 10_000
const maxProjectionEntries = 10_000
const maxJsonUtf8Bytes = 1_048_576
const fixedProfileProjectionEntries = 13

type JsonPrimitive = boolean | null | number | string
export type ProfileJsonValue = JsonPrimitive | readonly ProfileJsonValue[] | ProfileJsonObject
export interface ProfileJsonObject { readonly [key: string]: ProfileJsonValue }

export interface ProfileResolution {
  readonly chain: { readonly block_number: CanonicalDecimal; readonly block_hash: string }
  readonly profile: { readonly version: CanonicalDecimal }
}

export interface ProfileProjection extends ProfileJsonObject {
  readonly version: CanonicalDecimal
  readonly governance: string
  readonly charter: ProfileJsonObject
  readonly agents: ProfileJsonObject
  readonly data: ProfileJsonObject
  readonly workflow: ProfileJsonObject
}

export type AgentProjection =
  | (ProfileJsonObject & { readonly agent_id: CanonicalDecimal; readonly is_member: false })
  | (ProfileJsonObject & {
      readonly agent_id: CanonicalDecimal
      readonly is_member: true
      readonly data: ProfileJsonObject
      readonly agent_verifier: string
      readonly authentication_wallet: string
    })

export interface ResolvedProfile<T extends ProfileJsonObject> {
  readonly data: T
  readonly resolution: ProfileResolution
}

export interface ProfileBinding {
  readonly chainId: CanonicalDecimal
  readonly tawgAddress: EvmAddress
}

const publicMessage = 'The selected TAWG Profile state is inconsistent.'

function inconsistent(): never {
  throw new TasError('PROFILE_INCONSISTENT', publicMessage)
}

function dataProperty(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return inconsistent()
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return inconsistent()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) return inconsistent()
    return descriptor.value
  } catch {
    return inconsistent()
  }
}

function optionalDataProperty(value: unknown, key: string): unknown | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return inconsistent()
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return inconsistent()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor) return undefined
    if (!('value' in descriptor)) return inconsistent()
    return descriptor.value
  } catch {
    return inconsistent()
  }
}

function stringProperty(value: unknown, key: string): string {
  const candidate = dataProperty(value, key)
  return typeof candidate === 'string' ? candidate : inconsistent()
}

function booleanProperty(value: unknown, key: string): boolean {
  const candidate = dataProperty(value, key)
  return typeof candidate === 'boolean' ? candidate : inconsistent()
}

function arrayProperty(value: unknown, key: string): readonly unknown[] {
  const candidate = dataProperty(value, key)
  if (!Array.isArray(candidate)) return inconsistent()
  try {
    if (Object.getPrototypeOf(candidate) !== Array.prototype) return inconsistent()
    const lengthDescriptor = Object.getOwnPropertyDescriptor(candidate, 'length')
    if (!lengthDescriptor || !('value' in lengthDescriptor) || typeof lengthDescriptor.value !== 'number' || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) return inconsistent()
    if (lengthDescriptor.value > maxProjectionEntries) return inconsistent()
    const descriptors = Object.getOwnPropertyDescriptors(candidate) as unknown as Record<PropertyKey, PropertyDescriptor>
    const keys = Reflect.ownKeys(descriptors).filter((property) => property !== 'length')
    if (keys.length !== lengthDescriptor.value || keys.some((property, index) => property !== String(index))) return inconsistent()
    return keys.map((property) => {
      const descriptor = descriptors[property as string]
      if (!descriptor?.enumerable || !('value' in descriptor)) return inconsistent()
      return descriptor.value
    })
  } catch {
    return inconsistent()
  }
}

function canonicalUint256(value: unknown, allowZero: boolean): CanonicalDecimal {
  if (typeof value !== 'string' || value.length > 78 || !decimal.test(value)) return inconsistent()
  try {
    const number = BigInt(value)
    if ((!allowZero && number === 0n) || number > maxUint256) return inconsistent()
  } catch {
    return inconsistent()
  }
  return value
}

function requiredAddress(value: unknown): EvmAddress {
  if (typeof value !== 'string') return inconsistent()
  try {
    const normalized = getAddress(value)
    if (normalized.toLowerCase() === zeroAddress) return inconsistent()
    return normalized
  } catch {
    return inconsistent()
  }
}

function isZeroAddress(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try { return getAddress(value).toLowerCase() === zeroAddress } catch { return false }
}

function defineJsonProperty(target: object, key: string, value: ProfileJsonValue): void {
  Object.defineProperty(target, key, { configurable: true, enumerable: true, value, writable: true })
}

interface ProjectionBudget {
  entries: number
  jsonBytes: number
  nodes: number
}

type ProjectionFrame =
  | {
      readonly kind: 'array'
      readonly depth: number
      readonly descriptors: Readonly<Record<PropertyKey, PropertyDescriptor>>
      readonly keys: readonly string[]
      readonly output: ProfileJsonValue[]
    }
  | {
      readonly kind: 'object'
      readonly depth: number
      readonly descriptors: Readonly<Record<PropertyKey, PropertyDescriptor>>
      readonly keys: readonly string[]
      readonly output: Record<string, ProfileJsonValue>
    }

function sanitizeJson(value: unknown, budget: ProjectionBudget): ProfileJsonValue {
  const frames: ProjectionFrame[] = []
  const seen = new WeakSet<object>()

  function allocate(input: unknown, depth: number): ProfileJsonValue {
    if (depth > maxProjectionDepth || ++budget.nodes > maxProjectionNodes) return inconsistent()
    if (input === null || typeof input === 'boolean' || typeof input === 'string') return input
    if (typeof input === 'number') return Number.isFinite(input) ? input : inconsistent()
    if (typeof input !== 'object' || seen.has(input)) return inconsistent()

    let prototype: object | null
    try {
      prototype = Object.getPrototypeOf(input)
    } catch {
      return inconsistent()
    }
    const isArray = Array.isArray(input)
    if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return inconsistent()
    seen.add(input)

    if (isArray) {
      try {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length')
        if (!lengthDescriptor || !('value' in lengthDescriptor) || typeof lengthDescriptor.value !== 'number' || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) return inconsistent()
        if (budget.entries + lengthDescriptor.value > maxProjectionEntries) return inconsistent()
      } catch {
        return inconsistent()
      }
    }

    let descriptors: Readonly<Record<PropertyKey, PropertyDescriptor>>
    try {
      descriptors = Object.getOwnPropertyDescriptors(input) as unknown as Readonly<Record<PropertyKey, PropertyDescriptor>>
    } catch {
      return inconsistent()
    }
    const ownKeys = Reflect.ownKeys(descriptors)
    if (isArray) {
      const lengthDescriptor = descriptors.length
      if (!lengthDescriptor || !('value' in lengthDescriptor) || typeof lengthDescriptor.value !== 'number' || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) return inconsistent()
      const keys = ownKeys.filter((key): key is string => typeof key === 'string' && key !== 'length')
      if (keys.length !== ownKeys.length - 1 || keys.length !== lengthDescriptor.value || keys.some((key, index) => key !== String(index))) return inconsistent()
      if ((budget.entries += keys.length) > maxProjectionEntries) return inconsistent()
      const output: ProfileJsonValue[] = new Array<ProfileJsonValue>(keys.length)
      frames.push({ kind: 'array', depth, descriptors, keys, output })
      return output
    }

    if (ownKeys.some((key) => typeof key !== 'string')) return inconsistent()
    const keys = ownKeys as string[]
    if ((budget.entries += keys.length) > maxProjectionEntries) return inconsistent()
    const output = Object.create(null) as Record<string, ProfileJsonValue>
    frames.push({ kind: 'object', depth, descriptors, keys, output })
    return output
  }

  const output = allocate(value, 0)
  while (frames.length > 0) {
    const frame = frames.pop()!
    for (const key of frame.keys) {
      const descriptor = frame.descriptors[key]
      if (!descriptor?.enumerable || !('value' in descriptor)) return inconsistent()
      const child = allocate(descriptor.value, frame.depth + 1)
      if (frame.kind === 'array') frame.output[Number(key)] = child
      else defineJsonProperty(frame.output, key, child)
    }
  }
  return output
}

function parseJsonObject(value: unknown, budget: ProjectionBudget): ProfileJsonObject {
  if (typeof value !== 'string') return inconsistent()
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes > maxJsonUtf8Bytes || (budget.jsonBytes += bytes) > maxJsonUtf8Bytes) return inconsistent()
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return inconsistent() }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return inconsistent()
  return sanitizeJson(parsed, budget) as ProfileJsonObject
}

function validateCompleteProjection<T extends ProfileJsonObject>(value: T): T {
  return sanitizeJson(value, { entries: 0, jsonBytes: 0, nodes: 0 }) as T
}

function repositoryLocator(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return inconsistent()
  return value
}

function requireBlockHash(value: unknown): string {
  return typeof value === 'string' && blockHash.test(value) ? value : inconsistent()
}

function resolution(value: ProfileSnapshot | RawAgentSnapshot): ProfileResolution {
  const version = canonicalUint256(dataProperty(value, 'version'), false)
  return {
    chain: {
      block_number: canonicalUint256(dataProperty(value, 'blockNumber'), true),
      block_hash: requireBlockHash(dataProperty(value, 'blockHash')),
    },
    profile: { version },
  }
}

/** Converts one exact-block ProfileReader snapshot into the public discovery projection. */
export class ProfileResolver {
  readonly #reader: ProfileReader
  readonly #binding: Readonly<ProfileBinding>

  constructor(reader: ProfileReader, binding: ProfileBinding) {
    this.#reader = reader
    this.#binding = Object.freeze({
      chainId: canonicalUint256(binding.chainId, false),
      tawgAddress: requiredAddress(binding.tawgAddress),
    })
  }

  get binding(): Readonly<ProfileBinding> {
    return this.#binding
  }

  async get(selector: ChainSelector = { kind: 'latest' }, options?: ProfileReadOptions): Promise<ResolvedProfile<ProfileProjection>> {
    const snapshot = await this.#reader.readProfile(selector, options)
    this.#validateBinding(snapshot)
    const resolved = resolution(snapshot)
    const governance = requiredAddress(dataProperty(snapshot, 'governance'))
    const identityRegistry = requiredAddress(dataProperty(snapshot, 'identityRegistry'))
    const charter = dataProperty(snapshot, 'charter')
    const repository = repositoryLocator(dataProperty(charter, 'repository'))
    const commit = stringProperty(charter, 'commitHash')
    if (!commitHash.test(commit) || stringProperty(charter, 'path') !== 'charter/') return inconsistent()

    const rawAgentIds = arrayProperty(snapshot, 'agentIds')
    const rawDataEntries = arrayProperty(snapshot, 'dataEntries')
    if (rawAgentIds.length + rawDataEntries.length + fixedProfileProjectionEntries > maxProjectionEntries) return inconsistent()
    const ids = rawAgentIds.map((id) => canonicalUint256(id, true))
    if (new Set(ids).size !== ids.length) return inconsistent()

    const jsonBudget: ProjectionBudget = { entries: 0, jsonBytes: 0, nodes: 0 }
    const projectedData = Object.create(null) as Record<string, ProfileJsonValue>
    const seenKeys = new Set<string>()
    for (const entry of rawDataEntries) {
      const key = stringProperty(entry, 'key')
      if (!dataKey.test(key) || seenKeys.has(key) || booleanProperty(entry, 'exists') !== true) return inconsistent()
      seenKeys.add(key)
      defineJsonProperty(projectedData, key, parseJsonObject(dataProperty(entry, 'data'), jsonBudget))
    }

    const workflow = dataProperty(snapshot, 'workflow')
    const workflowAddress = requiredAddress(dataProperty(workflow, 'workflowAddress'))
    const workflowData = parseJsonObject(dataProperty(workflow, 'data'), jsonBudget)

    return {
      data: validateCompleteProjection({
        version: resolved.profile.version,
        governance,
        charter: { repository, commit, path: 'charter/' },
        agents: { identity_registry: identityRegistry, agent_ids: ids },
        data: projectedData,
        workflow: { address: workflowAddress, data: workflowData },
      }),
      resolution: resolved,
    }
  }

  async getAgent(agentId: string, selector: ChainSelector = { kind: 'latest' }, options?: ProfileReadOptions): Promise<ResolvedProfile<AgentProjection>> {
    const requestedAgentId = canonicalUint256(agentId, true)
    const snapshot = await this.#reader.readAgent(requestedAgentId, selector, options)
    this.#validateBinding(snapshot)
    const resolved = resolution(snapshot)
    requiredAddress(dataProperty(snapshot, 'identityRegistry'))
    const returnedAgentId = canonicalUint256(dataProperty(snapshot, 'agentId'), true)
    if (returnedAgentId !== requestedAgentId) return inconsistent()
    const isMember = booleanProperty(snapshot, 'isMember')
    const rawData = dataProperty(snapshot, 'data')
    const verifier = dataProperty(snapshot, 'agentVerifier')
    const wallet = optionalDataProperty(snapshot, 'authenticationWallet')

    if (!isMember) {
      if (rawData !== '' || !isZeroAddress(verifier) || wallet !== undefined) return inconsistent()
      return { data: { agent_id: requestedAgentId, is_member: false }, resolution: resolved }
    }

    const authenticationWallet = requiredAddress(wallet)
    const jsonBudget: ProjectionBudget = { entries: 0, jsonBytes: 0, nodes: 0 }
    return {
      data: validateCompleteProjection({
        agent_id: requestedAgentId,
        is_member: true,
        data: parseJsonObject(rawData, jsonBudget),
        agent_verifier: requiredAddress(verifier),
        authentication_wallet: authenticationWallet,
      }),
      resolution: resolved,
    }
  }

  #validateBinding(snapshot: ProfileSnapshot | RawAgentSnapshot): void {
    const chainId = canonicalUint256(dataProperty(snapshot, 'chainId'), false)
    const tawgAddress = requiredAddress(dataProperty(snapshot, 'tawgAddress'))
    if (chainId !== this.binding.chainId || tawgAddress.toLowerCase() !== this.binding.tawgAddress.toLowerCase()) return inconsistent()
  }
}
