import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createChatService } from '../../src/core/chat/service.js'
import type { ChatConfiguredSource, ChatConfiguredTarget } from '../../src/core/chat/types.js'
import { registerChatWaitTools } from '../../src/mcp/chatWaitTools.js'
import { isChatGeneratedToolEntry, registerGeneratedChatTools } from '../../src/mcp/generatedChatTools.js'
import { getManifestRegistry } from '../../src/mcp/manifest/registry.js'
import { createFakeChatBroker } from '../fakes/chat/broker.js'
import { createFakeDiscordClient } from '../fakes/chat/fakeDiscordClient.js'
import { createFakeTelegramClient } from '../fakes/chat/fakeTelegramClient.js'

const instanceBase = {
  phase: 'member', chain_id: '31337', tawg_address: '0x1000000000000000000000000000000000000001',
} as const
const credential = { type: 'inline', secret: 'offline-chat-credential' } as const
const sources = [
  { name: 'telegram-main', platform: 'telegram', pollInterval: '1s' },
  { name: 'discord-main', platform: 'discord', pollInterval: '1s' },
] as const satisfies readonly ChatConfiguredSource[]
const targets = [
  { name: 'contribution-mentions', source: 'telegram-main', conversationId: '-100-contributions' },
  { name: 'evaluator-replies', source: 'telegram-main', conversationId: '-100-evaluators' },
  { name: 'discord-reviews', source: 'discord-main', conversationId: 'review-channel' },
] as const satisfies readonly ChatConfiguredTarget[]

async function compose(broker: ReturnType<typeof createFakeChatBroker>, agentId = '42') {
  const instance = { ...instanceBase, agent_id: agentId } as const
  const service = createChatService({
    sources,
    targets,
    factories: {
      telegram: createFakeTelegramClient(broker),
      discord: createFakeDiscordClient(broker),
    },
  })
  const server = new McpServer({ name: 'offline-chat-test', version: '1' })
  const registry = getManifestRegistry()
  const entries = Object.freeze([...registry.list('telegram'), ...registry.list('discord')]
    .filter(isChatGeneratedToolEntry))
  registerGeneratedChatTools(server, entries, service, instance)
  registerChatWaitTools(server, service, sources, instance)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const received = new Map<number, unknown>()
  clientTransport.onmessage = (message) => {
    if ('id' in message && typeof message.id === 'number') received.set(message.id, message)
  }

  async function close(): Promise<void> {
    const results = await Promise.allSettled([server.close(), clientTransport.close()])
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure !== undefined) throw failure.reason
  }

  async function request(id: number, method: string, params: Record<string, unknown>): Promise<unknown> {
    await clientTransport.send({ jsonrpc: '2.0', id, method, params })
    for (let attempt = 0; attempt < 100 && !received.has(id); attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }
    return received.get(id)
  }

  try {
    await server.connect(serverTransport)
    await clientTransport.start()
    await request(1, 'initialize', {
      protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'offline-chat-test', version: '1' },
    })
    await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    return { request, close }
  } catch (error) {
    try { await close() } catch { /* preserve the initialization failure */ }
    throw error
  }
}

function waitData(response: unknown): { events: Array<Record<string, unknown>>; next_cursor?: string } {
  return (response as { result: { structuredContent: { data: { events: Array<Record<string, unknown>>; next_cursor?: string } } } })
    .result.structuredContent.data
}

function responseAgentId(response: unknown): string {
  return (response as { result: { structuredContent: { context: { instance: { agent_id: string } } } } })
    .result.structuredContent.context.instance.agent_id
}

