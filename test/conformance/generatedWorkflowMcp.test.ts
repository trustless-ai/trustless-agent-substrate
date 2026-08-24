import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'

import { TasError } from '../../src/core/errors.js'
import type {
  WorkflowOperationInvocation,
  WorkflowOperationService,
} from '../../src/core/workflow/types.js'
import { registerGeneratedWorkflowTools } from '../../src/mcp/generatedWorkflowTools.js'
import { getManifestRegistry } from '../../src/mcp/manifest/registry.js'
import { expectedWorkflowTools } from './toolInventory.expected.js'

const instance = {
  phase: 'member',
  chain_id: '31337',
  tawg_address: '0x1000000000000000000000000000000000000001',
  agent_id: '340282366920938463463374607431768211457',
} as const

async function connect(service: WorkflowOperationService) {
  const registry = getManifestRegistry()
  const server = new McpServer({ name: 'test', version: '1' })
  registerGeneratedWorkflowTools(server, registry, service, instance)
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
    protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'generated-workflow-test', version: '1' },
  })
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return { registry, request, close: async () => { await server.close(); await clientTransport.close() } }
}

describe('generated Workflow MCP tools', () => {
  it('registers all and only the reviewed agent-sdk Manifest group', async () => {
    const app = await connect({ invoke: async () => '0x1234' })
    try {
      const listed = await app.request(2, 'tools/list', {}) as { result: { tools: Array<{ name: string }> } }
      expect(listed.result.tools.map(({ name }) => name).toSorted()).toEqual(expectedWorkflowTools)
      expect(listed.result.tools).toHaveLength(56)
    } finally { await app.close() }
  })

  it('advertises the exact Manifest descriptions, schemas, and annotations', async () => {
    const app = await connect({ invoke: async () => '0x1234' })
    try {
      const listed = await app.request(2, 'tools/list', {}) as { result: { tools: Array<{
        name: string
        description: string
        inputSchema: unknown
        outputSchema: { oneOf: Array<{ properties: { data?: unknown } }> }
        annotations: unknown
      }> } }
      for (const tool of listed.result.tools) {
        const entry = app.registry.get(tool.name)!
        expect(tool.description).toBe(entry.description)
        expect(tool.inputSchema).toEqual(entry.input_schema)
        expect(tool.annotations).toEqual(entry.annotations)
        expect(tool.outputSchema.oneOf[0]?.properties.data).toEqual(entry.output_schema)
        expect(tool.outputSchema.oneOf).toHaveLength(2)
      }
    } finally { await app.close() }
  })

  it('dispatches one operation and returns the standard TAS envelope', async () => {
    const invocations: WorkflowOperationInvocation[] = []
    const signals: Array<AbortSignal | undefined> = []
    const app = await connect({
      invoke: async (invocation, options) => {
        invocations.push(invocation)
        signals.push(options?.signal)
        return '0x1234'
      },
    })
    try {
      const response = await app.request(2, 'tools/call', {
        name: 'workflow.identity.erc8004.recompute.compute_agent_id',
        arguments: { registryId: '42' },
      })
      expect(response).toMatchObject({ result: { structuredContent: {
        context: { instance }, data: '0x1234',
      } } })
      expect(invocations).toEqual([{
        toolName: 'workflow.identity.erc8004.recompute.compute_agent_id',
        arguments: { registryId: '42' },
      }])
      expect(signals[0]).toBeInstanceOf(AbortSignal)
    } finally { await app.close() }
  })

  it('rejects invalid input before dispatch', async () => {
    let calls = 0
    const app = await connect({ invoke: async () => { calls += 1; return '0x1234' } })
    try {
      const response = await app.request(2, 'tools/call', {
        name: 'workflow.identity.erc8004.recompute.compute_agent_id',
        arguments: { registryId: '42', unknown: true },
      })
      expect(response).toMatchObject({ result: { isError: true } })
      expect(calls).toBe(0)
    } finally { await app.close() }
  })

  it('maps the initial closed Workflow gate to a redacted TAS error envelope', async () => {
    const app = await connect({
      invoke: async () => {
        throw new TasError('WORKFLOW_SOURCE_VERIFICATION_REQUIRED', 'private verification detail')
      },
    })
    try {
      const response = await app.request(2, 'tools/call', {
        name: 'workflow.execution.erc8301.agent_workflow.get_task',
        arguments: { taskHash: '0x1234' },
      })
      expect(response).toMatchObject({ result: {
        isError: true,
        structuredContent: {
          context: { instance },
          error: {
            code: 'WORKFLOW_SOURCE_VERIFICATION_REQUIRED',
            category: 'conflict',
            retryable: false,
            recovery: { action: 'reconcile' },
          },
        },
      } })
      expect(JSON.stringify(response)).not.toContain('private verification detail')
    } finally { await app.close() }
  })
})
