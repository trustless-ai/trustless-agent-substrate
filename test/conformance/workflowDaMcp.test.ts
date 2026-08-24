import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'

import type { DaService } from '../../src/core/da/service.js'
import type { DaGetInput, DaGetResult, DaPutInput, DaPutResult } from '../../src/core/da/types.js'
import { TasError } from '../../src/core/errors.js'
import type { RepositorySource } from '../../src/core/repository/types.js'
import { registerDaTools } from '../../src/mcp/daTools.js'
import type { TasPublicInstance } from '../../src/mcp/results.js'

const member: Extract<TasPublicInstance, { readonly phase: 'member' }> = {
  phase: 'member',
  chain_id: '31337',
  tawg_address: '0x1000000000000000000000000000000000000001',
  agent_id: '340282366920938463463374607431768211457',
}
const commit = 'a'.repeat(40)
const source: RepositorySource = {
  provider: 'github',
  locator: 'https://github.com/trustless-ai/tawg-demo',
  owner: 'trustless-ai',
  repository: 'tawg-demo',
  profile: { blockNumber: '42', blockHash: `0x${'b'.repeat(64)}`, version: '7' },
  charter: { commit: 'c'.repeat(40), path: 'charter/' },
}
const ref = { type: 'git', commit, path: 'data/contributions/round-1.json' } as const

class RecordingDaService implements DaService {
  readonly getCalls: DaGetInput[] = []
  readonly putCalls: DaPutInput[] = []
  failure?: TasError
  getResult: DaGetResult = {
    source,
    ref,
    content: { encoding: 'base64', value: 'eyJzY29yZSI6MX0=', media_type: 'application/json' },
    size_bytes: 11,
  }
  putResult: DaPutResult = { source, ref, size_bytes: 11 }

  async capabilities() {
    if (this.failure) throw this.failure
    return {
      backend: 'git', reference_types: ['git'], read: true, write: true,
      content_encodings: ['utf8', 'base64'], max_inline_bytes: 1_048_576,
    } as const
  }

  async get(input: DaGetInput): Promise<DaGetResult> {
    this.getCalls.push(input)
    if (this.failure) throw this.failure
    return this.getResult
  }

  async put(input: DaPutInput): Promise<DaPutResult> {
    this.putCalls.push(input)
    if (this.failure) throw this.failure
    return this.putResult
  }
}

async function harness(service = new RecordingDaService()) {
  const server = new McpServer({ name: 'da-tools-test', version: '1' })
  registerDaTools(server, service, member)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const received = new Map<number, unknown>()
  clientTransport.onmessage = (message) => {
    if ('id' in message && typeof message.id === 'number') received.set(message.id, message)
  }
  await server.connect(serverTransport)
  await clientTransport.start()
  async function request(id: number, method: string, params: Record<string, unknown>): Promise<unknown> {
    await clientTransport.send({ jsonrpc: '2.0', id, method, params })
    for (let count = 0; count < 100 && !received.has(id); count += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }
    return received.get(id)
  }
  await request(1, 'initialize', {
    protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'da-test', version: '1' },
  })
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return { service, request, close: async () => { await server.close(); await clientTransport.close() } }
}

