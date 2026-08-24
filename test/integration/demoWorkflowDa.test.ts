import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { InMemoryTransport, type McpServerFactory } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'

import { createTasApp } from '../../src/app/createTasApp.js'
import type { DaClient } from '../../src/core/da/client.js'
import type { DaCredential, GitDaPath, GitDaReference } from '../../src/core/da/types.js'
import type { RepositorySource } from '../../src/core/repository/types.js'
import { createProfileRpcFixture, fixtureAgentId, fixtureProfileAddress } from '../fixtures/profile/blocks.js'

function configuration(): string {
  return `config_version = 1
mode = "member"

[instance]
chain_id = "31337"
tawg_address = "${fixtureProfileAddress}"
agent_id = "${fixtureAgentId}"

[chain]
family = "evm"
rpc_url_env = "TAS_RPC_URL"

[repository]
client = "github"

[da]
client = "git"
`
}

function offlineGitDaClient(observedSecrets: string[]): DaClient {
  const objects = new Map<string, Uint8Array>()

  return {
    capabilities() {
      return {
        backend: 'git',
        reference_types: ['git'],
        read: true,
        write: true,
        content_encodings: ['utf8', 'base64'],
        max_inline_bytes: 1_048_576,
      }
    },
    async put(
      _source: RepositorySource,
      path: GitDaPath,
      bytes: Uint8Array,
      _mediaType?: string,
      credential?: DaCredential,
    ): Promise<GitDaReference> {
      if (credential) observedSecrets.push(credential.secret)
      const commit = createHash('sha1').update(path).update(bytes).digest('hex')
      objects.set(`${commit}:${path}`, bytes.slice())
      return { type: 'git', commit, path }
    },
    async get(
      _source: RepositorySource,
      ref: GitDaReference,
      credential?: DaCredential,
    ) {
      if (credential) observedSecrets.push(credential.secret)
      const object = objects.get(`${ref.commit}:${ref.path}`)
      if (!object) throw new Error('offline immutable object was not found')
      return { bytes: object.slice() }
    },
  }
}

async function connect(factory: McpServerFactory) {
  const server = factory({ era: '2026-07-28' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const responses = new Map<number, unknown>()
  let nextId = 1
  clientTransport.onmessage = (message) => {
    if ('id' in message && typeof message.id === 'number') responses.set(message.id, message)
  }
  await server.connect(serverTransport)
  await clientTransport.start()
  const request = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const id = nextId++
    await clientTransport.send({ jsonrpc: '2.0', id, method, params })
    for (let attempt = 0; attempt < 1_000 && !responses.has(id); attempt += 1) {
      await new Promise<void>((done) => setTimeout(done, 2))
    }
    const response = responses.get(id)
    if (response === undefined) throw new Error(`MCP ${method} did not respond.`)
    return response
  }
  await request('initialize', {
    protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'demo-workflow-da', version: '1' },
  })
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return {
    call: async (name: string, arguments_: Record<string, unknown> = {}) => await request('tools/call', {
      name, arguments: arguments_,
    }),
    close: async () => { await server.close(); await clientTransport.close() },
  }
}

function structuredContent(response: unknown): Record<string, unknown> {
  const value = response as { result?: { structuredContent?: unknown } }
  if (!value.result?.structuredContent || typeof value.result.structuredContent !== 'object') {
    throw new Error('MCP response did not contain structured content.')
  }
  return value.result.structuredContent as Record<string, unknown>
}

describe('demo TAWG immutable DA flow', () => {
  it('round-trips an exact contribution record through member TAS MCP tools', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tas-demo-da-'))
    const configPath = join(root, 'tas.toml')
    writeFileSync(configPath, configuration())
    const observedSecrets: string[] = []
    let factory: McpServerFactory | undefined
    const profileFixture = createProfileRpcFixture()
    const app = await createTasApp(configPath, {
      environment: { TAS_RPC_URL: 'http://127.0.0.1:8545' },
      stateRoot: join(root, 'state'),
      createChainClient: () => profileFixture.client,
      createWalletChainClient: () => ({ account: undefined, chain: { id: 31337 } }) as never,
      createRepositoryClient: () => ({
        async resolveDefaultHead(source) { return source.charter.commit },
        async readFile(_source, commit, path) { return { path, commit, bytes: new Uint8Array() } },
        async listIssues() { return { items: [], consistency: 'live' } },
        async listPullRequests() { return { items: [], consistency: 'live' } },
        async listCommits() { return { items: [], consistency: 'live' } },
      }),
      createDaClient: () => offlineGitDaClient(observedSecrets),
      createWorkflowCodeReader: () => ({ async readCode() { return '0x' } }),
      serve(selectedFactory) { factory = selectedFactory; return { close: async () => {} } },
    })
    if (factory === undefined) throw new Error('TAS did not expose an MCP server.')
    const mcp = await connect(factory)

    try {
      const contribution = JSON.stringify({
        kind: 'contribution',
        agent_id: fixtureAgentId,
        round: 3,
        summary: 'Implemented the demo Workflow evidence path.',
      })
      const credential = { type: 'inline', secret: 'operation-scoped-demo-secret' }
      const putResponse = structuredContent(await mcp.call('workflow.da.put', {
        content: { encoding: 'utf8', value: contribution, media_type: 'application/json' },
        destination: { path: 'data/rounds/3/contribution.json' },
        credential,
      }))
      const putData = putResponse.data as { ref: GitDaReference; size_bytes: number }

      expect(putData).toEqual({
        ref: {
          type: 'git',
          commit: expect.stringMatching(/^[0-9a-f]{40}$/),
          path: 'data/rounds/3/contribution.json',
        },
        size_bytes: Buffer.byteLength(contribution),
      })
      expect(putResponse).not.toHaveProperty('source')
      expect(JSON.stringify(putResponse)).not.toContain(credential.secret)

      const getResponse = structuredContent(await mcp.call('workflow.da.get', {
        ref: putData.ref,
        credential,
      }))
      const getData = getResponse.data as {
        ref: GitDaReference
        content: { encoding: 'base64'; value: string; media_type?: string }
        size_bytes: number
      }
      expect(getData.ref).toEqual(putData.ref)
      expect(getData.size_bytes).toBe(Buffer.byteLength(contribution))
      expect(getData.content).not.toHaveProperty('media_type')
      expect(Buffer.from(getData.content.value, 'base64').toString('utf8')).toBe(contribution)
      expect(getResponse).not.toHaveProperty('digest')
      expect(JSON.stringify(getResponse)).not.toContain(credential.secret)

      const putContext = putResponse.context as { resolved: { repository: { commit: string }; da: GitDaReference } }
      const getContext = getResponse.context as { resolved: { repository: { commit: string }; da: GitDaReference } }
      expect(putContext.resolved.repository.commit).toBe(putData.ref.commit)
      expect(putContext.resolved.da).toEqual(putData.ref)
      expect(getContext.resolved).toEqual(putContext.resolved)
      expect(observedSecrets).toEqual([credential.secret, credential.secret])
    } finally {
      await mcp.close()
      await app.close()
      rmSync(root, { force: true, recursive: true })
    }
  })
})
