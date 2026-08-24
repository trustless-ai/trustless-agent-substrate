import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { createGitHubRequest } from '../../src/clients/repository/githubRequest.js'
import { createGitHubRepositoryClient } from '../../src/clients/repository/githubRepositoryClient.js'
import { TasError } from '../../src/core/errors.js'
import type { ActivityWindow, RepositoryCredential, RepositorySource } from '../../src/core/repository/types.js'
import { RecordingGitHubRequest } from '../fixtures/repository/github.js'

const source: RepositorySource = {
  provider: 'github',
  locator: 'https://github.com/trustless-ai/tawg-demo',
  owner: 'trustless-ai',
  repository: 'tawg-demo',
  profile: { blockNumber: '42', blockHash: `0x${'a'.repeat(64)}`, version: '3' },
  charter: { commit: 'b'.repeat(40), path: 'charter/' },
}
const window: ActivityWindow = {
  since: '2026-08-23T01:00:00Z',
  observedAt: '2026-08-23T03:00:00Z',
  limit: 50,
  providerPage: 1,
  providerOffset: 0,
}
const apiHeaders = { 'x-github-api-version': '2026-03-10' }

function issue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    node_id: 'I_kwDOopaque',
    id: 9_007_199_254_740_991,
    number: 7,
    title: 'Contribution proposal',
    state: 'open',
    user: { login: 'alice' },
    created_at: '2026-08-23T02:00:00Z',
    updated_at: '2026-08-23T02:30:00Z',
    html_url: 'https://github.com/trustless-ai/tawg-demo/issues/7',
    ...overrides,
  }
}

function commit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sha: 'c'.repeat(40),
    commit: {
      message: 'Implement contribution flow',
      author: { name: 'Alice' },
      committer: { date: '2026-08-23T02:00:00Z' },
    },
    author: { login: 'alice' },
    html_url: 'https://github.com/trustless-ai/tawg-demo/commit/example',
    ...overrides,
  }
}

function expectTasCode(operation: Promise<unknown>, code: string): Promise<void> {
  return expect(operation).rejects.toMatchObject({ name: 'TasError', code })
}

describe('GitHub request authentication boundary', () => {
  it('configures unauthenticated defaults once and adds authorization only to the credentialed call', async () => {
    const defaults: unknown[] = []
    const calls: Array<{ authenticated: boolean; version: unknown }> = []
    const configured = async <T>(_route: string, parameters: Readonly<Record<string, unknown>> = {}) => {
      const headers = parameters.headers as Readonly<Record<string, unknown>>
      const authenticated = Object.hasOwn(headers, 'authorization')
      if (authenticated && headers.authorization !== 'Bearer operation-secret') throw new Error('wrong authorization')
      calls.push({ authenticated, version: headers['x-github-api-version'] })
      return { data: {} as T, headers: {} }
    }
    const base = Object.assign(configured, {
      defaults: (value: unknown) => {
        defaults.push(value)
        return base
      },
    })
    const providerFetch = async () => new Response('{}', {
      headers: { 'content-type': 'application/json' },
    })
    const adapter = createGitHubRequest(base, providerFetch)

    await adapter.request('GET /example', { headers: apiHeaders }, { type: 'inline', secret: 'operation-secret' })
    await adapter.request('GET /example', { headers: apiHeaders })

    expect(defaults).toHaveLength(1)
    expect(defaults[0]).toMatchObject({
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': '@trustless-ai/tas/0.1',
        'x-github-api-version': '2026-03-10',
      },
      request: { fetch: expect.any(Function) },
    })
    expect(calls).toEqual([
      { authenticated: true, version: '2026-03-10' },
      { authenticated: false, version: '2026-03-10' },
    ])
    expect(JSON.stringify(defaults)).not.toContain('operation-secret')
    expect(JSON.stringify(calls)).not.toContain('operation-secret')
  })

  it('rejects a chunked Provider response above the fixed byte limit before Octokit parses it', async () => {
    const defaults: unknown[] = []
    const configured = async <T>() => ({ data: {} as T, headers: {} })
    const base = Object.assign(configured, {
      defaults: (value: unknown) => {
        defaults.push(value)
        return base
      },
    })
    createGitHubRequest(
      base,
      async () => new Response('x'.repeat(2_097_153), { headers: { 'content-type': 'application/json' } }),
    )
    const options = defaults[0] as { request: { fetch: typeof fetch } }

    await expect(options.request.fetch('https://api.github.com/example')).rejects.toThrow(
      'GitHub response exceeded the TAS byte limit.',
    )
  })
})

