import { describe, expect, expectTypeOf, it } from 'vitest'

import type { RepositoryActivityClient } from '../../../src/core/repository/client.js'
import { encodeRepositoryCursor } from '../../../src/core/repository/cursor.js'
import type { RepositoryResolver } from '../../../src/core/repository/resolver.js'
import {
  createRepositoryService,
  type RepositoryActivityInput,
  type RepositoryActivityResult,
} from '../../../src/core/repository/service.js'
import type {
  ActivityWindow,
  RepositoryCommit,
  RepositoryCredential,
  RepositoryIssue,
  RepositoryPage,
  RepositoryPullRequest,
  RepositorySource,
} from '../../../src/core/repository/types.js'
import type { ChainSelector } from '../../../src/core/profile/types.js'

const profileBlockHash = `0x${'a'.repeat(64)}` as const
const alternateBlockHash = `0x${'b'.repeat(64)}` as const
const secret = 'repository-operation-secret'

function repository(overrides: Partial<RepositorySource> = {}): RepositorySource {
  return {
    provider: 'github',
    locator: 'https://github.com/trustless-ai/tawg-demo',
    owner: 'trustless-ai',
    repository: 'tawg-demo',
    profile: { blockNumber: '42', blockHash: profileBlockHash, version: '3' },
    charter: { commit: 'c'.repeat(40), path: 'charter/' },
    ...overrides,
  }
}

class RecordingResolver implements RepositoryResolver {
  readonly selectors: ChainSelector[] = []
  source = repository()

  async resolve(selector: ChainSelector): Promise<RepositorySource> {
    this.selectors.push(selector)
    return this.source
  }
}

interface ActivityCall {
  readonly kind: 'issue' | 'pull_request' | 'commit'
  readonly source: RepositorySource
  readonly window: ActivityWindow
  readonly authenticated: boolean
}

class RecordingActivityClient implements RepositoryActivityClient {
  readonly calls: ActivityCall[] = []
  issuePage: RepositoryPage<RepositoryIssue> = { items: [] }
  pullRequestPage: RepositoryPage<RepositoryIssue> = { items: [] }
  commitPage: RepositoryPage<RepositoryCommit> = { items: [] }

  async listIssues(source: RepositorySource, window: ActivityWindow, credential?: RepositoryCredential) {
    this.calls.push({ kind: 'issue', source, window, authenticated: credential !== undefined })
    return this.issuePage
  }

  async listPullRequests(source: RepositorySource, window: ActivityWindow, credential?: RepositoryCredential) {
    this.calls.push({ kind: 'pull_request', source, window, authenticated: credential !== undefined })
    return this.pullRequestPage
  }

  async listCommits(source: RepositorySource, window: ActivityWindow, credential?: RepositoryCredential) {
    this.calls.push({ kind: 'commit', source, window, authenticated: credential !== undefined })
    return this.commitPage
  }
}

function clock(value = '2026-08-23T03:00:00.987Z') {
  let calls = 0
  return {
    now: () => {
      calls += 1
      return new Date(value)
    },
    calls: () => calls,
  }
}

function setup(clockValue?: string) {
  const resolver = new RecordingResolver()
  const client = new RecordingActivityClient()
  const time = clock(clockValue)
  return { resolver, client, time, service: createRepositoryService(resolver, client, time.now) }
}

function cursor(overrides: Partial<Parameters<typeof encodeRepositoryCursor>[0]> = {}): string {
  return encodeRepositoryCursor({
    version: 1,
    tool: 'repo.issue.list',
    repository: repository().locator,
    profileBlockHash,
    since: '2026-08-23T01:00:00Z',
    observedAt: '2026-08-23T03:00:00Z',
    order: 'newest_first',
    providerPage: 4,
    providerOffset: 9,
    ...overrides,
  })
}

