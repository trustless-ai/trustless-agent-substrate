import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { MemberTasConfig, ResolvedTasConfig } from '../../../src/local/config/types.js'
import { memberInstancePath } from '../../../src/local/instance/paths.js'

const root = '/var/lib/tas'
const tawgAddress = '0xAbCdEf0123456789aBCdEf0123456789AbCdEf01' as const
const agentId = '340282366920938463463374607431768211457' as const

function memberConfig(overrides: Partial<MemberTasConfig> = {}): MemberTasConfig {
  return {
    configVersion: 1,
    mode: 'member',
    instance: { chainId: '11155111', tawgAddress, agentId },
    chain: { family: 'evm', rpcUrl: 'https://rpc.example', rpcSource: 'config' },
    repository: { client: 'github' },
    da: { client: 'git' },
    chat: { sources: [], targets: [] },
    proofProviders: [],
    ...overrides,
  }
}

describe('memberInstancePath', () => {
  it('uses only the canonical public member identity tuple', () => {
    const identity = memberConfig()

    expect(memberInstancePath(root, identity)).toBe(
      join(root, 'instances', 'eip155-11155111-0xabcdef0123456789abcdef0123456789abcdef01', 'agents', agentId),
    )
  })

  it('preserves a uint256 agent ID as its canonical decimal string', () => {
    const enormousAgentId = '115792089237316195423570985008687907853269984665640564039457584007913129639935'

    expect(memberInstancePath(root, memberConfig({
      instance: { chainId: '1', tawgAddress, agentId: enormousAgentId },
    }))).toBe(
      join(root, 'instances', 'eip155-1-0xabcdef0123456789abcdef0123456789abcdef01', 'agents', enormousAgentId),
    )
  })

  it('does not let host-local IDs, wallets, repositories, RPC URLs, or secrets affect the path', () => {
    const publicIdentity = memberConfig()
    const contaminated = {
      ...memberConfig({
        chain: { family: 'evm', rpcUrl: 'https://rpc.example/other?token=secret', rpcSource: 'environment' },
      }),
      hostAgentId: 'host-agent-99',
      authenticationWallet: '0x9999999999999999999999999999999999999999',
      repositoryUrl: 'https://example.invalid/different/repository.git',
      privateKey: 'not-a-real-key',
    } as MemberTasConfig

    expect(memberInstancePath(root, contaminated)).toBe(memberInstancePath(root, publicIdentity))
  })

  it.each<ResolvedTasConfig>([
    {
      configVersion: 1,
      mode: 'identity_setup',
      identitySetup: { chainId: '11155111', identityRegistryAddress: tawgAddress },
      chain: { family: 'evm', rpcUrl: 'https://rpc.example', rpcSource: 'config' },
    },
    {
      configVersion: 1,
      mode: 'tawg_setup',
      tawgSetup: { chainId: '11155111', tawgAddress },
      chain: { family: 'evm', rpcUrl: 'https://rpc.example', rpcSource: 'config' },
    },
  ])('returns no member path or creates member state for %s mode', async (identity) => {
    const isolatedRoot = join(await mkdtemp(join(tmpdir(), 'tas-setup-path-')), 'missing-root')

    try {
      expect(memberInstancePath(isolatedRoot, identity)).toBeUndefined()
      expect(existsSync(isolatedRoot)).toBe(false)
    } finally {
      await rm(join(isolatedRoot, '..'), { force: true, recursive: true })
    }
  })
})
