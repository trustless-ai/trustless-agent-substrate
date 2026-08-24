import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'

import { TasError } from '../../../src/core/errors.js'
import type {
  RoleSkillGetInput,
  RoleSkillLoader,
  TawgSkillGetInput,
  TawgSkillLoader,
} from '../../../src/core/skill/loader.js'
import type {
  CollaborationSkillArtifact,
  RoleSkillGetResult,
  TasSkillArtifact,
  TawgSkillGetResult,
} from '../../../src/core/skill/types.js'
import { registerSkillTools } from '../../../src/mcp/skillTools.js'
import type { TasPublicInstance } from '../../../src/mcp/results.js'

const repositoryUrl = 'https://github.com/trustless-ai/tawg-demo' as const
const repositoryCommit = 'a'.repeat(40)
const digest = 'b'.repeat(64)
const blockHash = `0x${'c'.repeat(64)}` as const
const releaseContent = '# Release Skill\nfull release instructions'
const repositoryContent = '# Repository Skill\nfull repository instructions'

const tas: TasSkillArtifact = {
  skill: { name: 'tas', package: '@trustless-ai/tas', version: '0.1.0' },
  source: { kind: 'release', path: 'skills/tas/SKILL.md', contentDigest: { algorithm: 'sha256', value: digest } },
  content: { mediaType: 'text/markdown; charset=utf-8', encoding: 'utf8', value: releaseContent },
}
const collaboration: CollaborationSkillArtifact = {
  skill: { name: 'tawg-collaboration', package: '@trustless-ai/tas', version: '0.1.0' },
  source: {
    kind: 'release', path: 'skills/tawg-collaboration/SKILL.md', contentDigest: { algorithm: 'sha256', value: digest },
  },
  content: { mediaType: 'text/markdown; charset=utf-8', encoding: 'utf8', value: releaseContent },
}
const tawgResult: TawgSkillGetResult = {
  skill: { name: 'tawg' },
  source: {
    kind: 'repository', repositoryUrl, commit: repositoryCommit, path: 'skills/SKILL.md',
    profile: { blockNumber: '42', blockHash, version: '7' },
    contentDigest: { algorithm: 'sha256', value: digest },
  },
  content: { mediaType: 'text/markdown; charset=utf-8', encoding: 'utf8', value: repositoryContent },
}
const roleResult: RoleSkillGetResult = {
  skill: { name: 'role', role: 'contributor' },
  source: {
    kind: 'repository', repositoryUrl, commit: repositoryCommit, path: 'skills/roles/contributor.md',
    profile: { blockNumber: '42', blockHash, version: '7' },
    contentDigest: { algorithm: 'sha256', value: digest },
  },
  content: { mediaType: 'text/markdown; charset=utf-8', encoding: 'utf8', value: repositoryContent },
}

const identitySetup: TasPublicInstance = {
  phase: 'identity_setup', chain_id: '1', identity_registry_address: '0x8004000000000000000000000000000000000001',
}
const tawgSetup: TasPublicInstance = {
  phase: 'tawg_setup', chain_id: '1', tawg_address: '0x8004000000000000000000000000000000000002',
}
const member: TasPublicInstance = {
  phase: 'member', chain_id: '31337', tawg_address: '0x1000000000000000000000000000000000000001',
  agent_id: '340282366920938463463374607431768211457',
}

class RecordingTawgLoader implements TawgSkillLoader {
  readonly calls: TawgSkillGetInput[] = []
  failure?: TasError
  async get(input: TawgSkillGetInput): Promise<TawgSkillGetResult> {
    this.calls.push(input)
    if (this.failure) throw this.failure
    return tawgResult
  }
}

class RecordingRoleLoader implements RoleSkillLoader {
  readonly calls: RoleSkillGetInput[] = []
  failure?: TasError
  async get(input: RoleSkillGetInput): Promise<RoleSkillGetResult> {
    this.calls.push(input)
    if (this.failure) throw this.failure
    return roleResult
  }
}

async function harness(
  instance: TasPublicInstance,
  loaders: { tawg?: TawgSkillLoader; role?: RoleSkillLoader } = {},
) {
  const server = new McpServer({ name: 'skill-tools-test', version: '1' })
  registerSkillTools(server, { tas, collaboration, instance, ...loaders })
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
    protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  })
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return { request, close: async () => { await server.close(); await clientTransport.close() } }
}

function toolErrorCode(response: unknown): unknown {
  return (response as { result?: { structuredContent?: { error?: { code?: unknown } } } })
    .result?.structuredContent?.error?.code
}