describe('RepositoryService first-page activity', () => {
  it('defaults to latest and limit 50, captures the clock once, and normalizes UTC seconds', async () => {
    const { resolver, client, time, service } = setup()

    const result = await service.listActivity({
      tool: 'repo.issue.list',
      since: '2026-08-23T09:00:00+08:00',
    })

    expect(time.calls()).toBe(1)
    expect(resolver.selectors).toEqual([{ kind: 'latest' }])
    expect(client.calls).toEqual([{
      kind: 'issue',
      source: repository(),
      window: {
        since: '2026-08-23T01:00:00Z', observedAt: '2026-08-23T03:00:00Z', limit: 50,
        providerPage: 1, providerOffset: 0,
      },
      authenticated: false,
    }])
    expect(result).toEqual({
      source: repository(),
      observedAt: '2026-08-23T03:00:00Z',
      items: [],
      page: { consistency: 'live' },
    })
  })

  it.each([1, 100])('accepts the inclusive activity limit boundary %s', async (limit) => {
    const { service, client } = setup()

    await service.listActivity({ tool: 'repo.issue.list', since: '2026-08-23T01:00:00Z', limit })

    expect(client.calls[0]?.window.limit).toBe(limit)
  })

  it.each([0, 101, 1.5, Number.NaN])('rejects invalid activity limit %s', async (limit) => {
    const { service, client } = setup()

    await expect(service.listActivity({ tool: 'repo.issue.list', since: '2026-08-23T01:00:00Z', limit }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(client.calls).toEqual([])
  })

  it.each([
    'not-a-time',
    '2026-02-30T01:00:00Z',
    '2026-08-23 01:00:00Z',
    '2026-08-23T03:00:01Z',
    '0000-01-01T00:00:00+00:01',
    '9999-12-31T23:59:59-00:01',
  ])('rejects malformed or post-observation since time %s', async (since) => {
    const { service, client } = setup()

    await expect(service.listActivity({ tool: 'repo.issue.list', since }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(client.calls).toEqual([])
  })

  it.each([
    ['repo.issue.list', 'issue'],
    ['repo.pull_request.list', 'pull_request'],
    ['repo.commit.list', 'commit'],
  ] as const)('dispatches %s only to the matching provider port', async (tool, kind) => {
    const { service, client } = setup()

    await service.listActivity({ tool, since: '2026-08-23T01:00:00Z' })

    expect(client.calls.map((call) => call.kind)).toEqual([kind])
  })

  it('binds each literal tool to its corresponding result item type', async () => {
    const { service } = setup()

    const issues = await service.listActivity({ tool: 'repo.issue.list', since: '2026-08-23T01:00:00Z' })
    const pullRequests = await service.listActivity({ tool: 'repo.pull_request.list', since: '2026-08-23T01:00:00Z' })
    const commits = await service.listActivity({ tool: 'repo.commit.list', since: '2026-08-23T01:00:00Z' })

    expectTypeOf(issues).toEqualTypeOf<RepositoryActivityResult<RepositoryIssue>>()
    expectTypeOf(pullRequests).toEqualTypeOf<RepositoryActivityResult<RepositoryPullRequest>>()
    expectTypeOf(commits).toEqualTypeOf<RepositoryActivityResult<RepositoryCommit>>()
  })

  it('returns a next cursor only when the provider returns a next position', async () => {
    const { service, client } = setup()
    client.issuePage = { items: [], nextPosition: { providerPage: 2, providerOffset: 7 } }

    const result = await service.listActivity({ tool: 'repo.issue.list', since: '2026-08-23T01:00:00Z' })

    expect(result.page).toEqual({ consistency: 'live', nextCursor: expect.any(String) })
    expect(result.page.nextCursor).toBe(cursor({ providerPage: 2, providerOffset: 7 }))
  })
})

describe('RepositoryService cursor activity', () => {
  it('decodes first, re-resolves the exact Profile block, and reuses observation and provider position', async () => {
    const { service, resolver, client, time } = setup('2026-08-23T04:00:00Z')

    const result = await service.listActivity({
      tool: 'repo.issue.list',
      since: '2026-08-23T01:00:00Z',
      cursor: cursor(),
      limit: 25,
    })

    expect(time.calls()).toBe(1)
    expect(resolver.selectors).toEqual([{ kind: 'block_hash', blockHash: profileBlockHash }])
    expect(client.calls[0]?.window).toEqual({
      since: '2026-08-23T01:00:00Z', observedAt: '2026-08-23T03:00:00Z', limit: 25,
      providerPage: 4, providerOffset: 9,
    })
    expect(result.observedAt).toBe('2026-08-23T03:00:00Z')
  })

  it('rejects an explicit selector on a cursor page after cursor decoding and before resolution', async () => {
    const { service, resolver } = setup()

    await expect(service.listActivity({
      tool: 'repo.issue.list', since: '2026-08-23T01:00:00Z', cursor: cursor(), selector: { kind: 'safe' },
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(resolver.selectors).toEqual([])

    await expect(service.listActivity({
      tool: 'repo.issue.list', since: '2026-08-23T01:00:00Z', cursor: 'not-a-cursor', selector: { kind: 'safe' },
    })).rejects.toMatchObject({ code: 'REPOSITORY_CURSOR_INVALID' })
  })

  it('decodes a cursor before validating other cursor-page arguments', async () => {
    const { service, resolver, client } = setup()

    await expect(service.listActivity({
      tool: 'repo.issue.list', since: 'not-a-time', cursor: 'not-a-cursor', limit: 0,
    })).rejects.toMatchObject({ code: 'REPOSITORY_CURSOR_INVALID' })
    expect(resolver.selectors).toEqual([])
    expect(client.calls).toEqual([])
  })

  it('rejects an offset time that normalizes beyond the four-digit UTC year before resolution', async () => {
    const { service, resolver, client } = setup('9999-12-31T23:59:59Z')
    const upperCursor = cursor({
      since: '9999-12-31T23:59:59Z',
      observedAt: '9999-12-31T23:59:59Z',
    })

    await expect(service.listActivity({
      tool: 'repo.issue.list',
      since: '9999-12-31T23:59:59-00:01',
      cursor: upperCursor,
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(resolver.selectors).toEqual([])
    expect(client.calls).toEqual([])
  })

  it.each([
    ['changed since', { since: '2026-08-23T01:00:01Z' }, undefined],
    ['changed tool', { since: '2026-08-23T01:00:00Z', tool: 'repo.commit.list' as const }, undefined],
    ['changed Repository', { since: '2026-08-23T01:00:00Z' }, repository({
      locator: 'https://github.com/trustless-ai/other', owner: 'trustless-ai', repository: 'other',
    })],
    ['changed Profile block', { since: '2026-08-23T01:00:00Z' }, repository({
      profile: { blockNumber: '43', blockHash: alternateBlockHash, version: '4' },
    })],
  ])('rejects %s as an exact cursor context mismatch', async (_description, inputOverrides, changedSource) => {
    const { service, resolver, client } = setup()
    if (changedSource) resolver.source = changedSource
    const input: RepositoryActivityInput = {
      tool: 'repo.issue.list', cursor: cursor(),
      ...inputOverrides,
    }

    await expect(service.listActivity(input)).rejects.toMatchObject({ code: 'REPOSITORY_CURSOR_CONTEXT_MISMATCH' })
    expect(client.calls).toEqual([])
  })

  it('passes an inline credential once but excludes it from the result and cursor', async () => {
    const { service, client } = setup()
    client.issuePage = { items: [], nextPosition: { providerPage: 2, providerOffset: 0 } }

    const result = await service.listActivity({
      tool: 'repo.issue.list', since: '2026-08-23T01:00:00Z',
      credential: { type: 'inline', secret },
    })

    expect(client.calls[0]?.authenticated).toBe(true)
    expect(JSON.stringify(client.calls)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain(secret)
  })
})

describe('RepositoryService discovery', () => {
  it('returns the exact Repository Resolver source without calling the provider', async () => {
    const { service, resolver, client } = setup()

    await expect(service.getRepository({ kind: 'finalized' })).resolves.toEqual(repository())
    expect(resolver.selectors).toEqual([{ kind: 'finalized' }])
    expect(client.calls).toEqual([])
  })
})
