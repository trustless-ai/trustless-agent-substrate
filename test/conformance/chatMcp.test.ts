import { readFileSync } from 'node:fs'

import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'

import { TasError } from '../../src/core/errors.js'
import type { ChatService } from '../../src/core/chat/service.js'
import { registerGeneratedChatTools } from '../../src/mcp/generatedChatTools.js'
import { registerChatWaitTools } from '../../src/mcp/chatWaitTools.js'
import type { ChatGeneratedToolEntry } from '../../src/mcp/generatedChatTools.js'

const instance = {
  phase: 'member', chain_id: '31337', tawg_address: '0x1000000000000000000000000000000000000001', agent_id: '42',
} as const
const sources = [
  { name: 'telegram-main', platform: 'telegram', pollInterval: '6s' },
  { name: 'discord-main', platform: 'discord', pollInterval: '6s' },
] as const
const entries = JSON.parse(readFileSync(new URL('../../manifests/telegram.v1.json', import.meta.url), 'utf8')).tools as ChatGeneratedToolEntry[]

async function connect(service: ChatService) {
  const server = new McpServer({ name: 'test', version: '1' })
  registerGeneratedChatTools(server, entries, service, instance)
  registerChatWaitTools(server, service, sources, instance)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const received = new Map<number, unknown>()
  clientTransport.onmessage = (message) => { if ('id' in message && typeof message.id === 'number') received.set(message.id, message) }
  await server.connect(serverTransport)
  await clientTransport.start()
  async function request(id: number, method: string, params: Record<string, unknown>): Promise<unknown> {
    await clientTransport.send({ jsonrpc: '2.0', id, method, params })
    for (let attempt = 0; attempt < 100 && !received.has(id); attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 1))
    return received.get(id)
  }
  await request(1, 'initialize', { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'chat-test', version: '1' } })
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return { request, close: async () => { await server.close(); await clientTransport.close() } }
}