describe('workflow.da MCP contract', () => {
  it('registers exactly three tools with side-effect-accurate annotations and write-only credentials', async () => {
    const app = await harness()
    try {
      const response = await app.request(2, 'tools/list', {}) as { result: { tools: Array<Record<string, unknown>> } }
      const tools = response.result.tools
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'workflow.da.capabilities', 'workflow.da.get', 'workflow.da.put',
      ])
      expect(tools.find(({ name }) => name === 'workflow.da.capabilities')?.annotations).toMatchObject({
        readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
      })
      expect(tools.find(({ name }) => name === 'workflow.da.get')?.annotations).toMatchObject({
        readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
      })
      expect(tools.find(({ name }) => name === 'workflow.da.put')?.annotations).toMatchObject({
        readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
      })
      for (const name of ['workflow.da.get', 'workflow.da.put']) {
        const schema = tools.find((tool) => tool.name === name)?.inputSchema as {
          additionalProperties: boolean
          properties: { credential: { properties: { secret: Record<string, unknown> } } }
        }
        expect(schema.additionalProperties).toBe(false)
        expect(schema.properties.credential.properties.secret).toMatchObject({ writeOnly: true, maxLength: 4_096 })
      }
    } finally { await app.close() }
  })

  it('returns fixed Git capabilities without claiming a Profile or IPFS resolution', async () => {
    const app = await harness()
    try {
      const response = await app.request(2, 'tools/call', {
        name: 'workflow.da.capabilities', arguments: {},
      }) as { result: { structuredContent: { context: unknown; data: unknown } } }
      expect(response.result.structuredContent).toMatchObject({
        context: { instance: member, request_id: expect.any(String) },
        data: {
          backend: 'git', reference_types: ['git'], read: true, write: true,
          content_encodings: ['utf8', 'base64'], max_inline_bytes: 1_048_576,
        },
      })
      expect(response.result.structuredContent.context).not.toHaveProperty('resolved')
    } finally { await app.close() }
  })

  it('gets an immutable reference with exact resolution and one operation credential', async () => {
    const app = await harness()
    try {
      const response = await app.request(2, 'tools/call', {
        name: 'workflow.da.get',
        arguments: {
          ref,
          selector: { kind: 'block_hash', block_hash: source.profile.blockHash },
          credential: { type: 'inline', secret: 'private-repository-token' },
        },
      }) as { result: { content: unknown; structuredContent: { context: unknown; data: unknown } } }
      expect(response.result.structuredContent).toEqual({
        context: {
          instance: member,
          request_id: expect.any(String),
          resolved: {
            chain: { block_number: '42', block_hash: source.profile.blockHash },
            profile: { version: '7' },
            repository: { url: source.locator, commit },
            da: ref,
          },
        },
        data: {
          ref,
          content: { encoding: 'base64', value: 'eyJzY29yZSI6MX0=', media_type: 'application/json' },
          size_bytes: 11,
        },
      })
      expect(app.service.getCalls).toHaveLength(1)
      expect(app.service.getCalls[0]).toMatchObject({
        ref,
        selector: { kind: 'block_hash', blockHash: source.profile.blockHash },
        credential: { type: 'inline', secret: 'private-repository-token' },
        signal: expect.any(AbortSignal),
      })
      expect(JSON.stringify(response)).not.toContain('private-repository-token')
    } finally { await app.close() }
  })

  it('puts exact content with an explicit Git destination and returns only ref and size', async () => {
    const app = await harness()
    try {
      const response = await app.request(2, 'tools/call', {
        name: 'workflow.da.put',
        arguments: {
          destination: { path: ref.path },
          content: { encoding: 'utf8', value: '{"score":1}', media_type: 'application/json' },
          credential: { type: 'inline', secret: 'write-token' },
        },
      }) as { result: { structuredContent: { context: unknown; data: unknown } } }
      expect(response.result.structuredContent).toMatchObject({
        context: { resolved: { repository: { url: source.locator, commit }, da: ref } },
        data: { ref, size_bytes: 11 },
      })
      expect(response.result.structuredContent.data).toEqual({ ref, size_bytes: 11 })
      expect(app.service.putCalls[0]).toMatchObject({
        destination: { path: ref.path },
        content: { encoding: 'utf8', value: '{"score":1}', media_type: 'application/json' },
        credential: { type: 'inline', secret: 'write-token' },
        signal: expect.any(AbortSignal),
      })
      expect(JSON.stringify(response)).not.toContain('write-token')
    } finally { await app.close() }
  })

  it.each([
    ['DA_PATH_INVALID', { destination: { path: ref.path }, content: { encoding: 'utf8', value: 'a' } }],
    ['DA_CONTENT_TOO_LARGE', { destination: { path: ref.path }, content: { encoding: 'utf8', value: 'a' } }],
  ] as const)('returns %s as a native tool error without Provider detail', async (code, arguments_) => {
    const service = new RecordingDaService()
    service.failure = new TasError(code, 'provider-secret-detail')
    const app = await harness(service)
    try {
      const response = await app.request(2, 'tools/call', { name: 'workflow.da.put', arguments: arguments_ })
      expect(response).toMatchObject({ result: { isError: true, structuredContent: { error: { code } } } })
      expect(JSON.stringify(response)).not.toContain('provider-secret-detail')
    } finally { await app.close() }
  })

  it.each([
    { ref: { type: 'git', commit: 'main', path: ref.path } },
    { ref: { ...ref, path: 'data/../secret' } },
    { ref, credential: { type: 'inline', secret: 'x', extra: true } },
    { ref, unknown: true },
    { destination: { path: ref.path }, content: { encoding: 'hex', value: '00' } },
    { destination: { path: 'data/../secret' }, content: { encoding: 'utf8', value: 'a' } },
    { destination: { path: ref.path }, content: { encoding: 'utf8', value: 'a' }, credential: { type: 'inline', secret: 'x'.repeat(4_097) } },
  ])('rejects malformed input before calling the DA service: %o', async (arguments_) => {
    const app = await harness()
    try {
      const name = Object.hasOwn(arguments_, 'ref') ? 'workflow.da.get' : 'workflow.da.put'
      const response = await app.request(2, 'tools/call', { name, arguments: arguments_ })
      expect(response).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining('Input validation error') }] } })
      expect(app.service.getCalls).toEqual([])
      expect(app.service.putCalls).toEqual([])
    } finally { await app.close() }
  })
})
