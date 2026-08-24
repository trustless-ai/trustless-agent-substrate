import { describe, expect, it } from 'vitest'

import { TasError } from '../../../src/core/errors.js'
import type { ProfileReader } from '../../../src/core/profile/reader.js'
import { ProfileResolver, type ProfileProjection, type ResolvedProfile } from '../../../src/core/profile/resolver.js'
import type { ChainSelector, ProfileSnapshot } from '../../../src/core/profile/types.js'
import { createRepositoryResolver } from '../../../src/core/repository/resolver.js'

const profileHash = `0x${'a'.repeat(64)}` as const
const charterCommit40 = 'b'.repeat(40)
const charterCommit64 = 'c'.repeat(64)
const selector = { kind: 'block_hash', blockHash: profileHash } as const

function profile(overrides: {
  readonly repository?: string
  readonly commit?: string
  readonly path?: string
} = {}): ResolvedProfile<ProfileProjection> {
  return {
    data: {
      version: '19',
      governance: '0x2000000000000000000000000000000000000002',
      charter: {
        repository: overrides.repository ?? 'https://github.com/trustless-ai/tawg-demo',
        commit: overrides.commit ?? charterCommit40,
        path: overrides.path ?? 'charter/',
      },
      agents: {},
      data: {},
      workflow: {},
    },
    resolution: {
      chain: { block_number: '9007199254740993123456789', block_hash: profileHash },
      profile: { version: '19' },
    },
  } as ResolvedProfile<ProfileProjection>
}

function fakeProfileResolver(
  resolved: ResolvedProfile<ProfileProjection> = profile(),
): {
  readonly port: { get(selector?: ChainSelector): Promise<ResolvedProfile<ProfileProjection>> }
  readonly selectors: ChainSelector[]
} {
  const selectors: ChainSelector[] = []
  return {
    selectors,
    port: {
      get: async (selected = { kind: 'latest' }) => {
        selectors.push(selected)
        return resolved
      },
    },
  }
}

describe('RepositoryResolver', () => {
  it.each([charterCommit40, charterCommit64])('derives one immutable Repository source from the exact Profile snapshot using a full commit: %s', async (commit) => {
    const fake = fakeProfileResolver(profile({ commit }))
    const repositoryResolver = createRepositoryResolver(fake.port)

    await expect(repositoryResolver.resolve(selector)).resolves.toEqual({
      provider: 'github',
      locator: 'https://github.com/trustless-ai/tawg-demo',
      owner: 'trustless-ai',
      repository: 'tawg-demo',
      profile: {
        blockNumber: '9007199254740993123456789',
        blockHash: profileHash,
        version: '19',
      },
      charter: { commit, path: 'charter/' },
    })
    expect(fake.selectors).toEqual([selector])
  })

  it('ignores extra caller data instead of allowing a Repository override', async () => {
    const fake = fakeProfileResolver()
    const resolveWithUntrustedExtraArguments = createRepositoryResolver(fake.port).resolve as (
      selected: ChainSelector,
      untrusted: unknown,
    ) => Promise<unknown>

    const result = await resolveWithUntrustedExtraArguments(
      { kind: 'latest' },
      { repository: 'https://github.com/attacker/override', owner: 'attacker' },
    )

    expect(result).toMatchObject({
      locator: 'https://github.com/trustless-ai/tawg-demo',
      owner: 'trustless-ai',
      repository: 'tawg-demo',
    })
    expect(fake.selectors).toEqual([{ kind: 'latest' }])
  })

  it.each([
    'http://github.com/trustless-ai/tawg-demo',
    'https://github.com/trustless-ai/tawg-demo.git',
    'https://github.com/trustless-ai/tawg-demo/',
  ])('fails closed with the Repository locator error for an invalid projected locator: %s', async (repository) => {
    const repositoryResolver = createRepositoryResolver(fakeProfileResolver(profile({ repository })).port)

    await expect(repositoryResolver.resolve({ kind: 'latest' })).rejects.toMatchObject({
      code: 'REPOSITORY_LOCATOR_UNSUPPORTED',
    })
  })

  it('surfaces an unsupported provider locator through the real Profile-to-Repository composition', async () => {
    const rawProfile: ProfileSnapshot = {
      chainId: '31337',
      tawgAddress: '0x1000000000000000000000000000000000000001',
      blockNumber: '42',
      blockHash: profileHash,
      version: '19',
      governance: '0x2000000000000000000000000000000000000002',
      identityRegistry: '0x3000000000000000000000000000000000000003',
      charter: {
        repository: 'https://github.com/trustless-ai/tawg-demo.git',
        commitHash: charterCommit40,
        path: 'charter/',
      },
      agentIds: [],
      dataEntries: [],
      workflow: {
        workflowAddress: '0x4000000000000000000000000000000000000004',
        data: '{}',
      },
    }
    const reader: ProfileReader = {
      readProfile: async () => rawProfile,
      readAgent: async () => { throw new Error('not used') },
    }
    const profileResolver = new ProfileResolver(reader, {
      chainId: '31337',
      tawgAddress: rawProfile.tawgAddress,
    })

    await expect(
      createRepositoryResolver(profileResolver).resolve({ kind: 'latest' }),
    ).rejects.toMatchObject<TasError>({ code: 'REPOSITORY_LOCATOR_UNSUPPORTED' })
  })

  it.each([
    ['abbreviated commit', { commit: 'b'.repeat(39) }],
    ['uppercase commit', { commit: 'B'.repeat(40) }],
    ['branch name', { commit: 'main' }],
    ['wrong Charter path', { path: 'charter' }],
  ])('fails closed when the Profile projection has an invalid %s', async (_description, overrides) => {
    const repositoryResolver = createRepositoryResolver(fakeProfileResolver(profile(overrides)).port)

    await expect(repositoryResolver.resolve({ kind: 'latest' })).rejects.toMatchObject({
      code: 'PROFILE_INCONSISTENT',
    })
  })

  it('preserves the original Profile read error and stable code', async () => {
    const original = new TasError(
      'HISTORICAL_STATE_UNAVAILABLE',
      'The selected Profile history is unavailable.',
    )
    const port = {
      get: async (_selected?: ChainSelector): Promise<ResolvedProfile<ProfileProjection>> => {
        throw original
      },
    }
    const repositoryResolver = createRepositoryResolver(port)

    await expect(repositoryResolver.resolve(selector)).rejects.toBe(original)
  })
})
