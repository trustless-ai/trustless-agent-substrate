import { isProxy } from 'node:util/types'

import { getAddress } from 'viem'
import type { Account } from 'viem'

import { decodeBySchema, encodeEvmJson, type EvmJsonValue } from '../../clients/chain/jsonCodec.js'
import type { EvmAddress } from '../../local/config/types.js'
import type { GeneratedToolEntry } from '../../mcp/manifest/types.js'
import { TasError } from '../errors.js'
import type { AgentProjection, ResolvedProfile } from '../profile/resolver.js'
import type {
  VerifiedWorkflowBlockSelector,
  VerifiedWorkflowContext,
  WorkflowOperationInvocation,
  WorkflowOperationService,
  WorkflowOperationServiceOptions,
} from './types.js'

const privateKey = /^0x[0-9a-fA-F]{64}$/
const zeroAddress = `0x${'0'.repeat(40)}`

type FailureCode =
  | 'AUTHORIZATION_DENIED'
  | 'CREDENTIAL_REQUIRED'
  | 'EXTERNAL_UNAVAILABLE'
  | 'INVALID_ARGUMENT'
  | 'MANIFEST_BINDING_UNSUPPORTED'
  | 'OPERATION_OUTCOME_UNKNOWN'
  | 'WALLET_MISMATCH'

function fail(code: FailureCode): never {
  const messages = {
    AUTHORIZATION_DENIED: 'The configured Agent is not authorized for this Workflow operation.',
    CREDENTIAL_REQUIRED: 'A valid inline EVM credential is required.',
    EXTERNAL_UNAVAILABLE: 'The Workflow operation could not be completed.',
    INVALID_ARGUMENT: 'The Workflow invocation arguments are invalid.',
    MANIFEST_BINDING_UNSUPPORTED: 'The requested Workflow binding is unavailable.',
    OPERATION_OUTCOME_UNKNOWN: 'The submitted Workflow operation outcome is unknown.',
    WALLET_MISMATCH: 'The credential does not match the configured Agent wallet.',
  } as const
  throw new TasError(code, messages[code])
}

function ownData(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function inspectInvocation(value: unknown): WorkflowOperationInvocation {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    return fail('INVALID_ARGUMENT')
  }
  try {
    const prototype = Object.getPrototypeOf(value)
    const keys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null)
      || keys.length !== 2
      || keys.some((key) => key !== 'toolName' && key !== 'arguments')) return fail('INVALID_ARGUMENT')
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

interface SplitArguments {
  readonly parameters: Readonly<Record<string, unknown>>
  readonly credential: unknown
  readonly hasCredential: boolean
}

function splitArguments(value: unknown, credentialExpected: boolean): SplitArguments {
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

  const parameters = Object.create(null) as Record<string, unknown>
  let credential: unknown
  let hasCredential = false
  for (const key of keys) {
    if (typeof key !== 'string') return fail('INVALID_ARGUMENT')
    const descriptor = descriptors[key]
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return fail('INVALID_ARGUMENT')
    if (key === 'credential') {
      if (!credentialExpected) return fail('INVALID_ARGUMENT')
      credential = descriptor.value
      hasCredential = true
      continue
    }
    Object.defineProperty(parameters, key, {
      configurable: true,
      enumerable: true,
      value: descriptor.value,
      writable: true,
    })
  }
  return { parameters, credential, hasCredential }
}

function credentialSecret(value: unknown, present: boolean): `0x${string}` {
  if (!present || value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    return fail('CREDENTIAL_REQUIRED')
  }
  try {
    const prototype = Object.getPrototypeOf(value)
    const keys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null)
      || keys.length !== 2
      || keys.some((key) => key !== 'type' && key !== 'secret')) return fail('CREDENTIAL_REQUIRED')
    const type = Object.getOwnPropertyDescriptor(value, 'type')
    const secret = Object.getOwnPropertyDescriptor(value, 'secret')
    if (type === undefined || secret === undefined
      || !type.enumerable || !secret.enumerable
      || !('value' in type) || !('value' in secret)
      || type.value !== 'inline' || typeof secret.value !== 'string'
      || !privateKey.test(secret.value)) return fail('CREDENTIAL_REQUIRED')
    return secret.value as `0x${string}`
  } catch (error) {
    if (error instanceof TasError) throw error
    return fail('CREDENTIAL_REQUIRED')
  }
}

function canonicalAddress(value: unknown, failure: 'AUTHORIZATION_DENIED' | 'CREDENTIAL_REQUIRED'): EvmAddress {
  if (typeof value !== 'string') return fail(failure)
  try {
    const normalized = getAddress(value)
    if (normalized.toLowerCase() === zeroAddress) return fail(failure)
    return normalized
  } catch (error) {
    if (error instanceof TasError) throw error
    return fail(failure)
  }
}

function selectorMatches(selector: VerifiedWorkflowBlockSelector, resolved: ResolvedProfile<AgentProjection>): boolean {
  return resolved.resolution.chain.block_hash.toLowerCase() === selector.blockHash.toLowerCase()
}

async function currentMemberWallet(
  options: WorkflowOperationServiceOptions,
  context: VerifiedWorkflowContext,
  signal?: AbortSignal,
): Promise<EvmAddress> {
  let resolved: ResolvedProfile<AgentProjection>
  try {
    resolved = signal === undefined
      ? await options.memberResolver.getAgent(options.agentId, context.blockSelector)
      : await options.memberResolver.getAgent(options.agentId, context.blockSelector, { signal })
  } catch (error) {
    if (signal?.aborted && error instanceof Error && error.name === 'AbortError') throw error
    return fail('EXTERNAL_UNAVAILABLE')
  }
  if (!selectorMatches(context.blockSelector, resolved)) return fail('AUTHORIZATION_DENIED')
  const projection = ownData(resolved, 'data')
  if (ownData(projection, 'agent_id') !== options.agentId || ownData(projection, 'is_member') !== true) {
    return fail('AUTHORIZATION_DENIED')
  }
  return canonicalAddress(ownData(projection, 'authentication_wallet'), 'AUTHORIZATION_DENIED')
}