describe('GitHub Repository issue and Pull Request activity', () => {
  it('queries the versioned Issue endpoint and keeps the inclusive window by source-native ID', async () => {
    const transport = new RecordingGitHubRequest()
    transport.enqueue([
      issue({ node_id: 'future', created_at: '2026-08-23T03:00:01Z' }),
      issue({ node_id: 'upper', number: 8, user: null, created_at: '2026-08-23T03:00:00Z' }),
      issue({ node_id: 'pr', pull_request: {}, created_at: '2026-08-23T02:00:00Z' }),
      issue({ node_id: 'lower', number: 6, created_at: '2026-08-23T01:00:00Z' }),
      issue({ node_id: 'old', created_at: '2026-08-23T00:59:59Z' }),
    ])
    const client = createGitHubRepositoryClient(transport, () => new Date('2026-08-23T03:00:00Z'))

    const result = await client.listIssues(source, window)

    expect(result).toEqual({
      items: [
        {
          id: 'upper', number: '8', title: 'Contribution proposal', state: 'open', author: null,
          createdAt: '2026-08-23T03:00:00Z', updatedAt: '2026-08-23T02:30:00Z',
          url: 'https://github.com/trustless-ai/tawg-demo/issues/7',
        },
        {
          id: 'lower', number: '6', title: 'Contribution proposal', state: 'open', author: 'alice',
          createdAt: '2026-08-23T01:00:00Z', updatedAt: '2026-08-23T02:30:00Z',
          url: 'https://github.com/trustless-ai/tawg-demo/issues/7',
        },
      ],
    })
    expect(transport.calls).toEqual([{
      route: 'GET /repos/{owner}/{repo}/issues',
      parameters: {
        owner: 'trustless-ai', repo: 'tawg-demo', state: 'all', sort: 'created', direction: 'desc',
        since: '2026-08-23T00:59:59Z', per_page: 100, page: 1, headers: apiHeaders,
      },
      authenticated: false,
    }])
  })

  it('preserves a raw provider offset when a Pull Request result fills the page', async () => {
    const transport = new RecordingGitHubRequest()
    transport.enqueue([
      issue({ node_id: 'skipped', number: 10 }),
      issue({ node_id: 'selected-pr', number: 9, pull_request: {} }),
      issue({ node_id: 'plain-issue', number: 8 }),
      issue({ node_id: 'later-pr', number: 7, pull_request: {} }),
    ], { link: '<https://api.github.com/page=2>; rel="next"' })
    const client = createGitHubRepositoryClient(transport, () => new Date())

    const result = await client.listPullRequests(source, { ...window, limit: 1, providerOffset: 1 })

    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ id: 'selected-pr', number: '9' })
    expect(result.nextPosition).toEqual({ providerPage: 1, providerOffset: 2 })
  })

  it('returns continuation after the 20-page bound even when every page is filtered out', async () => {
    const transport = new RecordingGitHubRequest()
    for (let page = 1; page <= 20; page += 1) {
      transport.enqueue([issue({ node_id: `issue-${page}` })], { link: '<https://api.github.com/next>; rel="next"' })
    }
    const client = createGitHubRepositoryClient(transport, () => new Date())

    const result = await client.listPullRequests(source, window)

    expect(result).toEqual({ items: [], nextPosition: { providerPage: 21, providerOffset: 0 } })
    expect(transport.calls).toHaveLength(20)
  })

  it('rejects a Provider continuation beyond the largest safe Issue page', async () => {
    const transport = new RecordingGitHubRequest()
    transport.enqueue([], { link: '<https://api.github.com/next>; rel="next"' })
    const client = createGitHubRepositoryClient(transport, () => new Date())

    await expectTasCode(
      client.listPullRequests(source, { ...window, providerPage: Number.MAX_SAFE_INTEGER }),
      'REPOSITORY_FETCH_FAILED',
    )
    expect(transport.calls).toHaveLength(1)
    expect(transport.calls[0]?.parameters.page).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('ends pagination when a later provider page crosses below the inclusive boundary', async () => {
    const transport = new RecordingGitHubRequest()
    transport.enqueue([issue({ node_id: 'first-page' })], { link: '<https://api.github.com/page=2>; rel="next"' })
    transport.enqueue([issue({ node_id: 'old', created_at: '2026-08-23T00:59:59Z' })], { link: '<https://api.github.com/page=3>; rel="next"' })
    const client = createGitHubRepositoryClient(transport, () => new Date())

    const result = await client.listIssues(source, window)

    expect(result.items.map((item) => item.id)).toEqual(['first-page'])
    expect(result.nextPosition).toBeUndefined()
  })

  it.each([
    ['non-array body', {}],
    ['unsafe number', [issue({ number: Number.MAX_SAFE_INTEGER + 1 })]],
    ['missing node ID', [issue({ node_id: undefined })]],
    ['malformed date', [issue({ created_at: 'not-a-date' })]],
    ['invalid state', [issue({ state: 'merged' })]],
    ['invalid URL', [issue({ html_url: 'not-a-github-url' })]],
    ['more than one provider page', Array.from({ length: 101 }, (_, index) => issue({ node_id: `issue-${index}` }))],
    ['oversized opaque ID', [issue({ node_id: 'i'.repeat(513) })]],
    ['oversized title', [issue({ title: 't'.repeat(1_025) })]],
    ['oversized login', [issue({ user: { login: 'u'.repeat(257) } })]],
  ])('rejects malformed Issue provider data: %s', async (_description, body) => {
    const transport = new RecordingGitHubRequest()
    transport.enqueue(body)
    const client = createGitHubRepositoryClient(transport, () => new Date())

    await expectTasCode(client.listIssues(source, window), 'REPOSITORY_FETCH_FAILED')
  })
})

