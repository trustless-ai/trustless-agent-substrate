import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { InMemoryTransport } from '@modelcontextprotocol/server'
import type { McpServerFactory } from '@modelcontextprotocol/server'
import { afterAll, describe, expect, it } from 'vitest'
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, http, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

import { createTasApp, type TasApp } from '../../src/app/createTasApp.js'
import { expectedIdentityTools, expectedMemberTools, expectedTawgTools } from '../conformance/toolInventory.expected.js'
import { identityRegistryFixture } from '../fixtures/contracts/identityRegistry.js'
import { tawgProfileFixture } from '../fixtures/contracts/tawgProfile.js'

const chainId = 31337
const zeroAddress = `0x${'0'.repeat(40)}` as Address
const anvilChain = defineChain({
  id: chainId, name: 'Anvil fixture', nativeCurrency: { name: 'Anvil ETH', symbol: 'AETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1'] } },
})

interface RunningTas {
  readonly app: TasApp
  readonly tools: readonly string[]
  readonly calls: readonly string[]
  call(name: string, arguments_: Record<string, unknown>): Promise<{ readonly data?: unknown; readonly error?: { readonly code: string } }>
  close(): Promise<void>
}

function configuration(mode: 'identity_setup' | 'tawg_setup' | 'member', address: Address, agentId?: string): string {
  const phase = mode === 'identity_setup'
    ? `[identity_setup]\nchain_id = "${chainId}"\nidentity_registry_address = "${address}"`
    : mode === 'tawg_setup'
      ? `[tawg_setup]\nchain_id = "${chainId}"\ntawg_address = "${address}"`
      : `[instance]\nchain_id = "${chainId}"\ntawg_address = "${address}"\nagent_id = "${agentId}"\n\n[repository]\nclient = "github"\n\n[da]\nclient = "git"`
  return `config_version = 1\nmode = "${mode}"\n\n${phase}\n\n[chain]\nfamily = "evm"\nrpc_url_env = "TAS_RPC_URL"\n`
}

async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Could not reserve an Anvil port.')
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
  return address.port
}

async function connect(factory: McpServerFactory): Promise<Pick<RunningTas, 'tools' | 'calls' | 'call' | 'close'>> {
  const server = factory({ era: '2026-07-28' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const responses = new Map<number, unknown>()
  let nextId = 1
  const calls: string[] = []
  clientTransport.onmessage = (message) => {
    if ('id' in message && typeof message.id === 'number') responses.set(message.id, message)
  }
  await server.connect(serverTransport)
  await clientTransport.start()
  const request = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const id = nextId++
    await clientTransport.send({ jsonrpc: '2.0', id, method, params })
    for (let attempt = 0; attempt < 500 && !responses.has(id); attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2))
    }
    const response = responses.get(id)
    if (response === undefined) throw new Error(`MCP ${method} did not respond.`)
    return response
  }
  await request('initialize', { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'chain-onboarding', version: '1' } })
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const listed = await request('tools/list', {}) as { readonly result: { readonly tools: readonly { readonly name: string }[] } }
  return {
    tools: listed.result.tools.map(({ name }) => name).sort(),
    calls,
    async call(name, arguments_) {
      calls.push(name)
      const response = await request('tools/call', { name, arguments: arguments_ }) as {
        readonly result?: { readonly structuredContent?: { readonly data?: unknown; readonly error?: { readonly code: string } } }
      }
      return response.result?.structuredContent ?? {}
    },
    async close() { await server.close(); await clientTransport.close() },
  }
}

async function startTas(
  root: string,
  mode: 'identity_setup' | 'tawg_setup' | 'member',
  locator: Address,
  rpcUrl: string,
  agentId?: string,
): Promise<RunningTas> {
  const configPath = join(root, `${mode}-${Math.random().toString(16).slice(2)}.toml`)
  writeFileSync(configPath, configuration(mode, locator, agentId))
  let factory: McpServerFactory | undefined
  const app = await createTasApp(configPath, {
    environment: { TAS_RPC_URL: rpcUrl }, stateRoot: join(root, 'state'),
    serve(selectedFactory) { factory = selectedFactory; return { close: async () => {} } },
  })
  if (factory === undefined) throw new Error('TAS did not expose an MCP server.')
  const mcp = await connect(factory)
  return { app, ...mcp, async close() { await mcp.close(); await app.close() } }
}