function decodeParameters(entry: GeneratedToolEntry, parameters: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  try {
    const decoded = decodeBySchema(entry.input_schema, parameters)
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) return fail('INVALID_ARGUMENT')
    return decoded as Readonly<Record<string, unknown>>
  } catch (error) {
    if (error instanceof TasError) throw error
    return fail('INVALID_ARGUMENT')
  }
}

function inputValue(decoded: Readonly<Record<string, unknown>>, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(decoded, name)
  return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor ? descriptor.value : undefined
}

function sourceFailure(entry: GeneratedToolEntry): never {
  if (entry.operation.completion === 'external_handle') return fail('OPERATION_OUTCOME_UNKNOWN')
  return fail('EXTERNAL_UNAVAILABLE')
}

async function resolveContractAddress(
  options: WorkflowOperationServiceOptions,
  entry: GeneratedToolEntry,
  context: VerifiedWorkflowContext,
): Promise<EvmAddress> {
  try {
    return canonicalAddress(await options.contractAddressResolver.resolve(entry, context), 'AUTHORIZATION_DENIED')
  } catch (error) {
    if (error instanceof TasError && error.code !== 'AUTHORIZATION_DENIED') throw error
    return fail('EXTERNAL_UNAVAILABLE')
  }
}

export function createWorkflowOperationService(options: WorkflowOperationServiceOptions): WorkflowOperationService {
  const dependencies: WorkflowOperationServiceOptions = Object.freeze({
    agentId: options.agentId,
    gate: options.gate,
    registry: options.registry,
    memberResolver: options.memberResolver,
    contractAddressResolver: options.contractAddressResolver,
    client: options.client,
  })
  return Object.freeze({
    async invoke(
      invocation: WorkflowOperationInvocation,
      operationOptions?: { readonly signal?: AbortSignal },
    ): Promise<EvmJsonValue> {
      // This is intentionally the first action. No caller data or binding is
      // inspected until the current Workflow source has passed the gate.
      const verified = await dependencies.gate.assertCurrent(operationOptions?.signal)
      const inspected = inspectInvocation(invocation)
      const entry = dependencies.registry.get(inspected.toolName)
      if (entry === undefined || (entry.binding.kind !== 'function' && entry.binding.kind !== 'class_method')) {
        return fail('MANIFEST_BINDING_UNSUPPORTED')
      }

      const credentialExpected = entry.credential === 'evm_private_key'
      const split = splitArguments(inspected.arguments, credentialExpected)
      const decoded = decodeParameters(entry, split.parameters)
      let secret: `0x${string}` | undefined
      let account: Account | undefined
      try {
        if (credentialExpected) {
          if (entry.binding.kind !== 'class_method') return fail('MANIFEST_BINDING_UNSUPPORTED')
          secret = credentialSecret(split.credential, split.hasCredential)
          try {
            account = dependencies.client.accountFromPrivateKey(secret)
          } catch {
            return fail('CREDENTIAL_REQUIRED')
          }
          canonicalAddress(account.address, 'CREDENTIAL_REQUIRED')
        }

        let contractAddress: EvmAddress | undefined
        if (entry.runtime_dependencies.includes('contract_address')) {
          contractAddress = await resolveContractAddress(dependencies, entry, verified)
        }

        if (entry.binding.kind === 'class_method') {
          const authenticationWallet = await currentMemberWallet(dependencies, verified, operationOptions?.signal)
          if (credentialExpected) {
            const signer = canonicalAddress(account?.address, 'CREDENTIAL_REQUIRED')
            if (signer.toLowerCase() !== authenticationWallet.toLowerCase()) return fail('WALLET_MISMATCH')
          } else {
            try {
              account = dependencies.client.accountFromAddress(authenticationWallet)
            } catch {
              return fail('EXTERNAL_UNAVAILABLE')
            }
            let readAccount: EvmAddress
            try {
              readAccount = canonicalAddress(account.address, 'AUTHORIZATION_DENIED')
            } catch {
              return fail('EXTERNAL_UNAVAILABLE')
            }
            if (readAccount.toLowerCase() !== authenticationWallet.toLowerCase()) return fail('EXTERNAL_UNAVAILABLE')
          }
        }

        const orderedArguments = entry.binding.arguments.map((argument) => {
          if (argument.kind === 'input') return inputValue(decoded, argument.name)
          if (contractAddress === undefined) return fail('MANIFEST_BINDING_UNSUPPORTED')
          return { rpcUrl: verified.rpcUrl, address: contractAddress }
        })
        const invocationContext = {
          chainId: verified.chainId,
          rpcUrl: verified.rpcUrl,
          ...(contractAddress === undefined ? {} : { contractAddress }),
          ...(account === undefined ? {} : { account }),
        }
        try {
          const result = await dependencies.client.invoke(entry, orderedArguments, invocationContext)
          const encoded = encodeEvmJson(result)
          decodeBySchema(entry.output_schema, encoded)
          return encoded
        } catch (error) {
          if (error instanceof TasError && error.code === 'MANIFEST_BINDING_UNSUPPORTED') {
            return fail('MANIFEST_BINDING_UNSUPPORTED')
          }
          return sourceFailure(entry)
        }
      } finally {
        account = undefined
        secret = undefined
      }
    },
  })
}
