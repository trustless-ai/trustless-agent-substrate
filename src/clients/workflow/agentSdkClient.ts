import { OnChainProofClient } from '@trustless-ai/agent-sdk/anchor/ERC8263'
import { AgentWorkflowClient } from '@trustless-ai/agent-sdk/execution/ERC8301'
import { computeReplyHash, computeTaskHash } from '@trustless-ai/agent-sdk/execution/ERC8301/recompute'
import { IdentityRegistryClient } from '@trustless-ai/agent-sdk/identity/ERC8004'
import { computeAgentId } from '@trustless-ai/agent-sdk/identity/ERC8004/recompute'
import { SourceBindingClient } from '@trustless-ai/agent-sdk/identity/ERC8323'
import { AgentReputationClient } from '@trustless-ai/agent-sdk/reputation/ERC8275'
import { computeWinRate } from '@trustless-ai/agent-sdk/reputation/ERC8275/recompute'
import { ConsultEscrowClient } from '@trustless-ai/agent-sdk/settlement/ERC8203'
import { computeVerdictHash as computeSettlementVerdictHash } from '@trustless-ai/agent-sdk/settlement/ERC8203/recompute'
import { AgentVerifierClient, getTrustedVerifier, ProofVerifierClient } from '@trustless-ai/agent-sdk/verify/ERC8274'
import { ObservationCommitmentClient } from '@trustless-ai/agent-sdk/verify/ERC8281'
import { computeObservationDigest } from '@trustless-ai/agent-sdk/verify/ERC8281/recompute'
import {
  computeRawProposalHash,
  computeVerdictHash as computeJudgmentVerdictHash,
  JudgmentExecutionClient,
  WyriweAttestationClient,
} from '@trustless-ai/agent-sdk/verify/ERC8299'
import {
  computeRawInputHash,
  computeSanitizationPipelineHash,
} from '@trustless-ai/agent-sdk/verify/ERC8299/recompute'
import { isAddress, type Account } from 'viem'
import { privateKeyToAccount, toAccount } from 'viem/accounts'

import { TasError } from '../../core/errors.js'
import type { EvmAddress } from '../../local/config/types.js'
import type { GeneratedToolEntry } from '../../mcp/manifest/types.js'

export interface AgentSdkInvocationContext {
  readonly chainId: string
  readonly rpcUrl: string
  readonly contractAddress?: EvmAddress
  readonly account?: Account
}

export interface AgentSdkBindingClient {
  accountFromAddress(address: EvmAddress): Account
  accountFromPrivateKey(secret: `0x${string}`): Account
  invoke(
    entry: GeneratedToolEntry,
    orderedArguments: readonly unknown[],
    context: AgentSdkInvocationContext,
  ): Promise<unknown>
}

type SdkConfig = { readonly rpcUrl: string; readonly address: EvmAddress }
type SdkClient = object
type SdkClientConstructor = new (config: SdkConfig, account: Account) => SdkClient
type SdkFunction = (...arguments_: never[]) => unknown

interface FunctionBinding {
  readonly kind: 'function'
  readonly target: string
  readonly chainBound: boolean
  readonly call: SdkFunction
}

interface ClassBinding {
  readonly kind: 'class_method'
  readonly target: string
  readonly Client: SdkClientConstructor
  readonly member: string
}

type RuntimeBinding = FunctionBinding | ClassBinding

const bindingUnavailableMessage = 'The requested agent-sdk binding is unavailable.'
const invocationFailureMessage = 'The agent-sdk operation could not be completed.'
const foundryChainId = '31337'

function bindingUnavailable(): never {
  throw new TasError('MANIFEST_BINDING_UNSUPPORTED', bindingUnavailableMessage)
}

function functionBinding(target: string, call: SdkFunction, chainBound = false): FunctionBinding {
  return Object.freeze({ kind: 'function', target, chainBound, call })
}

