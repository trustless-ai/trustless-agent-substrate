import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'

import { TasError } from '../../../src/core/errors.js'
import type {
  RepositoryActivityInput,
  RepositoryActivityResult,
  RepositoryService,
} from '../../../src/core/repository/service.js'
import type { RepositoryCommit, RepositoryIssue, RepositorySource } from '../../../src/core/repository/types.js'
import { registerRepositoryTools } from '../../../src/mcp/repositoryTools.js'
import type { TasPublicInstance } from '../../../src/mcp/results.js'

const member: Extract<TasPublicInstance, { readonly phase: 'member' }> = {
  phase: 'member', chain_id: '31337', tawg_address: '0x1000000000000000000000000000000000000001',
  agent_id: '9007199254740993123456789',
}
const source: RepositorySource = {
  provider: 'github', locator: 'https://github.com/trustless-ai/tawg-demo', owner: 'trustless-ai', repository: 'tawg-demo',
  profile: { blockNumber: '42', blockHash: `0x${'a'.repeat(64)}`, version: '7' },
  charter: { commit: 'b'.repeat(40), path: 'charter/' },
}

class RecordingRepositoryService implements RepositoryService {
  readonly getCalls: unknown[] = []
  readonly activityCalls: RepositoryActivityInput[] = []
  issueResult: RepositoryActivityResult<RepositoryIssue> = {
    source, observedAt: '2026-08-23T03:00:00Z', items: [], page: { consistency: 'live' },
  }
  pullRequestResult: RepositoryActivityResult<RepositoryIssue> = {
    source, observedAt: '2026-08-23T03:00:00Z', items: [], page: { consistency: 'live' },
  }
  commitResult: RepositoryActivityResult<RepositoryCommit> = {
    source, observedAt: '2026-08-23T03:00:00Z', items: [], page: { consistency: 'live' },
  }
  failure?: TasError

  async getRepository(selector: Parameters<RepositoryService['getRepository']>[0]) {
    this.getCalls.push(selector)
    if (this.failure) throw this.failure
    return source
  }

  async listActivity(input: RepositoryActivityInput<'repo.issue.list'>): Promise<RepositoryActivityResult<RepositoryIssue>>
  async listActivity(input: RepositoryActivityInput<'repo.pull_request.list'>): Promise<RepositoryActivityResult<RepositoryIssue>>
  async listActivity(input: RepositoryActivityInput<'repo.commit.list'>): Promise<RepositoryActivityResult<RepositoryCommit>>
  async listActivity(input: RepositoryActivityInput): Promise<RepositoryActivityResult<RepositoryIssue | RepositoryCommit>>
  async listActivity(input: RepositoryActivityInput): Promise<RepositoryActivityResult<RepositoryIssue | RepositoryCommit>> {
    this.activityCalls.push(input)
    if (this.failure) throw this.failure
    if (input.tool === 'repo.issue.list') return this.issueResult
    if (input.tool === 'repo.pull_request.list') return this.pullRequestResult
    return this.commitResult
  }
}

