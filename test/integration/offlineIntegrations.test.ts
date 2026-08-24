import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { InMemoryTransport, type McpServerFactory } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'

import { createTasApp, type CreateTasAppDependencies } from '../../src/app/createTasApp.js'
import { bundleAttestationAdapter, createProofProviderRegistry } from '../../src/core/proof-provider/registry.js'
import { getManifestRegistry } from '../../src/mcp/manifest/registry.js'
import { createFakeChatBroker } from '../fakes/chat/broker.js'
import { createFakeDiscordClient } from '../fakes/chat/fakeDiscordClient.js'
import { createFakeTelegramClient } from '../fakes/chat/fakeTelegramClient.js'
import { FakeAttestationAdapter } from '../fakes/proof-provider/fakeAttestationAdapter.js'
import { createProfileRpcFixture } from '../fixtures/profile/blocks.js'
import {
  expectedIdentityTools,
  expectedMemberTools,
  expectedTawgTools,
  expectedTelegramDiscordMemberTools,
  expectedTelegramMemberTools,
} from '../conformance/toolInventory.expected.js'

const rpcUrl = 'https://rpc.example.test'
const tawgAddress = '0x8004000000000000000000000000000000000003'
const agentId = '340282366920938463463374607431768211457'
const providerManifest = {
  provider: 'fixture_attestor',
  type: 'attestation',
  operations_namespace: 'proof_provider.attestation.fixture_attestor',
  operations: ['generate', 'validate'],
} as const

function configuration(mode: 'identity_setup' | 'tawg_setup' | 'member', platforms: readonly ('telegram' | 'discord')[] = []): string {
  const phase = mode === 'identity_setup'
    ? '[identity_setup]\nchain_id = "31337"\nidentity_registry_address = "0x8004000000000000000000000000000000000001"'
    : mode === 'tawg_setup'
      ? '[tawg_setup]\nchain_id = "31337"\ntawg_address = "0x8004000000000000000000000000000000000002"'
      : `[instance]\nchain_id = "31337"\ntawg_address = "${tawgAddress}"\nagent_id = "${agentId}"\n\n[repository]\nclient = "github"\n\n[da]\nclient = "git"`
  const chat = mode !== 'member' || platforms.length === 0
    ? ''
    : `\n[chat]\nsources = [\n${platforms.map((platform) => `  { name = "${platform}-main", platform = "${platform}", poll_interval = "1s" },`).join('\n')}\n]\ntargets = [\n${platforms.map((platform) => `  { name = "${platform}-target", source = "${platform}-main", conversation_id = "${platform}-conversation" },`).join('\n')}\n]\n`
  return `config_version = 1\nmode = "${mode}"\n\n${phase}\n\n[chain]\nfamily = "evm"\nrpc_url = "${rpcUrl}"\n${chat}`
}

async function connect(factory: McpServerFactory) {
  const server = factory({ era: '2026-07-28' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const responses = new Map<number, unknown>()
  clientTransport.onmessage = (message) => {
    if ('id' in message && typeof message.id === 'number') responses.set(message.id, message)
  }
  await server.connect(serverTransport)
  await clientTransport.start()
  async function request(id: number, method: string, params: Record<string, unknown>): Promise<unknown> {
    await clientTransport.send({ jsonrpc: '2.0', id, method, params })
    for (let attempt = 0; attempt < 100 && !responses.has(id); attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }
    const response = responses.get(id)
    if (response === undefined) throw new Error(`MCP ${method} did not respond.`)
    return response
  }
  await request(1, 'initialize', {
    protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'offline-integrations', version: '1' },
  })
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return {
    request,
    close: async () => { await server.close(); await clientTransport.close() },
  }
}

async function composed(
  source: string,
  integrations: Pick<CreateTasAppDependencies, 'chatClientFactories' | 'proofProviderRegistry'> = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'tas-offline-integrations-'))
  const configPath = join(root, 'tas.toml')
  writeFileSync(configPath, source)
  let factory: McpServerFactory | undefined
  try {
    const app = await createTasApp(configPath, {
      ...integrations,
      stateRoot: join(root, 'state'),
      createChainClient: () => createProfileRpcFixture().client,
      createWalletChainClient: () => ({ account: undefined, chain: { id: 31337 } }) as never,
      createWorkflowCodeReader: () => ({ readCode: async () => undefined }),
      acquireLock: async () => async () => {},
      serve: (selectedFactory) => {
        factory = selectedFactory
        return { close: async () => {} }
      },
    })
    if (factory === undefined) throw new Error('TAS server factory was not composed.')
    const connection = await connect(factory)
    return {
      app,
      connection,
      factory,
      root,
      close: async () => {
        const results = await Promise.allSettled([connection.close(), app.close()])
        rmSync(root, { force: true, recursive: true })
        const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (failure !== undefined) throw failure.reason
      },
    }
  } catch (error) {
    rmSync(root, { force: true, recursive: true })
    throw error
  }
}

