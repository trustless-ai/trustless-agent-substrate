import { describe, expect, it, vi } from 'vitest'
import { decodeFunctionData } from 'viem'

import { TasError } from '../../src/core/errors.js'
import { createViemProfileReader } from '../../src/clients/chain/viemProfileReader.js'
import { erc165Abi, tawgProfileAbi } from '../../src/clients/chain/profileAbi.js'
import type { ChainSelector } from '../../src/core/profile/types.js'
import { createTasResultBuilder } from '../../src/mcp/results.js'
import {
  createProfileRpcFixture,
  fixtureAgentId,
  fixtureAlternateVersion,
  fixtureBlocks,
  fixtureProfileAddress,
  fixtureRegistryAddress,
  fixtureVerifierAddress,
  fixtureVersion,
  fixtureWalletAddress,
} from '../fixtures/profile/blocks.js'

function expectTasError(code: string) {
  return (error: unknown) => {
    expect(error).toBeInstanceOf(TasError)
    expect((error as TasError).code).toBe(code)
    expect((error as TasError).message).not.toContain('secret.invalid')
    expect(JSON.stringify((error as TasError).details ?? {})).not.toContain('raw-secret')
    return true
  }
}

function exactEthCallBlocks(requests: readonly Readonly<{ method: string; params?: readonly unknown[] }>[]) {
  return requests
    .filter(({ method }) => method === 'eth_call')
    .map(({ params }) => params?.[1])
}

function expectHashBoundCalls(
  requests: readonly Readonly<{ method: string; params?: readonly unknown[] }>[],
  blockHash: string,
): void {
  const selectors = exactEthCallBlocks(requests)
  expect(selectors).not.toHaveLength(0)
  for (const selector of selectors) expect(selector).toEqual({ blockHash, requireCanonical: true })
}

function profileFunctionCalls(requests: readonly Readonly<{ method: string; params?: readonly unknown[] }>[]): string[] {
  return requests.flatMap(({ method, params }) => {
    if (method !== 'eth_call') return []
    const data = (params?.[0] as { data?: `0x${string}` } | undefined)?.data
    if (!data) return []
    try {
      return [decodeFunctionData({ abi: [...erc165Abi, ...tawgProfileAbi], data }).functionName]
    } catch {
      return []
    }
  })
}

function abortTimeout(milliseconds = 100): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('cancellation timed out')), milliseconds))
}