async function harness(service = new RecordingRepositoryService()) {
  const server = new McpServer({ name: 'repository-tools-test', version: '1' })
  registerRepositoryTools(server, service, member)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const received = new Map<number, unknown>()
  clientTransport.onmessage = (message) => { if ('id' in message && typeof message.id === 'number') received.set(message.id, message) }
  await server.connect(serverTransport)
  await clientTransport.start()
  async function request(id: number, method: string, params: Record<string, unknown>): Promise<unknown> {
    await clientTransport.send({ jsonrpc: '2.0', id, method, params })
    for (let count = 0; count < 100 && !received.has(id); count += 1) await new Promise<void>((resolve) => setTimeout(resolve, 1))
    return received.get(id)
  }
  await request(1, 'initialize', { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return { service, request, close: async () => { await server.close(); await clientTransport.close() } }
}

describe('Repository MCP schemas and projections', () => {
  it('registers four exact read-only, idempotent, non-destructive tools with write-only credentials', async () => {
    const app = await harness()
    try {
      const response = await app.request(2, 'tools/list', {}) as { result: { tools: Array<Record<string, unknown>> } }
      const tools = response.result.tools
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'repo.commit.list', 'repo.get', 'repo.issue.list', 'repo.pull_request.list',
      ])
      for (const tool of tools) {
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, destructiveHint: false })
        expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false })
      }
      const listSchema = tools.find((tool) => tool.name === 'repo.issue.list')?.inputSchema as {
        properties: { credential: { properties: { secret: Record<string, unknown> } } }
      }
      expect(listSchema.properties.credential.properties.secret).toMatchObject({ writeOnly: true })
      const getSchema = tools.find((tool) => tool.name === 'repo.get')?.inputSchema as { properties: Record<string, unknown> }
      expect(getSchema.properties).not.toHaveProperty('credential')
    } finally { await app.close() }
  })

  it('projects repo.get with exact Profile and Charter resolution without activity access', async () => {
    const app = await harness()
    try {
      const response = await app.request(2, 'tools/call', {
        name: 'repo.get', arguments: { selector: { kind: 'block_hash', block_hash: source.profile.blockHash } },
      })
      expect(response).toMatchObject({ result: {
        content: [{ type: 'text', text: 'Tool completed.' }],
        structuredContent: {
          context: { instance: member, resolved: {
            chain: { block_number: '42', block_hash: source.profile.blockHash },
            profile: { version: '7' },
          } },
          data: { repository_url: source.locator, charter: { commit: source.charter.commit, path: 'charter/' } },
        },
      } })
      expect(app.service.getCalls).toEqual([{ kind: 'block_hash', blockHash: source.profile.blockHash }])
      expect(app.service.activityCalls).toEqual([])
      expect(response).not.toHaveProperty('result.structuredContent.context.resolved.repository')
      expect((response as { result: { structuredContent: { data: unknown } } }).result.structuredContent.data).toEqual({
        repository_url: source.locator,
        charter: { commit: source.charter.commit, path: 'charter/' },
      })
    } finally { await app.close() }
  })

  it('projects Pull Requests with the Issue-shaped contract and exact activity tool binding', async () => {
    const service = new RecordingRepositoryService()
    service.pullRequestResult = {
      source, observedAt: '2026-08-23T03:00:00Z',
      items: [{ id: 'PR_opaque', number: '11', title: 'Implement', state: 'closed', author: 'alice',
        createdAt: '2026-08-23T02:00:00Z', updatedAt: '2026-08-23T02:40:00Z', url: 'https://github.com/trustless-ai/tawg-demo/pull/11' }],
      page: { consistency: 'live' },
    }
    const app = await harness(service)
    try {
      const response = await app.request(2, 'tools/call', { name: 'repo.pull_request.list', arguments: {
        since: '2026-08-23T01:00:00Z',
      } }) as { result: { structuredContent: { data: unknown } } }
      expect(response.result.structuredContent.data).toEqual({
        observed_at: '2026-08-23T03:00:00Z',
        items: [{
          id: 'PR_opaque', number: '11', title: 'Implement', state: 'closed', author: 'alice',
          created_at: '2026-08-23T02:00:00Z', updated_at: '2026-08-23T02:40:00Z',
          url: 'https://github.com/trustless-ai/tawg-demo/pull/11',
        }],
        page: { consistency: 'live' },
      })
      expect(service.activityCalls).toEqual([{ tool: 'repo.pull_request.list', since: '2026-08-23T01:00:00Z' }])
    } finally { await app.close() }
  })

  it('projects commits with the exact commit-shaped contract and accepts an empty page', async () => {
    const service = new RecordingRepositoryService()
    service.commitResult = {
      source, observedAt: '2026-08-23T03:00:00Z',
      items: [{ commit: 'd'.repeat(40), message: 'Implement feature', authorName: 'Alice', authorLogin: null,
        committedAt: '2026-08-23T02:00:00Z', url: `https://github.com/trustless-ai/tawg-demo/commit/${'d'.repeat(40)}` }],
      page: { consistency: 'live' },
    }
    const app = await harness(service)
    try {
      const response = await app.request(2, 'tools/call', { name: 'repo.commit.list', arguments: {
        since: '2026-08-23T01:00:00Z', selector: { kind: 'finalized' },
      } }) as { result: { structuredContent: { data: unknown } } }
      expect(response.result.structuredContent.data).toEqual({
        observed_at: '2026-08-23T03:00:00Z',
        items: [{
          commit: 'd'.repeat(40), message: 'Implement feature', author_name: 'Alice', author_login: null,
          committed_at: '2026-08-23T02:00:00Z', url: `https://github.com/trustless-ai/tawg-demo/commit/${'d'.repeat(40)}`,
        }],
        page: { consistency: 'live' },
      })
      expect(service.activityCalls).toEqual([{
        tool: 'repo.commit.list', since: '2026-08-23T01:00:00Z', selector: { kind: 'finalized' },
      }])
    } finally { await app.close() }

    service.commitResult = { source, observedAt: '2026-08-23T04:00:00Z', items: [], page: { consistency: 'live' } }
    const empty = await harness(service)
    try {
      const response = await empty.request(2, 'tools/call', { name: 'repo.commit.list', arguments: {
        since: '2026-08-23T03:00:00Z',
      } }) as { result: { structuredContent: { data: unknown }; isError?: boolean } }
      expect(response.result.isError).toBeUndefined()
      expect(response.result.structuredContent.data).toEqual({
        observed_at: '2026-08-23T04:00:00Z', items: [], page: { consistency: 'live' },
      })
    } finally { await empty.close() }
  })

  it('maps Issue activity, passes one credential, and excludes cursor and secret from compact text', async () => {
    const service = new RecordingRepositoryService()
    service.issueResult = {
      source, observedAt: '2026-08-23T03:00:00Z',
      items: [{ id: 'I_opaque', number: '9', title: 'Proposal', state: 'open', author: null,
        createdAt: '2026-08-23T02:00:00Z', updatedAt: '2026-08-23T02:30:00Z', url: 'https://github.com/trustless-ai/tawg-demo/issues/9' }],
      page: { consistency: 'live', nextCursor: 'opaque-next-cursor' },
    }
    const app = await harness(service)
    try {
      const response = await app.request(2, 'tools/call', { name: 'repo.issue.list', arguments: {
        since: '2026-08-23T01:00:00Z', limit: 10, credential: { type: 'inline', secret: 'operation-secret' },
      } }) as { result: { content: Array<{ text: string }>; structuredContent: unknown } }
      expect(response).toMatchObject({ result: { structuredContent: {
        context: { resolved: { chain: { block_number: '42' }, profile: { version: '7' } } },
        data: { observed_at: '2026-08-23T03:00:00Z', items: [{
          id: 'I_opaque', number: '9', title: 'Proposal', state: 'open', author: null,
          created_at: '2026-08-23T02:00:00Z', updated_at: '2026-08-23T02:30:00Z',
        }], page: { consistency: 'live', next_cursor: 'opaque-next-cursor' } },
      } } })
      expect(service.activityCalls[0]).toMatchObject({ tool: 'repo.issue.list', credential: { type: 'inline', secret: 'operation-secret' } })
      expect(response).not.toHaveProperty('result.structuredContent.context.resolved.repository')
      expect(JSON.stringify(response.result.content)).not.toMatch(/operation-secret|opaque-next-cursor|Proposal/)
      expect(JSON.stringify(response)).not.toMatch(/"(?:ok|success)"/)
    } finally { await app.close() }
  })

  it.each([
    { since: '2026-08-23T01:00:00Z', cursor: 'cursor', selector: { kind: 'safe' } },
    { since: '2026-08-23T01:00:00Z', unknown: true },
    { since: '2026-08-23T01:00:00Z', credential: { type: 'inline', secret: 'x', extra: true } },
    { since: 'x'.repeat(36) },
    { since: '2026-08-23T01:00:00Z', cursor: 'c'.repeat(2_049) },
    { since: '2026-08-23T01:00:00Z', credential: { type: 'inline', secret: 's'.repeat(4_097) } },
  ])('rejects invalid list input before calling the service: %o', async (arguments_) => {
    const app = await harness()
    try {
      const response = await app.request(2, 'tools/call', { name: 'repo.issue.list', arguments: arguments_ })
      expect(response).toMatchObject({ result: { isError: true, content: [{ type: 'text', text: expect.stringContaining('Input validation error') }] } })
      expect(app.service.activityCalls).toEqual([])
    } finally { await app.close() }
  })

  it('returns Repository execution failures as native tool errors', async () => {
    const service = new RecordingRepositoryService()
    service.failure = new TasError('REPOSITORY_FETCH_FAILED', 'provider body secret')
    const app = await harness(service)
    try {
      const response = await app.request(2, 'tools/call', { name: 'repo.get', arguments: {} })
      expect(response).toMatchObject({ result: { isError: true, structuredContent: { error: { code: 'REPOSITORY_FETCH_FAILED' } } } })
      expect(JSON.stringify(response)).not.toContain('provider body secret')
    } finally { await app.close() }
  })
})
