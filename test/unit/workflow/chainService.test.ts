import { describe, expect, it, vi } from 'vitest'
import type { Account, PublicClient, WalletClient } from 'viem'

import type { ViemAction, ViemActionBindings } from '../../../src/clients/chain/viemActions.js'
import { TasError } from '../../../src/core/errors.js'
import { createChainService } from '../../../src/core/workflow/chainService.js'
import type { AgentMembershipResolver } from '../../../src/core/workflow/chainService.js'
import type { ResolvedTasConfig } from '../../../src/local/config/types.js'
import { getManifestRegistry } from '../../../src/mcp/manifest/registry.js'
import type { GeneratedToolEntry } from '../../../src/mcp/manifest/types.js'

const registry = getManifestRegistry()
const tawgAddress = '0x1000000000000000000000000000000000000001'
const identityRegistry = '0x8004000000000000000000000000000000000001'
const agentId = '340282366920938463463374607431768211457'
const matchingWallet = '0x2000000000000000000000000000000000000002'
const privateKey = `0x${'1'.repeat(64)}`

function config(mode: 'identity_setup' | 'tawg_setup' | 'member'): ResolvedTasConfig {
  const chain = { family: 'evm' as const, rpcUrl: 'https://rpc.example.invalid/secret-auth', rpcSource: 'config' as const }
  if (mode === 'identity_setup') return {
    configVersion: 1, mode, identitySetup: { chainId: '31337', identityRegistryAddress: identityRegistry }, chain,
  }
  if (mode === 'tawg_setup') return {
    configVersion: 1, mode, tawgSetup: { chainId: '31337', tawgAddress }, chain,
  }
  return {
    configVersion: 1,
    mode,
    instance: { chainId: '31337', tawgAddress, agentId },
    chain,
    repository: { client: 'github' },
    da: { client: 'git' },
    chat: { sources: [], targets: [] },
    proofProviders: [],
  }
}

function resolvedAgent(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    data: {
      agent_id: agentId,
      is_member: true,
      data: {},
      agent_verifier: '0x3000000000000000000000000000000000000003',
      authentication_wallet: matchingWallet,
      ...overrides,
    },
    resolution: {
      chain: { block_number: '42', block_hash: `0x${'4'.repeat(64)}` },
      profile: { version: '1' },
    },
  } as const
}

interface HarnessOptions {
  readonly mode?: 'identity_setup' | 'tawg_setup' | 'member'
  readonly result?: unknown
  readonly sourceError?: Error
  readonly resolved?: ReturnType<typeof resolvedAgent>
  readonly accountAddress?: string
  readonly profileError?: Error
}

function harness(options: HarnessOptions = {}) {
  const action = vi.fn(async (_client: unknown, _arguments: Readonly<Record<string, unknown>>) => {
    if (options.sourceError !== undefined) throw options.sourceError
    return options.result ?? '0x1234'
  }) as ViemAction
  const get = vi.fn((_entry: GeneratedToolEntry) => action)
  const accountFromPrivateKey = vi.fn((_secret: `0x${string}`) => ({
    address: options.accountAddress ?? matchingWallet,
  } as Account))
  const bindings: ViemActionBindings = { get, accountFromPrivateKey }
  const getAgent = vi.fn(async () => {
    if (options.profileError !== undefined) throw options.profileError
    return options.resolved ?? resolvedAgent()
  })
  const resolver: AgentMembershipResolver = { getAgent }
  const publicClient = { marker: 'configured-public-client' } as unknown as PublicClient
  const walletClient = { marker: 'configured-wallet-client', account: undefined } as unknown as WalletClient
  const serviceOptions = {
    registry,
    bindings,
    config: config(options.mode ?? 'member'),
    publicClient,
    walletClient,
    profileResolver: resolver,
  }
  const service = createChainService(serviceOptions)
  return { service, serviceOptions, action, get, accountFromPrivateKey, getAgent, publicClient, walletClient }
}

async function expectCode(promise: Promise<unknown>, code: string, forbidden: readonly string[] = []): Promise<TasError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(TasError)
    const tasError = error as TasError
    expect(tasError.code).toBe(code)
    for (const value of forbidden) expect(tasError.message).not.toContain(value)
    return tasError
  }
  throw new Error('Expected ChainService invocation to fail')
}