describe('Chat MCP tools', () => {
  it('validates the exact advertised phase-specific wait result envelope', async () => {
    let outputSchema: unknown
    registerChatWaitTools({
      registerTool(_name: string, definition: { outputSchema?: unknown }) { outputSchema = definition.outputSchema },
    } as never, {
      platforms: () => ['telegram'], invoke: async () => true, wait: async () => ({ events: [] }),
    }, sources, instance)
    const validate = (outputSchema as {
      '~standard': { validate(value: unknown): unknown | Promise<unknown> }
    })['~standard'].validate
    const envelope = {
      context: { instance, request_id: 'request-1' },
      data: { events: [] },
    }
    const event = {
      source: 'telegram-main', target: 'contributors', platform_event_id: 'update-1', platform_event_type: 'message',
      timestamp: '2026-08-23T10:00:00.000Z', sender: null,
    }

    await expect(Promise.resolve(validate(envelope))).resolves.toHaveProperty('value')
    await expect(Promise.resolve(validate({
      ...envelope, data: { events: [{ ...event, platform_payload: 'native-text' }] },
    }))).resolves.toHaveProperty('value')
    await expect(Promise.resolve(validate({
      ...envelope, data: { events: [{ ...event, platform_payload: ['native', 7, null] }] },
    }))).resolves.toHaveProperty('value')
    await expect(Promise.resolve(validate({
      ...envelope,
      context: { ...envelope.context, instance: { phase: 'member' } },
    }))).resolves.toHaveProperty('issues')
    await expect(Promise.resolve(validate({
      ...envelope,
      context: { ...envelope.context, instance: { ...instance, unexpected: true } },
    }))).resolves.toHaveProperty('issues')
  })

  it('registers generated platform tools only for selected configured platform groups and fixed selected wait bridges', async () => {
    const app = await connect({
      platforms: () => ['telegram'], invoke: async () => true, wait: async () => ({ events: [] }),
    })
    try {
      const response = await app.request(2, 'tools/list', {}) as { result: { tools: Array<{ name: string }> } }
      const names = response.result.tools.map(({ name }) => name)
      expect(names).toContain('chat.telegram.api.set_chat_title')
      expect(names).toContain('chat.telegram.events.wait')
      expect(names).not.toContain('chat.discord.events.wait')
      expect(names.every((name) => name.startsWith('chat.telegram.'))).toBe(true)
    } finally { await app.close() }
  })

  it('dispatches generated tools and bridges through their fixed service contracts without leaking credentials', async () => {
    const invocations: unknown[] = []
    const waits: unknown[] = []
    const app = await connect({
      platforms: () => ['telegram'],
      invoke: async (input) => { invocations.push(input); return true },
      wait: async (input) => { waits.push(input); return { events: [], nextCursor: 'opaque-next' } },
    })
    const secret = 'credential-must-not-escape'
    try {
      const operation = await app.request(2, 'tools/call', {
        name: 'chat.telegram.api.set_chat_title',
        arguments: { target: 'contributors', title: 'hello', credential: { type: 'inline', secret } },
      })
      const wait = await app.request(3, 'tools/call', {
        name: 'chat.telegram.events.wait',
        arguments: { source: 'telegram-main', cursor: 'opaque-before', wait_bound_ms: 10, credential: { type: 'inline', secret } },
      })
      expect(operation).toMatchObject({ result: { structuredContent: { context: { instance }, data: true } } })
      expect(wait).toMatchObject({ result: { structuredContent: { context: { instance }, data: { events: [], next_cursor: 'opaque-next' } } } })
      expect(invocations).toEqual([{ platform: 'telegram', toolName: 'chat.telegram.api.set_chat_title', bindingTarget: 'Api.setChatTitle', arguments: { target: 'contributors', title: 'hello', credential: { type: 'inline', secret } } }])
      expect(waits).toHaveLength(1)
      expect(waits[0]).toMatchObject({ platform: 'telegram', source: 'telegram-main', cursor: 'opaque-before', waitBoundMs: 10, credential: { type: 'inline', secret } })
      expect((waits[0] as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal)
      expect(JSON.stringify([operation, wait])).not.toContain(secret)
    } finally { await app.close() }
  })

  it('validates fixed wait inputs before dispatch and advertises the TAS result envelope', async () => {
    let waits = 0
    const app = await connect({
      platforms: () => ['telegram'], invoke: async () => true,
      wait: async () => { waits += 1; return { events: [] } },
    })
    try {
      const listed = await app.request(2, 'tools/list', {}) as { result: { tools: Array<{
        name: string
        outputSchema: { oneOf?: Array<{ properties?: { data?: unknown } }> }
      }> } }
      const waitTool = listed.result.tools.find(({ name }) => name === 'chat.telegram.events.wait')!
      expect(waitTool.outputSchema.oneOf?.[0]?.properties?.data).toMatchObject({
        type: 'object', required: ['events'], properties: { events: { type: 'array' } },
      })
      const invalid = await app.request(3, 'tools/call', {
        name: 'chat.telegram.events.wait',
        arguments: { source: 'telegram-main', wait_bound_ms: 'not-a-number' },
      })
      expect(invalid).toMatchObject({ result: { isError: true } })
      expect(waits).toBe(0)
    } finally { await app.close() }
  })

  it('returns the standard redacted credential error from both Chat entry points', async () => {
    const app = await connect({
      platforms: () => ['telegram'],
      invoke: async () => { throw new Error('unexpected') },
      wait: async () => { throw new TasError('CREDENTIAL_REQUIRED', 'credential detail') },
    })
    try {
      const response = await app.request(2, 'tools/call', {
        name: 'chat.telegram.events.wait', arguments: { source: 'telegram-main', wait_bound_ms: 10 },
      })
      expect(response).toMatchObject({ result: { isError: true, structuredContent: { error: { code: 'CREDENTIAL_REQUIRED' } } } })
    } finally { await app.close() }
  })
})
