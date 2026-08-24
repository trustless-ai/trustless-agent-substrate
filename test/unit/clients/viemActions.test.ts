import { describe, expect, it, vi } from 'vitest'

import { loadViemActionBindings } from '../../../src/clients/chain/viemActions.js'
import { TasError } from '../../../src/core/errors.js'
import { getManifestRegistry } from '../../../src/mcp/manifest/registry.js'
import type { GeneratedToolEntry, ManifestSourceProfile } from '../../../src/mcp/manifest/types.js'

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(TasError)
  expect((error as TasError).code).toBe(code)
}

describe('loadViemActionBindings', () => {
  it('binds every one of the 34 accepted Manifest members to an exact viem function', async () => {
    const registry = getManifestRegistry()
    const bindings = await loadViemActionBindings(registry)
    const entries = [...registry.list('viem-public'), ...registry.list('viem-wallet')]

    expect(entries).toHaveLength(34)
    for (const entry of entries) expect(bindings.get(entry)).toEqual(expect.any(Function))
  })

  it('refuses a registry other than the already validated process singleton', async () => {
    const registry = getManifestRegistry()
    const impostor = {
      list: (profile: ManifestSourceProfile) => registry.list(profile),
      get: (name: string) => registry.get(name),
    }

    await expect(loadViemActionBindings(impostor)).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'MANIFEST_BINDING_UNSUPPORTED')
      return true
    })
  })

  it('rejects unknown, cloned, or target-mismatched entries without property traversal fallback', async () => {
    const registry = getManifestRegistry()
    const bindings = await loadViemActionBindings(registry)
    const canonical = registry.get('workflow.chain.public.get_balance')!
    const cloned = { ...canonical }
    const mismatched = {
      ...canonical,
      binding: { kind: 'client_action', target: 'PublicActions.getBlockNumber' },
    } as GeneratedToolEntry

    for (const entry of [cloned, mismatched]) {
      expect(() => bindings.get(entry)).toThrowError(expect.objectContaining({
        code: 'MANIFEST_BINDING_UNSUPPORTED',
      }))
    }
  })

  it('constructs a local account from an exact private key without retaining the key on bindings', async () => {
    const bindings = await loadViemActionBindings(getManifestRegistry())
    const privateKey = `0x${'0'.repeat(63)}1` as const
    const account = bindings.accountFromPrivateKey(privateKey)

    expect(account.address).toBe('0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf')
    expect(JSON.stringify(bindings)).not.toContain(privateKey)
  })

  it('invokes a bound member with the viem action(client, parameters) convention', async () => {
    const registry = getManifestRegistry()
    const bindings = await loadViemActionBindings(registry)
    const action = bindings.get(registry.get('workflow.chain.public.get_block_number')!)
    const request = vi.fn(async () => '0x2a')

    await expect(action({ request }, {})).resolves.toBe(42n)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith({ method: 'eth_blockNumber' })
  })
})
