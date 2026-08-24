export type CanonicalDecimal = string
export type EvmAddress = `0x${string}`

export interface ResolvedChainConfig {
  readonly family: 'evm'
  readonly rpcUrl: string
  readonly rpcSource: 'config' | 'environment'
}

export interface ChatSourceConfig {
  readonly name: string
  readonly platform: 'telegram' | 'discord'
  readonly pollInterval: string
}

export interface ChatTargetConfig {
  readonly name: string
  readonly source: string
  readonly conversationId: string
}

export interface ProofProviderConfig {
  readonly name: string
  readonly type: 'attestation'
  readonly integration: string
  readonly baseUrl: string
}

export interface IdentitySetupTasConfig {
  readonly configVersion: 1
  readonly mode: 'identity_setup'
  readonly identitySetup: {
    readonly chainId: CanonicalDecimal
    readonly identityRegistryAddress: EvmAddress
  }
  readonly chain: ResolvedChainConfig
}

export interface TawgSetupTasConfig {
  readonly configVersion: 1
  readonly mode: 'tawg_setup'
  readonly tawgSetup: {
    readonly chainId: CanonicalDecimal
    readonly tawgAddress: EvmAddress
  }
  readonly chain: ResolvedChainConfig
}

export interface MemberTasConfig {
  readonly configVersion: 1
  readonly mode: 'member'
  readonly instance: {
    readonly chainId: CanonicalDecimal
    readonly tawgAddress: EvmAddress
    readonly agentId: CanonicalDecimal
  }
  readonly chain: ResolvedChainConfig
  readonly repository: { readonly client: 'github' }
  readonly da: { readonly client: 'git' }
  readonly chat: {
    readonly sources: readonly ChatSourceConfig[]
    readonly targets: readonly ChatTargetConfig[]
  }
  readonly proofProviders: readonly ProofProviderConfig[]
}

export type ResolvedTasConfig = IdentitySetupTasConfig | TawgSetupTasConfig | MemberTasConfig