describe('ChainService Public Actions', () => {
  it('decodes arguments, calls the bound action once with the configured client, and encodes bigint output', async () => {
    const app = harness({ result: 123n })
    const result = await app.service.invoke({
      toolName: 'workflow.chain.public.get_balance',
      arguments: { address: matchingWallet, blockNumber: '42' },
    })

    expect(result).toBe('123')
    expect(app.action).toHaveBeenCalledTimes(1)
    expect(app.action).toHaveBeenCalledWith(app.publicClient, expect.objectContaining({
      address: matchingWallet,
      blockNumber: 42n,
    }))
    expect(app.getAgent).not.toHaveBeenCalled()
    expect(app.accountFromPrivateKey).not.toHaveBeenCalled()
  })

  it.each(['client', 'transport', 'chain', 'credential'])('rejects caller-supplied runtime property %s', async (field) => {
    const app = harness()
    await expectCode(app.service.invoke({
      toolName: 'workflow.chain.public.get_block_number',
      arguments: { [field]: {} },
    }), 'INVALID_ARGUMENT')
    expect(app.action).not.toHaveBeenCalled()
  })

  it('preserves a Manifest-declared public account address parameter', async () => {
    const app = harness({ result: { accessList: [], gasUsed: 21_000n } })
    await expect(app.service.invoke({
      toolName: 'workflow.chain.public.create_access_list',
      arguments: { account: matchingWallet, to: tawgAddress },
    })).resolves.toEqual({ accessList: [], gasUsed: '21000' })
    expect(app.action).toHaveBeenCalledWith(app.publicClient, expect.objectContaining({ account: matchingWallet }))
  })

  it('rejects accessors and Proxies before any source or authorization operation', async () => {
    const accessor = Object.create(null) as Record<string, unknown>
    Object.defineProperty(accessor, 'address', { enumerable: true, get: () => matchingWallet })
    for (const argumentsValue of [accessor, new Proxy({}, {})]) {
      const app = harness()
      await expectCode(app.service.invoke({
        toolName: 'workflow.chain.public.get_balance', arguments: argumentsValue,
      }), 'INVALID_ARGUMENT')
      expect(app.action).not.toHaveBeenCalled()
      expect(app.getAgent).not.toHaveBeenCalled()
    }
  })

  it('rejects a proxied, inherited, accessor-bearing, or extended invocation envelope', async () => {
    const accessor = Object.create(null)
    Object.defineProperties(accessor, {
      toolName: { enumerable: true, get: () => 'workflow.chain.public.get_block_number' },
      arguments: { enumerable: true, value: {} },
    })
    const inherited = Object.create({})
    Object.assign(inherited, { toolName: 'workflow.chain.public.get_block_number', arguments: {} })
    const extended = { toolName: 'workflow.chain.public.get_block_number', arguments: {}, extra: true }
    for (const invocation of [new Proxy({ toolName: '', arguments: {} }, {}), accessor, inherited, extended]) {
      const app = harness()
      await expectCode(app.service.invoke(invocation as never), 'INVALID_ARGUMENT')
      expect(app.action).not.toHaveBeenCalled()
    }
  })

  it('captures configured dependencies once when the service is created', async () => {
    const app = harness({ result: 7n })
    const options = app.serviceOptions as unknown as Record<string, unknown>
    options.publicClient = { marker: 'replacement' }
    options.bindings = { get: () => { throw new Error('replacement') } }
    options.config = config('identity_setup')

    await expect(app.service.invoke({
      toolName: 'workflow.chain.public.get_block_number', arguments: {},
    })).resolves.toBe('7')
    expect(app.action).toHaveBeenCalledWith(app.publicClient, {})
  })

  it('maps unknown tools to binding unsupported and read failures to a redacted external error without retry', async () => {
    const upstream = 'upstream secret https://user:token@rpc.invalid/path'
    const unknown = harness()
    await expectCode(unknown.service.invoke({ toolName: 'workflow.chain.public.not_real', arguments: {} }), 'MANIFEST_BINDING_UNSUPPORTED')

    const failing = harness({ sourceError: new Error(upstream) })
    await expectCode(failing.service.invoke({
      toolName: 'workflow.chain.public.get_block_number', arguments: {},
    }), 'EXTERNAL_UNAVAILABLE', [upstream, 'token@rpc.invalid', privateKey])
    expect(failing.action).toHaveBeenCalledTimes(1)
  })

  it('rejects a source result that cannot pass the generated output schema', async () => {
    const app = harness({ result: { unexpected: true } })
    await expectCode(app.service.invoke({
      toolName: 'workflow.chain.public.get_block_number', arguments: {},
    }), 'EXTERNAL_UNAVAILABLE')
    expect(app.action).toHaveBeenCalledTimes(1)
  })
})