describe('flat Skill MCP discovery and phases', () => {
  it.each([identitySetup, tawgSetup, member])('registers the same four strict tools in $phase', async (instance) => {
    const tawg = new RecordingTawgLoader()
    const role = new RecordingRoleLoader()
    const app = await harness(instance, instance.phase === 'member' ? { tawg, role } : {})
    try {
      const response = await app.request(2, 'tools/list', {}) as {
        result: { tools: Array<{ name: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }> }
      }
      const tools = new Map(response.result.tools.map((tool) => [tool.name, tool]))
      expect([...tools.keys()].sort()).toEqual(['collaboration.get', 'role.get', 'tas.get', 'tawg.get'])
      for (const tool of tools.values()) {
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
        expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false })
      }
      expect(tools.get('tas.get')?.inputSchema).toMatchObject({ properties: {} })
      expect(tools.get('collaboration.get')?.inputSchema).toMatchObject({ properties: {} })
      expect(tools.get('tawg.get')?.inputSchema).toMatchObject({
        properties: { credential: { properties: { secret: { writeOnly: true } }, additionalProperties: false } },
      })
      expect(tools.get('role.get')?.inputSchema).toMatchObject({
        required: ['role'],
        properties: {
          role: { type: 'string' },
          credential: { properties: { secret: { writeOnly: true } }, additionalProperties: false },
        },
      })
    } finally { await app.close() }
  })

  it.each([identitySetup, tawgSetup])('keeps TAS available and returns a stable member-context error in $phase', async (instance) => {
    const app = await harness(instance)
    try {
      const tasResponse = await app.request(2, 'tools/call', { name: 'tas.get', arguments: {} }) as {
        result: { structuredContent: { data: unknown }; content: unknown }
      }
      expect(tasResponse.result.structuredContent.data).toMatchObject({ skill: { name: 'tas' } })
      for (const [index, name] of ['collaboration.get', 'tawg.get', 'role.get'].entries()) {
        const arguments_ = name === 'role.get' ? { role: 'contributor' } : {}
        const response = await app.request(index + 3, 'tools/call', { name, arguments: arguments_ })
        expect(toolErrorCode(response)).toBe('SKILL_MEMBER_CONTEXT_REQUIRED')
      }
    } finally { await app.close() }
  })

  it('requires both Repository loaders when registering member tools', () => {
    const server = new McpServer({ name: 'skill-tools-test', version: '1' })
    expect(() => registerSkillTools(server, { tas, collaboration, instance: member }))
      .toThrow('Invalid TAS Skill service composition.')
  })
})

