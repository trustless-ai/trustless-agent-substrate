import {
  CLIENT_CAPABILITIES_META_KEY,
  InMemoryTransport,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'

import type { DaService } from '../../src/core/da/service.js'
import type { ProfileReader } from '../../src/core/profile/reader.js'
import { ProfileResolver } from '../../src/core/profile/resolver.js'
import type { ProfileSnapshot, RawAgentSnapshot } from '../../src/core/profile/types.js'
import type { RepositoryService } from '../../src/core/repository/service.js'
import type { RepositorySource } from '../../src/core/repository/types.js'
import type { RoleSkillLoader, TawgSkillLoader } from '../../src/core/skill/loader.js'
import { loadBundledCollaborationSkill } from '../../src/core/skill/collaborationSkill.js'
import { loadBundledTasSkill } from '../../src/core/skill/tasSkill.js'
import type { ChainService } from '../../src/core/workflow/chainService.js'
import type { WorkflowSourceService } from '../../src/core/workflow/sourceService.js'
import type { WorkflowOperationService } from '../../src/core/workflow/types.js'
import { getManifestRegistry } from '../../src/mcp/manifest/registry.js'
import { createTasMcpServer } from '../../src/mcp/server.js'
import { expectedMemberTools } from './toolInventory.expected.js'

const tawgAddress = '0x1000000000000000000000000000000000000001' as const
const blockHash = `0x${'a'.repeat(64)}` as const
const agentId = '340282366920938463463374607431768211457'
const source: RepositorySource = {
  provider: 'github', locator: 'https://github.com/trustless-ai/tawg-demo', owner: 'trustless-ai', repository: 'tawg-demo',
  profile: { blockNumber: '42', blockHash, version: '7' },
  charter: { commit: 'b'.repeat(40), path: 'charter/' },
}
const profile: ProfileSnapshot = {
  chainId: '31337', tawgAddress, blockNumber: '42', blockHash, version: '7',
  governance: '0x2000000000000000000000000000000000000002',
  identityRegistry: '0x3000000000000000000000000000000000000003',
  charter: { repository: source.locator, commitHash: source.charter.commit, path: 'charter/' },
  agentIds: [agentId], dataEntries: [],
  workflow: { workflowAddress: '0x4000000000000000000000000000000000000004', data: '{}' },
}
const agent: RawAgentSnapshot = {
  chainId: '31337', tawgAddress, blockNumber: '42', blockHash, version: '7',
  identityRegistry: profile.identityRegistry, agentId, isMember: true, data: '{}',
  agentVerifier: '0x5000000000000000000000000000000000000005',
  authenticationWallet: '0x6000000000000000000000000000000000000006',
}
const reader: ProfileReader = {
  readProfile: async () => profile,
  readAgent: async () => agent,
}
const resolver = new ProfileResolver(reader, { chainId: '31337', tawgAddress })
const repositoryService: RepositoryService = {
  getRepository: async () => source,
  listActivity: async () => ({
    source, observedAt: '2026-08-23T00:00:00Z', items: [], page: { consistency: 'live' },
  }),
}
const roleSkillLoader: RoleSkillLoader = {
  get: async ({ role }) => ({
    skill: { name: 'role', role },
    source: {
      kind: 'repository',
      repositoryUrl: source.locator, commit: source.charter.commit,
      path: `skills/roles/${role}.md`, profile: source.profile,
      contentDigest: { algorithm: 'sha256', value: 'c'.repeat(64) },
    },
    content: { mediaType: 'text/markdown; charset=utf-8', encoding: 'utf8', value: '# Contributor' },
  }),
}
const tawgSkillLoader: TawgSkillLoader = {
  get: async () => ({
    skill: { name: 'tawg' },
    source: {
      kind: 'repository', repositoryUrl: source.locator, commit: source.charter.commit,
      path: 'skills/SKILL.md', profile: source.profile,
      contentDigest: { algorithm: 'sha256', value: 'd'.repeat(64) },
    },
    content: { mediaType: 'text/markdown; charset=utf-8', encoding: 'utf8', value: '# Demo TAWG' },
  }),
}
const chainService: ChainService = { invoke: async () => { throw new Error('not called') } }
const workflowService: WorkflowOperationService = { invoke: async () => { throw new Error('not called') } }
const workflowSourceService: WorkflowSourceService = {
  verify: async () => { throw new Error('not called') },
  get: async () => { throw new Error('not called') },
}
const daService: DaService = {
  capabilities: async () => ({
    backend: 'git', reference_types: ['git'], read: true, write: true,
    content_encodings: ['utf8', 'base64'], max_inline_bytes: 1_048_576,
  }),
  get: async () => { throw new Error('not called') },
  put: async () => { throw new Error('not called') },
}

function serverFactory() {
  return createTasMcpServer({
    tasSkill: loadBundledTasSkill(),
    collaborationSkill: loadBundledCollaborationSkill(),
    instance: { phase: 'member', chain_id: '31337', tawg_address: tawgAddress, agent_id: agentId },
    resolver,
    repositoryService,
    tawgSkillLoader,
    roleSkillLoader,
    registry: getManifestRegistry(),
    chainService,
    workflowService,
    workflowSourceService,
    daService,
  })
}

async function connect(era: 'legacy' | 'modern') {
  const server = serverFactory()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const received = new Map<number, unknown>()
  clientTransport.onmessage = (message) => {
    if ('id' in message && typeof message.id === 'number') received.set(message.id, message)
  }
  await server.connect(serverTransport)
  await clientTransport.start()
  async function request(id: number, method: string, params: Record<string, unknown>): Promise<unknown> {
    await clientTransport.send({ jsonrpc: '2.0', id, method, params })
    for (let attempt = 0; attempt < 100 && !received.has(id); attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }
    return received.get(id)
  }
  const meta = {
    [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
    [CLIENT_CAPABILITIES_META_KEY]: {},
  }
  if (era === 'legacy') {
    await request(1, 'initialize', {
      protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    })
    await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }
  return {
    request,
    params: era === 'legacy' ? {} : { _meta: meta },
    close: async () => { await server.close(); await clientTransport.close() },
  }
}

describe('Repository and Role Skill member MCP conformance', () => {
  it.each(['legacy', 'modern'] as const)('registers the cumulative member inventory on each fresh %s server', async (era) => {
    const first = await connect(era)
    const second = await connect(era)
    try {
      const one = await first.request(2, 'tools/list', first.params) as { result: { tools: Array<{ name: string }> } }
      const two = await second.request(2, 'tools/list', second.params) as { result: { tools: Array<{ name: string }> } }
      expect(one.result.tools.map(({ name }) => name).toSorted()).toEqual(expectedMemberTools)
      expect(two.result.tools.map(({ name }) => name).toSorted()).toEqual(expectedMemberTools)
      expect(new Set(one.result.tools.map(({ name }) => name))).toHaveLength(expectedMemberTools.length)
    } finally {
      await first.close()
      await second.close()
    }
  })

  it.each(['legacy', 'modern'] as const)('returns Collaboration, Root, and Role Skills through a fresh %s server', async (era) => {
    const app = await connect(era)
    try {
      const collaboration = await app.request(2, 'tools/call', {
        name: 'collaboration.get', arguments: {}, ...app.params,
      }) as { result: { structuredContent: { data: unknown }; content: unknown } }
      const tawg = await app.request(3, 'tools/call', {
        name: 'tawg.get', arguments: {}, ...app.params,
      }) as { result: { structuredContent: { data: unknown }; content: unknown } }
      const role = await app.request(4, 'tools/call', {
        name: 'role.get', arguments: { role: 'contributor' }, ...app.params,
      }) as { result: { structuredContent: { data: unknown }; content: unknown } }

      expect(collaboration.result.structuredContent.data).toMatchObject({
        skill: { name: 'tawg-collaboration' },
        source: {
          kind: 'release', package: '@trustless-ai/tas', version: '0.1.0',
          path: 'skills/tawg-collaboration/SKILL.md', content_digest: { algorithm: 'sha256' },
        },
        content: { media_type: 'text/markdown; charset=utf-8', encoding: 'utf8', value: expect.stringContaining('# TAWG Collaboration') },
      })
      expect(tawg.result.structuredContent.data).toEqual({
        skill: { name: 'tawg' },
        source: {
          kind: 'repository', repository_url: source.locator, commit: source.charter.commit,
          path: 'skills/SKILL.md', content_digest: { algorithm: 'sha256', value: 'd'.repeat(64) },
        },
        content: { media_type: 'text/markdown; charset=utf-8', encoding: 'utf8', value: '# Demo TAWG' },
      })
      expect(role.result.structuredContent.data).toEqual({
        skill: { name: 'role', role: 'contributor' },
        source: {
          kind: 'repository', repository_url: source.locator, commit: source.charter.commit,
          path: 'skills/roles/contributor.md', content_digest: { algorithm: 'sha256', value: 'c'.repeat(64) },
        },
        content: { media_type: 'text/markdown; charset=utf-8', encoding: 'utf8', value: '# Contributor' },
      })
      expect(JSON.stringify([collaboration.result.content, tawg.result.content, role.result.content]))
        .not.toMatch(/TAWG Collaboration|Demo TAWG|Contributor/)
    } finally { await app.close() }
  })
})