async function toolNames(composition: Awaited<ReturnType<typeof composed>>): Promise<readonly string[]> {
  const listed = await composition.connection.request(2, 'tools/list', {}) as {
    result: { tools: Array<{ name: string }> }
  }
  return listed.result.tools.map(({ name }) => name).toSorted()
}

describe('offline integration composition', () => {
  it.each([
    ['identity_setup', expectedIdentityTools],
    ['tawg_setup', expectedTawgTools],
  ] as const)('keeps Chat and Proof Provider capabilities out of %s', async (mode, expected) => {
    const broker = createFakeChatBroker()
    const adapter = new FakeAttestationAdapter(providerManifest)
    const composition = await composed(configuration(mode), {
      chatClientFactories: {
        telegram: createFakeTelegramClient(broker),
        discord: createFakeDiscordClient(broker),
      },
      proofProviderRegistry: createProofProviderRegistry([bundleAttestationAdapter(providerManifest, adapter)]),
    })
    try {
      const names = await toolNames(composition)
      expect(names).toEqual(expected)
      expect(names.some((name) => name.startsWith('chat.') || name.startsWith('proof_provider.'))).toBe(false)
    } finally { await composition.close() }
  })

  it('keeps Chat absent and exposes empty Proof Provider discovery for a production member without integrations', async () => {
    const composition = await composed(configuration('member'))
    try {
      expect(await toolNames(composition)).toEqual(expectedMemberTools)
      const discovery = await composition.connection.request(3, 'tools/call', {
        name: 'proof_provider.attestation.list', arguments: {},
      })
      expect(discovery).toMatchObject({ result: { structuredContent: { data: [] } } })
    } finally { await composition.close() }
  })

  it('registers only the configured Telegram group through an exact injected offline Client factory', async () => {
    const broker = createFakeChatBroker()
    const composition = await composed(configuration('member', ['telegram']), {
      chatClientFactories: {
        telegram: createFakeTelegramClient(broker),
        discord: createFakeDiscordClient(broker),
      },
    })
    try {
      const names = await toolNames(composition)
      expect(names).toEqual(expectedTelegramMemberTools)
      expect(names.some((name) => name.startsWith('chat.discord.'))).toBe(false)
    } finally { await composition.close() }
  })

  it('uses one Registry-owned reviewed Chat snapshot for every process connection', async () => {
    const broker = createFakeChatBroker()
    const composition = await composed(configuration('member', ['telegram']), {
      chatClientFactories: { telegram: createFakeTelegramClient(broker) },
    })
    const secondConnection = await connect(composition.factory)
    try {
      const expected = expectedTelegramMemberTools
      expect(await toolNames(composition)).toEqual(expected)
      const secondList = await secondConnection.request(2, 'tools/list', {}) as {
        result: { tools: Array<{ name: string }> }
      }
      expect(secondList.result.tools.map(({ name }) => name).toSorted()).toEqual(expected)
      const registry = getManifestRegistry()
      expect(getManifestRegistry()).toBe(registry)
      expect(Object.isFrozen(registry.list('telegram'))).toBe(true)
    } finally {
      await secondConnection.close()
      await composition.close()
    }
  })

  it('registers both configured platform groups and a directly injected bundled Provider adapter', async () => {
    const broker = createFakeChatBroker()
    const adapter = new FakeAttestationAdapter(providerManifest)
    const composition = await composed(configuration('member', ['telegram', 'discord']), {
      chatClientFactories: {
        telegram: createFakeTelegramClient(broker),
        discord: createFakeDiscordClient(broker),
      },
      proofProviderRegistry: createProofProviderRegistry([bundleAttestationAdapter(providerManifest, adapter)]),
    })
    try {
      const names = await toolNames(composition)
      expect(names).toEqual([
        ...expectedTelegramDiscordMemberTools,
        'proof_provider.attestation.fixture_attestor.generate',
        'proof_provider.attestation.fixture_attestor.validate',
      ].toSorted())
      const discovery = await composition.connection.request(3, 'tools/call', {
        name: 'proof_provider.attestation.list', arguments: {},
      })
      expect(discovery).toMatchObject({ result: { structuredContent: { data: [providerManifest] } } })
    } finally { await composition.close() }
  })

  it('fails closed when a configured Chat platform has no matching factory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tas-offline-integrations-'))
    const configPath = join(root, 'tas.toml')
    writeFileSync(configPath, configuration('member', ['telegram']))
    try {
      await expect(createTasApp(configPath, {
        stateRoot: join(root, 'state'),
        createChainClient: () => createProfileRpcFixture().client,
        createWalletChainClient: () => ({ account: undefined, chain: { id: 31337 } }) as never,
        createWorkflowCodeReader: () => ({ readCode: async () => undefined }),
        acquireLock: async () => async () => {},
        serve: () => ({ close: async () => {} }),
      })).rejects.toMatchObject({ code: 'CONFIG_CLIENT_UNSUPPORTED' })
    } finally { rmSync(root, { force: true, recursive: true }) }
  })
})
