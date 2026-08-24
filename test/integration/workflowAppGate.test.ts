import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { InMemoryTransport, type McpServerFactory } from '@modelcontextprotocol/server'
import { toAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'

import { createTasApp } from '../../src/app/createTasApp.js'
import type { RepositoryClient } from '../../src/core/repository/client.js'
import {
  createProfileRpcFixture,
  fixtureAgentId,
  fixtureProfileAddress,
  fixtureWalletAddress,
  fixtureWorkflowAddress,
} from '../fixtures/profile/blocks.js'

const fixtureRoot = fileURLToPath(new URL('../fixtures/workflow/repository/', import.meta.url))
const repository = 'https://github.com/trustless-ai/example'
const workflowCommit = 'b'.repeat(40)
const deployedRuntime = '0x60806040525f5ffdfea26469706673582212202bc854b8f014573d5df2486e18fbe5139d93a28c744b27d1e37043a83571ab1364736f6c634300081e0033' as const

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

function repositoryClient(): RepositoryClient {
  return {
    async resolveDefaultHead(source) { return source.charter.commit },
    async readFile(_source, commit, path) {
      return { path, commit, bytes: new Uint8Array(readFileSync(resolve(fixtureRoot, path))) }
    },
    async listIssues() { return { items: [], consistency: 'live' } },
    async listPullRequests() { return { items: [], consistency: 'live' } },
    async listCommits() { return { items: [], consistency: 'live' } },
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
    protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'workflow-app-gate', version: '1' },
  })
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return {
    call: async (name: string, arguments_: Record<string, unknown> = {}) => await request('tools/call', {
      name, arguments: arguments_,
    }),
    close: async () => { await server.close(); await clientTransport.close() },
  }
}

describe('member TAS Workflow source composition', () => {
  it('uses one process-scoped Gate for source tools and generated Workflow operations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tas-workflow-app-gate-'))
    const configPath = join(root, 'tas.toml')
    writeFileSync(configPath, configuration())
    let runtimeCode: `0x${string}` = deployedRuntime
    let factory: McpServerFactory | undefined
    const workflowData = JSON.stringify({ source: {
      repository,
      commit: workflowCommit,
      sourcePath: 'contracts/Workflow.sol',
      metadataPath: 'contracts/Workflow.metadata.json',
    } })
    const profileFixture = createProfileRpcFixture({ workflowData })
    const bindingInvocations: Array<Readonly<{ tool: string; contractAddress?: string; accountAddress?: string }>> = []
    const app = await createTasApp(configPath, {
      environment: { TAS_RPC_URL: 'http://127.0.0.1:8545' },
      stateRoot: join(root, 'state'),
      createChainClient: () => profileFixture.client,
      createWalletChainClient: () => ({ account: undefined, chain: { id: 31337 } }) as never,
      createRepositoryClient: repositoryClient,
      createWorkflowCodeReader: () => ({ async readCode() { return runtimeCode } }),
      createAgentSdkBindingClient: () => ({
        accountFromAddress: (address) => toAccount(address),
        accountFromPrivateKey: () => { throw new Error('write binding is not used in this test') },
        async invoke(entry, _arguments, context) {
          bindingInvocations.push({
            tool: entry.name,
            contractAddress: context.contractAddress,
            accountAddress: context.account?.address,
          })
          return {
            task: {
              stage: 0,
              taskSeq: 1n,
              inputHash: '0x1234',
              timestamp: 2n,
              expiresAt: 3n,
              prevReplyHashes: [],
              workflowRunId: '0xabcd',
              input: '0x',
            },
            proven: true,
          }
        },
      }),
      serve(selectedFactory) { factory = selectedFactory; return { close: async () => {} } },
    })
    if (factory === undefined) throw new Error('TAS did not expose an MCP server.')
    const mcp = await connect(factory)

    try {
      const operation = { taskHash: '0x1234' }
      const before = await mcp.call('workflow.execution.erc8301.agent_workflow.get_task', operation)
      expect(before).toMatchObject({ result: { structuredContent: { error: {
        code: 'WORKFLOW_SOURCE_VERIFICATION_REQUIRED',
      } } } })

      const verify = await mcp.call('workflow.source.verify')
      expect(verify).toMatchObject({ result: { structuredContent: { data: { valid: true, reason: 'verified' } } } })
      const source = await mcp.call('workflow.source.get')
      expect(source).toMatchObject({ result: { structuredContent: { data: { source: {
        content: expect.stringContaining('contract Workflow'),
      } } } } })

      const enabledGate = await mcp.call('workflow.execution.erc8301.agent_workflow.get_task', operation)
      expect(enabledGate).toMatchObject({ result: { structuredContent: { data: {
        proven: true,
        task: { taskSeq: '1', inputHash: '0x1234' },
      } } } })
      expect(bindingInvocations).toEqual([{
        tool: 'workflow.execution.erc8301.agent_workflow.get_task',
        contractAddress: fixtureWorkflowAddress,
        accountAddress: fixtureWalletAddress,
      }])

      runtimeCode = '0x6000'
      const stale = await mcp.call('workflow.execution.erc8301.agent_workflow.get_task', operation)
      expect(stale).toMatchObject({ result: { structuredContent: { error: {
        code: 'WORKFLOW_SOURCE_VERIFICATION_REQUIRED',
      } } } })
    } finally {
      await mcp.close()
      await app.close()
      rmSync(root, { force: true, recursive: true })
    }
  }, 35_000)
})
