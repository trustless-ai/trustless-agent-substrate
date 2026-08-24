import { describe, expect, it, vi } from 'vitest'

import { TasError } from '../../../src/core/errors.js'
import type { GeneratedToolEntry } from '../../../src/mcp/manifest/types.js'
import { getManifestRegistry } from '../../../src/mcp/manifest/registry.js'

const workflowClientEvents = vi.hoisted(() => ({
  constructions: [] as Array<{ readonly config: unknown; readonly account: unknown; readonly instance: object }>,
  calls: [] as Array<{ readonly instance: object; readonly member: string; readonly arguments: readonly unknown[] }>,
  error: undefined as Error | undefined,
}))

vi.mock('@trustless-ai/agent-sdk/execution/ERC8301', () => {
  class AgentWorkflowClient {
    constructor(config: unknown, account: unknown) {
      workflowClientEvents.constructions.push({ config, account, instance: this })
    }

    async onAgentReply(...arguments_: readonly unknown[]): Promise<undefined> {
      workflowClientEvents.calls.push({ instance: this, member: 'onAgentReply', arguments: arguments_ })
      if (workflowClientEvents.error !== undefined) throw workflowClientEvents.error
      return undefined
    }

    async getReply(): Promise<never> { throw new Error('unused test SDK method') }
    async getTask(): Promise<never> { throw new Error('unused test SDK method') }
    async onAgentProve(): Promise<never> { throw new Error('unused test SDK method') }
    async result(): Promise<never> { throw new Error('unused test SDK method') }
    async run(): Promise<never> { throw new Error('unused test SDK method') }
  }
  return { AgentWorkflowClient }
})

import { createAgentSdkBindingClient } from '../../../src/clients/workflow/agentSdkClient.js'

const registry = getManifestRegistry()
const manifestEntries = registry.list('agent-sdk')
const workflowAddress = '0x1000000000000000000000000000000000000001'
const walletAddress = '0x2000000000000000000000000000000000000002'
const privateKey = `0x${'1'.repeat(64)}` as const

function manifestEntry(name: string): GeneratedToolEntry {
  const entry = registry.get(name)
  if (entry === undefined) throw new Error(`Missing test Manifest entry ${name}`)
  return entry
}

const replyEntry = manifestEntry('workflow.execution.erc8301.agent_workflow.on_agent_reply')
const computeAgentIdEntry = manifestEntry('workflow.identity.erc8004.recompute.compute_agent_id')
const getTrustedVerifierEntry = manifestEntry('workflow.verify.erc8274.get_trusted_verifier')

const foundryContext = {
  chainId: '31337',
  rpcUrl: 'http://127.0.0.1:8545',
  contractAddress: workflowAddress,
}

async function expectUnsupported(promise: Promise<unknown>): Promise<void> {
  try {
    await promise
    throw new Error('Expected binding to be unsupported')
  } catch (error) {
    expect(error).toBeInstanceOf(TasError)
    expect((error as TasError).code).toBe('MANIFEST_BINDING_UNSUPPORTED')
    expect((error as Error).message).toBe('The requested agent-sdk binding is unavailable.')
  }
}

