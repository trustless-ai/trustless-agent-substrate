import type { AgentSdkBindingClient } from '../../clients/workflow/agentSdkClient.js'
import type { EvmJsonValue } from '../../clients/chain/jsonCodec.js'
import type { CanonicalDecimal, EvmAddress } from '../../local/config/types.js'
import type { GeneratedToolEntry } from '../../mcp/manifest/types.js'
import type { AgentProjection, ResolvedProfile } from '../profile/resolver.js'
import type { ChainSelector } from '../profile/types.js'

export type VerifiedWorkflowBlockSelector = Extract<
  ChainSelector,
  { readonly kind: 'block_hash' }
>

export interface VerifiedWorkflowContext {
  readonly chainId: CanonicalDecimal
  readonly rpcUrl: string
  readonly workflowAddress: EvmAddress
  /** Pins source verification and member authorization to one immutable chain state. */
  readonly blockSelector: VerifiedWorkflowBlockSelector
  readonly fingerprint: string
}

export interface WorkflowVerificationGate {
  assertCurrent(signal?: AbortSignal): Promise<VerifiedWorkflowContext>
}

export interface MutableWorkflowVerificationGate extends WorkflowVerificationGate {
  accept(context: VerifiedWorkflowContext): void
  assertAccepted(context: VerifiedWorkflowContext): VerifiedWorkflowContext
  invalidate(): void
}

export interface WorkflowOperationRegistry {
  get(toolName: string): GeneratedToolEntry | undefined
}

export interface WorkflowMemberResolver {
  getAgent(
    agentId: string,
    selector: VerifiedWorkflowBlockSelector,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ResolvedProfile<AgentProjection>>
}

/**
 * Chooses the contract required by one reviewed SDK operation.
 *
 * The Workflow address from the verified Profile is available in `context`,
 * but this boundary must make any ERC-specific address choice explicitly.
 */
export interface WorkflowContractAddressResolver {
  resolve(entry: GeneratedToolEntry, context: VerifiedWorkflowContext): Promise<EvmAddress>
}

export interface WorkflowOperationInvocation {
  readonly toolName: string
  readonly arguments: Readonly<Record<string, unknown>>
}

export interface WorkflowOperationService {
  invoke(invocation: WorkflowOperationInvocation, options?: { readonly signal?: AbortSignal }): Promise<EvmJsonValue>
}

export interface WorkflowOperationServiceOptions {
  readonly agentId: CanonicalDecimal
  readonly gate: WorkflowVerificationGate
  readonly registry: WorkflowOperationRegistry
  readonly memberResolver: WorkflowMemberResolver
  readonly contractAddressResolver: WorkflowContractAddressResolver
  readonly client: AgentSdkBindingClient
}