describe('viem exact-block Profile reader', () => {
  const selectors: ReadonlyArray<readonly [ChainSelector, bigint, string]> = [
    [{ kind: 'latest' }, fixtureBlocks.latest.number, fixtureBlocks.latest.hash],
    [{ kind: 'safe' }, fixtureBlocks.safe.number, fixtureBlocks.safe.hash],
    [{ kind: 'finalized' }, fixtureBlocks.finalized.number, fixtureBlocks.finalized.hash],
    [{ kind: 'block_number', blockNumber: fixtureBlocks.historical.number.toString() }, fixtureBlocks.historical.number, fixtureBlocks.historical.hash],
    [{ kind: 'block_hash', blockHash: fixtureBlocks.historical.hash }, fixtureBlocks.historical.number, fixtureBlocks.historical.hash],
  ]

  it.each(selectors)('pins every Profile read for selector %o', async (selector, number, hash) => {
    const fixture = createProfileRpcFixture()
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })

    const snapshot = await reader.readProfile(selector)

    expect(snapshot).toMatchObject({
      chainId: '31337', tawgAddress: fixtureProfileAddress, blockNumber: number.toString(), blockHash: hash,
      version: fixtureVersion, identityRegistry: fixtureRegistryAddress,
      agentIds: [fixtureAgentId],
      dataEntries: [{ key: 'artifacts', exists: true, data: '{"type":"git"}' }],
    })
    expectHashBoundCalls(fixture.requests, hash)
    expect(fixture.requests.some(({ method, params }) => method === 'eth_getBlockByNumber' && params?.[0] === `0x${number.toString(16)}`)).toBe(true)
  })

  it('reads a member wallet and owner at the same selected block without narrowing uint256 values', async () => {
    const fixture = createProfileRpcFixture()
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })

    const snapshot = await reader.readAgent(fixtureAgentId, { kind: 'block_number', blockNumber: '77' })

    expect(snapshot).toMatchObject({
      agentId: fixtureAgentId,
      version: fixtureVersion,
      isMember: true,
      data: '{"role":"contributor"}',
      agentVerifier: fixtureVerifierAddress,
      authenticationWallet: fixtureWalletAddress,
    })
    expectHashBoundCalls(fixture.requests, fixtureBlocks.historical.hash)
    const registryCalls = fixture.requests.filter(({ method, params }) => method === 'eth_call' && (params?.[0] as { to?: string })?.to === fixtureRegistryAddress)
    expect(registryCalls).toHaveLength(2)
  })

  it('returns successful negative raw data and skips Registry reads for a nonmember', async () => {
    const fixture = createProfileRpcFixture({ member: false })
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })

    const snapshot = await reader.readAgent(fixtureAgentId, { kind: 'latest' })

    expect(snapshot).toEqual(expect.objectContaining({ agentId: fixtureAgentId, isMember: false, data: '', agentVerifier: '0x0000000000000000000000000000000000000000' }))
    expect(snapshot).not.toHaveProperty('authenticationWallet')
    const registryCalls = fixture.requests.filter(({ method, params }) => method === 'eth_call' && (params?.[0] as { to?: string })?.to === fixtureRegistryAddress)
    expect(registryCalls).toHaveLength(0)
  })

  it('binds load-balanced contract reads to H1 even when number-based calls would return H2', async () => {
    const fixture = createProfileRpcFixture({ loadBalancedNumberState: true })
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })

    const snapshot = await reader.readProfile({ kind: 'latest' })

    expect(snapshot.version).not.toBe(fixtureAlternateVersion)
    expect(snapshot.version).toBe(fixtureVersion)
    expectHashBoundCalls(fixture.requests, fixtureBlocks.latest.hash)
  })

  it('fails safely when EIP-1898 eth_call is unsupported and never retries by block number', async () => {
    const fixture = createProfileRpcFixture({ unsupportedEip1898: true })
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })

    await expect(reader.readProfile({ kind: 'latest' })).rejects.toSatisfy(expectTasError('EXTERNAL_UNAVAILABLE'))
    expect(exactEthCallBlocks(fixture.requests)).toEqual([{ blockHash: fixtureBlocks.latest.hash, requireCanonical: true }])
  })

  it.each(['not canonical', 'non-canonical'] as const)('reports a hash-bound eth_call rejected as %s as a resolution conflict', async (canonicalityFailure) => {
    const fixture = createProfileRpcFixture({ canonicalityFailure })
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })

    await expect(reader.readProfile({ kind: 'latest' })).rejects.toSatisfy(expectTasError('RESOLUTION_CONFLICT'))
    expect(exactEthCallBlocks(fixture.requests)).toEqual([{ blockHash: fixtureBlocks.latest.hash, requireCanonical: true }])
  })

  it('rejects a changed hash during the final exact-block re-fetch', async () => {
    const fixture = createProfileRpcFixture({ reorgAfterReads: true })
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
    await expect(reader.readProfile({ kind: 'latest' })).rejects.toSatisfy(expectTasError('RESOLUTION_CONFLICT'))
  })

  it('rejects a block that disappears during the final exact-block re-fetch', async () => {
    const fixture = createProfileRpcFixture({ blockUnavailableAfterReads: true })
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
    await expect(reader.readProfile({ kind: 'latest' })).rejects.toSatisfy(expectTasError('RESOLUTION_CONFLICT'))
  })

  it('rejects a block-hash resolution whose returned block has a different hash', async () => {
    const fixture = createProfileRpcFixture({ blockHashMismatch: true })
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
    await expect(reader.readProfile({ kind: 'block_hash', blockHash: fixtureBlocks.historical.hash })).rejects.toSatisfy(expectTasError('RESOLUTION_CONFLICT'))
  })

  it('rejects a block-number resolution whose returned block has a different number', async () => {
    const fixture = createProfileRpcFixture({ blockNumberMismatch: true })
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
    await expect(reader.readProfile({ kind: 'block_number', blockNumber: '77' })).rejects.toSatisfy(expectTasError('RESOLUTION_CONFLICT'))
    expect(fixture.requests.filter(({ method }) => method === 'eth_call')).toHaveLength(0)
  })

  it('rejects a Profile that does not support the fixed interface', async () => {
    const fixture = createProfileRpcFixture({ unsupportedInterface: true })
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
    await expect(reader.readProfile({ kind: 'latest' })).rejects.toSatisfy(expectTasError('PROFILE_INCONSISTENT'))
    expect(fixture.requests.filter(({ method }) => method === 'eth_call')).toHaveLength(1)
  })

  it.each(['safe', 'finalized'] as const)('rejects unsupported %s finality without falling back', async (kind) => {
    const fixture = createProfileRpcFixture({ unsupportedFinality: kind })
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
    await expect(reader.readProfile({ kind })).rejects.toSatisfy(expectTasError('FINALITY_UNSUPPORTED'))
    expect(fixture.requests.filter(({ method }) => method === 'eth_getBlockByNumber')).toHaveLength(1)
  })

  it('does not misreport a generic transport failure as unsupported finality', async () => {
    const fixture = createProfileRpcFixture({ transportFailure: true })
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
    await expect(reader.readProfile({ kind: 'safe' })).rejects.toSatisfy(expectTasError('EXTERNAL_UNAVAILABLE'))
  })

  it('does not misreport a generic transport failure as unavailable history for an explicit selector', async () => {
    const fixture = createProfileRpcFixture({ transportFailure: true })
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
    await expect(reader.readProfile({ kind: 'block_number', blockNumber: '77' })).rejects.toSatisfy(expectTasError('EXTERNAL_UNAVAILABLE'))
  })

  it('rejects an unavailable explicit historical block without current-state fallback', async () => {
    const fixture = createProfileRpcFixture({ unavailableBlock: 77n })
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
    await expect(reader.readProfile({ kind: 'block_number', blockNumber: '77' })).rejects.toSatisfy(expectTasError('HISTORICAL_STATE_UNAVAILABLE'))
    expect(fixture.requests.filter(({ method }) => method === 'eth_getBlockByNumber')).toHaveLength(1)
  })

  it.each([
    [-32000, 'missing trie node at https://secret.invalid/archive?token=raw-secret'],
    [-32001, 'historical state unavailable at https://secret.invalid/archive?token=raw-secret'],
    [-32002, 'state at block 0x4d is pruned by https://secret.invalid/archive?token=raw-secret'],
  ] as const)('maps production-shaped historical eth_call failure %s without exposing its marker text', async (code, message) => {
    const fixture = createProfileRpcFixture({ historicalStateFailure: { code, message } })
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
    await expect(reader.readProfile({ kind: 'block_number', blockNumber: '77' })).rejects.toSatisfy(expectTasError('HISTORICAL_STATE_UNAVAILABLE'))
  })

  it.each([-32000, -32001, -32002] as const)('does not infer unavailable history from ambiguous JSON-RPC code %s', async (ambiguousRpcFailure) => {
    const fixture = createProfileRpcFixture({ ambiguousRpcFailure })
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
    await expect(reader.readProfile({ kind: 'block_number', blockNumber: '77' })).rejects.toSatisfy(expectTasError('EXTERNAL_UNAVAILABLE'))
  })

  it.each([
    ['missing trie node', '0xdeadbeef'],
    ['execution reverted: missing trie node', undefined],
  ] as const)('does not infer unavailable history from marker-like failure with revert semantics: %s', async (message, data) => {
    const fixture = createProfileRpcFixture({ historicalStateFailure: { code: -32000, message, ...(data ? { data } : {}) } })
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
    await expect(reader.readProfile({ kind: 'block_number', blockNumber: '77' })).rejects.toSatisfy(expectTasError('EXTERNAL_UNAVAILABLE'))
  })

  it('does not use a pruned-state marker outside an explicit historical selector', async () => {
    const fixture = createProfileRpcFixture({ historicalStateFailure: { code: -32000, message: 'missing trie node' } })
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
    await expect(reader.readProfile({ kind: 'latest' })).rejects.toSatisfy(expectTasError('EXTERNAL_UNAVAILABLE'))
  })

  it('does not use a pruned-state marker during block resolution', async () => {
    const fixture = createProfileRpcFixture({ blockResolutionFailure: { code: -32000, message: 'missing trie node' } })
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
    await expect(reader.readProfile({ kind: 'block_number', blockNumber: '77' })).rejects.toSatisfy(expectTasError('EXTERNAL_UNAVAILABLE'))
  })

  it.each(['latest', 'safe', 'finalized'] as const)('maps a missing %s tagged block to external unavailability without fallback', async (kind) => {
    const fixture = createProfileRpcFixture({ unavailableTag: kind })
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
    await expect(reader.readProfile({ kind })).rejects.toSatisfy(expectTasError('EXTERNAL_UNAVAILABLE'))
    expect(fixture.requests.filter(({ method }) => method === 'eth_getBlockByNumber')).toHaveLength(1)
  })

  it.each([
    [{ duplicateAgentIds: true }, 'duplicate Agent enumeration'],
    [{ missingEnumeratedData: true }, 'missing enumerated Data'],
  ] as const)('rejects inconsistent Profile responses: %s', async (options) => {
    const fixture = createProfileRpcFixture(options)
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
    await expect(reader.readProfile({ kind: 'latest' })).rejects.toSatisfy(expectTasError('PROFILE_INCONSISTENT'))
  })

  it('stops Agent enumeration immediately after a duplicate ID', async () => {
    const fixture = createProfileRpcFixture({ duplicateAgentIds: true })
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
    await expect(reader.readProfile({ kind: 'latest' })).rejects.toSatisfy(expectTasError('PROFILE_INCONSISTENT'))
    const calls = profileFunctionCalls(fixture.requests)
    expect(calls.filter((name) => name === 'agentIdAt')).toHaveLength(2)
    expect(calls).not.toContain('dataKeyAt')
  })

  it('stops Data enumeration before reading a duplicate key payload', async () => {
    const fixture = createProfileRpcFixture({ duplicateDataKeys: true })
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
    await expect(reader.readProfile({ kind: 'latest' })).rejects.toSatisfy(expectTasError('PROFILE_INCONSISTENT'))
    const calls = profileFunctionCalls(fixture.requests)
    expect(calls.filter((name) => name === 'dataKeyAt')).toHaveLength(2)
    expect(calls.filter((name) => name === 'getData')).toHaveLength(1)
  })

  it('does no RPC work when already cancelled', async () => {
    const fixture = createProfileRpcFixture()
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
    const controller = new AbortController()
    controller.abort()
    await expect(reader.readProfile({ kind: 'latest' }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fixture.requests).toHaveLength(0)
  })

  it('does no RPC work for a cancelled Agent read', async () => {
    const fixture = createProfileRpcFixture()
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
    const controller = new AbortController()
    controller.abort()
    await expect(reader.readAgent(fixtureAgentId, { kind: 'latest' }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(fixture.requests).toHaveLength(0)
  })

  it('aborts promptly while an RPC request is still pending', async () => {
    const fixture = createProfileRpcFixture({ holdFunction: 'agentIdAt' })
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
    const controller = new AbortController()
    const operation = reader.readProfile({ kind: 'latest' }, { signal: controller.signal })
    await fixture.heldCallStarted
    controller.abort()
    await expect(Promise.race([operation, abortTimeout()])).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.race([fixture.heldCallAborted, abortTimeout()])
  })

  it.each(['eth_getBlockByNumber', 'eth_chainId'] as const)('propagates cancellation into a pending %s transport request', async (holdMethod) => {
    const fixture = createProfileRpcFixture({ holdMethod })
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
    const controller = new AbortController()
    const operation = reader.readProfile({ kind: 'latest' }, { signal: controller.signal })
    await fixture.heldCallStarted
    controller.abort()
    await expect(Promise.race([operation, abortTimeout()])).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.race([fixture.heldCallAborted, abortTimeout()])
  })

  it('aborts a pending transport request at the configured operation deadline without a caller signal', async () => {
    const fixture = createProfileRpcFixture({ holdFunction: 'agentIdAt' })
    const reader = createViemProfileReader({
      client: fixture.client,
      tawgAddress: fixtureProfileAddress,
      operationTimeoutMs: 10,
    })

    const operation = reader.readProfile({ kind: 'latest' })
    await fixture.heldCallStarted
    await expect(Promise.race([operation, abortTimeout()])).rejects.toSatisfy(expectTasError('EXTERNAL_UNAVAILABLE'))
    await Promise.race([fixture.heldCallAborted, abortTimeout()])
  })

  it('applies the safe default operation deadline when no timeout is configured', async () => {
    vi.useFakeTimers()
    try {
      const fixture = createProfileRpcFixture({ holdFunction: 'agentIdAt' })
      const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
      const operation = reader.readProfile({ kind: 'latest' })
      const observed = operation.then(
        () => null,
        (error: unknown) => error,
      )
      await fixture.heldCallStarted

      await vi.advanceTimersByTimeAsync(30_000)

      expect(await observed).toSatisfy(expectTasError('EXTERNAL_UNAVAILABLE'))
      await fixture.heldCallAborted
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts a hanging sibling RPC when another initial getter fails', async () => {
    const fixture = createProfileRpcFixture({ failFunction: 'governance', holdFunction: 'version' })
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })

    const operation = reader.readProfile({ kind: 'latest' })
    await fixture.heldCallStarted

    await expect(operation).rejects.toSatisfy(expectTasError('EXTERNAL_UNAVAILABLE'))
    await Promise.race([fixture.heldCallAborted, abortTimeout()])
  })

  it('does not deduplicate identical RPCs across two independently cancellable readers', async () => {
    const fixture = createProfileRpcFixture({ holdFirstMethod: 'eth_chainId' })
    const firstReader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
    const secondReader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
    const controller = new AbortController()

    const first = firstReader.readProfile({ kind: 'latest' }, { signal: controller.signal })
    await fixture.heldCallStarted
    const second = secondReader.readProfile({ kind: 'latest' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()

    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    await expect(second).resolves.toMatchObject({ version: fixtureVersion })
    await Promise.race([fixture.heldCallAborted, abortTimeout()])
    expect(fixture.requests.filter(({ method }) => method === 'eth_chainId')).toHaveLength(2)
  })

  it.each(['agentIdAt', 'dataKeyAt'] as const)('maps an encoded -32000 IndexOutOfBounds from %s after a positive count to Profile inconsistency', async (functionName) => {
    const fixture = createProfileRpcFixture({ indexFailure: { functionName, kind: 'revert' } })
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
    await expect(reader.readProfile({ kind: 'latest' })).rejects.toSatisfy(expectTasError('PROFILE_INCONSISTENT'))
  })

  it.each(['agentIdAt', 'dataKeyAt'] as const)('keeps a transport outage during %s externally unavailable', async (functionName) => {
    const fixture = createProfileRpcFixture({ indexFailure: { functionName, kind: 'transport' } })
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
    await expect(reader.readProfile({ kind: 'latest' })).rejects.toSatisfy(expectTasError('EXTERNAL_UNAVAILABLE'))
  })

  it.each(['agentIdAt', 'dataKeyAt'] as const)('maps pruned archive state during historical %s reads without treating it as a structural revert', async (functionName) => {
    const fixture = createProfileRpcFixture({ indexFailure: { functionName, kind: 'historical' } })
    const reader = createViemProfileReader({ client: fixture.client, tawgAddress: fixtureProfileAddress })
    await expect(reader.readProfile({ kind: 'block_number', blockNumber: '77' })).rejects.toSatisfy(expectTasError('HISTORICAL_STATE_UNAVAILABLE'))
  })

  it.each([
    'PROFILE_INCONSISTENT',
    'FINALITY_UNSUPPORTED',
    'HISTORICAL_STATE_UNAVAILABLE',
    'RESOLUTION_CONFLICT',
    'EXTERNAL_UNAVAILABLE',
  ] as const)('projects %s through the fixed safe MCP error boundary', (code) => {
    const result = createTasResultBuilder({ phase: 'tawg_setup', chain_id: '31337', tawg_address: fixtureProfileAddress })
      .toolError(new TasError(code, 'raw https://secret.invalid/rpc?token=raw-secret', { upstream: 'raw-secret' }))
    expect(JSON.stringify(result)).not.toContain('secret.invalid')
    expect(JSON.stringify(result)).not.toContain('raw-secret')
    expect(result.structuredContent).toEqual(expect.objectContaining({ error: expect.objectContaining({ code }) }))
  })
})
