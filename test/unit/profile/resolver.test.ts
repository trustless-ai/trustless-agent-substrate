import { describe, expect, it } from 'vitest'

import { TasError } from '../../../src/core/errors.js'
import type { ProfileReader } from '../../../src/core/profile/reader.js'
import { ProfileResolver } from '../../../src/core/profile/resolver.js'
import type { ProfileSnapshot, RawAgentSnapshot } from '../../../src/core/profile/types.js'

const address = {
  tawg: '0x1000000000000000000000000000000000000001',
  governance: '0x2000000000000000000000000000000000000002',
  registry: '0x3000000000000000000000000000000000000003',
  workflow: '0x4000000000000000000000000000000000000004',
  verifier: '0x5000000000000000000000000000000000000005',
  wallet: '0x6000000000000000000000000000000000000006',
} as const
const zeroAddress = `0x${'0'.repeat(40)}` as const
const hash = `0x${'a'.repeat(64)}` as const
const largeAgentId = '9007199254740993123456789'
type ProfileJsonObjectForTest = Record<string, unknown>

function profile(overrides: Partial<ProfileSnapshot> = {}): ProfileSnapshot {
  return {
    chainId: '31337',
    tawgAddress: address.tawg,
    blockNumber: '42',
    blockHash: hash,
    version: '7',
    governance: address.governance,
    identityRegistry: address.registry,
    charter: {
      repository: 'https://github.com/trustless-ai/tawg-demo',
      commitHash: 'b'.repeat(40),
      path: 'charter/',
    },
    agentIds: [largeAgentId, '2'],
    dataEntries: [{ key: 'project.meta', exists: true, data: '{"title":"Demo","nested":{"labels":["a",2,true,null]}}' }],
    workflow: { workflowAddress: address.workflow, data: '{"source":{"path":"workflow/Workflow.sol"}}' },
    ...overrides,
  }
}

function agent(overrides: Partial<RawAgentSnapshot> = {}): RawAgentSnapshot {
  return {
    chainId: '31337',
    tawgAddress: address.tawg,
    blockNumber: '42',
    blockHash: hash,
    version: '7',
    identityRegistry: address.registry,
    agentId: largeAgentId,
    isMember: true,
    data: '{"role":"contributor","unknown":{"emoji":"🤖"}}',
    agentVerifier: address.verifier,
    authenticationWallet: address.wallet,
    ...overrides,
  }
}

function reader(profileSnapshot: ProfileSnapshot = profile(), agentSnapshot: RawAgentSnapshot = agent()): ProfileReader {
  return {
    readProfile: async () => profileSnapshot,
    readAgent: async () => agentSnapshot,
  }
}

function resolver(profileSnapshot = profile(), agentSnapshot = agent()): ProfileResolver {
  return new ProfileResolver(reader(profileSnapshot, agentSnapshot), { chainId: '31337', tawgAddress: address.tawg })
}

async function expectInconsistent(operation: Promise<unknown>): Promise<void> {
  await expect(operation).rejects.toMatchObject<TasError>({ code: 'PROFILE_INCONSISTENT' })
}

