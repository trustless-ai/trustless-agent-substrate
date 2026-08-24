import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'

import { TasError } from '../../src/core/errors.js'
import type { WorkflowSourceService } from '../../src/core/workflow/sourceService.js'
import type { WorkflowVerificationResult } from '../../src/core/workflow/sourceVerifier.js'
import { registerWorkflowSourceTools } from '../../src/mcp/workflowSourceTools.js'

const instance = {
  phase: 'member',
  chain_id: '31337',
  tawg_address: '0x1000000000000000000000000000000000000001',
  agent_id: '340282366920938463463374607431768211457',
} as const
const blockHash = `0x${'a'.repeat(64)}` as const
const result: WorkflowVerificationResult = {
  valid: true,
  reason: 'verified',
  fingerprint: `sha256:${'b'.repeat(64)}`,
  compiler: { version: '0.8.30+commit.73712a01', settingsHash: `sha256:${'c'.repeat(64)}` },
  source: {
    keccak256: `0x${'d'.repeat(64)}`,
    closureHash: `sha256:${'e'.repeat(64)}`,
    metadataSha256: 'f'.repeat(64),
  },
  deployedCodeHash: `0x${'1'.repeat(64)}`,
  context: {
    chainId: '31337',
    blockNumber: '42',
    blockHash,
    profileVersion: '7',
    workflowAddress: '0x4000000000000000000000000000000000000004',
    repository: 'https://github.com/trustless-ai/demo-tawg',
    commit: '2'.repeat(40),
    sourcePath: 'contracts/Workflow.sol',
    metadataPath: 'contracts/Workflow.metadata.json',
  },
}

async function connect(service: WorkflowSourceService) {
  const server = new McpServer({ name: 'test', version: '1' })
  registerWorkflowSourceTools(server, service, instance)
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
    protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'workflow-source-test', version: '1' },
  })
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return { request, close: async () => { await server.close(); await clientTransport.close() } }
}

describe('Workflow source MCP tools', () => {
  it('advertises exactly two read-only tools with write-only optional Repository credentials', async () => {
    const app = await connect({
      verify: async () => result,
      get: async () => ({ ...result, sourceContent: 'contract Workflow {}' }),
    })
    try {
      const response = await app.request(2, 'tools/list', {}) as { result: { tools: Array<{ name: string; inputSchema: any; annotations: unknown }> } }
      expect(response.result.tools.map(({ name }) => name).toSorted()).toEqual([
        'workflow.source.get',
        'workflow.source.verify',
      ])
      for (const tool of response.result.tools) {
        expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true })
        expect(tool.inputSchema.properties.credential.properties.secret.writeOnly).toBe(true)
      }
    } finally { await app.close() }
  })

  it('returns verification findings and immutable resolution without returning source content', async () => {
    const calls: unknown[] = []
    const secret = 'private-repository-token'
    const app = await connect({
      verify: async (input) => { calls.push(input); return result },
      get: async () => ({ ...result, sourceContent: 'not called' }),
    })
    try {
      const response = await app.request(2, 'tools/call', {
        name: 'workflow.source.verify',
        arguments: {
          selector: { kind: 'block_hash', block_hash: blockHash },
          credential: { type: 'inline', secret },
        },
      })
      expect(response).toMatchObject({ result: { structuredContent: {
        context: { instance, resolved: {
          chain: { block_number: '42', block_hash: blockHash },
          profile: { version: '7' },
          repository: { url: result.context.repository, commit: result.context.commit },
        } },
        data: { valid: true, reason: 'verified', fingerprint: result.fingerprint },
      } } })
      expect(JSON.stringify(response)).not.toContain(secret)
      expect(response).not.toMatchObject({ result: { structuredContent: { data: { source: expect.anything() } } } })
      expect(JSON.stringify(response)).not.toContain('contract Workflow')
      expect(calls).toHaveLength(1)
      expect((calls[0] as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal)
    } finally { await app.close() }
  })

  it('returns the verified source only from get and keeps negative verification as success data', async () => {
    const negative: WorkflowVerificationResult = { ...result, valid: false, reason: 'runtime_mismatch' }
    const app = await connect({
      verify: async () => negative,
      get: async () => ({ ...result, sourceContent: 'pragma solidity 0.8.30; contract Workflow {}' }),
    })
    try {
      const verify = await app.request(2, 'tools/call', { name: 'workflow.source.verify', arguments: {} })
      expect(verify).toMatchObject({ result: { structuredContent: { data: { valid: false, reason: 'runtime_mismatch' } } } })
      const get = await app.request(3, 'tools/call', { name: 'workflow.source.get', arguments: {} })
      expect(get).toMatchObject({ result: { structuredContent: { data: { source: {
        path: result.context.sourcePath,
        hash: result.source.keccak256,
        content: 'pragma solidity 0.8.30; contract Workflow {}',
      } } } } })
    } finally { await app.close() }
  })

  it('maps missing verification to the stable redacted TAS error', async () => {
    const app = await connect({
      verify: async () => result,
      get: async () => { throw new TasError('WORKFLOW_SOURCE_VERIFICATION_REQUIRED', 'secret state') },
    })
    try {
      const response = await app.request(2, 'tools/call', { name: 'workflow.source.get', arguments: {} })
      expect(response).toMatchObject({ result: { isError: true, structuredContent: { error: {
        code: 'WORKFLOW_SOURCE_VERIFICATION_REQUIRED', recovery: { action: 'reconcile' },
      } } } })
      expect(JSON.stringify(response)).not.toContain('secret state')
    } finally { await app.close() }
  })
})
