import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { InMemoryTransport } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'

import { TasError } from '../../src/core/errors.js'
import type { ChatService } from '../../src/core/chat/service.js'
import type { ChatConfiguredSource } from '../../src/core/chat/types.js'
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
import type { TasPublicInstance } from '../../src/mcp/results.js'
import { expectedIdentityTools, expectedMemberTools, expectedTawgTools } from './toolInventory.expected.js'

const tawgAddress = '0x1000000000000000000000000000000000000001' as const
const blockHash = `0x${'a'.repeat(64)}` as const
const expectedSkillBytes = readFileSync(new URL('../../skills/tas/SKILL.md', import.meta.url))
const expectedSkillContent = expectedSkillBytes.toString('utf8')
const expectedSkillDigest = createHash('sha256').update(expectedSkillBytes).digest('hex')
const skillArtifacts = () => ({
  tasSkill: loadBundledTasSkill(),
  collaborationSkill: loadBundledCollaborationSkill(),
})
const instances = {
  identity: {
    phase: 'identity_setup', chain_id: '31337',
    identity_registry_address: '0x8004000000000000000000000000000000000001',
  },
  tawg: { phase: 'tawg_setup', chain_id: '31337', tawg_address: tawgAddress },
  member: { phase: 'member', chain_id: '31337', tawg_address: tawgAddress, agent_id: '340282366920938463463374607431768211457' },
} as const satisfies Record<string, TasPublicInstance>

function profileSnapshot(): ProfileSnapshot {
  return {
    chainId: '31337', tawgAddress, blockNumber: '42', blockHash, version: '1',
    governance: '0x2000000000000000000000000000000000000002',
    identityRegistry: '0x3000000000000000000000000000000000000003',
    charter: { repository: 'https://github.com/trustless-ai/tawg-demo', commitHash: 'b'.repeat(40), path: 'charter/' },
    agentIds: [], dataEntries: [],
    workflow: { workflowAddress: '0x4000000000000000000000000000000000000004', data: '{}' },
  }
}

function agentSnapshot(): RawAgentSnapshot {
  return {
    chainId: '31337', tawgAddress, blockNumber: '42', blockHash, version: '1',
    identityRegistry: '0x3000000000000000000000000000000000000003',
    agentId: instances.member.agent_id, isMember: false, data: '',
    agentVerifier: '0x0000000000000000000000000000000000000000',
  }
}

const reader: ProfileReader = {
  readProfile: async () => profileSnapshot(),
  readAgent: async () => agentSnapshot(),
}
const resolver = new ProfileResolver(reader, { chainId: '31337', tawgAddress })
const registry = getManifestRegistry()
const chainService: ChainService = { invoke: async () => { throw new Error('not called') } }
const workflowService: WorkflowOperationService = {
  invoke: async () => { throw new TasError('WORKFLOW_SOURCE_VERIFICATION_REQUIRED', 'closed') },
}
const workflowSourceService: WorkflowSourceService = {
  verify: async () => { throw new TasError('WORKFLOW_SOURCE_UNAVAILABLE', 'unavailable') },
  get: async () => { throw new TasError('WORKFLOW_SOURCE_VERIFICATION_REQUIRED', 'closed') },
}
const daService: DaService = {
  capabilities: async () => ({
    backend: 'git', reference_types: ['git'], read: true, write: true,
    content_encodings: ['utf8', 'base64'], max_inline_bytes: 1_048_576,
  }),
  get: async () => { throw new Error('not called') },
  put: async () => { throw new Error('not called') },
}
const mismatchedChatService: ChatService = {
  platforms: () => ['telegram', 'discord'],
  invoke: async () => { throw new Error('not called') },
  wait: async () => { throw new Error('not called') },
}
const telegramChatSources = [{
  name: 'telegram-main', platform: 'telegram', pollInterval: '1s',
}] as const satisfies readonly ChatConfiguredSource[]
const repositorySource: RepositorySource = {
  provider: 'github', locator: 'https://github.com/trustless-ai/tawg-demo', owner: 'trustless-ai', repository: 'tawg-demo',
  profile: { blockNumber: '42', blockHash, version: '1' },
  charter: { commit: 'b'.repeat(40), path: 'charter/' },
}
const repositoryService: RepositoryService = {
  getRepository: async () => repositorySource,
  listActivity: async () => ({
    source: repositorySource, observedAt: '2026-08-23T00:00:00Z', items: [], page: { consistency: 'live' },
  }),
}
const roleSkillLoader: RoleSkillLoader = {
  get: async ({ role }) => ({
    skill: { name: 'role', role },
    source: {
      kind: 'repository',
      repositoryUrl: repositorySource.locator,
      commit: repositorySource.charter.commit,
      path: `skills/roles/${role}.md`,
      profile: repositorySource.profile,
      contentDigest: { algorithm: 'sha256', value: 'c'.repeat(64) },
    },
    content: { mediaType: 'text/markdown; charset=utf-8', encoding: 'utf8', value: '# Role' },
  }),
}
const tawgSkillLoader: TawgSkillLoader = {
  get: async () => ({
    skill: { name: 'tawg' },
    source: {
      kind: 'repository', repositoryUrl: repositorySource.locator,
      commit: repositorySource.charter.commit, path: 'skills/SKILL.md', profile: repositorySource.profile,
      contentDigest: { algorithm: 'sha256', value: 'd'.repeat(64) },
    },
    content: { mediaType: 'text/markdown; charset=utf-8', encoding: 'utf8', value: '# TAWG' },
  }),
}

