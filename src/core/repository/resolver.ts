import { TasError } from '../errors.js'
import type { ProfileResolver } from '../profile/resolver.js'
import type { ChainSelector } from '../profile/types.js'
import { parseGitHubLocator } from './locator.js'
import type { RepositorySource } from './types.js'

const fullCommit = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const exactBlockHash = /^0x[0-9a-fA-F]{64}$/

export interface RepositoryResolver {
  resolve(selector: ChainSelector, options?: { readonly signal?: AbortSignal }): Promise<RepositorySource>
}

function inconsistent(): never {
  throw new TasError(
    'PROFILE_INCONSISTENT',
    'The selected TAWG Profile state is inconsistent.',
  )
}

function requireBlockHash(value: string): `0x${string}` {
  return exactBlockHash.test(value) ? value as `0x${string}` : inconsistent()
}

export function createRepositoryResolver(
  profileResolver: Pick<ProfileResolver, 'get'>,
): RepositoryResolver {
  return {
    async resolve(selector: ChainSelector, options?: { readonly signal?: AbortSignal }): Promise<RepositorySource> {
      const resolved = options === undefined
        ? await profileResolver.get(selector)
        : await profileResolver.get(selector, options)
      const repository = resolved.data.charter.repository
      const commit = resolved.data.charter.commit
      const path = resolved.data.charter.path

      if (typeof repository !== 'string') return inconsistent()
      const locator = parseGitHubLocator(repository)
      if (typeof commit !== 'string' || !fullCommit.test(commit) || path !== 'charter/') {
        return inconsistent()
      }

      return {
        provider: 'github',
        locator: locator.locator,
        owner: locator.owner,
        repository: locator.repository,
        profile: {
          blockNumber: resolved.resolution.chain.block_number,
          blockHash: requireBlockHash(resolved.resolution.chain.block_hash),
          version: resolved.resolution.profile.version,
        },
        charter: { commit, path },
      }
    },
  }
}