describe('agent-sdk runtime binding', () => {
  it('creates fresh address and private-key accounts without retaining either account', () => {
    const binding = createAgentSdkBindingClient(manifestEntries)

    const firstRead = binding.accountFromAddress(walletAddress)
    const secondRead = binding.accountFromAddress(walletAddress)
    const firstSigner = binding.accountFromPrivateKey(privateKey)
    const secondSigner = binding.accountFromPrivateKey(privateKey)

    expect(firstRead.address).toBe(walletAddress)
    expect(secondRead.address).toBe(walletAddress)
    expect(firstRead).not.toBe(secondRead)
    expect(firstSigner.address).toBe(secondSigner.address)
    expect(firstSigner).not.toBe(secondSigner)
  })

  it('constructs one fresh SDK client per class invocation and preserves ordered arguments', async () => {
    workflowClientEvents.constructions.length = 0
    workflowClientEvents.calls.length = 0
    workflowClientEvents.error = undefined
    const binding = createAgentSdkBindingClient(manifestEntries)
    const account = binding.accountFromPrivateKey(privateKey)
    const reply = Object.freeze({ outputHash: `0x${'a'.repeat(64)}` })

    await expect(binding.invoke(replyEntry, [reply], { ...foundryContext, account })).resolves.toBeNull()
    await expect(binding.invoke(replyEntry, [reply], { ...foundryContext, account })).resolves.toBeNull()

    expect(workflowClientEvents.constructions).toHaveLength(2)
    expect(workflowClientEvents.constructions[0]?.config).toEqual({
      address: workflowAddress,
      rpcUrl: foundryContext.rpcUrl,
    })
    expect(workflowClientEvents.constructions[0]?.account).toBe(account)
    expect(workflowClientEvents.constructions[0]?.instance)
      .not.toBe(workflowClientEvents.constructions[1]?.instance)
    expect(workflowClientEvents.calls).toEqual([
      { instance: workflowClientEvents.constructions[0]?.instance, member: 'onAgentReply', arguments: [reply] },
      { instance: workflowClientEvents.constructions[1]?.instance, member: 'onAgentReply', arguments: [reply] },
    ])
  })

  it('executes pure recompute functions without a chain, contract, or account dependency', async () => {
    const binding = createAgentSdkBindingClient(manifestEntries)

    await expect(binding.invoke(computeAgentIdEntry, [7n], {
      chainId: '1',
      rpcUrl: 'https://not-used.example.invalid',
    })).resolves.toBe(`0x${'0'.repeat(63)}7`)
  })

  it('fails closed when a chain-bound operation is not on the SDK foundry chain', async () => {
    const binding = createAgentSdkBindingClient(manifestEntries)
    const account = binding.accountFromAddress(walletAddress)

    await expectUnsupported(binding.invoke(replyEntry, [{}], {
      ...foundryContext,
      chainId: '1',
      account,
    }))
  })

  it.each([
    { label: 'contract address', context: { chainId: '31337', rpcUrl: foundryContext.rpcUrl, account: {} } },
    { label: 'account', context: foundryContext },
  ])('fails closed when a class binding lacks its $label', async ({ context }) => {
    const binding = createAgentSdkBindingClient(manifestEntries)

    await expectUnsupported(binding.invoke(replyEntry, [{}], context as never))
  })

  it('requires a contract address but not an account for a chain-bound SDK function', async () => {
    const binding = createAgentSdkBindingClient(manifestEntries)

    await expectUnsupported(binding.invoke(getTrustedVerifierEntry, [], {
      chainId: '31337',
      rpcUrl: foundryContext.rpcUrl,
    }))
  })

  it('strictly admits only the reviewed source, binding kind, and target tuple', async () => {
    const binding = createAgentSdkBindingClient(manifestEntries)
    const account = binding.accountFromAddress(walletAddress)
    const invoke = (entry: GeneratedToolEntry) => binding.invoke(entry, [{}], { ...foundryContext, account })

    await expectUnsupported(invoke({
      ...replyEntry,
      source: { ...replyEntry.source, export: 'IdentityRegistryClient' },
    }))
    await expectUnsupported(invoke({
      ...replyEntry,
      source: { ...replyEntry.source, member: 'run' },
    }))
    await expectUnsupported(invoke({
      ...replyEntry,
      binding: { ...replyEntry.binding, target: 'AgentWorkflowClient.run' },
    }))
  })

  it('admits every reviewed Manifest source tuple before exposing the client', () => {
    expect(() => createAgentSdkBindingClient(manifestEntries)).not.toThrow()
  })

  it('fails construction when any reviewed Manifest tuple is absent from the runtime table', () => {
    const first = manifestEntries[0]
    if (first === undefined) throw new Error('Expected the agent-sdk Manifest inventory.')
    const unsupported = { ...first, source: { ...first.source, member: 'notReviewed' } }

    expect(() => createAgentSdkBindingClient([unsupported])).toThrowError(TasError)
  })

  it('sanitizes exceptions raised by the SDK', async () => {
    workflowClientEvents.error = new Error('upstream leaked secret 0xdeadbeef')
    const binding = createAgentSdkBindingClient(manifestEntries)
    const account = binding.accountFromAddress(walletAddress)

    try {
      await binding.invoke(replyEntry, [{}], { ...foundryContext, account })
      throw new Error('Expected invocation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toMatch(/could not be completed/i)
      expect((error as Error).message).not.toContain('0xdeadbeef')
    } finally {
      workflowClientEvents.error = undefined
    }
  })
})