describe('ChainService Wallet Actions', () => {
  const sign = (argumentsValue: Readonly<Record<string, unknown>>) => ({
    toolName: 'workflow.chain.wallet.sign_message', arguments: argumentsValue,
  })

  it.each([
    {},
    { credential: null },
    { credential: { type: 'inline' } },
    { credential: { type: 'inline', secret: '0x1234' } },
    { credential: { type: 'other', secret: privateKey } },
    { credential: { type: 'inline', secret: privateKey, extra: true } },
  ])('requires one exact inline 32-byte EVM private key: %j', async (credential) => {
    const app = harness()
    await expectCode(app.service.invoke(sign({ message: 'hello', ...credential })), 'CREDENTIAL_REQUIRED', [privateKey])
    expect(app.accountFromPrivateKey).not.toHaveBeenCalled()
    expect(app.getAgent).not.toHaveBeenCalled()
    expect(app.action).not.toHaveBeenCalled()
  })

  it.each(['identity_setup', 'tawg_setup'] as const)('constructs an Account per %s call and never performs a Profile lookup', async (mode) => {
    const app = harness({ mode })
    const invocation = sign({ message: 'hello', credential: { type: 'inline', secret: privateKey } })

    await expect(app.service.invoke(invocation)).resolves.toBe('0x1234')
    await expect(app.service.invoke(invocation)).resolves.toBe('0x1234')
    expect(app.accountFromPrivateKey).toHaveBeenCalledTimes(2)
    expect(app.getAgent).not.toHaveBeenCalled()
    expect(app.action).toHaveBeenCalledTimes(2)
    for (const [, args] of app.action.mock.calls) {
      expect(args).toMatchObject({ message: 'hello', account: { address: matchingWallet } })
      expect(args).not.toHaveProperty('credential')
      expect(JSON.stringify(args)).not.toContain(privateKey)
    }
  })

  it('checks the configured ERC-8004 agent membership at latest exactly once before one Wallet source call', async () => {
    const app = harness()
    await expect(app.service.invoke(sign({
      message: 'hello', credential: { type: 'inline', secret: privateKey },
    }))).resolves.toBe('0x1234')

    expect(app.getAgent).toHaveBeenCalledTimes(1)
    expect(app.getAgent).toHaveBeenCalledWith(agentId, { kind: 'latest' })
    expect(app.action).toHaveBeenCalledTimes(1)
    expect(app.action).toHaveBeenCalledWith(app.walletClient, expect.objectContaining({
      message: 'hello', account: expect.objectContaining({ address: matchingWallet }),
    }))
  })

  it.each([
    ['nonmember', resolvedAgent({ is_member: false }), 'AUTHORIZATION_DENIED'],
    ['wrong Agent record', resolvedAgent({ agent_id: '7' }), 'AUTHORIZATION_DENIED'],
    ['zero wallet', resolvedAgent({ authentication_wallet: `0x${'0'.repeat(40)}` }), 'AUTHORIZATION_DENIED'],
    ['wallet mismatch', resolvedAgent({ authentication_wallet: '0x4000000000000000000000000000000000000004' }), 'WALLET_MISMATCH'],
  ])('rejects %s before invoking a Wallet action', async (_label, resolved, code) => {
    const app = harness({ resolved: resolved as ReturnType<typeof resolvedAgent> })
    await expectCode(app.service.invoke(sign({
      message: 'hello', credential: { type: 'inline', secret: privateKey },
    })), code)
    expect(app.getAgent).toHaveBeenCalledTimes(1)
    expect(app.action).not.toHaveBeenCalled()
  })

  it('redacts a Profile lookup failure before it crosses the Chain boundary', async () => {
    const sourceMessage = `profile failure ${privateKey} https://user:auth@rpc.invalid`
    const app = harness({ profileError: new Error(sourceMessage) })
    await expectCode(app.service.invoke(sign({
      message: 'hello', credential: { type: 'inline', secret: privateKey },
    })), 'EXTERNAL_UNAVAILABLE', [privateKey, sourceMessage, 'auth@rpc.invalid'])
    expect(app.getAgent).toHaveBeenCalledTimes(1)
    expect(app.action).not.toHaveBeenCalled()
  })

  it.each(['client', 'transport', 'chain', 'account'])('prevents Wallet callers from overriding injected %s', async (field) => {
    const app = harness()
    await expectCode(app.service.invoke(sign({
      message: 'hello', credential: { type: 'inline', secret: privateKey }, [field]: {},
    })), 'INVALID_ARGUMENT', [privateKey])
    expect(app.accountFromPrivateKey).not.toHaveBeenCalled()
    expect(app.getAgent).not.toHaveBeenCalled()
    expect(app.action).not.toHaveBeenCalled()
  })

  it('distinguishes local signing failure from uncertain transaction submission without retry or source leakage', async () => {
    const sourceMessage = `raw failure ${privateKey} https://user:auth@rpc.invalid`
    const signing = harness({ sourceError: new Error(sourceMessage) })
    await expectCode(signing.service.invoke(sign({
      message: 'hello', credential: { type: 'inline', secret: privateKey },
    })), 'EXTERNAL_UNAVAILABLE', [privateKey, sourceMessage, 'auth@rpc.invalid'])
    expect(signing.action).toHaveBeenCalledTimes(1)

    const transaction = harness({ sourceError: new Error(sourceMessage) })
    await expectCode(transaction.service.invoke({
      toolName: 'workflow.chain.wallet.send_transaction',
      arguments: { to: matchingWallet, credential: { type: 'inline', secret: privateKey } },
    }), 'OPERATION_OUTCOME_UNKNOWN', [privateKey, sourceMessage, 'auth@rpc.invalid'])
    expect(transaction.action).toHaveBeenCalledTimes(1)
  })

  it('returns transaction hashes and receipt-shaped values only through the generated codec boundary', async () => {
    const hash = `0x${'a'.repeat(64)}`
    const app = harness({ result: hash })
    await expect(app.service.invoke({
      toolName: 'workflow.chain.wallet.send_transaction',
      arguments: { to: matchingWallet, credential: { type: 'inline', secret: privateKey } },
    })).resolves.toBe(hash)
  })
})
