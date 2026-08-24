import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'

import type { ProfileReader } from '../../src/core/profile/reader.js'
import { ProfileResolver } from '../../src/core/profile/resolver.js'
import type { ChainSelector, ProfileSnapshot, RawAgentSnapshot } from '../../src/core/profile/types.js'
import { registerProfileTools } from '../../src/mcp/profileTools.js'
import type { TasPublicInstance } from '../../src/mcp/results.js'

const tawg = '0x1000000000000000000000000000000000000001' as const
const hash = `0x${'a'.repeat(64)}` as const
const member: TasPublicInstance = { phase: 'member', chain_id: '31337', tawg_address: tawg, agent_id: '9007199254740993' }

function snapshot(): ProfileSnapshot {
  return {
    chainId: '31337', tawgAddress: tawg, blockNumber: '42', blockHash: hash, version: '1',
    governance: '0x2000000000000000000000000000000000000002',
    identityRegistry: '0x3000000000000000000000000000000000000003',
    charter: { repository: 'https://github.com/trustless-ai/tawg-demo', commitHash: 'b'.repeat(40), path: 'charter/' },
    agentIds: ['9007199254740993'], dataEntries: [{ key: 'meta', exists: true, data: '{"nested":{"ok":true}}' }],
    workflow: { workflowAddress: '0x4000000000000000000000000000000000000004', data: '{}' },
  }
}

function agentSnapshot(isMember = true): RawAgentSnapshot {
  return {
    chainId: '31337', tawgAddress: tawg, blockNumber: '42', blockHash: hash, version: '1',
    identityRegistry: '0x3000000000000000000000000000000000000003', agentId: '9007199254740993', isMember,
    data: isMember ? '{"role":"contributor"}' : '',
    agentVerifier: isMember ? '0x5000000000000000000000000000000000000005' : '0x0000000000000000000000000000000000000000',
    ...(isMember ? { authenticationWallet: '0x6000000000000000000000000000000000000006' as const } : {}),
  }
}

interface HarnessOptions {
  readonly reader?: ProfileReader
  readonly instance?: Exclude<TasPublicInstance, { readonly phase: 'identity_setup' }>
}

function recordAt(value: unknown, ...path: readonly string[]): Record<string, unknown> {
  let current = value
  for (const key of path) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) throw new TypeError(`Expected object at ${path.join('.')}`)
    current = (current as Record<string, unknown>)[key]
  }
  if (current === null || typeof current !== 'object' || Array.isArray(current)) throw new TypeError(`Expected object at ${path.join('.')}`)
  return current as Record<string, unknown>
}

function arrayAt(value: unknown, ...path: readonly string[]): readonly unknown[] {
  let current = value
  for (const key of path) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) throw new TypeError(`Expected object at ${path.join('.')}`)
    current = (current as Record<string, unknown>)[key]
  }
  if (!Array.isArray(current)) throw new TypeError(`Expected array at ${path.join('.')}`)
  return current
}

