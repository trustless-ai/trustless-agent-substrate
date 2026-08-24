import type { PublicJsonObject, PublicJsonValue } from '../../mcp/results.js'

export type ChatPlatform = 'telegram' | 'discord'

export interface ChatCredential {
  readonly type: 'inline'
  readonly secret: string
}

export interface ChatConfiguredSource {
  readonly name: string
  readonly platform: ChatPlatform
  readonly pollInterval: string
}

export interface ChatConfiguredTarget {
  readonly name: string
  readonly source: string
  readonly conversationId: string
}

export interface ChatClientAuthentication {
  readonly source: ChatConfiguredSource
  readonly credential: ChatCredential
}

export interface ChatClientOperation {
  readonly toolName: string
  readonly bindingTarget: string
  /** A configured target; callers never supply its conversation ID. */
  readonly target: ChatConfiguredTarget
  /** Generated arguments excluding TAS-owned target selection and credential. */
  readonly arguments: Readonly<Record<string, unknown>>
}

export interface ChatClientWaitRequest {
  readonly cursor?: string
  readonly waitBoundMs: number
  readonly pollIntervalMs: number
  readonly targetConversationIds: readonly string[]
}

/** Platform-native delivery data before TAS binds it to one configured target. */
export interface ChatClientEvent {
  readonly conversationId: string
  readonly platformEventId: string
  readonly platformEventType: string
  readonly timestamp: string
  readonly sender: PublicJsonObject | null
  readonly platformPayload: PublicJsonValue
}

export interface ChatClientWaitResult {
  readonly events: readonly ChatClientEvent[]
  readonly nextCursor?: string
}

export interface ChatClientWaitOptions {
  readonly signal?: AbortSignal
}

/** One authenticated, operation-scoped platform client. */
export interface ChatAuthenticatedClient {
  invoke(operation: ChatClientOperation): Promise<PublicJsonValue>
  wait(request: ChatClientWaitRequest, options?: ChatClientWaitOptions): Promise<ChatClientWaitResult>
}

/** Creates a fresh authenticated client for exactly one TAS operation. */
export interface ChatClientFactory {
  create(authentication: ChatClientAuthentication): Promise<ChatAuthenticatedClient> | ChatAuthenticatedClient
}

/** A platform-neutral delivery event. Its cursor/order semantics remain platform-specific. */
export interface ChatEvent {
  readonly source: string
  readonly target: string
  readonly platformEventId: string
  readonly platformEventType: string
  readonly timestamp: string
  readonly sender: PublicJsonObject | null
  readonly platformPayload: PublicJsonValue
}

export interface ChatWaitResult {
  readonly events: readonly ChatEvent[]
  readonly nextCursor?: string
}