describe('flat Skill MCP results and validation', () => {
  it('returns all four complete Skills with exact public source variants and compact text', async () => {
    const tawg = new RecordingTawgLoader()
    const role = new RecordingRoleLoader()
    const app = await harness(member, { tawg, role })
    const secret = 'operation-secret-that-must-not-return'
    try {
      const calls = [
        ['tas.get', {}, 'tas'],
        ['collaboration.get', {}, 'tawg-collaboration'],
        ['tawg.get', { credential: { type: 'inline', secret } }, 'tawg'],
        ['role.get', { role: 'contributor', credential: { type: 'inline', secret } }, 'role'],
      ] as const
      const responses = []
      for (const [index, [name, arguments_, skillName]] of calls.entries()) {
        const response = await app.request(index + 2, 'tools/call', { name, arguments: arguments_ }) as {
          result: { content: unknown; structuredContent: { context: unknown; data: Record<string, unknown> } }
        }
        expect(response.result.structuredContent.data).toMatchObject({ skill: { name: skillName } })
        expect(JSON.stringify(response.result.content)).not.toMatch(/full release instructions|full repository instructions|operation-secret/)
        expect(JSON.stringify(response)).not.toContain(secret)
        responses.push(response)
      }

      expect(responses[0]?.result.structuredContent.data).toEqual({
        skill: { name: 'tas' },
        source: {
          kind: 'release', package: '@trustless-ai/tas', version: '0.1.0', path: 'skills/tas/SKILL.md',
          content_digest: { algorithm: 'sha256', value: digest },
        },
        content: { media_type: 'text/markdown; charset=utf-8', encoding: 'utf8', value: releaseContent },
      })
      expect(responses[1]?.result.structuredContent.data).toMatchObject({
        skill: { name: 'tawg-collaboration' },
        source: { kind: 'release', path: 'skills/tawg-collaboration/SKILL.md' },
      })
      expect(responses[2]?.result.structuredContent).toMatchObject({
        context: { instance: member, resolved: {
          chain: { block_number: '42', block_hash: blockHash }, profile: { version: '7' },
          repository: { url: repositoryUrl, commit: repositoryCommit },
        } },
        data: {
          skill: { name: 'tawg' },
          source: {
            kind: 'repository', repository_url: repositoryUrl, commit: repositoryCommit,
            path: 'skills/SKILL.md', content_digest: { algorithm: 'sha256', value: digest },
          },
          content: { media_type: 'text/markdown; charset=utf-8', encoding: 'utf8', value: repositoryContent },
        },
      })
      expect(responses[3]?.result.structuredContent.data).toMatchObject({
        skill: { name: 'role', role: 'contributor' },
        source: { kind: 'repository', path: 'skills/roles/contributor.md' },
      })
      expect(tawg.calls).toEqual([{ credential: { type: 'inline', secret } }])
      expect(role.calls).toEqual([{ role: 'contributor', credential: { type: 'inline', secret } }])
    } finally { await app.close() }
  })

  it.each([
    ['tas.get', { unknown: true }],
    ['collaboration.get', { unknown: true }],
    ['tawg.get', { commit: 'a'.repeat(40) }],
    ['tawg.get', { repository: repositoryUrl }],
    ['tawg.get', { path: 'skills/SKILL.md' }],
    ['tawg.get', { credential: { type: 'inline', secret: 'x', extra: true } }],
    ['role.get', {}],
    ['role.get', { role: '../contributor' }],
    ['role.get', { role: 'contributor', commit: 'a'.repeat(40) }],
    ['role.get', { role: 'contributor', repository: repositoryUrl }],
    ['role.get', { role: 'contributor', path: 'skills/roles/contributor.md' }],
    ['role.get', { role: 'contributor', unknown: true }],
    ['role.get', { role: 'contributor', credential: { type: 'inline', secret: 'x', extra: true } }],
  ] as const)('rejects invalid or unknown %s input before Repository access', async (name, arguments_) => {
    const tawg = new RecordingTawgLoader()
    const role = new RecordingRoleLoader()
    const app = await harness(member, { tawg, role })
    try {
      const response = await app.request(2, 'tools/call', { name, arguments: arguments_ })
      expect(response).toMatchObject({
        result: { isError: true, content: [{ type: 'text', text: expect.stringContaining('Input validation error') }] },
      })
      expect(tawg.calls).toEqual([])
      expect(role.calls).toEqual([])
    } finally { await app.close() }
  })

  it('returns Repository loader failures through the fixed public error projection', async () => {
    const tawg = new RecordingTawgLoader()
    tawg.failure = new TasError('SKILL_INVALID', 'full provider body containing a secret')
    const app = await harness(member, { tawg, role: new RecordingRoleLoader() })
    try {
      const response = await app.request(2, 'tools/call', { name: 'tawg.get', arguments: {} })
      expect(toolErrorCode(response)).toBe('SKILL_INVALID')
      expect(JSON.stringify(response)).not.toContain('full provider body containing a secret')
    } finally { await app.close() }
  })

  it('rejects a Root loader result substituted with a Role Skill', async () => {
    const tawg: TawgSkillLoader = { get: async () => roleResult as unknown as TawgSkillGetResult }
    const app = await harness(member, { tawg, role: new RecordingRoleLoader() })
    try {
      const response = await app.request(2, 'tools/call', { name: 'tawg.get', arguments: {} })
      expect(toolErrorCode(response)).toBe('SKILL_INVALID')
      expect(JSON.stringify(response)).not.toContain(repositoryContent)
    } finally { await app.close() }
  })

  it('rejects a Role loader result whose role and path do not match the request', async () => {
    const substituted: RoleSkillGetResult = {
      ...roleResult,
      skill: { name: 'role', role: 'evaluator' },
      source: { ...roleResult.source, path: 'skills/roles/evaluator.md' },
    }
    const role: RoleSkillLoader = { get: async () => substituted }
    const app = await harness(member, { tawg: new RecordingTawgLoader(), role })
    try {
      const response = await app.request(2, 'tools/call', {
        name: 'role.get', arguments: { role: 'contributor' },
      })
      expect(toolErrorCode(response)).toBe('SKILL_INVALID')
      expect(JSON.stringify(response)).not.toContain(repositoryContent)
    } finally { await app.close() }
  })

  it('rejects an accessor-backed Role result that changes after validation', async () => {
    let roleReads = 0
    let pathReads = 0
    const changingSkill = Object.defineProperty({ name: 'role' }, 'role', {
      enumerable: true,
      get: () => roleReads++ === 0 ? 'contributor' : 'evaluator',
    })
    const changingSource = Object.defineProperty({ ...roleResult.source }, 'path', {
      enumerable: true,
      get: () => pathReads++ === 0 ? 'skills/roles/contributor.md' : 'skills/roles/evaluator.md',
    })
    const role: RoleSkillLoader = {
      get: async () => ({
        ...roleResult,
        skill: changingSkill,
        source: changingSource,
      }) as unknown as RoleSkillGetResult,
    }
    const app = await harness(member, { tawg: new RecordingTawgLoader(), role })
    try {
      const response = await app.request(2, 'tools/call', {
        name: 'role.get', arguments: { role: 'contributor' },
      })
      expect(toolErrorCode(response)).toBe('SKILL_INVALID')
      expect(JSON.stringify(response)).not.toContain(repositoryContent)
    } finally { await app.close() }
  })
})
