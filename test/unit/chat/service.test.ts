import { describe, expect, it } from 'vitest'

import { TasError } from '../../../src/core/errors.js'
import { createChatService } from '../../../src/core/chat/service.js'
import type {
  ChatAuthenticatedClient,
  ChatClientFactory,
  ChatConfiguredSource,
  ChatConfiguredTarget,
} from '../../../src/core/chat/types.js'

const sources: readonly ChatConfiguredSource[] = [
  { name: 'telegram-main', platform: 'telegram', pollInterval: '6s' },
  { name: 'discord-main', platform: 'discord', pollInterval: '10s' },
]
const targets: readonly ChatConfiguredTarget[] = [
  { name: 'telegram-contributors', source: 'telegram-main', conversationId: '-100123' },
  { name: 'telegram-evaluators', source: 'telegram-main', conversationId: '-100456' },
  { name: 'discord-evaluators', source: 'discord-main', conversationId: '987654' },
]
const credential = { type: 'inline', secret: 'bot-token' } as const

function client(overrides: Partial<ChatAuthenticatedClient> = {}): ChatAuthenticatedClient {
  return {
    invoke: async () => ({ accepted: true }),
    wait: async () => ({ events: [], nextCursor: 'next' }),
    ...overrides,
  }
}

function factory(create: ChatClientFactory['create']): ChatClientFactory {
  return { create }
}