describe('offline Chat Clients', () => {
  afterEach(() => { vi.useRealTimers() })

  it('resolves an empty fake Client wait exactly at its request bound', async () => {
    vi.useFakeTimers()
    const broker = createFakeChatBroker()
    const client = await createFakeTelegramClient(broker).create({ source: sources[0], credential })
    let result: unknown = 'pending'
    const waiting = client.wait({
      waitBoundMs: 25, pollIntervalMs: 1_000, targetConversationIds: ['-100-contributions'],
    }).then((value) => { result = value })

    await vi.advanceTimersByTimeAsync(24)
    expect(result).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toEqual({ events: [] })
    await waiting
  })

  it('rejects an aborted pending fake Client wait with the production AbortError contract', async () => {
    vi.useFakeTimers()
    const broker = createFakeChatBroker()
    const client = await createFakeTelegramClient(broker).create({ source: sources[0], credential })
    const controller = new AbortController()
    let outcome = 'pending'
    const waiting = client.wait({
      waitBoundMs: 25, pollIntervalMs: 1_000, targetConversationIds: ['-100-contributions'],
    }, { signal: controller.signal }).then(
      () => { outcome = 'resolved' },
      (error: unknown) => { outcome = error instanceof Error ? error.name : 'non-error' },
    )

    controller.abort()
    await Promise.resolve()
    expect(outcome).toBe('AbortError')
    await waiting
  })

  it('shares offline Telegram and Discord deliveries while each caller owns its cursors across restart', async () => {
    const broker = createFakeChatBroker()
    const compositions = new Set<Awaited<ReturnType<typeof compose>>>()
    try {
      const contributor = await compose(broker)
      compositions.add(contributor)
      const evaluator = await compose(broker)
      compositions.add(evaluator)
      broker.append({
        platform: 'telegram', source: 'telegram-main', conversationId: '-100-contributions',
        platformEventId: 'telegram-update-1', platformEventType: 'message', timestamp: '2026-08-23T10:00:00.000Z',
        sender: { id: 'contributor-7', display_name: 'Contributor' }, platformPayload: { text: '@evaluator contribution ready' },
      })
      const contributorMention = waitData(await contributor.request(2, 'tools/call', {
        name: 'chat.telegram.events.wait',
        arguments: { source: 'telegram-main', wait_bound_ms: 10, credential },
      }))
      const evaluatorMention = waitData(await evaluator.request(2, 'tools/call', {
        name: 'chat.telegram.events.wait',
        arguments: { source: 'telegram-main', wait_bound_ms: 10, credential },
      }))

      expect(contributorMention).toMatchObject({
        next_cursor: 'telegram:1', events: [{
          source: 'telegram-main', target: 'contribution-mentions', platform_event_id: 'telegram-update-1',
          platform_payload: { text: '@evaluator contribution ready' },
        }],
      })
      expect(evaluatorMention).toEqual(contributorMention)

      broker.append({
        platform: 'telegram', source: 'telegram-main', conversationId: '-100-unconfigured',
        platformEventId: 'telegram-update-ignored', platformEventType: 'message', timestamp: '2026-08-23T10:00:00.500Z',
        sender: null, platformPayload: { text: 'not routed to TAS' },
      })
      const contributorSkipped = waitData(await contributor.request(3, 'tools/call', {
        name: 'chat.telegram.events.wait',
        arguments: {
          source: 'telegram-main', cursor: contributorMention.next_cursor, wait_bound_ms: 10, credential,
        },
      }))
      expect(contributorSkipped).toEqual({ events: [], next_cursor: 'telegram:2' })

      broker.append({
        platform: 'discord', source: 'discord-main', conversationId: 'review-channel',
        platformEventId: 'discord-message-1', platformEventType: 'messageCreate', timestamp: '2026-08-23T10:00:01.000Z',
        sender: { id: 'contributor-7', username: 'contributor' }, platformPayload: { content: 'also posted in Discord' },
      })
      const contributorDiscord = waitData(await contributor.request(4, 'tools/call', {
        name: 'chat.discord.events.wait',
        arguments: { source: 'discord-main', wait_bound_ms: 10, credential },
      }))
      const evaluatorDiscord = waitData(await evaluator.request(3, 'tools/call', {
        name: 'chat.discord.events.wait',
        arguments: { source: 'discord-main', wait_bound_ms: 10, credential },
      }))

      expect(contributorDiscord).toMatchObject({
        next_cursor: 'discord:1', events: [{ target: 'discord-reviews', platform_event_id: 'discord-message-1' }],
      })
      expect(evaluatorDiscord).toEqual(contributorDiscord)

      const reply = await evaluator.request(5, 'tools/call', {
        name: 'chat.telegram.api.send_message_draft',
        arguments: {
          target: 'evaluator-replies', draft_id: 1, text: 'Evaluation accepted.', credential,
        },
      })
      expect(reply).toMatchObject({ result: { structuredContent: { data: true } } })
      expect(broker.sends()).toEqual([{
        platform: 'telegram', source: 'telegram-main', conversationId: '-100-evaluators',
        toolName: 'chat.telegram.api.send_message_draft', bindingTarget: 'Api.sendMessageDraft',
        arguments: { draft_id: 1, text: 'Evaluation accepted.' },
      }])

      broker.append({
        platform: 'telegram', source: 'telegram-main', conversationId: '-100-evaluators',
        platformEventId: 'telegram-update-2', platformEventType: 'message', timestamp: '2026-08-23T10:00:02.000Z',
        sender: { id: 'evaluator-9', display_name: 'Evaluator' }, platformPayload: { text: 'Evaluation accepted.' },
      })
      await contributor.close()
      compositions.delete(contributor)
      const restartedContributor = await compose(broker)
      compositions.add(restartedContributor)
      const resumed = waitData(await restartedContributor.request(5, 'tools/call', {
        name: 'chat.telegram.events.wait',
        arguments: {
          source: 'telegram-main', cursor: contributorSkipped.next_cursor, wait_bound_ms: 10, credential,
        },
      }))
      expect(resumed).toMatchObject({
        next_cursor: 'telegram:3', events: [{ target: 'evaluator-replies', platform_event_id: 'telegram-update-2' }],
      })
    } finally {
      const results = await Promise.allSettled([...compositions].map(async (composition) => composition.close()))
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failure !== undefined) throw failure.reason
    }
  })

  it('keeps three caller-supplied cursors independent across duplicate cross-platform delivery and server replacement', async () => {
    const broker = createFakeChatBroker()
    const compositions = new Set<Awaited<ReturnType<typeof compose>>>()
    try {
      const agentACredential = { type: 'inline', secret: 'offline-agent-a-credential' } as const
      const agentBCredential = { type: 'inline', secret: 'offline-agent-b-credential' } as const
      const agentCCredential = { type: 'inline', secret: 'offline-agent-c-credential' } as const
      const agentA = await compose(broker, '800400000000000000000000000000000001')
      compositions.add(agentA)
      const agentB = await compose(broker, '800400000000000000000000000000000002')
      compositions.add(agentB)
      const agentC = await compose(broker, '800400000000000000000000000000000003')
      compositions.add(agentC)

      const duplicateTelegramMessage = {
        platform: 'telegram', source: 'telegram-main', conversationId: '-100-contributions',
        platformEventId: 'telegram-shared-1', platformEventType: 'message', timestamp: '2026-08-24T09:00:00.000Z',
        sender: { id: 'agent-a', display_name: 'Agent A' }, platformPayload: { text: 'Review contribution 17.' },
      } as const
      broker.append(duplicateTelegramMessage)
      const agentCFirstResponse = await agentC.request(2, 'tools/call', {
        name: 'chat.telegram.events.wait',
        arguments: { source: 'telegram-main', wait_bound_ms: 10, credential: agentCCredential },
      })
      const agentCFirst = waitData(agentCFirstResponse)
      expect(responseAgentId(agentCFirstResponse)).toBe('800400000000000000000000000000000003')
      expect(agentCFirst).toMatchObject({
        next_cursor: 'telegram:1', events: [{ platform_event_id: 'telegram-shared-1' }],
      })

      broker.append(duplicateTelegramMessage)
      const agentAFirstResponse = await agentA.request(2, 'tools/call', {
        name: 'chat.telegram.events.wait',
        arguments: { source: 'telegram-main', wait_bound_ms: 10, credential: agentACredential },
      })
      const agentAFirst = waitData(agentAFirstResponse)
      expect(responseAgentId(agentAFirstResponse)).toBe('800400000000000000000000000000000001')
      expect(agentAFirst.events.map((event) => event.platform_event_id)).toEqual([
        'telegram-shared-1', 'telegram-shared-1',
      ])
      expect(agentAFirst.next_cursor).toBe('telegram:2')

      broker.append({
        platform: 'discord', source: 'discord-main', conversationId: 'review-channel',
        platformEventId: 'discord-shared-1', platformEventType: 'messageCreate', timestamp: '2026-08-24T09:00:01.000Z',
        sender: { id: 'agent-a', username: 'agent-a' }, platformPayload: { content: 'Review contribution 17.' },
      })
      const agentADiscord = waitData(await agentA.request(3, 'tools/call', {
        name: 'chat.discord.events.wait',
        arguments: { source: 'discord-main', wait_bound_ms: 10, credential: agentACredential },
      }))
      expect(agentADiscord).toMatchObject({
        next_cursor: 'discord:1', events: [{ platform_event_id: 'discord-shared-1' }],
      })

      broker.append({
        platform: 'telegram', source: 'telegram-main', conversationId: '-100-evaluators',
        platformEventId: 'telegram-handoff-2', platformEventType: 'message', timestamp: '2026-08-24T09:00:02.000Z',
        sender: { id: 'agent-b', display_name: 'Agent B' }, platformPayload: { text: 'Contribution 17 is ready.' },
      })
      const agentBFirstResponse = await agentB.request(2, 'tools/call', {
        name: 'chat.telegram.events.wait',
        arguments: { source: 'telegram-main', wait_bound_ms: 10, credential: agentBCredential },
      })
      const agentBFirst = waitData(agentBFirstResponse)
      expect(responseAgentId(agentBFirstResponse)).toBe('800400000000000000000000000000000002')
      expect(agentBFirst.events.map((event) => event.platform_event_id)).toEqual([
        'telegram-shared-1', 'telegram-shared-1', 'telegram-handoff-2',
      ])
      expect([agentAFirst.next_cursor, agentBFirst.next_cursor, agentCFirst.next_cursor]).toEqual([
        'telegram:2', 'telegram:3', 'telegram:1',
      ])

      const agentASend = await agentA.request(4, 'tools/call', {
        name: 'chat.telegram.api.send_message_draft',
        arguments: {
          target: 'evaluator-replies', draft_id: 101, text: 'Agent A reply.', credential: agentACredential,
        },
      })
      const agentBSend = await agentB.request(3, 'tools/call', {
        name: 'chat.telegram.api.send_message_draft',
        arguments: {
          target: 'evaluator-replies', draft_id: 102, text: 'Agent B reply.', credential: agentBCredential,
        },
      })
      const agentCSend = await agentC.request(3, 'tools/call', {
        name: 'chat.telegram.api.send_message_draft',
        arguments: {
          target: 'evaluator-replies', draft_id: 103, text: 'Agent C reply.', credential: agentCCredential,
        },
      })
      expect([agentASend, agentBSend, agentCSend]).toMatchObject([
        { result: { structuredContent: { data: true } } },
        { result: { structuredContent: { data: true } } },
        { result: { structuredContent: { data: true } } },
      ])
      expect(broker.sends()).toEqual([
        {
          platform: 'telegram', source: 'telegram-main', conversationId: '-100-evaluators',
          toolName: 'chat.telegram.api.send_message_draft', bindingTarget: 'Api.sendMessageDraft',
          arguments: { draft_id: 101, text: 'Agent A reply.' },
        },
        {
          platform: 'telegram', source: 'telegram-main', conversationId: '-100-evaluators',
          toolName: 'chat.telegram.api.send_message_draft', bindingTarget: 'Api.sendMessageDraft',
          arguments: { draft_id: 102, text: 'Agent B reply.' },
        },
        {
          platform: 'telegram', source: 'telegram-main', conversationId: '-100-evaluators',
          toolName: 'chat.telegram.api.send_message_draft', bindingTarget: 'Api.sendMessageDraft',
          arguments: { draft_id: 103, text: 'Agent C reply.' },
        },
      ])

      await agentA.close()
      compositions.delete(agentA)
      const replacementAgentA = await compose(broker, '800400000000000000000000000000000001')
      compositions.add(replacementAgentA)
      const agentAResumed = waitData(await replacementAgentA.request(2, 'tools/call', {
        name: 'chat.telegram.events.wait',
        arguments: {
          source: 'telegram-main', cursor: agentAFirst.next_cursor, wait_bound_ms: 10,
          credential: agentACredential,
        },
      }))
      expect(agentAResumed).toMatchObject({
        next_cursor: 'telegram:3', events: [{ platform_event_id: 'telegram-handoff-2' }],
      })

      const agentCResumed = waitData(await agentC.request(4, 'tools/call', {
        name: 'chat.telegram.events.wait',
        arguments: {
          source: 'telegram-main', cursor: agentCFirst.next_cursor, wait_bound_ms: 10,
          credential: agentCCredential,
        },
      }))
      expect(agentCResumed.events.map((event) => event.platform_event_id)).toEqual([
        'telegram-shared-1', 'telegram-handoff-2',
      ])
      expect(agentCResumed.next_cursor).toBe('telegram:3')

      const agentBUnchanged = waitData(await agentB.request(4, 'tools/call', {
        name: 'chat.telegram.events.wait',
        arguments: {
          source: 'telegram-main', cursor: agentBFirst.next_cursor, wait_bound_ms: 10,
          credential: agentBCredential,
        },
      }))
      expect(agentBUnchanged).toEqual({ events: [] })
    } finally {
      const results = await Promise.allSettled([...compositions].map(async (composition) => composition.close()))
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failure !== undefined) throw failure.reason
    }
  })
})
