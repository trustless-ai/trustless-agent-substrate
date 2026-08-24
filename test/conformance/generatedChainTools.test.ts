import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'

import type { ChainInvocation, ChainService } from '../../src/core/workflow/chainService.js'
import { TasError } from '../../src/core/errors.js'
import { registerGeneratedChainTools } from '../../src/mcp/generatedChainTools.js'
import { getManifestRegistry } from '../../src/mcp/manifest/registry.js'
import { expectedPublicChainTools, expectedWalletChainTools } from './toolInventory.expected.js'

const instance = {
  phase: 'identity_setup',
  chain_id: '31337',
  identity_registry_address: '0x8004000000000000000000000000000000000001',
} as const

function isObjectOnlySchema(schema: unknown, root: Record<string, unknown>): boolean {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return false
  const record = schema as Record<string, unknown>
  if (record.type === 'object') return true
  if (typeof record.$ref === 'string' && record.$ref.startsWith('#/$defs/')) {
    const name = record.$ref.slice('#/$defs/'.length)
    return isObjectOnlySchema((root.$defs as Record<string, unknown> | undefined)?.[name], root)
  }
  const branches = record.oneOf ?? record.anyOf
  return Array.isArray(branches) && branches.length > 0
    && Array.from(branches).every((branch) => isObjectOnlySchema(branch, root))
}

async function connect(service: ChainService) {
  const registry = getManifestRegistry()
  const server = new McpServer({ name: 'test', version: '1' })
  registerGeneratedChainTools(server, registry, service, instance)
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
    protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'generated-test', version: '1' },
  })
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return { registry, request, close: async () => { await server.close(); await clientTransport.close() } }
}

