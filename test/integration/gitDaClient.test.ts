import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { createGitDaClient } from '../../src/clients/da/gitDaClient.js'
import { TasError } from '../../src/core/errors.js'
import type { RepositoryCredential, RepositorySource } from '../../src/core/repository/types.js'
import { RecordingGitHubRequest } from '../fixtures/repository/github.js'

const source: RepositorySource = {
  provider: 'github',
  locator: 'https://github.com/trustless-ai/tawg-demo',
  owner: 'trustless-ai',
  repository: 'tawg-demo',
  profile: { blockNumber: '42', blockHash: `0x${'a'.repeat(64)}`, version: '3' },
  charter: { commit: 'b'.repeat(40), path: 'charter/' },
}
const apiHeaders = { 'x-github-api-version': '2026-03-10' }
const head = '1'.repeat(40)
const baseTree = '2'.repeat(40)
const blob = '3'.repeat(40)
const nextTree = '4'.repeat(40)
const commit = '5'.repeat(40)

function expectTasCode(operation: Promise<unknown>, code: string): Promise<void> {
  return expect(operation).rejects.toMatchObject({ name: 'TasError', code })
}

describe('GitHub Git DA immutable reads', () => {
  it('reads exact bytes at the full commit and never substitutes a mutable ref', async () => {
    const transport = new RecordingGitHubRequest()
    const bytes = Buffer.from([0, 1, 2, 0xff])
    transport.enqueue({
      type: 'file', encoding: 'base64', content: bytes.toString('base64'), size: bytes.length,
      path: 'data/evidence/result.bin',
    })
    const client = createGitDaClient(transport)

    const result = await client.get(source, {
      type: 'git', commit: 'f'.repeat(40), path: 'data/evidence/result.bin',
    })

    expect([...result.bytes]).toEqual([...bytes])
    expect(transport.calls).toEqual([{
      route: 'GET /repos/{owner}/{repo}/contents/{path}',
      parameters: {
        owner: 'trustless-ai', repo: 'tawg-demo', path: 'data/evidence/result.bin',
        ref: 'f'.repeat(40), headers: apiHeaders,
      },
      authenticated: false,
    }])
  })

  it('passes one private Repository credential without retaining or recording it', async () => {
    const secret = 'github-private-da-token'
    const credential: RepositoryCredential = { type: 'inline', secret }
    const transport = new RecordingGitHubRequest()
    const body = { type: 'file', encoding: 'base64', content: 'YQ==', size: 1, path: 'data/a.txt' }
    transport.enqueue(body)
    transport.enqueue(body)
    const client = createGitDaClient(transport)

    await client.get(source, { type: 'git', commit: 'f'.repeat(40), path: 'data/a.txt' }, credential)
    await client.get(source, { type: 'git', commit: 'f'.repeat(40), path: 'data/a.txt' })

    expect(transport.calls.map((call) => call.authenticated)).toEqual([true, false])
    expect(JSON.stringify(transport.calls)).not.toContain(secret)
    expect(JSON.stringify(client)).not.toContain(secret)
  })

  it('passes one operation signal through the GitHub request boundary', async () => {
    const transport = new RecordingGitHubRequest()
    const controller = new AbortController()
    transport.enqueue({ type: 'file', encoding: 'base64', content: 'YQ==', size: 1, path: 'data/a.txt' })
    const client = createGitDaClient(transport)

    await client.get(
      source,
      { type: 'git', commit: 'f'.repeat(40), path: 'data/a.txt' },
      undefined,
      { signal: controller.signal },
    )

    expect(transport.calls[0]?.parameters).toMatchObject({ request: { signal: controller.signal } })
  })

  it.each([
    ['short commit', { type: 'git', commit: 'abc', path: 'data/a.txt' }],
    ['uppercase commit', { type: 'git', commit: 'F'.repeat(40), path: 'data/a.txt' }],
    ['path traversal', { type: 'git', commit: 'f'.repeat(40), path: 'data/../secret' }],
    ['outside data', { type: 'git', commit: 'f'.repeat(40), path: 'charter/README.md' }],
  ])('fails closed before the Provider request for an invalid reference: %s', async (_name, ref) => {
    const transport = new RecordingGitHubRequest()
    const client = createGitDaClient(transport)

    await expectTasCode(client.get(source, ref as never), 'DA_REFERENCE_INVALID')
    expect(transport.calls).toHaveLength(0)
  })

  it('rejects malformed or oversized Provider content without returning partial bytes', async () => {
    const transport = new RecordingGitHubRequest()
    transport.enqueue({ type: 'file', encoding: 'base64', content: 'YQ==', size: 2, path: 'data/a.txt' })
    const client = createGitDaClient(transport)

    await expectTasCode(
      client.get(source, { type: 'git', commit: 'f'.repeat(40), path: 'data/a.txt' }),
      'DA_FETCH_FAILED',
    )
  })

  it('distinguishes a Provider object above the inline limit from a malformed response', async () => {
    const transport = new RecordingGitHubRequest()
    transport.enqueue({
      type: 'file', encoding: 'base64', content: '', size: 1_048_577, path: 'data/large.bin',
    })
    const client = createGitDaClient(transport)

    await expectTasCode(
      client.get(source, { type: 'git', commit: 'f'.repeat(40), path: 'data/large.bin' }),
      'DA_CONTENT_TOO_LARGE',
    )
  })
})

