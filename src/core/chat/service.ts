import { TasError } from '../errors.js'
import type { PublicJsonValue } from '../../mcp/results.js'
import type {
  ChatAuthenticatedClient,
  ChatClientFactory,
  ChatClientWaitRequest,
  ChatClientWaitResult,
  ChatConfiguredSource,
  ChatConfiguredTarget,
  ChatCredential,
  ChatEvent,
  ChatPlatform,
  ChatWaitResult,
} from './types.js'

export interface ChatOperationInvocation {
  readonly platform: ChatPlatform
  readonly toolName: string
  readonly bindingTarget: string
  readonly arguments: Readonly<Record<string, unknown>>
}

export interface ChatWaitInvocation {
  readonly platform: ChatPlatform
  readonly source: string
  readonly cursor?: string
  readonly waitBoundMs: number
  readonly credential?: unknown
  readonly signal?: AbortSignal
}

export interface ChatService {
  /** Configured platform groups for which callers may register generated tools. */
  platforms(): readonly ChatPlatform[]
  invoke(invocation: ChatOperationInvocation): Promise<PublicJsonValue>
  wait(invocation: ChatWaitInvocation): Promise<ChatWaitResult>
}

export interface ChatServiceOptions {
  readonly sources: readonly ChatConfiguredSource[]
  readonly targets: readonly ChatConfiguredTarget[]
  readonly factories: Readonly<Partial<Record<ChatPlatform, ChatClientFactory>>>
}

function invalidArgument(): never {
  throw new TasError('INVALID_ARGUMENT', 'The request arguments are invalid.')
}

function requiredCredential(value: unknown): ChatCredential {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TasError('CREDENTIAL_REQUIRED', 'A valid operation credential is required.')
  }
  const candidate = value as Record<string, unknown>
  if (candidate.type !== 'inline' || typeof candidate.secret !== 'string' || candidate.secret.length === 0 || candidate.secret.length > 4_096) {
    throw new TasError('CREDENTIAL_REQUIRED', 'A valid operation credential is required.')
  }
  return { type: 'inline', secret: candidate.secret }
}

function sourcePollIntervalMs(value: string): number {
  const match = /^(0|[1-9][0-9]*)(ms|s|m)$/.exec(value)
  if (match === null) return invalidArgument()
  const amount = Number(match[1])
  const multiplier = match[2] === 'ms' ? 1 : match[2] === 's' ? 1_000 : 60_000
  const milliseconds = amount * multiplier
  return Number.isSafeInteger(milliseconds) && milliseconds >= 1_000 && milliseconds <= 60_000
    ? milliseconds
    : invalidArgument()
}

function waitBound(value: number): number {
  return Number.isSafeInteger(value) && value >= 1 && value <= 60_000 ? value : invalidArgument()
}

function cursor(value: string | undefined): string | undefined {
  return value === undefined || (typeof value === 'string' && value.length > 0) ? value : invalidArgument()
}

function abortError(): Error {
  const error = new Error('The Chat wait was aborted.')
  error.name = 'AbortError'
  return error
}

const waitTimedOut = Symbol('chat wait timed out')

async function waitWithinBound(
  client: ChatAuthenticatedClient,
  request: ChatClientWaitRequest,
  waitBoundMs: number,
  signal?: AbortSignal,
): Promise<ChatClientWaitResult | typeof waitTimedOut> {
  if (signal?.aborted) throw abortError()
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let removeAbortListener: (() => void) | undefined
  const timeout = new Promise<typeof waitTimedOut>((resolve) => {
    timer = setTimeout(() => {
      resolve(waitTimedOut)
      controller.abort()
    }, waitBoundMs)
  })
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal === undefined) return
    const onAbort = () => {
      controller.abort()
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    removeAbortListener = () => signal.removeEventListener('abort', onAbort)
  })
  try {
    return await Promise.race([client.wait(request, { signal: controller.signal }), timeout, aborted])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    removeAbortListener?.()
  }
}

function argumentsWithoutTasInputs(arguments_: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const { credential: _credential, target: _target, ...operationArguments } = arguments_
  return operationArguments
}

export function createChatService(options: ChatServiceOptions): ChatService {
  const sources = new Map(options.sources.map((source) => [source.name, source]))
  const targets = new Map(options.targets.map((target) => [target.name, target]))
  const sourceTargets = new Map<string, readonly ChatConfiguredTarget[]>()
  for (const source of options.sources) sourceTargets.set(source.name, options.targets.filter((target) => target.source === source.name))
  const platforms = [...new Set(options.sources
    .filter((source) => options.factories[source.platform] !== undefined)
    .map((source) => source.platform))]

  async function clientFor(source: ChatConfiguredSource, credential: ChatCredential): Promise<ChatAuthenticatedClient> {
    const factory = options.factories[source.platform]
    if (factory === undefined) throw new TasError('EXTERNAL_UNAVAILABLE', 'The configured chat service is unavailable.')
    return factory.create({ source, credential })
  }

  return {
    platforms: () => platforms,
    async invoke(invocation: ChatOperationInvocation): Promise<PublicJsonValue> {
      const targetName = invocation.arguments.target
      if (typeof targetName !== 'string' || targetName.length === 0) return invalidArgument()
      const target = targets.get(targetName)
      if (target === undefined) return invalidArgument()
      const source = sources.get(target.source)
      if (source === undefined || source.platform !== invocation.platform) return invalidArgument()
      const authenticatedClient = await clientFor(source, requiredCredential(invocation.arguments.credential))
      return authenticatedClient.invoke({
        toolName: invocation.toolName,
        bindingTarget: invocation.bindingTarget,
        target,
        arguments: argumentsWithoutTasInputs(invocation.arguments),
      })
    },
    async wait(invocation: ChatWaitInvocation): Promise<ChatWaitResult> {
      const source = sources.get(invocation.source)
      if (source === undefined || source.platform !== invocation.platform) return invalidArgument()
      const configuredTargets = sourceTargets.get(source.name) ?? []
      if (configuredTargets.length === 0) return invalidArgument()
      const request = {
        cursor: cursor(invocation.cursor),
        waitBoundMs: waitBound(invocation.waitBoundMs),
        pollIntervalMs: sourcePollIntervalMs(source.pollInterval),
        targetConversationIds: configuredTargets.map((target) => target.conversationId),
      }
      const credential = requiredCredential(invocation.credential)
      if (invocation.signal?.aborted) throw abortError()
      const authenticatedClient = await clientFor(source, credential)
      const result = await waitWithinBound(authenticatedClient, request, request.waitBoundMs, invocation.signal)
      if (result === waitTimedOut) return { events: [] }
      const targetByConversation = new Map(configuredTargets.map((target) => [target.conversationId, target]))
      const events: ChatEvent[] = []
      for (const event of result.events) {
        const target = targetByConversation.get(event.conversationId)
        if (target !== undefined) events.push({
          source: source.name,
          target: target.name,
          platformEventId: event.platformEventId,
          platformEventType: event.platformEventType,
          timestamp: event.timestamp,
          sender: event.sender,
          platformPayload: event.platformPayload,
        })
      }
      return result.nextCursor === undefined ? { events } : { events, nextCursor: result.nextCursor }
    },
  }
}