function classBinding(
  Client: SdkClientConstructor,
  exportName: string,
  member: string,
): ClassBinding {
  return Object.freeze({
    kind: 'class_method',
    target: `${exportName}.${member}`,
    Client,
    member,
  })
}

function classBindings(
  Client: SdkClientConstructor,
  exportName: string,
  members: readonly string[],
): ReadonlyMap<string, RuntimeBinding> {
  return new Map(members.map((member) => [member, classBinding(Client, exportName, member)]))
}

function functionBindings(
  values: Readonly<Record<string, SdkFunction>>,
  chainBound = false,
): ReadonlyMap<string, RuntimeBinding> {
  return new Map(Object.entries(values).map(([member, call]) => [
    member,
    functionBinding(member, call, chainBound),
  ]))
}

const reviewedBindings: ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, RuntimeBinding>>> = new Map([
  ['./anchor/ERC8263', new Map([
    ['OnChainProofClient', classBindings(OnChainProofClient, 'OnChainProofClient', ['anchor', 'anchorWithAux'])],
  ])],
  ['./execution/ERC8301', new Map([
    ['AgentWorkflowClient', classBindings(AgentWorkflowClient, 'AgentWorkflowClient', [
      'getReply', 'getTask', 'onAgentProve', 'onAgentReply', 'result', 'run',
    ])],
  ])],
  ['./execution/ERC8301/recompute', new Map([
    ['computeReplyHash', functionBindings({ computeReplyHash })],
    ['computeTaskHash', functionBindings({ computeTaskHash })],
  ])],
  ['./identity/ERC8004', new Map([
    ['IdentityRegistryClient', classBindings(IdentityRegistryClient, 'IdentityRegistryClient', [
      'getAgentURI', 'getAgentWallet', 'getMetadata', 'ownerOf', 'register', 'setAgentURI',
      'setAgentWallet', 'setMetadata', 'unsetAgentWallet',
    ])],
  ])],
  ['./identity/ERC8004/recompute', new Map([
    ['computeAgentId', functionBindings({ computeAgentId })],
  ])],
  ['./identity/ERC8323', new Map([
    ['SourceBindingClient', classBindings(SourceBindingClient, 'SourceBindingClient', [
      'boundCollection', 'getSourceNFT', 'hasSourceNFT', 'isSourceNFTOwnershipValid',
      'register', 'supportsSourceBinding',
    ])],
  ])],
  ['./reputation/ERC8275', new Map([
    ['AgentReputationClient', classBindings(AgentReputationClient, 'AgentReputationClient', [
      'getDecayWeight', 'getReputation', 'verifyOutcome',
    ])],
  ])],
  ['./reputation/ERC8275/recompute', new Map([
    ['computeWinRate', functionBindings({ computeWinRate })],
  ])],
  ['./settlement/ERC8203', new Map([
    ['ConsultEscrowClient', classBindings(ConsultEscrowClient, 'ConsultEscrowClient', [
      'getJob', 'open', 'parseOpened', 'parseRefunded', 'parseReleased', 'refund', 'release', 'verify',
    ])],
  ])],
  ['./settlement/ERC8203/recompute', new Map([
    ['computeVerdictHash', functionBindings({ computeVerdictHash: computeSettlementVerdictHash })],
  ])],
  ['./verify/ERC8274', new Map([
    ['AgentVerifierClient', classBindings(AgentVerifierClient, 'AgentVerifierClient', ['verify'])],
    ['getTrustedVerifier', functionBindings({ getTrustedVerifier }, true)],
    ['ProofVerifierClient', classBindings(ProofVerifierClient, 'ProofVerifierClient', [
      'proofProfile', 'proofSystem', 'verify',
    ])],
  ])],
  ['./verify/ERC8281', new Map([
    ['ObservationCommitmentClient', classBindings(ObservationCommitmentClient, 'ObservationCommitmentClient', [
      'parseRecordedEvent', 'record', 'supportsObservationCommitment',
    ])],
  ])],
  ['./verify/ERC8281/recompute', new Map([
    ['computeObservationDigest', functionBindings({ computeObservationDigest })],
  ])],
  ['./verify/ERC8299', new Map([
    ['computeRawProposalHash', functionBindings({ computeRawProposalHash })],
    ['computeVerdictHash', functionBindings({ computeVerdictHash: computeJudgmentVerdictHash })],
    ['JudgmentExecutionClient', classBindings(JudgmentExecutionClient, 'JudgmentExecutionClient', [
      'proofSystem', 'verify',
    ])],
    ['WyriweAttestationClient', classBindings(WyriweAttestationClient, 'WyriweAttestationClient', [
      'proofSystem', 'verify',
    ])],
  ])],
  ['./verify/ERC8299/recompute', new Map([
    ['computeRawInputHash', functionBindings({ computeRawInputHash })],
    ['computeSanitizationPipelineHash', functionBindings({ computeSanitizationPipelineHash })],
  ])],
])

