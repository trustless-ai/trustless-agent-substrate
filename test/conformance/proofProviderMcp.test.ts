import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'

import { TasError } from '../../src/core/errors.js'
import { bundleAttestationAdapter, createProofProviderRegistry } from '../../src/core/proof-provider/registry.js'
import { registerProofProviderTools } from '../../src/mcp/proofProviderTools.js'
import { FakeAttestationAdapter } from '../fakes/proof-provider/fakeAttestationAdapter.js'

const member = {
  phase: 'member', chain_id: '31337', tawg_address: '0x1000000000000000000000000000000000000001', agent_id: '42',
} as const
const manifest = {
  provider: 'fixture_attestor',
  type: 'attestation',
  operations_namespace: 'proof_provider.attestation.fixture_attestor',
  operations: ['generate', 'validate'],
} as const

async function harness(adapter?: FakeAttestationAdapter) {
  const server = new McpServer({ name: 'proof-provider-test', version: '1' })
  registerProofProviderTools(server, createProofProviderRegistry(
    adapter === undefined ? [] : [bundleAttestationAdapter(manifest, adapter)],
  ), member)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const received = new Map<number, unknown>()
  clientTransport.onmessage = (message) => { if ('id' in message && typeof message.id === 'number') received.set(message.id, message) }
  await server.connect(serverTransport)
  await clientTransport.start()
  async function request(id: number, method: string, params: Record<string, unknown>): Promise<unknown> {
    await clientTransport.send({ jsonrpc: '2.0', id, method, params })
    for (let count = 0; count < 100 && !received.has(id); count += 1) await new Promise<void>((resolve) => setTimeout(resolve, 1))
    return received.get(id)
  }
  await request(1, 'initialize', { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return { request, close: async () => { await server.close(); await clientTransport.close() } }
}

describe('Proof Provider MCP tools', () => {
  it('always exposes empty attestation discovery without provider network calls', async () => {
    const app = await harness()
    try {
      const listed = await app.request(2, 'tools/list', {}) as { result: { tools: Array<{ name: string; annotations: unknown }> } }
      expect(listed.result.tools.map(({ name }) => name)).toEqual(['proof_provider.attestation.list'])
      expect(listed.result.tools[0]?.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, destructiveHint: false })
      const response = await app.request(3, 'tools/call', { name: 'proof_provider.attestation.list', arguments: {} })
      expect(response).toMatchObject({ result: { structuredContent: { context: { instance: member }, data: [] } } })
    } finally { await app.close() }
  })

  it('discovers a reviewed adapter and dispatches its namespaced generation with one credential', async () => {
    const adapter = new FakeAttestationAdapter(manifest)
    const app = await harness(adapter)
    try {
      const discovery = await app.request(2, 'tools/call', { name: 'proof_provider.attestation.list', arguments: {} })
      const generated = await app.request(3, 'tools/call', {
        name: 'proof_provider.attestation.fixture_attestor.generate',
        arguments: { input: { subject: 'contribution-7' }, credential: { type: 'inline', secret: 'provider-secret' } },
      })
      expect(discovery).toMatchObject({ result: { structuredContent: { data: [manifest] } } })
      expect(generated).toMatchObject({ result: { structuredContent: { data: { proof: { subject: 'contribution-7' } } } } })
      expect(adapter.generateCalls).toEqual([{
        input: { subject: 'contribution-7' }, credential: { type: 'inline', secret: 'provider-secret' }, signal: expect.any(AbortSignal),
      }])
      expect(JSON.stringify(generated)).not.toContain('provider-secret')
      expect(adapter.retainedOperationState()).toEqual({ credentials: 0, proofs: 0 })
    } finally { await app.close() }
  })

  it('returns both valid and invalid proof data as successful validation results without a credential', async () => {
    const adapter = new FakeAttestationAdapter(manifest)
    const app = await harness(adapter)
    try {
      const valid = await app.request(2, 'tools/call', {
        name: 'proof_provider.attestation.fixture_attestor.validate', arguments: { proof: { verdict: 'valid' } },
      })
      const invalid = await app.request(3, 'tools/call', {
        name: 'proof_provider.attestation.fixture_attestor.validate', arguments: { proof: { verdict: 'invalid' } },
      })
      expect(valid).toMatchObject({ result: { structuredContent: { data: { valid: true, reason: 'verified by fixture' } } } })
      expect(invalid).toMatchObject({ result: { structuredContent: { data: { valid: false, reason: 'fixture rejected proof' } } } })
      expect(adapter.validateCalls).toEqual([{ proof: { verdict: 'valid' }, signal: expect.any(AbortSignal) }, { proof: { verdict: 'invalid' }, signal: expect.any(AbortSignal) }])
      expect(adapter.retainedOperationState()).toEqual({ credentials: 0, proofs: 0 })
    } finally { await app.close() }
  })

  it.each([
    { input: { subject: 'contribution-7' } },
    { input: { subject: 'contribution-7' }, credential: { type: 'inline', secret: '', extra: true } },
    { proof: { verdict: 'valid' }, credential: { type: 'inline', secret: 'not-allowed' } },
  ])('rejects malformed MCP input before adapter invocation: %o', async (arguments_) => {
    const adapter = new FakeAttestationAdapter(manifest)
    const app = await harness(adapter)
    try {
      const name = 'proof' in arguments_
        ? 'proof_provider.attestation.fixture_attestor.validate'
        : 'proof_provider.attestation.fixture_attestor.generate'
      const response = await app.request(2, 'tools/call', { name, arguments: arguments_ })
      expect(response).toMatchObject({ result: { isError: true, content: [{ type: 'text', text: expect.stringContaining('Input validation error') }] } })
      expect(adapter.generateCalls).toEqual([])
      expect(adapter.validateCalls).toEqual([])
    } finally { await app.close() }
  })

  it('returns a sanitized native tool error when a provider transport fails', async () => {
    const adapter = new FakeAttestationAdapter(manifest)
    adapter.generateFailure = new TasError('EXTERNAL_UNAVAILABLE', 'provider transport detail secret')
    const app = await harness(adapter)
    try {
      const response = await app.request(2, 'tools/call', {
        name: 'proof_provider.attestation.fixture_attestor.generate',
        arguments: { input: { subject: 'contribution-7' }, credential: { type: 'inline', secret: 'provider-secret' } },
      })
      expect(response).toMatchObject({ result: { isError: true, structuredContent: { error: { code: 'EXTERNAL_UNAVAILABLE' } } } })
      expect(JSON.stringify(response)).not.toMatch(/provider transport detail secret|provider-secret/)
      expect(adapter.retainedOperationState()).toEqual({ credentials: 0, proofs: 0 })
    } finally { await app.close() }
  })
})
