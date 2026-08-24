import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { RoleSkillLoader, TawgSkillLoader } from '../../src/core/skill/loader.js'
import { loadBundledCollaborationSkill } from '../../src/core/skill/collaborationSkill.js'
import { loadBundledTasSkill } from '../../src/core/skill/tasSkill.js'
import { registerSkillTools } from '../../src/mcp/skillTools.js'
import type { TasPublicInstance } from '../../src/mcp/results.js'

const validTasSkill = '---\nname: tas\ndescription: Use when loading the release-matched TAS Skill.\n---\n\n# TAS\n'
const validCollaborationSkill = '---\nname: tawg-collaboration\ndescription: Use when coordinating TAWG work.\n---\n\n# Collaboration\n'

function createPackageRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tas-skill-tool-'))
  mkdirSync(join(root, 'skills', 'tas'), { recursive: true })
  mkdirSync(join(root, 'skills', 'tawg-collaboration'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@trustless-ai/tas', version: '9.8.7' }))
  writeFileSync(join(root, 'skills', 'tas', 'SKILL.md'), validTasSkill)
  writeFileSync(join(root, 'skills', 'tawg-collaboration', 'SKILL.md'), validCollaborationSkill)
  return root
}

const unusedTawgLoader: TawgSkillLoader = {
  get: async () => { throw new Error('Repository Skill is not used in this conformance test.') },
}
const unusedRoleLoader: RoleSkillLoader = {
  get: async () => { throw new Error('Repository Skill is not used in this conformance test.') },
}

async function callToolThroughSdk(instance: TasPublicInstance, packageRoot: string): Promise<{ tools: unknown; result: unknown }> {
  const server = new McpServer({ name: 'tas-test', version: '1.0.0' })
  registerSkillTools(server, {
    tas: loadBundledTasSkill({ packageRoot }),
    collaboration: loadBundledCollaborationSkill({ packageRoot }),
    instance,
    ...(instance.phase === 'member' ? { tawg: unusedTawgLoader, role: unusedRoleLoader } : {}),
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
    for (let count = 0; count < 100 && !received.has(id); count += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }
    return received.get(id)
  }

  try {
    await request(1, 'initialize', {
      protocolVersion: '2026-07-28', capabilities: {},
      clientInfo: { name: 'tas-conformance-test', version: '1.0.0' },
    })
    await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    return {
      tools: await request(2, 'tools/list', {}),
      result: await request(3, 'tools/call', { name: 'tas.get', arguments: {} }),
    }
  } finally {
    await server.close()
    await clientTransport.close()
  }
}

describe('flat bundled Skill tools', () => {
  it.each<TasPublicInstance>([
    { phase: 'identity_setup', chain_id: '1', identity_registry_address: '0x8004000000000000000000000000000000000001' },
    { phase: 'tawg_setup', chain_id: '1', tawg_address: '0x8004000000000000000000000000000000000002' },
    { phase: 'member', chain_id: '1', tawg_address: '0x8004000000000000000000000000000000000002', agent_id: '9007199254740993' },
  ])('exposes the same four tools and the exact no-input TAS Skill in $phase', async (instance) => {
    const root = createPackageRoot()
    try {
      const { tools, result } = await callToolThroughSdk(instance, root)

      const listed = (tools as {
        result: { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }
      }).result.tools
      expect(listed.map(({ name }) => name).sort()).toEqual(['collaboration.get', 'role.get', 'tas.get', 'tawg.get'])
      expect(listed).toHaveLength(4)
      const schemas = new Map(listed.map(({ name, inputSchema }) => [name, inputSchema]))
      expect(schemas.get('tas.get')).toMatchObject({ type: 'object', properties: {}, additionalProperties: false })
      expect(schemas.get('collaboration.get')).toMatchObject({ type: 'object', properties: {}, additionalProperties: false })
      expect(result).toMatchObject({ result: { structuredContent: {
        context: { instance },
        data: {
          skill: { name: 'tas' },
          source: {
            kind: 'release', package: '@trustless-ai/tas', version: '9.8.7', path: 'skills/tas/SKILL.md',
            content_digest: { algorithm: 'sha256' },
          },
          content: { media_type: 'text/markdown; charset=utf-8', encoding: 'utf8', value: validTasSkill },
        },
      } } })
      expect(JSON.stringify(result)).not.toContain('credential')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('returns both startup-cached release artifacts when bundled files mutate later', () => {
    const root = createPackageRoot()
    try {
      const tas = loadBundledTasSkill({ packageRoot: root })
      const collaboration = loadBundledCollaborationSkill({ packageRoot: root })
      writeFileSync(join(root, 'skills', 'tas', 'SKILL.md'), validTasSkill.replace('# TAS', '# later mutation'))
      writeFileSync(
        join(root, 'skills', 'tawg-collaboration', 'SKILL.md'),
        validCollaborationSkill.replace('# Collaboration', '# later mutation'),
      )
      const server = new McpServer({ name: 'tas-test', version: '1.0.0' })
      registerSkillTools(server, { tas, collaboration, instance: identitySetup })

      expect(tas.content.value).toBe(validTasSkill)
      expect(collaboration.content.value).toBe(validCollaborationSkill)
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })
})

const identitySetup: TasPublicInstance = {
  phase: 'identity_setup', chain_id: '1', identity_registry_address: '0x8004000000000000000000000000000000000001',
}