function bindingFor(entry: GeneratedToolEntry): RuntimeBinding {
  const { entrypoint, export: exportName, member } = entry.source
  const binding = reviewedBindings.get(entrypoint)?.get(exportName)?.get(member)
  if (binding === undefined
    || entry.binding.kind !== binding.kind
    || entry.binding.target !== binding.target) return bindingUnavailable()
  if (binding.kind === 'class_method') {
    const descriptor = Object.getOwnPropertyDescriptor(binding.Client.prototype, binding.member)
    if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'function') {
      return bindingUnavailable()
    }
  }
  return binding
}

function requireFoundryChain(context: AgentSdkInvocationContext): void {
  if (context.chainId !== foundryChainId) bindingUnavailable()
}

function requireClassContext(context: AgentSdkInvocationContext): {
  readonly config: SdkConfig
  readonly account: Account
} {
  requireFoundryChain(context)
  if (context.contractAddress === undefined || !isAddress(context.contractAddress)
    || context.account === undefined || !isAddress(context.account.address)) return bindingUnavailable()
  return {
    config: { rpcUrl: context.rpcUrl, address: context.contractAddress },
    account: context.account,
  }
}

async function invokeReviewed(
  binding: RuntimeBinding,
  orderedArguments: readonly unknown[],
  context: AgentSdkInvocationContext,
): Promise<unknown> {
  if (binding.kind === 'function') {
    if (binding.chainBound) {
      requireFoundryChain(context)
      if (context.contractAddress === undefined || !isAddress(context.contractAddress)) bindingUnavailable()
    }
    return await Reflect.apply(binding.call, undefined, orderedArguments) ?? null
  }

  const { config, account } = requireClassContext(context)
  const client = new binding.Client(config, account)
  const method = Reflect.get(client, binding.member)
  if (typeof method !== 'function') return bindingUnavailable()
  return await Reflect.apply(method, client, orderedArguments) ?? null
}

/** Creates the reviewed runtime adapter after validating the complete bundled Manifest inventory. */
export function createAgentSdkBindingClient(entries: readonly GeneratedToolEntry[]): AgentSdkBindingClient {
  for (const entry of entries) bindingFor(entry)
  return Object.freeze({
    accountFromAddress(address: EvmAddress): Account {
      return toAccount(address)
    },
    accountFromPrivateKey(secret: `0x${string}`): Account {
      return privateKeyToAccount(secret)
    },
    async invoke(
      entry: GeneratedToolEntry,
      orderedArguments: readonly unknown[],
      context: AgentSdkInvocationContext,
    ): Promise<unknown> {
      try {
        return await invokeReviewed(bindingFor(entry), orderedArguments, context)
      } catch (error) {
        if (error instanceof TasError && error.code === 'MANIFEST_BINDING_UNSUPPORTED') throw error
        throw new Error(invocationFailureMessage)
      }
    },
  })
}
