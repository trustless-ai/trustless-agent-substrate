import { isProxy } from 'node:util/types'

import type { Account, PublicClient, WalletClient } from 'viem'

import { decodeBySchema, encodeEvmJson } from '../../clients/chain/jsonCodec.js'
import type { EvmJsonValue } from '../../clients/chain/jsonCodec.js'
import type { ViemActionBindings } from '../../clients/chain/viemActions.js'
import type { ResolvedTasConfig } from '../../local/config/types.js'
import type { ManifestRegistry } from '../../mcp/manifest/registry.js'
import { getManifestRegistry } from '../../mcp/manifest/registry.js'
import type { GeneratedToolEntry } from '../../mcp/manifest/types.js'
import { TasError } from '../errors.js'
import type { AgentProjection, ResolvedProfile } from '../profile/resolver.js'
import type { ChainSelector } from '../profile/types.js'

const privateKey = /^0x[0-9a-fA-F]{64}$/
const address = /^0x[0-9a-fA-F]{40}$/
const zeroAddress = `0x${'0'.repeat(40)}`

export interface AgentMembershipResolver {
  getAgent(agentId: string, selector: ChainSelector): Promise<ResolvedProfile<AgentProjection>>
}

export interface ChainInvocation {
  readonly toolName: string
  readonly arguments: Readonly<Record<string, unknown>>
}

export interface ChainService {
  invoke(invocation: ChainInvocation): Promise<EvmJsonValue>
}

export interface ChainServiceOptions {
  readonly registry: ManifestRegistry
  readonly bindings: ViemActionBindings
  readonly config: ResolvedTasConfig
  readonly publicClient: PublicClient
  readonly walletClient: WalletClient
  readonly profileResolver?: AgentMembershipResolver
}

interface SplitArguments {
  readonly parameters: Readonly<Record<string, unknown>>
  readonly credential: unknown
  readonly hasCredential: boolean
}

interface InspectedInvocation {
  readonly toolName: string
  readonly arguments: Readonly<Record<string, unknown>>
}

function fail(code: 'INVALID_ARGUMENT' | 'CREDENTIAL_REQUIRED' | 'AUTHORIZATION_DENIED'
  | 'WALLET_MISMATCH' | 'MANIFEST_BINDING_UNSUPPORTED' | 'EXTERNAL_UNAVAILABLE'
  | 'OPERATION_OUTCOME_UNKNOWN'): never {
  const messages = {
    INVALID_ARGUMENT: 'The Chain invocation arguments are invalid.',
    CREDENTIAL_REQUIRED: 'A valid inline EVM credential is required.',
    AUTHORIZATION_DENIED: 'The configured Agent is not authorized for this Wallet operation.',
    WALLET_MISMATCH: 'The credential does not match the configured Agent wallet.',
    MANIFEST_BINDING_UNSUPPORTED: 'The requested Chain binding is unavailable.',
    EXTERNAL_UNAVAILABLE: 'The Chain operation could not be completed.',
    OPERATION_OUTCOME_UNKNOWN: 'The submitted Chain operation outcome is unknown.',
  } as const
  throw new TasError(code, messages[code])
}

function inspectArguments(value: unknown, wallet: boolean): SplitArguments {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    return fail('INVALID_ARGUMENT')
  }
  let prototype: object | null
  let descriptors: PropertyDescriptorMap
  let keys: readonly PropertyKey[]
  try {
    prototype = Object.getPrototypeOf(value)
    descriptors = Object.getOwnPropertyDescriptors(value)
    keys = Reflect.ownKeys(value)
  } catch {
    return fail('INVALID_ARGUMENT')
  }
  if (prototype !== Object.prototype && prototype !== null) return fail('INVALID_ARGUMENT')

  const parameters: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  let credential: unknown
  let hasCredential = false
  for (const key of keys) {
    if (typeof key !== 'string') return fail('INVALID_ARGUMENT')
    const descriptor = descriptors[key]
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      return fail('INVALID_ARGUMENT')
    }
    if (key === 'credential') {
      if (!wallet) return fail('INVALID_ARGUMENT')
      credential = descriptor.value
      hasCredential = true
    } else {
      Object.defineProperty(parameters, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true,
      })
    }
  }
  return { parameters, credential, hasCredential }
}

function inspectInvocation(value: unknown): InspectedInvocation {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    return fail('INVALID_ARGUMENT')
  }
  try {
    const prototype = Object.getPrototypeOf(value)
    const keys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null)
      || keys.length !== 2 || keys.some((key) => key !== 'toolName' && key !== 'arguments')) {
      return fail('INVALID_ARGUMENT')
    }
    const toolName = Object.getOwnPropertyDescriptor(value, 'toolName')
    const arguments_ = Object.getOwnPropertyDescriptor(value, 'arguments')
    if (toolName === undefined || arguments_ === undefined
      || !toolName.enumerable || !arguments_.enumerable
      || !('value' in toolName) || !('value' in arguments_)
      || typeof toolName.value !== 'string') return fail('INVALID_ARGUMENT')
    return { toolName: toolName.value, arguments: arguments_.value as Readonly<Record<string, unknown>> }
  } catch (error) {
    if (error instanceof TasError) throw error
    return fail('INVALID_ARGUMENT')
  }
}