describe('generated Chain MCP tools', () => {
  it('registers all and only both accepted whole Manifest groups', async () => {
    const app = await connect({ invoke: async () => '42' })
    try {
      const listed = await app.request(2, 'tools/list', {}) as { result: { tools: Array<{ name: string }> } }
      expect(listed.result.tools.map(({ name }) => name).toSorted()).toEqual([
        ...expectedPublicChainTools,
        ...expectedWalletChainTools,
      ].toSorted())
    } finally { await app.close() }
  })

  it('advertises exact Manifest metadata and wraps only the output data schema', async () => {
    const app = await connect({ invoke: async () => '42' })
    try {
      const listed = await app.request(2, 'tools/list', {}) as { result: { tools: Array<{
        name: string
        description: string
        inputSchema: Record<string, unknown>
        outputSchema: { oneOf: Array<{ properties: { data?: unknown } }> }
        annotations: unknown
      }> } }
      for (const tool of listed.result.tools) {
        const entry = app.registry.get(tool.name)!
        const expectedInput = entry.input_schema.type === undefined
          ? { ...entry.input_schema, type: 'object' }
          : entry.input_schema
        expect(tool.inputSchema).toEqual(expectedInput)
        if (entry.input_schema.type === undefined) {
          expect(isObjectOnlySchema(entry.input_schema, entry.input_schema)).toBe(true)
          const { type: sdkRootType, ...manifestFields } = tool.inputSchema
          expect(sdkRootType).toBe('object')
          expect(manifestFields).toEqual(entry.input_schema)
        }
        expect(tool.description).toBe(entry.description)
        expect(tool.annotations).toEqual(entry.annotations)
        expect(tool.outputSchema.oneOf[0]?.properties.data).toEqual(entry.output_schema)
        expect(tool.outputSchema.oneOf).toHaveLength(2)
        const serializedInput = JSON.stringify(tool.inputSchema)
        if (entry.credential === 'none') {
          expect(serializedInput).not.toContain('"credential"')
        } else {
          const root = tool.inputSchema as {
            properties: { credential: { properties: { secret: { writeOnly?: boolean } } } }
            required: string[]
          }
          expect(root.properties.credential.properties.secret.writeOnly).toBe(true)
          expect(root.required).not.toContain('credential')
        }
      }
    } finally { await app.close() }
  })

  it('mechanically dispatches Public and Wallet calls and never echoes the credential', async () => {
    const invocations: ChainInvocation[] = []
    const service: ChainService = {
      invoke: async (invocation) => {
        invocations.push(invocation)
        return invocation.toolName.endsWith('get_block_number') ? '42' : '0x1234'
      },
    }
    const app = await connect(service)
    const secret = `0x${'ab'.repeat(32)}`
    try {
      const publicResult = await app.request(2, 'tools/call', {
        name: 'workflow.chain.public.get_block_number', arguments: {},
      })
      const walletResult = await app.request(3, 'tools/call', {
        name: 'workflow.chain.wallet.sign_message',
        arguments: { message: 'hello', credential: { type: 'inline', secret } },
      })

      expect(publicResult).toMatchObject({ result: { structuredContent: { context: { instance }, data: '42' } } })
      expect(walletResult).toMatchObject({ result: { structuredContent: { context: { instance }, data: '0x1234' } } })
      expect(invocations).toEqual([
        { toolName: 'workflow.chain.public.get_block_number', arguments: {} },
        {
          toolName: 'workflow.chain.wallet.sign_message',
          arguments: { credential: { secret, type: 'inline' }, message: 'hello' },
        },
      ])
      expect(JSON.stringify(walletResult)).not.toContain(secret)
    } finally { await app.close() }
  })

  it('rejects invalid input before dispatch', async () => {
    let calls = 0
    const app = await connect({ invoke: async () => { calls += 1; return '42' } })
    try {
      const response = await app.request(2, 'tools/call', {
        name: 'workflow.chain.public.get_block_number', arguments: { unknown: true },
      })
      expect(response).toMatchObject({ result: { isError: true } })
      expect(calls).toBe(0)
    } finally { await app.close() }
  })

  it('returns the native redacted TAS error envelope accepted by every generated output schema', async () => {
    const secret = 'credential-detail-that-must-not-escape'
    const app = await connect({
      invoke: async () => { throw new TasError('CREDENTIAL_REQUIRED', secret) },
    })
    try {
      const response = await app.request(2, 'tools/call', {
        name: 'workflow.chain.wallet.sign_message',
        arguments: { message: 'hello' },
      })
      expect(response).toMatchObject({ result: {
        isError: true,
        structuredContent: {
          context: { instance },
          error: {
            code: 'CREDENTIAL_REQUIRED',
            category: 'configuration',
            retryable: false,
            recovery: { action: 'user_action' },
          },
        },
      } })
      expect(JSON.stringify(response)).not.toContain(secret)
    } finally { await app.close() }
  })

  it('keeps viem outside the production startup graph until Manifest preflight succeeds', () => {
    const mainUrl = pathToFileURL(new URL('../../src/app/main.ts', import.meta.url).pathname).href
    const script = `
      import { registerHooks } from 'node:module'
      let viemLoads = 0
      registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === 'viem' || specifier.startsWith('viem/')) {
          viemLoads += 1
          throw new Error('pre-gate viem load')
        }
        return nextResolve(specifier, context)
      } })
      const { run } = await import(${JSON.stringify(mainUrl)})
      let stdout = ''
      let stderr = ''
      const status = await run(
        ['--config', 'ignored.toml'],
        { write(value) { stdout += value } },
        { write(value) { stderr += value } },
        { preflight() { throw new Error('expected preflight stop') } },
      )
      process.stdout.write(JSON.stringify({ status, stdout, stderr, viemLoads }))
    `
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      encoding: 'utf8',
      cwd: process.cwd(),
    })

    expect(child.status).toBe(0)
    expect(child.stderr).toBe('')
    expect(JSON.parse(child.stdout)).toEqual({
      status: 1, stdout: '', stderr: 'TAS_STARTUP_FAILED\n', viemLoads: 0,
    })
  })
})