async function connect(instance: TasPublicInstance, selectedResolver?: ProfileResolver) {
  const server = createTasMcpServer({
    ...skillArtifacts(),
    chainService,
    instance,
    registry,
    ...(selectedResolver === undefined ? {} : { resolver: selectedResolver }),
    ...(instance.phase === 'member'
      ? { repositoryService, tawgSkillLoader, roleSkillLoader, workflowService, workflowSourceService, daService }
      : {}),
  })
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
  await request(1, 'initialize', {
    protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'inventory-test', version: '1' },
  })
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return {
    request,
    close: async () => { await server.close(); await clientTransport.close() },
  }
}

describe('fixed Slice A1 MCP inventory', () => {
  it.each([
    [instances.identity, undefined, expectedIdentityTools],
    [instances.tawg, resolver, expectedTawgTools],
    [instances.member, resolver, expectedMemberTools],
  ] as const)('exposes exactly the tools for $phase', async (instance, selectedResolver, expectedNames) => {
    const app = await connect(instance, selectedResolver)
    try {
      const response = await app.request(2, 'tools/list', {}) as { result: { tools: Array<{ name: string }> } }
      const repeated = await app.request(3, 'tools/list', {}) as { result: unknown }
      expect(response.result.tools.map(({ name }) => name).sort()).toEqual(expectedNames)
      expect(repeated.result).toEqual(response.result)
    } finally { await app.close() }
  })

  it('fails closed for impossible phase and Profile service combinations', () => {
    const skills = skillArtifacts()
    expect(() => createTasMcpServer({ ...skills, chainService, instance: instances.identity, registry, resolver })).toThrow()
    expect(() => createTasMcpServer({ ...skills, chainService, instance: instances.tawg, registry })).toThrow()
    expect(() => createTasMcpServer({ ...skills, chainService, instance: instances.member, registry })).toThrow()
    const memberServices = { resolver, repositoryService, tawgSkillLoader, roleSkillLoader, workflowService, workflowSourceService, daService }
    for (const missing of [
      'repositoryService',
      'tawgSkillLoader',
      'roleSkillLoader',
      'workflowService',
      'workflowSourceService',
      'daService',
    ] as const) {
      expect(() => createTasMcpServer({
        ...skills, chainService, instance: instances.member, registry,
        ...memberServices, [missing]: undefined,
      }), `member composition without ${missing}`).toThrow('Invalid TAS phase service composition.')
    }
    expect(() => createTasMcpServer({
      ...skills, chainService, instance: instances.identity, registry, tawgSkillLoader,
    })).toThrow()
    expect(() => createTasMcpServer({ ...skills, chainService, instance: instances.identity, registry, workflowService })).toThrow()
    expect(() => createTasMcpServer({ ...skills, chainService, instance: instances.tawg, registry, resolver, workflowService })).toThrow()
    expect(() => createTasMcpServer({ ...skills, chainService, instance: instances.identity, registry, workflowSourceService })).toThrow()
    expect(() => createTasMcpServer({ ...skills, chainService, instance: instances.identity, registry, daService })).toThrow()
    expect(() => createTasMcpServer({
      ...skills,
      chainService,
      instance: instances.member,
      registry,
      resolver,
      repositoryService,
      tawgSkillLoader,
      roleSkillLoader,
      workflowService,
      workflowSourceService,
      daService,
      chatService: mismatchedChatService,
      chatSources: telegramChatSources,
      chatToolEntries: [],
    })).toThrow('Invalid TAS phase service composition.')
  })

  it('creates fresh isolated servers with the running package version and successful nonmember data', async () => {
    const first = await connect(instances.member, resolver)
    const second = await connect(instances.member, resolver)
    try {
      const skill = await first.request(2, 'tools/call', { name: 'tas.get', arguments: {} })
      const nonmember = await second.request(2, 'tools/call', {
        name: 'profile.get_agent', arguments: { agent_id: instances.member.agent_id },
      })
      expect(skill).toMatchObject({ result: { structuredContent: { data: {
        skill: { name: 'tas' },
        source: {
          kind: 'release', package: '@trustless-ai/tas', version: '0.1.0', path: 'skills/tas/SKILL.md',
          content_digest: { algorithm: 'sha256', value: expectedSkillDigest },
        },
        content: { media_type: 'text/markdown; charset=utf-8', encoding: 'utf8', value: expectedSkillContent },
      } } } })
      expect(nonmember).toMatchObject({ result: { structuredContent: { data: { agent_id: instances.member.agent_id, is_member: false } } } })
      expect((nonmember as { result: { isError?: boolean } }).result.isError).toBeUndefined()
    } finally {
      await first.close()
      await second.close()
    }
  })

  it.each([
    [instances.identity, undefined],
    [instances.tawg, resolver],
  ] as const)('keeps member Skills discoverable but guarded in $phase', async (instance, selectedResolver) => {
    const app = await connect(instance, selectedResolver)
    try {
      for (const [id, name] of ['collaboration.get', 'tawg.get', 'role.get'].entries()) {
        const response = await app.request(id + 2, 'tools/call', {
          name, arguments: name === 'role.get' ? { role: 'contributor' } : {},
        })
        expect(response).toMatchObject({ result: { isError: true, structuredContent: {
          error: { code: 'SKILL_MEMBER_CONTEXT_REQUIRED' },
        } } })
      }
    } finally { await app.close() }
  })

  it('does not expose Profile operations in identity setup', async () => {
    const app = await connect(instances.identity)
    try {
      const response = await app.request(2, 'tools/call', { name: 'profile.get', arguments: {} })
      expect(response).toMatchObject({ error: { code: expect.any(Number) } })
      expect(response).not.toHaveProperty('result')
    } finally { await app.close() }
  })
})