describe('GitHub Git DA writes', () => {
  function enqueueSuccessfulWrite(transport: RecordingGitHubRequest): void {
    transport.enqueue({ default_branch: 'main' })
    transport.enqueue({ object: { sha: head } })
    transport.enqueue({ tree: { sha: baseTree } })
    transport.enqueue({ sha: blob })
    transport.enqueue({ sha: nextTree })
    transport.enqueue({ sha: commit })
    transport.enqueue({ object: { sha: commit } })
  }

  it('writes exact bytes on the observed head and returns the resulting immutable commit', async () => {
    const transport = new RecordingGitHubRequest()
    enqueueSuccessfulWrite(transport)
    const client = createGitDaClient(transport)
    const bytes = Buffer.from([0, 0xff, 10, 13])
    const credential: RepositoryCredential = { type: 'inline', secret: 'write-token' }

    const result = await client.put(source, 'data/evidence/result.bin', bytes, 'application/octet-stream', credential)

    expect(result).toEqual({ type: 'git', commit, path: 'data/evidence/result.bin' })
    expect(transport.calls.map(({ route }) => route)).toEqual([
      'GET /repos/{owner}/{repo}',
      'GET /repos/{owner}/{repo}/git/ref/{ref}',
      'GET /repos/{owner}/{repo}/git/commits/{commit_sha}',
      'POST /repos/{owner}/{repo}/git/blobs',
      'POST /repos/{owner}/{repo}/git/trees',
      'POST /repos/{owner}/{repo}/git/commits',
      'PATCH /repos/{owner}/{repo}/git/refs/{ref}',
    ])
    expect(transport.calls.every((call) => call.authenticated)).toBe(true)
    expect(transport.calls[3]?.parameters).toEqual({
      owner: 'trustless-ai', repo: 'tawg-demo', content: bytes.toString('base64'), encoding: 'base64', headers: apiHeaders,
    })
    expect(transport.calls[4]?.parameters).toEqual({
      owner: 'trustless-ai', repo: 'tawg-demo', base_tree: baseTree,
      tree: [{ path: 'data/evidence/result.bin', mode: '100644', type: 'blob', sha: blob }],
      headers: apiHeaders,
    })
    expect(transport.calls[5]?.parameters).toEqual({
      owner: 'trustless-ai', repo: 'tawg-demo', message: 'TAS DA: write data/evidence/result.bin',
      tree: nextTree, parents: [head], headers: apiHeaders,
    })
    expect(transport.calls[6]?.parameters).toEqual({
      owner: 'trustless-ai', repo: 'tawg-demo', ref: 'heads/main', sha: commit, force: false, headers: apiHeaders,
    })
  })

  it('uses one signal across every request in the multi-step write', async () => {
    const transport = new RecordingGitHubRequest()
    enqueueSuccessfulWrite(transport)
    const client = createGitDaClient(transport)
    const controller = new AbortController()

    await client.put(
      source,
      'data/a.txt',
      Buffer.from('a'),
      undefined,
      { type: 'inline', secret: 'token' },
      { signal: controller.signal },
    )

    expect(transport.calls).toHaveLength(7)
    expect(transport.calls.every((call) => (
      call.parameters.request as { signal?: AbortSignal } | undefined
    )?.signal === controller.signal)).toBe(true)
  })

  it('fails explicitly when the upstream head wins the compare-and-set race', async () => {
    const transport = new RecordingGitHubRequest()
    transport.enqueue({ default_branch: 'main' })
    transport.enqueue({ object: { sha: head } })
    transport.enqueue({ tree: { sha: baseTree } })
    transport.enqueue({ sha: blob })
    transport.enqueue({ sha: nextTree })
    transport.enqueue({ sha: commit })
    transport.enqueueError({ status: 422, response: { data: { message: 'Reference update failed', secret: 'provider-secret' } } })
    const client = createGitDaClient(transport)

    const operation = client.put(source, 'data/a.txt', Buffer.from('a'), 'text/plain', {
      type: 'inline', secret: 'caller-secret',
    })

    await expectTasCode(operation, 'RESOLUTION_CONFLICT')
    await operation.catch((error: unknown) => {
      expect(error).toBeInstanceOf(TasError)
      expect(JSON.stringify(error)).not.toContain('provider-secret')
      expect(JSON.stringify(error)).not.toContain('caller-secret')
    })
  })

  it('reports an unknown outcome when the ref-update response cannot establish whether the write landed', async () => {
    const transport = new RecordingGitHubRequest()
    transport.enqueue({ default_branch: 'main' })
    transport.enqueue({ object: { sha: head } })
    transport.enqueue({ tree: { sha: baseTree } })
    transport.enqueue({ sha: blob })
    transport.enqueue({ sha: nextTree })
    transport.enqueue({ sha: commit })
    transport.enqueueError({ status: 500, response: { data: { message: 'unknown' } } })
    const client = createGitDaClient(transport)

    await expectTasCode(
      client.put(source, 'data/a.txt', Buffer.from('a'), undefined, { type: 'inline', secret: 'token' }),
      'OPERATION_OUTCOME_UNKNOWN',
    )
  })

  it('reports an unknown outcome when cancellation races with the branch ref update', async () => {
    const controller = new AbortController()
    const responses: unknown[] = [
      { default_branch: 'main' },
      { object: { sha: head } },
      { tree: { sha: baseTree } },
      { sha: blob },
      { sha: nextTree },
      { sha: commit },
    ]
    const request = {
      async request<T>(route: string): Promise<{ data: T; headers: {} }> {
        if (route === 'PATCH /repos/{owner}/{repo}/git/refs/{ref}') {
          const reason = new DOMException('caller cancelled', 'AbortError')
          controller.abort(reason)
          throw reason
        }
        const data = responses.shift()
        if (data === undefined) throw new Error('unexpected request')
        return { data: data as T, headers: {} }
      },
    }
    const client = createGitDaClient(request)

    await expectTasCode(
      client.put(
        source,
        'data/a.txt',
        Buffer.from('a'),
        undefined,
        { type: 'inline', secret: 'token' },
        { signal: controller.signal },
      ),
      'OPERATION_OUTCOME_UNKNOWN',
    )
  })

  it('rejects invalid paths and oversized bytes before creating Git objects', async () => {
    const transport = new RecordingGitHubRequest()
    const client = createGitDaClient(transport)

    await expectTasCode(client.put(source, '../secret', Buffer.from('x'), undefined), 'DA_PATH_INVALID')
    await expectTasCode(
      client.put(source, 'data/large.bin', Buffer.alloc(1_048_577), undefined),
      'DA_CONTENT_TOO_LARGE',
    )
    expect(transport.calls).toHaveLength(0)
  })

  it.each(['@', '.hidden', 'release.lock', 'feature//unsafe', 'feature@{1'])(
    'rejects an invalid Provider default branch before creating Git objects: %s',
    async (branch) => {
      const transport = new RecordingGitHubRequest()
      transport.enqueue({ default_branch: branch })
      const client = createGitDaClient(transport)

      await expectTasCode(
        client.put(source, 'data/a.txt', Buffer.from('a'), undefined),
        'DA_WRITE_FAILED',
      )
      expect(transport.calls).toHaveLength(1)
    },
  )
})
