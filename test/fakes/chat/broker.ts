import type {
  ChatClientEvent,
  ChatClientOperation,
  ChatClientWaitOptions,
  ChatClientWaitRequest,
  ChatClientWaitResult,
  ChatPlatform,
} from '../../../src/core/chat/types.js'

export interface FakeChatEvent extends ChatClientEvent {
  readonly platform: ChatPlatform
  readonly source: string
}

export interface FakeChatSend {
  readonly platform: ChatPlatform
  readonly source: string
  readonly conversationId: string
  readonly toolName: string
  readonly bindingTarget: string
  readonly arguments: Readonly<Record<string, unknown>>
}

interface StoredEvent extends FakeChatEvent {
  readonly sequence: number
}

interface Waiter {
  readonly platform: ChatPlatform
  readonly source: string
  readonly request: ChatClientWaitRequest
  readonly resolve: (result: ChatClientWaitResult) => void
  readonly reject: (error: Error) => void
  readonly clear: () => void
}

function cursor(platform: ChatPlatform, sequence: number): string {
  return `${platform}:${sequence}`
}

function cursorSequence(platform: ChatPlatform, value: string | undefined): number {
  if (value === undefined) return 0
  const match = /^(telegram|discord):([1-9][0-9]*)$/.exec(value)
  if (match === null || match[1] !== platform) throw new TypeError('The fake Chat cursor is invalid for this platform.')
  return Number(match[2])
}

function abortError(): Error {
  const error = new Error('The fake Chat wait was aborted.')
  error.name = 'AbortError'
  return error
}

/** Deterministic, test-only event broker shared by isolated fake platform Clients. */
export class FakeChatBroker {
  readonly #events: StoredEvent[] = []
  readonly #sends: FakeChatSend[] = []
  readonly #sequences = new Map<ChatPlatform, number>()
  readonly #waiters = new Set<Waiter>()

  append(event: FakeChatEvent): void {
    const sequence = (this.#sequences.get(event.platform) ?? 0) + 1
    this.#sequences.set(event.platform, sequence)
    this.#events.push({ ...event, sequence })
    for (const waiter of [...this.#waiters]) {
      const result = this.#available(waiter.platform, waiter.source, waiter.request)
      if (result.nextCursor !== undefined) {
        waiter.clear()
        waiter.resolve(result)
      }
    }
  }

  sends(): readonly FakeChatSend[] {
    return [...this.#sends]
  }

  capture(platform: ChatPlatform, source: string, operation: ChatClientOperation): void {
    this.#sends.push({
      platform,
      source,
      conversationId: operation.target.conversationId,
      toolName: operation.toolName,
      bindingTarget: operation.bindingTarget,
      arguments: operation.arguments,
    })
  }

  wait(
    platform: ChatPlatform,
    source: string,
    request: ChatClientWaitRequest,
    options: ChatClientWaitOptions = {},
  ): Promise<ChatClientWaitResult> {
    const available = this.#available(platform, source, request)
    if (available.nextCursor !== undefined) return Promise.resolve(available)
    if (options.signal?.aborted) return Promise.reject(abortError())
    return new Promise<ChatClientWaitResult>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      let removeAbortListener: (() => void) | undefined
      const waiter: Waiter = {
        platform,
        source,
        request,
        resolve,
        reject,
        clear: () => {
          this.#waiters.delete(waiter)
          if (timeout !== undefined) clearTimeout(timeout)
          removeAbortListener?.()
        },
      }
      timeout = setTimeout(() => {
        waiter.clear()
        resolve({ events: [] })
      }, request.waitBoundMs)
      if (options.signal !== undefined) {
        const onAbort = () => {
          waiter.clear()
          reject(abortError())
        }
        options.signal.addEventListener('abort', onAbort, { once: true })
        removeAbortListener = () => options.signal?.removeEventListener('abort', onAbort)
      }
      this.#waiters.add(waiter)
    })
  }

  #available(platform: ChatPlatform, source: string, request: ChatClientWaitRequest): ChatClientWaitResult {
    const after = cursorSequence(platform, request.cursor)
    const sourceEvents = this.#events.filter((event) => event.platform === platform && event.source === source && event.sequence > after)
    const targetConversationIds = new Set(request.targetConversationIds)
    const events = sourceEvents.filter((event) => targetConversationIds.has(event.conversationId))
      .map(({ platform: _platform, source: _source, sequence: _sequence, ...event }) => event)
    const latest = sourceEvents.at(-1)
    return latest === undefined ? { events } : { events, nextCursor: cursor(platform, latest.sequence) }
  }
}

export function createFakeChatBroker(): FakeChatBroker {
  return new FakeChatBroker()
}