async function harness(options: HarnessOptions = {}) {
  const calls: Array<{ operation: string; selector: ChainSelector; agentId?: string; signal?: AbortSignal }> = []
  const reader: ProfileReader = options.reader ?? {
    readProfile: async (selector, readOptions) => { calls.push({ operation: 'profile', selector, signal: readOptions?.signal }); return snapshot() },
    readAgent: async (agentId, selector, readOptions) => { calls.push({ operation: 'agent', agentId, selector, signal: readOptions?.signal }); return agentSnapshot() },
  }
  const server = new McpServer({ name: 'tas-profile-test', version: '1.0.0' })
  registerProfileTools(server, new ProfileResolver(reader, { chainId: '31337', tawgAddress: tawg }), options.instance ?? member)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const received = new Map<number, unknown>()
  clientTransport.onmessage = (message) => { if ('id' in message && typeof message.id === 'number') received.set(message.id, message) }
  await server.connect(serverTransport)
  await clientTransport.start()
  async function request(id: number, method: string, params: Record<string, unknown>): Promise<unknown> {
    await clientTransport.send({ jsonrpc: '2.0', id, method, params })
    for (let attempts = 0; attempts < 100 && !received.has(id); attempts += 1) await new Promise<void>((resolve) => setTimeout(resolve, 1))
    return received.get(id)
  }
  await request(1, 'initialize', { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return {
    calls,
    request,
    send: clientTransport.send.bind(clientTransport),
    close: async () => { await server.close(); await clientTransport.close() },
  }
}

describe('Profile MCP tools', () => {
  it.each([
    { phase: 'tawg_setup', chain_id: '1', tawg_address: tawg },
    { phase: 'member', chain_id: '1', tawg_address: tawg, agent_id: '9007199254740993' },
    { phase: 'tawg_setup', chain_id: '31337', tawg_address: '0x1000000000000000000000000000000000000002' },
    { phase: 'member', chain_id: '31337', tawg_address: '0x1000000000000000000000000000000000000002', agent_id: '9007199254740993' },
  ] as const)('fails closed before tool registration when the public %s instance differs from the Resolver binding', (instance) => {
    const server = new McpServer({ name: 'tas-profile-binding-test', version: '1.0.0' })
    const resolver = new ProfileResolver({ readProfile: async () => snapshot(), readAgent: async () => agentSnapshot() }, { chainId: '31337', tawgAddress: tawg })

    expect(() => registerProfileTools(server, resolver, instance)).toThrow('The selected TAWG Profile state is inconsistent.')
  })

  it.each([
    [undefined, { kind: 'latest' }],
    [{ kind: 'latest' }, { kind: 'latest' }],
    [{ kind: 'safe' }, { kind: 'safe' }],
    [{ kind: 'finalized' }, { kind: 'finalized' }],
    [{ kind: 'block_number', block_number: '9007199254740993' }, { kind: 'block_number', blockNumber: '9007199254740993' }],
    [{ kind: 'block_hash', block_hash: hash }, { kind: 'block_hash', blockHash: hash }],
  ] as const)('maps Agent selector %o to the reader and preserves the exact Agent context', async (selector, expected) => {
    const app = await harness()
    try {
      const args = { agent_id: '9007199254740993', ...(selector === undefined ? {} : { selector }) }
      const response = await app.request(2, 'tools/call', { name: 'profile.get_agent', arguments: args })
      expect(app.calls[0]).toMatchObject({ operation: 'agent', agentId: '9007199254740993', selector: expected })
      expect(response).toMatchObject({ result: { structuredContent: {
        context: { instance: member, resolved: { chain: { block_number: '42', block_hash: hash }, profile: { version: '1' } } },
        data: { agent_id: '9007199254740993', is_member: true },
      } } })
    } finally { await app.close() }
  })

  it('lists exactly strict read-only, idempotent, open-world Profile tools', async () => {
    const app = await harness()
    try {
      const response = await app.request(2, 'tools/list', {})
      expect(response).toMatchObject({ result: { tools: [
        { name: 'profile.get', inputSchema: { type: 'object', additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
        { name: 'profile.get_agent', inputSchema: { type: 'object', required: ['agent_id'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
      ] } })
    } finally { await app.close() }
  })

  it('advertises the exact validated Profile and Agent output contracts', async () => {
    const app = await harness()
    try {
      const response = await app.request(2, 'tools/list', {}) as { result: { tools: Array<{ name: string; inputSchema: unknown; outputSchema: unknown }> } }
      const profileTool = response.result.tools.find((tool) => tool.name === 'profile.get')
      const agentTool = response.result.tools.find((tool) => tool.name === 'profile.get_agent')
      const profileSchema = profileTool?.outputSchema
      const agentSchema = agentTool?.outputSchema
      const positiveDecimal = '^[1-9][0-9]*$'
      const canonicalDecimal = '^(?:0|[1-9][0-9]*)$'
      const nonzeroAddress = '^0x(?!0{40}$)[0-9a-fA-F]{40}$'

      expect(profileSchema).toMatchObject({
        type: 'object', additionalProperties: false, required: ['context', 'data'],
        properties: {
          context: { additionalProperties: false, properties: {
            resolved: { additionalProperties: false, properties: {
              chain: { additionalProperties: false, properties: { block_number: { pattern: canonicalDecimal, maxLength: 78 }, block_hash: { pattern: '^0x[0-9a-fA-F]{64}$' } } },
              profile: { additionalProperties: false, properties: { version: { pattern: positiveDecimal, maxLength: 78 } } },
            } },
          } },
          data: { additionalProperties: false, properties: {
            version: { pattern: positiveDecimal, maxLength: 78 },
            governance: { pattern: nonzeroAddress },
            charter: { additionalProperties: false, properties: {
              repository: { type: 'string', minLength: 1 }, commit: { pattern: '^(?:[0-9a-f]{40}|[0-9a-f]{64})$' }, path: { const: 'charter/' },
            } },
            agents: { additionalProperties: false, properties: {
              identity_registry: { pattern: nonzeroAddress }, agent_ids: { items: { pattern: canonicalDecimal, maxLength: 78 } },
            } },
            data: { propertyNames: { pattern: '^[a-z][a-z0-9._-]{0,63}$' }, additionalProperties: { type: 'object' } },
            workflow: { additionalProperties: false, properties: { address: { pattern: nonzeroAddress }, data: { type: 'object' } } },
          } },
        },
      })
      for (const instanceVariant of arrayAt(profileSchema, 'properties', 'context', 'properties', 'instance', 'oneOf')) {
        expect(instanceVariant).toMatchObject({
          type: 'object', additionalProperties: false,
          properties: { chain_id: { pattern: positiveDecimal, maxLength: 78 }, tawg_address: { pattern: nonzeroAddress } },
        })
        const instanceProperties = recordAt(instanceVariant, 'properties')
        if ('agent_id' in instanceProperties) {
          expect(instanceProperties.agent_id).toMatchObject({ pattern: canonicalDecimal, maxLength: 78 })
        }
      }
      expect(agentSchema).toMatchObject({
        type: 'object', additionalProperties: false,
        properties: { data: { oneOf: [
          { additionalProperties: false, required: ['agent_id', 'is_member', 'data', 'agent_verifier', 'authentication_wallet'], properties: {
            agent_id: { pattern: canonicalDecimal, maxLength: 78 }, is_member: { const: true }, data: { type: 'object' },
            agent_verifier: { pattern: nonzeroAddress }, authentication_wallet: { pattern: nonzeroAddress },
          } },
          { additionalProperties: false, required: ['agent_id', 'is_member'], properties: {
            agent_id: { pattern: canonicalDecimal, maxLength: 78 }, is_member: { const: false },
          } },
        ] } },
      })
      expect(recordAt(agentTool?.inputSchema, 'properties', 'agent_id')).toMatchObject({ pattern: canonicalDecimal, maxLength: 78 })
      for (const tool of [profileTool, agentTool]) {
        const selectorVariants = arrayAt(tool?.inputSchema, 'properties', 'selector', 'oneOf')
        const blockNumberVariant = selectorVariants.find((variant) => recordAt(variant, 'properties', 'kind').const === 'block_number')
        expect(recordAt(blockNumberVariant, 'properties', 'block_number')).toMatchObject({ pattern: canonicalDecimal, maxLength: 78 })
      }
    } finally { await app.close() }
  })

  it.each([
    [undefined, { kind: 'latest' }],
    [{ kind: 'latest' }, { kind: 'latest' }],
    [{ kind: 'safe' }, { kind: 'safe' }],
    [{ kind: 'finalized' }, { kind: 'finalized' }],
    [{ kind: 'block_number', block_number: '9007199254740993' }, { kind: 'block_number', blockNumber: '9007199254740993' }],
    [{ kind: 'block_hash', block_hash: hash }, { kind: 'block_hash', blockHash: hash }],
  ] as const)('maps selector %o to the reader and returns the exact Profile context', async (selector, expected) => {
    const app = await harness()
    try {
      const args = selector === undefined ? {} : { selector }
      const response = await app.request(2, 'tools/call', { name: 'profile.get', arguments: args })
      expect(app.calls[0]).toMatchObject({ operation: 'profile', selector: expected })
      expect(response).toMatchObject({ result: { structuredContent: {
        context: { instance: member, resolved: { chain: { block_number: '42', block_hash: hash }, profile: { version: '1' } } },
        data: { version: '1', data: { meta: { nested: { ok: true } } } },
      } } })
    } finally { await app.close() }
  })

  it('returns member and nonmember findings as successful native MCP results', async () => {
    let isMember = true
    const reader: ProfileReader = { readProfile: async () => snapshot(), readAgent: async () => agentSnapshot(isMember) }
    const app = await harness({ reader })
    try {
      const found = await app.request(2, 'tools/call', { name: 'profile.get_agent', arguments: { agent_id: '9007199254740993' } })
      expect(found).toMatchObject({ result: { structuredContent: { data: { agent_id: '9007199254740993', is_member: true, data: { role: 'contributor' } } } } })
      isMember = false
      const missing = await app.request(3, 'tools/call', { name: 'profile.get_agent', arguments: { agent_id: '9007199254740993' } })
      expect(missing).toMatchObject({ result: { structuredContent: { data: { agent_id: '9007199254740993', is_member: false } } } })
      expect((missing as { result: { isError?: boolean } }).result.isError).toBeUndefined()
      expect((missing as { result: { structuredContent: { data: object } } }).result.structuredContent.data).toEqual({ agent_id: '9007199254740993', is_member: false })
    } finally { await app.close() }
  })

  it('preserves Profile, Workflow, and member prototype-named JSON through the full MCP transport', async () => {
    const dangerous = '{"__proto__":{"polluted":true},"constructor":"safe","prototype":1,"toJSON":"inert"}'
    const reader: ProfileReader = {
      readProfile: async () => ({
        ...snapshot(), dataEntries: [{ key: 'danger', exists: true, data: dangerous }],
        workflow: { workflowAddress: '0x4000000000000000000000000000000000000004', data: dangerous },
      }),
      readAgent: async () => ({ ...agentSnapshot(), data: dangerous }),
    }
    const app = await harness({ reader })
    try {
      const profileResponse = await app.request(2, 'tools/call', { name: 'profile.get', arguments: {} })
      const agentResponse = await app.request(3, 'tools/call', { name: 'profile.get_agent', arguments: { agent_id: '9007199254740993' } })
      const values = [
        recordAt(profileResponse, 'result', 'structuredContent', 'data', 'data', 'danger'),
        recordAt(profileResponse, 'result', 'structuredContent', 'data', 'workflow', 'data'),
        recordAt(agentResponse, 'result', 'structuredContent', 'data', 'data'),
      ] as Array<Record<string, unknown>>

      for (const value of values) {
        expect(Object.getPrototypeOf(value)).toBeNull()
        expect(Object.keys(value)).toEqual(['__proto__', 'constructor', 'prototype', 'toJSON'])
        expect(Object.getOwnPropertyDescriptor(value, '__proto__')?.value).toEqual({ polluted: true })
      }
      expect((Object.prototype as { polluted?: unknown }).polluted).toBeUndefined()
    } finally { await app.close() }
  })

  it.each([
    { name: 'profile.get', arguments: { chain_id: '1' } },
    { name: 'profile.get', arguments: { tawg_address: tawg } },
    { name: 'profile.get', arguments: { agent_id: '1' } },
    { name: 'profile.get', arguments: { selector: { kind: 'latest', extra: true } } },
    { name: 'profile.get', arguments: { selector: { kind: 'block_number', block_number: '01' } } },
    { name: 'profile.get', arguments: { selector: { kind: 'block_hash', block_hash: '0x1234' } } },
    { name: 'profile.get_agent', arguments: { agent_id: '01' } },
    { name: 'profile.get_agent', arguments: { agent_id: (2n ** 256n).toString() } },
    { name: 'profile.get_agent', arguments: { agent_id: '9'.repeat(100_000) } },
    { name: 'profile.get_agent', arguments: { agent_id: '1', identity_registry_address: tawg } },
    { name: 'profile.get_agent', arguments: { agent_id: '1', authentication_wallet: tawg } },
    { name: 'profile.get_agent', arguments: { agent_id: '1', configured_agent_id: '1' } },
  ])('rejects caller-supplied locators and malformed strict input before reading: %o', async ({ name, arguments: args }) => {
    const app = await harness()
    try {
      const response = await app.request(2, 'tools/call', { name, arguments: args })
      expect(response).toMatchObject({ result: { isError: true } })
      expect(app.calls).toEqual([])
    } finally { await app.close() }
  })

  it('projects known TAS errors and unexpected failures without leaking endpoint, credential, or raw text', async () => {
    const secret = 'https://user:credential@example.invalid/rpc'
    for (const failure of [
      new (await import('../../src/core/errors.js')).TasError('PROFILE_INCONSISTENT', secret),
      Object.assign(new Error(secret), { endpoint: secret, credential: secret }),
    ]) {
      const reader: ProfileReader = { readProfile: async () => { throw failure }, readAgent: async () => { throw failure } }
      const app = await harness({ reader })
      try {
        const response = await app.request(2, 'tools/call', { name: 'profile.get', arguments: {} })
        expect(response).toMatchObject({ result: { isError: true, structuredContent: { error: { message: expect.any(String) } } } })
        expect(JSON.stringify(response)).not.toContain(secret)
      } finally { await app.close() }
    }
  })

  it('propagates MCP caller cancellation to the ProfileReader signal', async () => {
    let observed: AbortSignal | undefined
    let started!: () => void
    const didStart = new Promise<void>((resolve) => { started = resolve })
    const reader: ProfileReader = {
      readProfile: async (_selector, options) => {
        observed = options?.signal
        started()
        await new Promise<never>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }))
      },
      readAgent: async () => agentSnapshot(),
    }
    const app = await harness({ reader })
    try {
      const pending = app.request(2, 'tools/call', { name: 'profile.get', arguments: {} })
      await didStart
      await app.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'test cancellation' } })
      await pending
      for (let attempts = 0; attempts < 100 && !observed?.aborted; attempts += 1) await new Promise<void>((resolve) => setTimeout(resolve, 1))
      expect(observed?.aborted).toBe(true)
    } finally { await app.close() }
  })

  it('propagates MCP get_agent cancellation to the ProfileReader signal', async () => {
    let observed: AbortSignal | undefined
    let started!: () => void
    const didStart = new Promise<void>((resolve) => { started = resolve })
    const reader: ProfileReader = {
      readProfile: async () => snapshot(),
      readAgent: async (_agentId, _selector, options) => {
        observed = options?.signal
        started()
        await new Promise<never>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }))
      },
    }
    const app = await harness({ reader })
    try {
      const pending = app.request(2, 'tools/call', { name: 'profile.get_agent', arguments: { agent_id: '9007199254740993' } })
      await didStart
      await app.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'test cancellation' } })
      await pending
      for (let attempts = 0; attempts < 100 && !observed?.aborted; attempts += 1) await new Promise<void>((resolve) => setTimeout(resolve, 1))
      expect(observed?.aborted).toBe(true)
    } finally { await app.close() }
  })
})
