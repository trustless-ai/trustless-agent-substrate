import type { EvmAddress } from '../../local/config/types.js'

export type ChainSelector =
  | { readonly kind: 'latest' }
  | { readonly kind: 'safe' }
  | { readonly kind: 'finalized' }
  | { readonly kind: 'block_number'; readonly blockNumber: string }
  | { readonly kind: 'block_hash'; readonly blockHash: `0x${string}` }

export interface RawCharter {
  readonly repository: string
  readonly commitHash: string
  readonly path: string
}
export interface RawDataEntry {
  readonly key: string
  readonly exists: boolean
  readonly data: string
}

export interface RawWorkflow {
  readonly workflowAddress: EvmAddress
  readonly data: string
}

export interface ProfileSnapshot {
  readonly chainId: string
  readonly tawgAddress: EvmAddress
  readonly blockNumber: string
  readonly blockHash: `0x${string}`
  readonly version: string
  readonly governance: EvmAddress
  readonly identityRegistry: EvmAddress
  readonly charter: RawCharter
  readonly agentIds: readonly string[]
  readonly dataEntries: readonly RawDataEntry[]
  readonly workflow: RawWorkflow
}

export interface RawAgentSnapshot {
  readonly chainId: string
  readonly tawgAddress: EvmAddress
  readonly blockNumber: string
  readonly blockHash: `0x${string}`
  readonly version: string
  readonly identityRegistry: EvmAddress
  readonly agentId: string
  readonly isMember: boolean
  readonly data: string
  readonly agentVerifier: EvmAddress
  readonly authenticationWallet?: EvmAddress
}