describe('GitHub Repository commit activity', () => {
  it('queries the default branch window, sorts newest first, and preserves duplicate live commits', async () => {
    const transport = new RecordingGitHubRequest()
    transport.enqueue([
      commit({ sha: 'd'.repeat(40), commit: { message: 'older', author: null, committer: { date: '2026-08-23T01:00:00Z' } }, author: null }),
      commit({ sha: 'c'.repeat(40), commit: { message: 'merge', author: { name: 'Merge Bot' }, committer: { date: '2026-08-23T03:00:00Z' } }, author: null }),
      commit({ sha: 'c'.repeat(40), commit: { message: 'merge', author: { name: 'Merge Bot' }, committer: { date: '2026-08-23T03:00:00Z' } }, author: null }),
    ])
    const client = createGitHubRepositoryClient(transport, () => new Date())

    const result = await client.listCommits(source, window)

    expect(result.items.map((item) => item.commit)).toEqual(['c'.repeat(40), 'c'.repeat(40), 'd'.repeat(40)])
    expect(result.items[0]).toMatchObject({ message: 'merge', authorName: 'Merge Bot', authorLogin: null, committedAt: '2026-08-23T03:00:00Z' })
    expect(result.items[2]).toMatchObject({ message: 'older', authorName: null, authorLogin: null, committedAt: '2026-08-23T01:00:00Z' })
    expect(transport.calls[0]?.parameters).toEqual({
      owner: 'trustless-ai', repo: 'tawg-demo', since: window.since, until: window.observedAt,
      per_page: 100, page: 1, headers: apiHeaders,
    })
    expect(transport.calls[0]?.parameters).not.toHaveProperty('sha')
  })

  it.each([
    ['abbreviated hash', [commit({ sha: 'abc123' })]],
    ['uppercase hash', [commit({ sha: 'C'.repeat(40) })]],
    ['malformed committed date', [commit({ commit: { message: 'bad', author: null, committer: { date: 'yesterday' } } })]],
    ['missing committer', [commit({ commit: { message: 'bad', author: null } })]],
    ['invalid URL', [commit({ html_url: 'not-a-github-url' })]],
    ['more than one provider page', Array.from({ length: 101 }, (_, index) => commit({ sha: index.toString(16).padStart(40, '0') }))],
    ['oversized message', [commit({ commit: { message: 'm'.repeat(65_537), author: null, committer: { date: '2026-08-23T02:00:00Z' } } })]],
    ['oversized author name', [commit({ commit: { message: 'ok', author: { name: 'n'.repeat(1_025) }, committer: { date: '2026-08-23T02:00:00Z' } } })]],
    ['oversized author login', [commit({ author: { login: 'u'.repeat(257) } })]],
  ])('rejects malformed commit provider data: %s', async (_description, body) => {
    const transport = new RecordingGitHubRequest()
    transport.enqueue(body)
    const client = createGitHubRepositoryClient(transport, () => new Date())

    await expectTasCode(client.listCommits(source, window), 'REPOSITORY_FETCH_FAILED')
  })

  it('continues commit scanning through a provider Link page', async () => {
    const transport = new RecordingGitHubRequest()
    transport.enqueue([commit({ sha: 'a'.repeat(40) })], { link: '<https://api.github.com/page=2>; rel="next"' })
    transport.enqueue([commit({ sha: 'b'.repeat(40), commit: { message: 'second', author: null, committer: { date: '2026-08-23T01:00:00Z' } } })])
    const client = createGitHubRepositoryClient(transport, () => new Date())

    const result = await client.listCommits(source, window)

    expect(result.items.map((item) => item.commit)).toEqual(['a'.repeat(40), 'b'.repeat(40)])
    expect(transport.calls.map((call) => call.parameters.page)).toEqual([1, 2])
  })

  it('ends commit pagination when a later provider page crosses below the inclusive boundary', async () => {
    const transport = new RecordingGitHubRequest()
    transport.enqueue([commit({ sha: 'a'.repeat(40) })], { link: '<https://api.github.com/page=2>; rel="next"' })
    transport.enqueue([commit({
      sha: 'b'.repeat(40),
      commit: { message: 'old', author: null, committer: { date: '2026-08-23T00:59:59Z' } },
    })], { link: '<https://api.github.com/page=3>; rel="next"' })
    const client = createGitHubRepositoryClient(transport, () => new Date())

    const result = await client.listCommits(source, window)

    expect(result.items.map((item) => item.commit)).toEqual(['a'.repeat(40)])
    expect(result.nextPosition).toBeUndefined()
  })

  it('rejects a Provider continuation beyond the largest safe commit page', async () => {
    const transport = new RecordingGitHubRequest()
    transport.enqueue([], { link: '<https://api.github.com/next>; rel="next"' })
    const client = createGitHubRepositoryClient(transport, () => new Date())

    await expectTasCode(
      client.listCommits(source, { ...window, providerPage: Number.MAX_SAFE_INTEGER }),
      'REPOSITORY_FETCH_FAILED',
    )
    expect(transport.calls).toHaveLength(1)
    expect(transport.calls[0]?.parameters.page).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe('GitHub Repository immutable content', () => {
  it('resolves the provider default branch to one full immutable commit', async () => {
    const transport = new RecordingGitHubRequest()
    transport.enqueue({ default_branch: 'main' })
    transport.enqueue({ sha: 'e'.repeat(64) })
    const client = createGitHubRepositoryClient(transport, () => new Date())

    await expect(client.resolveDefaultHead(source)).resolves.toBe('e'.repeat(64))
    expect(transport.calls.map(({ route, parameters }) => ({ route, parameters }))).toEqual([
      {
        route: 'GET /repos/{owner}/{repo}',
        parameters: { owner: 'trustless-ai', repo: 'tawg-demo', headers: apiHeaders },
      },
      {
        route: 'GET /repos/{owner}/{repo}/commits/{ref}',
        parameters: { owner: 'trustless-ai', repo: 'tawg-demo', ref: 'main', headers: apiHeaders },
      },
    ])
  })

  it('reads a strict base64 file at the requested full commit and verifies provider size and path', async () => {
    const transport = new RecordingGitHubRequest()
    const bytes = Buffer.from('---\nname: contributor\n---\n', 'utf8')
    const content = bytes.toString('base64').replace(/(.{12})/g, '$1\n')
    transport.enqueue({ type: 'file', encoding: 'base64', content, size: bytes.length, path: 'skills/roles/contributor.md' })
    const client = createGitHubRepositoryClient(transport, () => new Date())

    const result = await client.readFile(source, 'f'.repeat(40), 'skills/roles/contributor.md')

    expect(result).toEqual({ path: 'skills/roles/contributor.md', commit: 'f'.repeat(40), bytes })
    expect(transport.calls[0]?.parameters).toEqual({
      owner: 'trustless-ai', repo: 'tawg-demo', path: 'skills/roles/contributor.md', ref: 'f'.repeat(40), headers: apiHeaders,
    })
  })

  it('passes the caller cancellation signal through the provider request boundary', async () => {
    const transport = new RecordingGitHubRequest()
    const controller = new AbortController()
    transport.enqueue({
      type: 'file', encoding: 'base64', content: 'YQ==', size: 1, path: 'data/a.txt',
    })
    const client = createGitHubRepositoryClient(transport, () => new Date())

    await client.readFile(source, 'f'.repeat(40), 'data/a.txt', undefined, { signal: controller.signal })

    expect(transport.calls[0]?.parameters).toEqual({
      owner: 'trustless-ai',
      repo: 'tawg-demo',
      path: 'data/a.txt',
      ref: 'f'.repeat(40),
      headers: apiHeaders,
      request: { signal: controller.signal },
    })
  })

  it.each([
    ['directory', { type: 'dir', encoding: 'base64', content: '', size: 0, path: 'skills/roles/contributor.md' }],
    ['symlink', { type: 'symlink', encoding: 'base64', content: '', size: 0, path: 'skills/roles/contributor.md' }],
    ['submodule', { type: 'submodule', encoding: 'base64', content: '', size: 0, path: 'skills/roles/contributor.md' }],
    ['wrong encoding', { type: 'file', encoding: 'utf8', content: 'abc', size: 3, path: 'skills/roles/contributor.md' }],
    ['invalid base64', { type: 'file', encoding: 'base64', content: '*bad*', size: 3, path: 'skills/roles/contributor.md' }],
    ['size mismatch', { type: 'file', encoding: 'base64', content: 'YQ==', size: 2, path: 'skills/roles/contributor.md' }],
    ['wrong path', { type: 'file', encoding: 'base64', content: 'YQ==', size: 1, path: 'other.md' }],
    ['oversized', { type: 'file', encoding: 'base64', content: '', size: 1_048_577, path: 'skills/roles/contributor.md' }],
  ])('rejects an invalid file response: %s', async (_description, body) => {
    const transport = new RecordingGitHubRequest()
    transport.enqueue(body)
    const client = createGitHubRepositoryClient(transport, () => new Date())

    await expectTasCode(client.readFile(source, 'f'.repeat(40), 'skills/roles/contributor.md'), 'REPOSITORY_FETCH_FAILED')
  })

  it('accepts a file exactly at the fixed 1 MiB decoded boundary', async () => {
    const transport = new RecordingGitHubRequest()
    const bytes = Buffer.alloc(1_048_576, 0x61)
    transport.enqueue({
      type: 'file', encoding: 'base64', content: bytes.toString('base64'), size: bytes.length,
      path: 'skills/roles/contributor.md',
    })
    const client = createGitHubRepositoryClient(transport, () => new Date())

    const result = await client.readFile(source, 'f'.repeat(40), 'skills/roles/contributor.md')

    expect(result.bytes).toHaveLength(1_048_576)
  })
})

describe('GitHub Repository credentials and errors', () => {
  it('passes one credential by reference without retaining or recording its secret', async () => {
    const secret = 'github-private-repository-token'
    const credential: RepositoryCredential = { type: 'inline', secret }
    const transport = new RecordingGitHubRequest()
    transport.enqueue([])
    transport.enqueue([])
    const client = createGitHubRepositoryClient(transport, () => new Date())

    await client.listIssues(source, window, credential)
    await client.listIssues(source, window)

    expect(transport.calls.map((call) => call.authenticated)).toEqual([true, false])
    expect(JSON.stringify(transport.calls)).not.toContain(secret)
    expect(JSON.stringify(client)).not.toContain(secret)
  })

  it.each([
    [401, {}, 'CREDENTIAL_REQUIRED'],
    [403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1787454000' }, 'REPOSITORY_RATE_LIMITED'],
    [429, { 'retry-after': '60' }, 'REPOSITORY_RATE_LIMITED'],
    [404, {}, 'REPOSITORY_NOT_FOUND'],
    [500, {}, 'REPOSITORY_FETCH_FAILED'],
  ])('maps GitHub HTTP %s without exposing provider details', async (status, headers, code) => {
    const transport = new RecordingGitHubRequest()
    transport.enqueueError({ status, response: { headers, data: { secret: 'provider-response-secret' } } })
    const client = createGitHubRepositoryClient(transport, () => new Date())

    const operation = client.listIssues(source, window)
    await expectTasCode(operation, code)
    await operation.catch((error: unknown) => {
      expect(String(error)).not.toContain('provider-response-secret')
    })
  })

  it('maps transport failures to one generic Repository fetch error', async () => {
    const transport = new RecordingGitHubRequest()
    transport.enqueueError(new Error('network secret detail'))
    const client = createGitHubRepositoryClient(transport, () => new Date())

    const operation = client.listIssues(source, window)
    await expectTasCode(operation, 'REPOSITORY_FETCH_FAILED')
  })

  it('fails closed when Provider error headers expose accessors instead of data', async () => {
    const headers = Object.defineProperty({}, 'x-ratelimit-remaining', {
      enumerable: true,
      get: () => { throw new Error('unsafe getter') },
    })
    const transport = new RecordingGitHubRequest()
    transport.enqueueError({ status: 403, response: { headers } })
    const client = createGitHubRepositoryClient(transport, () => new Date())

    await expectTasCode(client.listIssues(source, window), 'REPOSITORY_FETCH_FAILED')
  })

  it('ignores an accessor-backed Link header without invoking it', async () => {
    const headers = Object.defineProperty({}, 'link', {
      enumerable: true,
      get: () => { throw new Error('unsafe getter') },
    }) as Readonly<Record<string, string | undefined>>
    const transport = new RecordingGitHubRequest()
    transport.enqueue([], headers)
    const client = createGitHubRepositoryClient(transport, () => new Date())

    await expect(client.listIssues(source, window)).resolves.toEqual({ items: [] })
  })
})