async function waitForAnvil(client: ReturnType<typeof createPublicClient>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await client.getBlockNumber(); return } catch { await new Promise<void>((resolve) => setTimeout(resolve, 20)) }
  }
  throw new Error('Anvil did not become ready.')
}

async function assertTasSkill(tas: RunningTas): Promise<void> {
  const result = await tas.call('tas.get', {}) as {
    readonly data?: {
      readonly skill?: { readonly name?: string }
      readonly source?: { readonly package?: string }
      readonly content?: { readonly value?: string }
    }
  }
  expect(result.data).toMatchObject({ skill: { name: 'tas' }, source: { package: '@trustless-ai/tas' } })
  expect(result.data?.content?.value).toContain('# TAS')
}

interface ReceiptData {
  readonly status: string
  readonly logs: readonly unknown[]
}

async function pollSuccessfulReceipt(tas: RunningTas, hash: unknown): Promise<ReceiptData> {
  expect(hash).toMatch(/^0x[0-9a-f]+$/)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await tas.call('workflow.chain.public.get_transaction_receipt', { hash: hash as Hex })
    if (result.data !== undefined) {
      expect(result.data).toMatchObject({ status: 'success' })
      return result.data as ReceiptData
    }
    expect(result.error?.code).toBe('EXTERNAL_UNAVAILABLE')
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Transaction receipt remained unavailable after the bounded Agent-side poll.`)
}

function assertSecretsAbsentFromRuntime(root: string, secrets: readonly string[]): void {
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) {
        const text = readFileSync(path, 'utf8')
        for (const secret of secrets) expect(text, `${path} retained an Agent credential`).not.toContain(secret)
      }
    }
  }
  visit(root)
}

async function closeAnvil(process: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (process === undefined) return
  const waitForExit = (timeoutMs: number): Promise<boolean> => new Promise((resolve) => {
    if (process.exitCode !== null) { resolve(true); return }
    const timer = setTimeout(() => { process.off('exit', exited); resolve(false) }, timeoutMs)
    const exited = (): void => { clearTimeout(timer); resolve(true) }
    process.once('exit', exited)
  })
  if (process.exitCode === null) {
    process.kill('SIGTERM')
    if (!await waitForExit(1_000)) {
      process.kill('SIGKILL')
      await waitForExit(1_000)
    }
  }
  process.stdin.destroy()
  process.stdout.destroy()
  process.stderr.destroy()
}

describe('Slice A chain onboarding', () => {
  let anvil: ChildProcessWithoutNullStreams | undefined

  afterAll(async () => {
    await closeAnvil(anvil)
  }, 15_000)

  it('lets two Agents reconcile identities and permanent membership through restarted MCP-only TAS phases', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tas-chain-onboarding-'))
    const port = await unusedPort()
    const rpcUrl = `http://127.0.0.1:${port}`
    anvil = spawn('anvil', ['--silent', '--port', String(port), '--chain-id', String(chainId)], { stdio: 'pipe' })
    const publicClient = createPublicClient({ transport: http(rpcUrl, { retryCount: 0 }) })
    await waitForAnvil(publicClient)
    const deployer = (await publicClient.request({ method: 'eth_accounts' }) as readonly Address[])[0]
    if (deployer === undefined) throw new Error('Anvil did not expose an unlocked deployment account.')
    const deployerClient = createWalletClient({ account: deployer, chain: anvilChain, transport: http(rpcUrl, { retryCount: 0 }) })
    let evaluatorTas: RunningTas | undefined
    let tawgTas: RunningTas | undefined
    let memberTas: RunningTas | undefined
    try {
      const registryHash = await deployerClient.deployContract({ abi: identityRegistryFixture.abi, bytecode: identityRegistryFixture.bytecode })
      const registryReceipt = await publicClient.waitForTransactionReceipt({ hash: registryHash })
      const registryAddress = registryReceipt.contractAddress!

      evaluatorTas = await startTas(root, 'identity_setup', registryAddress, rpcUrl)
      expect(evaluatorTas.tools).toEqual(expectedIdentityTools)
      await assertTasSkill(evaluatorTas)
      expect(evaluatorTas.calls).toContain('tas.get')

      const evaluatorKey = generatePrivateKey()
      const evaluator = privateKeyToAccount(evaluatorKey)
      await publicClient.request({ method: 'anvil_setBalance', params: [evaluator.address, '0x3635c9adc5dea00000'] })
      const register = await evaluatorTas.call('workflow.chain.wallet.write_contract', {
        abi: identityRegistryFixture.abi, address: registryAddress, functionName: 'register', args: ['agent://evaluator', '0x'],
        credential: { type: 'inline', secret: evaluatorKey },
      })
      const registrationHash = register.data as Hex
      const receipt = await pollSuccessfulReceipt(evaluatorTas, registrationHash)
      const registered = decodeEventLog({ abi: identityRegistryFixture.abi, data: (receipt.logs[0] as { readonly data: Hex }).data, topics: (receipt.logs[0] as { readonly topics: readonly Hex[] }).topics })
      const evaluatorAgentId = String((registered.args as { readonly agentId: bigint }).agentId)
      expect(BigInt(evaluatorAgentId)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER))

      const owner = await evaluatorTas.call('workflow.chain.public.read_contract', { abi: identityRegistryFixture.abi, address: registryAddress, functionName: 'ownerOf', args: [evaluatorAgentId] })
      const emptyWallet = await evaluatorTas.call('workflow.chain.public.read_contract', { abi: identityRegistryFixture.abi, address: registryAddress, functionName: 'getAgentWallet', args: [evaluatorAgentId] })
      expect(owner.data).toBe(evaluator.address)
      expect(emptyWallet.data).toBe(zeroAddress)
      await evaluatorTas.close()
      evaluatorTas = undefined

      // A restart reconciles authoritative Registry state; it does not replay registration.
      evaluatorTas = await startTas(root, 'identity_setup', registryAddress, rpcUrl)
      await assertTasSkill(evaluatorTas)
      expect((await evaluatorTas.call('workflow.chain.public.read_contract', { abi: identityRegistryFixture.abi, address: registryAddress, functionName: 'registrationCount' })).data).toBe('1')
      await evaluatorTas.close()
      evaluatorTas = undefined

      // The harness deploys a Profile only after observing the public evaluator agentId.
      const profileHash = await deployerClient.deployContract({ abi: tawgProfileFixture.abi, bytecode: tawgProfileFixture.bytecode, args: [registryAddress, BigInt(evaluatorAgentId)] })
      const profileReceipt = await publicClient.waitForTransactionReceipt({ hash: profileHash })
      const profileAddress = profileReceipt.contractAddress!

      tawgTas = await startTas(root, 'tawg_setup', profileAddress, rpcUrl)
      expect(tawgTas.tools).toEqual(expectedTawgTools)
      await assertTasSkill(tawgTas)
      expect(tawgTas.calls).toContain('tas.get')
      const initialEvaluatorTawgApp = tawgTas.app
      const profile = await tawgTas.call('profile.get', {}) as { readonly data: { readonly agents: { readonly identity_registry: Address } } }
      const discoveredRegistryAddress = profile.data.agents.identity_registry
      expect(discoveredRegistryAddress.toLowerCase()).toBe(registryAddress.toLowerCase())
      expect((await tawgTas.call('profile.get_agent', { agent_id: evaluatorAgentId })).data).toEqual({ agent_id: evaluatorAgentId, is_member: false })

      // A zero Registry wallet causes Profile registration to revert; TAS preserves unknown external outcome semantics.
      expect((await tawgTas.call('workflow.chain.wallet.write_contract', {
        abi: tawgProfileFixture.abi, address: profileAddress, functionName: 'registerAgent', args: [evaluatorAgentId, '{"name":"evaluator"}', registryAddress],
        credential: { type: 'inline', secret: evaluatorKey },
      })).error?.code).toBe('OPERATION_OUTCOME_UNKNOWN')

      await tawgTas.close()
      tawgTas = await startTas(root, 'tawg_setup', profileAddress, rpcUrl)
      await assertTasSkill(tawgTas)
      expect(tawgTas.app).not.toBe(initialEvaluatorTawgApp)
      expect((await tawgTas.call('profile.get_agent', { agent_id: evaluatorAgentId })).data).toEqual({ agent_id: evaluatorAgentId, is_member: false })
      const establishWallet = await tawgTas.call('workflow.chain.wallet.write_contract', {
        abi: identityRegistryFixture.abi, address: discoveredRegistryAddress, functionName: 'establishAgentWallet', args: [evaluatorAgentId],
        credential: { type: 'inline', secret: evaluatorKey },
      })
      await pollSuccessfulReceipt(tawgTas, establishWallet.data)
      const registerMember = await tawgTas.call('workflow.chain.wallet.write_contract', {
        abi: tawgProfileFixture.abi, address: profileAddress, functionName: 'registerAgent', args: [evaluatorAgentId, '{"name":"evaluator"}', discoveredRegistryAddress],
        credential: { type: 'inline', secret: evaluatorKey },
      })
      await pollSuccessfulReceipt(tawgTas, registerMember.data)
      const evaluatorMember = await tawgTas.call('profile.get_agent', { agent_id: evaluatorAgentId }) as {
        readonly data: { readonly agent_id: string; readonly is_member: boolean; readonly data: { readonly name: string }; readonly agent_verifier: Address; readonly authentication_wallet: Address }
      }
      expect(evaluatorMember.data).toMatchObject({ agent_id: evaluatorAgentId, is_member: true, data: { name: 'evaluator' }, authentication_wallet: evaluator.address })
      expect(evaluatorMember.data.agent_verifier.toLowerCase()).toBe(registryAddress.toLowerCase())
      const reconciledEvaluatorTawgApp = tawgTas.app
      expect((await tawgTas.call('workflow.chain.wallet.write_contract', {
        abi: tawgProfileFixture.abi, address: profileAddress, functionName: 'registerAgent', args: [evaluatorAgentId, '{"name":"evaluator"}', discoveredRegistryAddress],
        credential: { type: 'inline', secret: evaluatorKey },
      })).error?.code).toBe('OPERATION_OUTCOME_UNKNOWN')

      await tawgTas.close()
      tawgTas = undefined

      // A second Agent receives only the Profile locator and owns a separate TAWG-setup process.
      const contributorTas = await startTas(root, 'tawg_setup', profileAddress, rpcUrl)
      tawgTas = contributorTas
      expect(contributorTas.tools).toEqual(expectedTawgTools)
      await assertTasSkill(contributorTas)
      expect(contributorTas.app).not.toBe(reconciledEvaluatorTawgApp)
      const contributorProfile = await contributorTas.call('profile.get', {}) as {
        readonly data: { readonly agents: { readonly identity_registry: Address } }
      }
      const contributorRegistryAddress = contributorProfile.data.agents.identity_registry
      expect(contributorRegistryAddress.toLowerCase()).toBe(registryAddress.toLowerCase())

      const contributorKey = generatePrivateKey()
      const contributor = privateKeyToAccount(contributorKey)
      await publicClient.request({ method: 'anvil_setBalance', params: [contributor.address, '0x3635c9adc5dea00000'] })
      const contributorRegister = await contributorTas.call('workflow.chain.wallet.write_contract', {
        abi: identityRegistryFixture.abi, address: contributorRegistryAddress, functionName: 'register', args: ['agent://contributor', '0x'],
        credential: { type: 'inline', secret: contributorKey },
      })
      const contributorReceipt = await pollSuccessfulReceipt(contributorTas, contributorRegister.data)
      const contributorEvent = decodeEventLog({ abi: identityRegistryFixture.abi, data: (contributorReceipt.logs[0] as { readonly data: Hex }).data, topics: (contributorReceipt.logs[0] as { readonly topics: readonly Hex[] }).topics })
      const contributorAgentId = String((contributorEvent.args as { readonly agentId: bigint }).agentId)
      const contributorWallet = await contributorTas.call('workflow.chain.wallet.write_contract', {
        abi: identityRegistryFixture.abi, address: contributorRegistryAddress, functionName: 'establishAgentWallet', args: [contributorAgentId], credential: { type: 'inline', secret: contributorKey },
      })
      await pollSuccessfulReceipt(contributorTas, contributorWallet.data)

      // Zero and nonzero EOA verifier addresses both fail the deployed-code requirement.
      expect((await contributorTas.call('workflow.chain.wallet.write_contract', {
        abi: tawgProfileFixture.abi, address: profileAddress, functionName: 'registerAgent', args: [contributorAgentId, '{"name":"contributor"}', zeroAddress], credential: { type: 'inline', secret: contributorKey },
      })).error?.code).toBe('OPERATION_OUTCOME_UNKNOWN')
      expect((await contributorTas.call('workflow.chain.wallet.write_contract', {
        abi: tawgProfileFixture.abi, address: profileAddress, functionName: 'registerAgent', args: [contributorAgentId, '{"name":"contributor"}', contributor.address], credential: { type: 'inline', secret: contributorKey },
      })).error?.code).toBe('OPERATION_OUTCOME_UNKNOWN')
      expect((await contributorTas.call('profile.get_agent', { agent_id: contributorAgentId })).data).toEqual({ agent_id: contributorAgentId, is_member: false })
      const contributorMembership = await contributorTas.call('workflow.chain.wallet.write_contract', {
        abi: tawgProfileFixture.abi, address: profileAddress, functionName: 'registerAgent', args: [contributorAgentId, '{"name":"contributor"}', contributorRegistryAddress], credential: { type: 'inline', secret: contributorKey },
      })
      await pollSuccessfulReceipt(contributorTas, contributorMembership.data)
      expect((await contributorTas.call('profile.get_agent', { agent_id: contributorAgentId })).data).toMatchObject({ is_member: true, authentication_wallet: contributor.address })
      await contributorTas.close()
      tawgTas = undefined

      memberTas = await startTas(root, 'member', profileAddress, rpcUrl, evaluatorAgentId)
      expect(memberTas.tools).toEqual(expectedMemberTools)
      await assertTasSkill(memberTas)
      expect((await memberTas.call('workflow.execution.erc8301.agent_workflow.get_task', {
        taskHash: '0x1234',
      })).error?.code).toBe('WORKFLOW_SOURCE_VERIFICATION_REQUIRED')
      const wrongKey = generatePrivateKey()
      expect((await memberTas.call('workflow.chain.wallet.sign_message', {
        message: { raw: '0x01' }, credential: { type: 'inline', secret: wrongKey },
      })).error?.code).toBe('WALLET_MISMATCH')
      expect((await memberTas.call('workflow.chain.wallet.sign_message', {
        message: { raw: '0x01' }, credential: { type: 'inline', secret: evaluatorKey },
      })).data).toMatch(/^0x[0-9a-f]+$/)
      expect((await memberTas.call('workflow.chain.wallet.sign_message', { message: { raw: '0x01' } })).error?.code).toBe('CREDENTIAL_REQUIRED')
      assertSecretsAbsentFromRuntime(root, [evaluatorKey, contributorKey, wrongKey])
    } finally {
      await memberTas?.close()
      await tawgTas?.close()
      await evaluatorTas?.close()
      rmSync(root, { force: true, recursive: true })
    }
  }, 120_000)
})