describe('Chat service', () => {
  it('routes a generated operation only to its configured platform target with one scoped client', async () => {
    const created: unknown[] = []
    const operations: unknown[] = []
    const service = createChatService({
      sources,
      targets,
      factories: {
        telegram: factory(async (authentication) => {
          created.push(authentication)
          return client({ invoke: async (operation) => { operations.push(operation); return { sent: '42' } } })
        }),
      },
    })

    await expect(service.invoke({
      platform: 'telegram',
      toolName: 'chat.telegram.api.send_message',
      bindingTarget: 'Api.sendMessage',
      arguments: { target: 'telegram-contributors', text: 'hello', credential },
    })).resolves.toEqual({ sent: '42' })
    expect(created).toEqual([{ source: sources[0], credential }])
    expect(operations).toEqual([{
      toolName: 'chat.telegram.api.send_message',
      bindingTarget: 'Api.sendMessage',
      target: targets[0],
      arguments: { text: 'hello' },
    }])
  })

  it.each([
    ['an arbitrary target', 'telegram-main', 'telegram-main'],
    ['a cross-platform target', 'discord-evaluators', 'telegram-main'],
  ])('rejects %s before constructing a client', async (_label, target) => {
    let clients = 0
    const service = createChatService({
      sources,
      targets,
      factories: { telegram: factory(async () => { clients += 1; return client() }) },
    })

    await expect(service.invoke({
      platform: 'telegram', toolName: 'chat.telegram.api.send_message', bindingTarget: 'Api.sendMessage',
      arguments: { target, text: 'hello', credential },
    })).rejects.toMatchObject<TasError>({ code: 'INVALID_ARGUMENT' })
    expect(clients).toBe(0)
  })

  it.each([
    ['missing', undefined],
    ['invalid type', { type: 'bearer', secret: 'bot-token' }],
    ['empty secret', { type: 'inline', secret: '' }],
  ])('rejects a %s credential without creating a client', async (_label, suppliedCredential) => {
    let clients = 0
    const service = createChatService({
      sources,
      targets,
      factories: { telegram: factory(async () => { clients += 1; return client() }) },
    })

    await expect(service.invoke({
      platform: 'telegram', toolName: 'chat.telegram.api.send_message', bindingTarget: 'Api.sendMessage',
      arguments: { target: 'telegram-contributors', credential: suppliedCredential },
    })).rejects.toMatchObject<TasError>({ code: 'CREDENTIAL_REQUIRED' })
    expect(clients).toBe(0)
  })

  it('passes a caller-owned cursor and normalizes platform events without retaining delivery state', async () => {
    const waits: unknown[] = []
    const service = createChatService({
      sources,
      targets,
      factories: {
        telegram: factory(async () => client({
          wait: async (request) => {
            waits.push(request)
            return {
              events: [{
                conversationId: '-100456', platformEventId: 'update-19', platformEventType: 'message',
                timestamp: '2026-08-23T10:00:00.000Z',
                sender: { id: 'agent-7', displayName: 'Evaluator' }, platformPayload: { text: 'score ready' },
              }],
              nextCursor: 'telegram-offset-20',
            }
          },
        })),
      },
    })

    const first = await service.wait({
      platform: 'telegram', source: 'telegram-main', cursor: 'telegram-offset-18', waitBoundMs: 100,
      credential,
    })
    const second = await service.wait({
      platform: 'telegram', source: 'telegram-main', waitBoundMs: 100, credential,
    })

    expect(first).toEqual({
      events: [{
        source: 'telegram-main', target: 'telegram-evaluators', platformEventId: 'update-19', platformEventType: 'message',
        timestamp: '2026-08-23T10:00:00.000Z', sender: { id: 'agent-7', displayName: 'Evaluator' },
        platformPayload: { text: 'score ready' },
      }],
      nextCursor: 'telegram-offset-20',
    })
    expect(second.nextCursor).toBe('telegram-offset-20')
    expect(waits).toEqual([
      { cursor: 'telegram-offset-18', waitBoundMs: 100, pollIntervalMs: 6_000, targetConversationIds: ['-100123', '-100456'] },
      { cursor: undefined, waitBoundMs: 100, pollIntervalMs: 6_000, targetConversationIds: ['-100123', '-100456'] },
    ])
  })

  it('preserves primitive and array platform-native payloads', async () => {
    let call = 0
    const service = createChatService({
      sources,
      targets,
      factories: {
        telegram: factory(async () => client({
          wait: async () => ({
            events: [{
              conversationId: '-100123', platformEventId: `update-${call}`,
              platformEventType: 'message', timestamp: '2026-08-23T10:00:00.000Z', sender: null,
              platformPayload: call++ === 0 ? 'native-text' : ['native', 7, null],
            }],
          }),
        })),
      },
    })

    const primitive = await service.wait({
      platform: 'telegram', source: 'telegram-main', waitBoundMs: 100, credential,
    })
    const array = await service.wait({
      platform: 'telegram', source: 'telegram-main', waitBoundMs: 100, credential,
    })

    expect(primitive.events[0]?.platformPayload).toBe('native-text')
    expect(array.events[0]?.platformPayload).toEqual(['native', 7, null])
  })

  it('returns an empty successful result at the bounded wait timeout', async () => {
    const service = createChatService({
      sources,
      targets,
      factories: { discord: factory(async () => client({ wait: async () => ({ events: [] }) })) },
    })

    await expect(service.wait({
      platform: 'discord', source: 'discord-main', waitBoundMs: 1, credential,
    })).resolves.toEqual({ events: [] })
  })

  it('enforces the wait bound, aborts the Client wait, and returns an empty success', async () => {
    let clientSignal: AbortSignal | undefined
    const service = createChatService({
      sources,
      targets,
      factories: {
        telegram: factory(async () => client({
          wait: (async (...arguments_: unknown[]) => {
            clientSignal = (arguments_[1] as { signal?: AbortSignal } | undefined)?.signal
            return new Promise(() => {})
          }) as ChatAuthenticatedClient['wait'],
        })),
      },
    })

    await expect(service.wait({
      platform: 'telegram', source: 'telegram-main', waitBoundMs: 1, credential,
    })).resolves.toEqual({ events: [] })
    expect(clientSignal?.aborted).toBe(true)
  }, 500)

  it('validates malformed wait inputs before constructing a Client', async () => {
    let clients = 0
    const service = createChatService({
      sources,
      targets,
      factories: { telegram: factory(async () => { clients += 1; return client() }) },
    })

    await expect(service.wait({
      platform: 'telegram', source: 'telegram-main', cursor: '', waitBoundMs: 0, credential,
    })).rejects.toMatchObject<TasError>({ code: 'INVALID_ARGUMENT' })
    expect(clients).toBe(0)
  })

  it('propagates caller cancellation to the Client wait', async () => {
    const caller = new AbortController()
    let clientSignal: AbortSignal | undefined
    let entered!: () => void
    const enteredWait = new Promise<void>((resolve) => { entered = resolve })
    const service = createChatService({
      sources,
      targets,
      factories: {
        telegram: factory(async () => client({
          wait: (async (...arguments_: unknown[]) => {
            clientSignal = (arguments_[1] as { signal?: AbortSignal } | undefined)?.signal
            entered()
            return new Promise(() => {})
          }) as ChatAuthenticatedClient['wait'],
        })),
      },
    })

    const waiting = service.wait({
      platform: 'telegram', source: 'telegram-main', waitBoundMs: 1_000, credential, signal: caller.signal,
    } as never)
    await enteredWait
    caller.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    expect(clientSignal?.aborted).toBe(true)
  }, 500)
})