describe('ProfileResolver', () => {
  it('exposes one immutable normalized process binding', () => {
    const instance = resolver()

    expect(instance.binding).toEqual({ chainId: '31337', tawgAddress: address.tawg })
    expect(Object.isFrozen(instance.binding)).toBe(true)
    expect(() => Object.assign(instance.binding, { chainId: '1' })).toThrow()
    expect(Reflect.set(instance, 'binding', { chainId: '1', tawgAddress: address.tawg })).toBe(false)
    expect(instance.binding.chainId).toBe('31337')
  })

  it('projects profile discovery data and the exact snapshot resolution', async () => {
    const result = await resolver().get()

    expect(result).toEqual({
      data: {
        version: '7',
        governance: address.governance,
        charter: { repository: 'https://github.com/trustless-ai/tawg-demo', commit: 'b'.repeat(40), path: 'charter/' },
        agents: { identity_registry: address.registry, agent_ids: [largeAgentId, '2'] },
        data: { 'project.meta': { title: 'Demo', nested: { labels: ['a', 2, true, null] } } },
        workflow: { address: address.workflow, data: { source: { path: 'workflow/Workflow.sol' } } },
      },
      resolution: { chain: { block_number: '42', block_hash: hash }, profile: { version: '7' } },
    })
    expect(result.data).not.toHaveProperty('pendingGovernance')
  })

  it('projects a member and a successful minimal nonmember', async () => {
    await expect(resolver().getAgent(largeAgentId)).resolves.toEqual({
      data: {
        agent_id: largeAgentId,
        is_member: true,
        data: { role: 'contributor', unknown: { emoji: '🤖' } },
        agent_verifier: address.verifier,
        authentication_wallet: address.wallet,
      },
      resolution: { chain: { block_number: '42', block_hash: hash }, profile: { version: '7' } },
    })

    const nonmember = agent({
      isMember: false,
      data: '',
      agentVerifier: zeroAddress,
      authenticationWallet: undefined,
    })
    await expect(resolver(profile(), nonmember).getAgent(largeAgentId)).resolves.toEqual({
      data: { agent_id: largeAgentId, is_member: false },
      resolution: { chain: { block_number: '42', block_hash: hash }, profile: { version: '7' } },
    })
  })

  it('preserves prototype-named extension keys as inert own data without pollution or execution', async () => {
    delete (Object.prototype as { polluted?: unknown }).polluted
    const dangerous = '{"__proto__":{"polluted":true},"constructor":{"safe":true},"prototype":"value","toJSON":"inert"}'
    const result = await resolver(profile({
      dataEntries: [{ key: 'danger', exists: true, data: dangerous }],
      workflow: { workflowAddress: address.workflow, data: dangerous },
    }), agent({ data: dangerous })).get()

    const projected = result.data.data.danger
    expect(Object.getPrototypeOf(projected)).toBeNull()
    expect(Object.keys(projected)).toEqual(['__proto__', 'constructor', 'prototype', 'toJSON'])
    expect(Object.getOwnPropertyDescriptor(projected, '__proto__')?.value).toEqual({ polluted: true })
    expect(typeof projected.toJSON).toBe('string')
    expect((Object.prototype as { polluted?: unknown }).polluted).toBeUndefined()
    expect(() => JSON.stringify(result.data)).not.toThrow()

    const workflowData = result.data.workflow.data as ProfileJsonObjectForTest
    expect(Object.getPrototypeOf(workflowData)).toBeNull()
    expect(Object.keys(workflowData)).toEqual(['__proto__', 'constructor', 'prototype', 'toJSON'])
    expect(Object.getOwnPropertyDescriptor(workflowData, '__proto__')?.value).toEqual({ polluted: true })
  })

  it('preserves prototype-named member keys as inert own data', async () => {
    const dangerous = '{"__proto__":{"polluted":true},"constructor":{"safe":true},"prototype":"value","toJSON":"inert"}'
    const result = await resolver(profile(), agent({ data: dangerous })).getAgent(largeAgentId)
    const memberData = result.data.data as ProfileJsonObjectForTest

    expect(Object.getPrototypeOf(memberData)).toBeNull()
    expect(Object.keys(memberData)).toEqual(['__proto__', 'constructor', 'prototype', 'toJSON'])
    expect(Object.getOwnPropertyDescriptor(memberData, '__proto__')?.value).toEqual({ polluted: true })
    expect((Object.prototype as { polluted?: unknown }).polluted).toBeUndefined()
  })

  it('keeps the typed Workflow address authoritative over similarly named Workflow JSON', async () => {
    const result = await resolver(profile({
      workflow: { workflowAddress: address.workflow, data: `{"address":"${zeroAddress}","version":"999"}` },
    })).get()

    expect(result.data.workflow).toEqual({
      address: address.workflow,
      data: { address: zeroAddress, version: '999' },
    })
  })

  it('preserves a non-empty provider-specific Repository locator for the Repository Resolver', async () => {
    const repository = 'https://github.com/trustless-ai/tawg-demo.git'
    const result = await resolver(profile({
      charter: { repository, commitHash: 'b'.repeat(40), path: 'charter/' },
    })).get()

    expect(result.data.charter.repository).toBe(repository)
  })

  it('keeps typed member fields authoritative over similarly named member JSON', async () => {
    const result = await resolver(profile(), agent({
      data: `{"agent_id":"1","is_member":false,"agent_verifier":"${zeroAddress}"}`,
    })).getAgent(largeAgentId)

    expect(result.data).toMatchObject({
      agent_id: largeAgentId,
      is_member: true,
      agent_verifier: address.verifier,
      data: { agent_id: '1', is_member: false, agent_verifier: zeroAddress },
    })
  })

  it.each([
    '[1,2]', 'null', 'true', '42', '"scalar"', '{', '{"n":1e999}',
  ])('rejects non-object, malformed, or non-finite Profile JSON: %s', async (data) => {
    await expectInconsistent(resolver(profile({ dataEntries: [{ key: 'bad', exists: true, data }] })).get())
    await expectInconsistent(resolver(profile({ workflow: { workflowAddress: address.workflow, data } })).get())
    await expectInconsistent(resolver(profile(), agent({ data })).getAgent(largeAgentId))
  })

  it('rejects JSON-incompatible accessors without invoking them', async () => {
    let calls = 0
    const entry = { key: 'safe', exists: true } as { key: string; exists: boolean; data?: string }
    Object.defineProperty(entry, 'data', { enumerable: true, get: () => { calls += 1; return '{}' } })

    await expectInconsistent(resolver(profile({ dataEntries: [entry as never] })).get())
    expect(calls).toBe(0)
  })

  it('rejects accessor-backed snapshot arrays without invoking their elements', async () => {
    let calls = 0
    const agentIds: string[] = []
    Object.defineProperty(agentIds, '0', { configurable: true, enumerable: true, get: () => { calls += 1; return '1' } })
    Object.defineProperty(agentIds, 'length', { value: 1 })

    await expectInconsistent(resolver(profile({ agentIds })).get())
    expect(calls).toBe(0)
  })

  it.each([
    profile({ agentIds: ['1', '1'] }),
    profile({ dataEntries: [{ key: 'same', exists: true, data: '{}' }, { key: 'same', exists: true, data: '{}' }] }),
    profile({ governance: zeroAddress }),
    profile({ identityRegistry: zeroAddress }),
    profile({ tawgAddress: zeroAddress }),
    profile({ workflow: { workflowAddress: zeroAddress, data: '{}' } }),
    profile({ charter: { repository: '', commitHash: 'b'.repeat(40), path: 'charter/' } }),
    profile({ charter: { repository: 'https://github.com/trustless-ai/tawg-demo', commitHash: 'B'.repeat(40), path: 'charter/' } }),
    profile({ charter: { repository: 'https://github.com/trustless-ai/tawg-demo', commitHash: 'b'.repeat(39), path: 'charter/' } }),
    profile({ charter: { repository: 'https://github.com/trustless-ai/tawg-demo', commitHash: 'b'.repeat(40), path: 'charter' } }),
    profile({ dataEntries: [{ key: 'Bad', exists: true, data: '{}' }] }),
    profile({ dataEntries: [{ key: `a${'b'.repeat(64)}`, exists: true, data: '{}' }] }),
    profile({ version: '0' }),
    profile({ version: '01' }),
    profile({ version: (2n ** 256n).toString() }),
    profile({ agentIds: ['01'] }),
    profile({ agentIds: [(2n ** 256n).toString()] }),
    profile({ chainId: '1' }),
    profile({ tawgAddress: '0x1000000000000000000000000000000000000002' }),
  ])('rejects inconsistent Profile snapshots', async (snapshot) => {
    await expectInconsistent(resolver(snapshot).get())
  })

  it.each([
    agent({ identityRegistry: zeroAddress }),
    agent({ agentVerifier: zeroAddress }),
    agent({ authenticationWallet: zeroAddress }),
    agent({ authenticationWallet: undefined }),
    agent({ agentId: '01' }),
    agent({ version: '0' }),
    agent({ blockNumber: '01' }),
    agent({ blockHash: '0x1234' }),
    agent({ chainId: '1' }),
    agent({ tawgAddress: '0x1000000000000000000000000000000000000002' }),
    agent({ isMember: false, data: '{}', agentVerifier: zeroAddress, authenticationWallet: undefined }),
    agent({ isMember: false, data: '', agentVerifier: address.verifier, authenticationWallet: undefined }),
    agent({ isMember: false, data: '', agentVerifier: zeroAddress, authenticationWallet: address.wallet }),
  ])('rejects inconsistent Agent snapshots', async (snapshot) => {
    await expectInconsistent(resolver(profile(), snapshot).getAgent(snapshot.agentId))
  })

  it('rejects a reader response for an Agent other than the requested canonical ID', async () => {
    await expectInconsistent(resolver(profile(), agent({ agentId: '2' })).getAgent(largeAgentId))
  })

  it('rejects 8,000-level JSON nesting as PROFILE_INCONSISTENT without a raw RangeError', async () => {
    const deeplyNested = `${'{"next":'.repeat(8_000)}0${'}'.repeat(8_000)}`
    const operation = resolver(profile({ dataEntries: [{ key: 'deep', exists: true, data: deeplyNested }] })).get()

    await expectInconsistent(operation)
  })

  it('enforces one aggregate UTF-8 byte budget across all JSON fields', async () => {
    const chunk = 'x'.repeat(600_000)
    const aggregate = profile({
      dataEntries: [
        { key: 'first', exists: true, data: JSON.stringify({ text: chunk }) },
        { key: 'second', exists: true, data: JSON.stringify({ text: chunk }) },
      ],
    })

    await expectInconsistent(resolver(aggregate).get())
  })

  it('rejects a single oversized JSON string before recursive projection', async () => {
    const oversized = JSON.stringify({ text: 'x'.repeat(1_100_000) })

    await expectInconsistent(resolver(profile({ workflow: { workflowAddress: address.workflow, data: oversized } })).get())
  })

  it('rejects wide JSON and aggregate Agent/Data projection budgets safely', async () => {
    const wide = JSON.stringify({ values: Array.from({ length: 10_000 }, () => 0) })
    await expectInconsistent(resolver(profile({ dataEntries: [{ key: 'wide', exists: true, data: wide }] })).get())

    const agentIds = Array.from({ length: 5_001 }, (_, index) => String(index))
    const dataEntries = Array.from({ length: 5_001 }, (_, index) => ({ key: `k${index}`, exists: true, data: '{}' }))
    await expectInconsistent(resolver(profile({ agentIds, dataEntries })).get())
  })

  it('rejects an oversized enumeration from its length before enumerating descriptors', async () => {
    let ownKeyReads = 0
    const oversized = new Proxy(new Array<string>(10_001), {
      ownKeys: (target) => { ownKeyReads += 1; return Reflect.ownKeys(target) },
    })

    await expectInconsistent(resolver(profile({ agentIds: oversized })).get())
    expect(ownKeyReads).toBe(0)
  })

  it('accepts valid projections near the local depth, node, entry, and byte budgets', async () => {
    const nearDepth = `${'{"next":'.repeat(62)}0${'}'.repeat(62)}`
    const nearWidth = JSON.stringify({ values: Array.from({ length: 9_000 }, () => 0) })
    const nearBytes = JSON.stringify({ text: 'x'.repeat(1_000_000) })

    await expect(resolver(profile({ dataEntries: [{ key: 'deep', exists: true, data: nearDepth }] })).get()).resolves.toMatchObject({ data: { data: { deep: expect.any(Object) } } })
    await expect(resolver(profile({ dataEntries: [{ key: 'wide', exists: true, data: nearWidth }] })).get()).resolves.toMatchObject({ data: { data: { wide: expect.any(Object) } } })
    await expect(resolver(profile({ dataEntries: [{ key: 'bytes', exists: true, data: nearBytes }] })).get()).resolves.toMatchObject({ data: { data: { bytes: expect.any(Object) } } })
  })

  it('rejects decimal strings longer than uint256 before BigInt or the reader', async () => {
    const huge = '9'.repeat(100_000)
    let reads = 0
    const guarded = new ProfileResolver({
      readProfile: async () => { reads += 1; return profile() },
      readAgent: async () => { reads += 1; return agent() },
    }, { chainId: '31337', tawgAddress: address.tawg })

    await expectInconsistent(guarded.getAgent(huge))
    expect(reads).toBe(0)
    expect(() => new ProfileResolver(reader(), { chainId: huge, tawgAddress: address.tawg })).toThrow(TasError)
  })
})
