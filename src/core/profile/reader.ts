import type { ChainSelector, ProfileSnapshot, RawAgentSnapshot } from './types.js'

export interface ProfileReadOptions {
  readonly signal?: AbortSignal
}

export interface ProfileReader {
  readProfile(selector: ChainSelector, options?: ProfileReadOptions): Promise<ProfileSnapshot>
  readAgent(agentId: string, selector: ChainSelector, options?: ProfileReadOptions): Promise<RawAgentSnapshot>
}