function credentialSecret(value: unknown, present: boolean): `0x${string}` {
  if (!present || value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    return fail('CREDENTIAL_REQUIRED')
  }
  let prototype: object | null
  let descriptors: PropertyDescriptorMap
  let keys: readonly PropertyKey[]
  try {
    prototype = Object.getPrototypeOf(value)
    descriptors = Object.getOwnPropertyDescriptors(value)
    keys = Reflect.ownKeys(value)
  } catch {
    return fail('CREDENTIAL_REQUIRED')
  }
  if (prototype !== Object.prototype && prototype !== null
    || keys.length !== 2 || keys.some((key) => typeof key !== 'string' || (key !== 'type' && key !== 'secret'))) {
    return fail('CREDENTIAL_REQUIRED')
  }
  const type = descriptors.type
  const secret = descriptors.secret
  if (type === undefined || secret === undefined
    || !type.enumerable || !secret.enumerable
    || !('value' in type) || !('value' in secret)
    || type.value !== 'inline' || typeof secret.value !== 'string'
    || !privateKey.test(secret.value)) return fail('CREDENTIAL_REQUIRED')
  return secret.value as `0x${string}`
}

function canonicalAccountAddress(account: Account): string {
  let candidate: unknown
  try {
    const descriptor = Object.getOwnPropertyDescriptor(account, 'address')
    if (descriptor === undefined || !('value' in descriptor)) return fail('CREDENTIAL_REQUIRED')
    candidate = descriptor.value
  } catch {
    return fail('CREDENTIAL_REQUIRED')
  }
  if (typeof candidate !== 'string' || !address.test(candidate) || candidate.toLowerCase() === zeroAddress) {
    return fail('CREDENTIAL_REQUIRED')
  }
  return candidate.toLowerCase()
}

function ownData(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

async function authorizeMember(
  agentId: string,
  resolver: AgentMembershipResolver | undefined,
  accountAddress: string,
): Promise<void> {
  if (resolver === undefined) return fail('AUTHORIZATION_DENIED')
  const resolved = await resolver.getAgent(agentId, { kind: 'latest' })
  const member = ownData(resolved, 'data')
  if (ownData(member, 'agent_id') !== agentId || ownData(member, 'is_member') !== true) {
    return fail('AUTHORIZATION_DENIED')
  }
  const authenticationWallet = ownData(member, 'authentication_wallet')
  if (typeof authenticationWallet !== 'string' || !address.test(authenticationWallet)
    || authenticationWallet.toLowerCase() === zeroAddress) return fail('AUTHORIZATION_DENIED')
  if (authenticationWallet.toLowerCase() !== accountAddress) return fail('WALLET_MISMATCH')
}

function sourceFailure(entry: GeneratedToolEntry): never {
  if (entry.operation.effect === 'side_effect' && entry.operation.completion !== 'synchronous') {
    return fail('OPERATION_OUTCOME_UNKNOWN')
  }
  return fail('EXTERNAL_UNAVAILABLE')
}

function ensureConnectionOnlyWallet(client: WalletClient): void {
  if (isProxy(client)) return fail('INVALID_ARGUMENT')
  try {
    const descriptor = Object.getOwnPropertyDescriptor(client, 'account')
    if (descriptor !== undefined && (!('value' in descriptor) || descriptor.value !== undefined)) {
      return fail('INVALID_ARGUMENT')
    }
  } catch {
    return fail('INVALID_ARGUMENT')
  }
}

export function createChainService(options: ChainServiceOptions): ChainService {
  if (options.registry !== getManifestRegistry()) return fail('MANIFEST_BINDING_UNSUPPORTED')
  ensureConnectionOnlyWallet(options.walletClient)
  if (options.config.mode === 'member' && options.profileResolver === undefined) {
    return fail('AUTHORIZATION_DENIED')
  }
  const registry = options.registry
  const bindings = options.bindings
  const phase = options.config.mode
  const memberAgentId = options.config.mode === 'member' ? options.config.instance.agentId : undefined
  const publicClient = options.publicClient
  const walletClient = options.walletClient
  const profileResolver = options.profileResolver

  return Object.freeze({
    async invoke(invocation: ChainInvocation): Promise<EvmJsonValue> {
      const inspected = inspectInvocation(invocation)
      const entry = registry.get(inspected.toolName)
      if (entry === undefined) return fail('MANIFEST_BINDING_UNSUPPORTED')
      const wallet = entry.source.export === 'WalletActions'
      const split = inspectArguments(inspected.arguments, wallet)

      let decoded: Readonly<Record<string, unknown>>
      try {
        const value = decodeBySchema(entry.input_schema, split.parameters)
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('INVALID_ARGUMENT')
        decoded = value as Readonly<Record<string, unknown>>
      } catch (error) {
        if (error instanceof TasError) throw error
        return fail('INVALID_ARGUMENT')
      }

      const action = bindings.get(entry)
      if (!wallet) {
        try {
          const sourceResult = await action(publicClient, decoded)
          const encoded = encodeEvmJson(sourceResult)
          decodeBySchema(entry.output_schema, encoded)
          return encoded
        } catch {
          return sourceFailure(entry)
        }
      }

      let secret: `0x${string}` | undefined
      let account: Account | undefined
      let walletArguments: Readonly<Record<string, unknown>> | undefined
      try {
        secret = credentialSecret(split.credential, split.hasCredential)
        try {
          account = bindings.accountFromPrivateKey(secret)
        } catch {
          return fail('CREDENTIAL_REQUIRED')
        }
        const accountAddress = canonicalAccountAddress(account)
        if (phase === 'member') {
          try {
            await authorizeMember(memberAgentId!, profileResolver, accountAddress)
          } catch (error) {
            if (error instanceof TasError) throw error
            return fail('EXTERNAL_UNAVAILABLE')
          }
        }
        walletArguments = Object.assign(Object.create(null) as Record<string, unknown>, decoded, { account })
        try {
          const sourceResult = await action(walletClient, walletArguments)
          const encoded = encodeEvmJson(sourceResult)
          decodeBySchema(entry.output_schema, encoded)
          return encoded
        } catch {
          return sourceFailure(entry)
        }
      } finally {
        walletArguments = undefined
        account = undefined
        secret = undefined
      }
    },
  })
}
