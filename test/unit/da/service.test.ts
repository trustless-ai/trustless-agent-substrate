import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import type { DaClient, DaClientContent } from '../../../src/core/da/client.js'
import { createDaService } from '../../../src/core/da/service.js'
import { TasError } from '../../../src/core/errors.js'
import type { ChainSelector } from '../../../src/core/profile/types.js'
import type { RepositoryResolver } from '../../../src/core/repository/resolver.js'
import type { RepositoryCredential, RepositorySource } from '../../../src/core/repository/types.js'
import type { GitDaPath, GitDaReference } from '../../../src/core/da/types.js'

const commit40 = 'a'.repeat(40)
const commit64 = 'b'.repeat(64)
const path = 'data/runs/42/result.bin' as const
const reference: GitDaReference = { type: 'git', commit: commit40, path }
const source: RepositorySource = {
  provider: 'github',
  locator: 'https://github.com/trustless-ai/demo-tawg',
  owner: 'trustless-ai',
  repository: 'demo-tawg',
  profile: {
    blockNumber: '42',
    blockHash: `0x${'c'.repeat(64)}`,
    version: '7',
  },
  charter: { commit: 'd'.repeat(40), path: 'charter/' },
}

interface GetCall {
  readonly source: RepositorySource
  readonly ref: GitDaReference
  readonly credential?: RepositoryCredential
}

interface PutCall {
  readonly source: RepositorySource
  readonly path: GitDaPath
  readonly bytes: Uint8Array
  readonly mediaType?: string
  readonly credential?: RepositoryCredential
}

class RecordingDaClient implements DaClient {
  readonly gets: GetCall[] = []
  readonly puts: PutCall[] = []
  getResult: DaClientContent = { bytes: new Uint8Array([0, 1, 2, 255]) }
  putResult: GitDaReference = { type: 'git', commit: commit64, path }
  getError?: Error
  putError?: Error

  capabilities() {
    return {
      backend: 'git',
      reference_types: ['git'],
      read: true,
      write: true,
      content_encodings: ['utf8', 'base64'],
      max_inline_bytes: 1_048_576,
    } as const
  }

  async get(
    requestedSource: RepositorySource,
    ref: GitDaReference,
    credential?: RepositoryCredential,
  ): Promise<DaClientContent> {
    this.gets.push({ source: requestedSource, ref, credential })
    if (this.getError) throw this.getError
    return this.getResult
  }

  async put(
    requestedSource: RepositorySource,
    requestedPath: GitDaPath,
    bytes: Uint8Array,
    mediaType?: string,
    credential?: RepositoryCredential,
  ): Promise<GitDaReference> {
    this.puts.push({ source: requestedSource, path: requestedPath, bytes, mediaType, credential })
    if (this.putError) throw this.putError
    return this.putResult
  }
}

function fixture() {
  const selectors: ChainSelector[] = []
  const resolver: RepositoryResolver = {
    resolve: async (selector) => {
      selectors.push(selector)
      return source
    },
  }
  const client = new RecordingDaClient()
  const service = createDaService(resolver, client)
  return { client, selectors, service }
}

function expectTasCode(operation: Promise<unknown>, code: string): Promise<void> {
  return expect(operation).rejects.toMatchObject({ name: 'TasError', code })
}

describe('DA capabilities', () => {
  it('reports the fixed effective Git DA interface and one MiB inline limit', async () => {
    const { service } = fixture()

    await expect(service.capabilities()).resolves.toEqual({
      backend: 'git',
      reference_types: ['git'],
      read: true,
      write: true,
      content_encodings: ['utf8', 'base64'],
      max_inline_bytes: 1_048_576,
    })
  })

  it('rejects a configured limit above the fixed Git client capability', () => {
    const resolver: RepositoryResolver = { resolve: async () => source }
    const client = new RecordingDaClient()

    expect(() => createDaService(resolver, client, { maxInlineBytes: 1_048_577 })).toThrowError(
      expect.objectContaining<TasError>({ code: 'INVALID_ARGUMENT' }),
    )
  })
})

describe('DA immutable get', () => {
  it('reads only the requested immutable commit and returns exact bytes as canonical base64', async () => {
    const { client, selectors, service } = fixture()
    const credential = { type: 'inline', secret: 'one-call-token' } as const
    const selector = { kind: 'safe' } as const
    client.getResult = {
      bytes: new Uint8Array([0, 0x7f, 0x80, 0xff]),
      mediaType: 'application/x.demo',
    }

    const result = await service.get({ ref: reference, selector, credential })

    expect(selectors).toEqual([selector])
    expect(client.gets).toEqual([{ source, ref: reference, credential }])
    expect(result).toEqual({
      source,
      ref: reference,
      content: {
        encoding: 'base64',
        value: 'AH+A/w==',
        media_type: 'application/x.demo',
      },
      size_bytes: 4,
    })
    expect(result.ref).not.toBe(reference)
  })

  it('defaults Profile selection to latest and omits an absent media type', async () => {
    const { selectors, service } = fixture()

    const result = await service.get({ ref: reference })

    expect(selectors).toEqual([{ kind: 'latest' }])
    expect(result.content).toEqual({ encoding: 'base64', value: 'AAEC/w==' })
  })

  it('rejects an oversized response without returning truncated content', async () => {
    const { client, service } = fixture()
    client.getResult = { bytes: new Uint8Array(1_048_577) }

    await expectTasCode(service.get({ ref: reference }), 'DA_CONTENT_TOO_LARGE')
  })

  it('never invokes Provider accessors while projecting returned bytes', async () => {
    const { client, service } = fixture()
    let getterCalls = 0
    const malicious = Object.create(null) as Record<string, unknown>
    Object.defineProperty(malicious, 'bytes', {
      enumerable: true,
      get: () => {
        getterCalls += 1
        return new Uint8Array(1_048_577)
      },
    })
    client.getResult = malicious as unknown as DaClientContent

    await expectTasCode(service.get({ ref: reference }), 'DA_FETCH_FAILED')
    expect(getterCalls).toBe(0)
  })

  it('ignores a shadowed typed-array byteLength accessor and uses the intrinsic length', async () => {
    const { client, service } = fixture()
    const bytes = new Uint8Array([1, 2, 3])
    Object.defineProperty(bytes, 'byteLength', {
      get: () => 0,
    })
    client.getResult = { bytes }

    await expect(service.get({ ref: reference })).resolves.toMatchObject({ size_bytes: 3 })
  })

  it('accepts Buffer and Uint8Array subclasses promised by the Client byte contract', async () => {
    const { client, service } = fixture()
    client.getResult = { bytes: Buffer.from([1, 2, 3]) }

    await expect(service.get({ ref: reference })).resolves.toMatchObject({
      size_bytes: 3,
      content: { encoding: 'base64', value: 'AQID' },
    })
  })

  it('bounds a Provider media type before projecting it into the response', async () => {
    const { client, service } = fixture()
    client.getResult = { bytes: new Uint8Array([1]), mediaType: 'x'.repeat(1_025) }

    await expectTasCode(service.get({ ref: reference }), 'DA_FETCH_FAILED')
  })

  it('validates the immutable reference before resolving the Profile-selected Repository', async () => {
    const { client, selectors, service } = fixture()

    await expectTasCode(service.get({
      ref: { type: 'git', commit: 'main', path } as GitDaReference,
    }), 'DA_REFERENCE_INVALID')
    expect(selectors).toEqual([])
    expect(client.gets).toEqual([])
  })
})

describe('DA put decoding', () => {
  it('strictly encodes UTF-8 and passes the media type and per-call credential through once', async () => {
    const { client, service } = fixture()
    const credential = { type: 'inline', secret: 'private-repository-token' } as const

    const result = await service.put({
      destination: { path },
      content: { encoding: 'utf8', value: 'Iñtërnâtiônàlizætiøn ☃', media_type: 'text/plain; charset=utf-8' },
      credential,
    })

    expect(client.puts).toHaveLength(1)
    expect(client.puts[0]).toMatchObject({
      source, path, mediaType: 'text/plain; charset=utf-8', credential,
    })
    expect(Buffer.from(client.puts[0]!.bytes).toString('hex')).toBe(
      Buffer.from('Iñtërnâtiônàlizætiøn ☃', 'utf8').toString('hex'),
    )
    expect(result).toEqual({ source, ref: { type: 'git', commit: commit64, path }, size_bytes: 31 })
    expect(Object.keys(result).sort()).toEqual(['ref', 'size_bytes', 'source'])
  })

  it('strictly decodes canonical base64 and preserves arbitrary bytes', async () => {
    const { client, service } = fixture()

    await service.put({
      destination: { path },
      content: { encoding: 'base64', value: 'AAD/gP8=' },
    })

    expect(client.puts[0]!.bytes).toEqual(new Uint8Array([0, 0, 255, 128, 255]))
  })

  it('rejects an oversized media type before resolving or writing', async () => {
    const { client, selectors, service } = fixture()

    await expectTasCode(service.put({
      destination: { path },
      content: { encoding: 'utf8', value: 'a', media_type: 'x'.repeat(1_025) },
    }), 'INVALID_ARGUMENT')
    expect(selectors).toEqual([])
    expect(client.puts).toEqual([])
  })

  it.each([
    ['invalid alphabet', 'ab-_'],
    ['ignored suffix', 'YQ==junk'],
    ['missing padding', 'YQ'],
    ['non-zero pad bits', 'YR=='],
  ])('rejects non-canonical base64 before any write: %s', async (_name, value) => {
    const { client, service } = fixture()

    await expectTasCode(service.put({
      destination: { path }, content: { encoding: 'base64', value },
    }), 'INVALID_ARGUMENT')
    expect(client.puts).toEqual([])
  })

  it('rejects a lone UTF-16 surrogate instead of silently replacing it during UTF-8 encoding', async () => {
    const { client, service } = fixture()

    await expectTasCode(service.put({
      destination: { path }, content: { encoding: 'utf8', value: '\ud800' },
    }), 'INVALID_ARGUMENT')
    expect(client.puts).toEqual([])
  })

  it('accepts exactly the inline limit and rejects one decoded byte more', async () => {
    const accepted = fixture()
    const rejected = fixture()

    await expect(accepted.service.put({
      destination: { path }, content: { encoding: 'utf8', value: 'x'.repeat(1_048_576) },
    })).resolves.toMatchObject({ size_bytes: 1_048_576 })
    await expectTasCode(rejected.service.put({
      destination: { path }, content: { encoding: 'utf8', value: 'x'.repeat(1_048_577) },
    }), 'DA_CONTENT_TOO_LARGE')
    expect(rejected.client.puts).toEqual([])
  })

  it.each([
    ['utf8', 'x'.repeat(100_000)],
    ['base64', 'eA=='.repeat(25_000)],
  ] as const)('rejects a far-oversized %s envelope before decoding or calling the Client', async (encoding, value) => {
    const client = new RecordingDaClient()
    const resolver: RepositoryResolver = { resolve: async () => source }
    const service = createDaService(resolver, client, { maxInlineBytes: 8 })

    await expectTasCode(service.put({ destination: { path }, content: { encoding, value } }), 'DA_CONTENT_TOO_LARGE')
    expect(client.puts).toEqual([])
  })

  it('rejects a missing or escaping Git destination before resolving the Repository', async () => {
    const missing = fixture()
    const escaping = fixture()

    await expectTasCode(missing.service.put({
      content: { encoding: 'utf8', value: 'result' },
    }), 'DA_PATH_INVALID')
    await expectTasCode(escaping.service.put({
      destination: { path: 'data/../secret' }, content: { encoding: 'utf8', value: 'result' },
    }), 'DA_PATH_INVALID')
    expect(missing.selectors).toEqual([])
    expect(escaping.selectors).toEqual([])
  })

  it('rejects a provider result that changes the requested path or returns a non-full commit', async () => {
    const changedPath = fixture()
    const mutableCommit = fixture()
    changedPath.client.putResult = { type: 'git', commit: commit64, path: 'data/other.bin' }
    mutableCommit.client.putResult = { type: 'git', commit: 'main', path }

    await expectTasCode(changedPath.service.put({
      destination: { path }, content: { encoding: 'utf8', value: 'result' },
    }), 'OPERATION_OUTCOME_UNKNOWN')
    await expectTasCode(mutableCommit.service.put({
      destination: { path }, content: { encoding: 'utf8', value: 'result' },
    }), 'OPERATION_OUTCOME_UNKNOWN')
  })
})

describe('DA provider errors and operation-scoped credentials', () => {
  it.each([
    ['get', 'CREDENTIAL_REQUIRED', 'CREDENTIAL_REQUIRED'],
    ['get', 'DA_UNAVAILABLE', 'DA_UNAVAILABLE'],
    ['get', 'REPOSITORY_FETCH_FAILED', 'DA_FETCH_FAILED'],
    ['put', 'AUTHORIZATION_DENIED', 'AUTHORIZATION_DENIED'],
    ['put', 'DA_UNAVAILABLE', 'DA_UNAVAILABLE'],
    ['put', 'RESOLUTION_CONFLICT', 'RESOLUTION_CONFLICT'],
    ['put', 'OPERATION_OUTCOME_UNKNOWN', 'OPERATION_OUTCOME_UNKNOWN'],
    ['put', 'REPOSITORY_RATE_LIMITED', 'OPERATION_OUTCOME_UNKNOWN'],
  ] as const)('maps a %s failure from %s to %s without exposing provider detail', async (operation, upstream, expected) => {
    const { client, service } = fixture()
    const error = new TasError(upstream, 'untrusted provider detail containing a token')
    if (operation === 'get') client.getError = error
    else client.putError = error

    const promise = operation === 'get'
      ? service.get({ ref: reference })
      : service.put({ destination: { path }, content: { encoding: 'utf8', value: 'result' } })

    await expectTasCode(promise, expected)
    await expect(promise).rejects.not.toMatchObject({ message: error.message })
  })

  it('uses each credential only for its own call and keeps no service-visible credential state', async () => {
    const { client, service } = fixture()
    const first = { type: 'inline', secret: 'first-token' } as const
    const second = { type: 'inline', secret: 'second-token' } as const

    await service.get({ ref: reference, credential: first })
    await service.get({ ref: reference, credential: second })
    await service.get({ ref: reference })

    expect(client.gets.map(({ credential }) => credential)).toEqual([first, second, undefined])
    expect(JSON.stringify(service)).not.toContain('token')
  })

  it('rejects a zero inline limit at construction', () => {
    const client = new RecordingDaClient()
    const resolver: RepositoryResolver = { resolve: async () => source }

    expect(() => createDaService(resolver, client, { maxInlineBytes: 0 })).toThrowError(
      expect.objectContaining<TasError>({ code: 'INVALID_ARGUMENT' }),
    )
  })

  it('bounds the whole operation even when Repository resolution never settles', async () => {
    const resolver: RepositoryResolver = {
      resolve: async () => await new Promise<RepositorySource>(() => undefined),
    }
    const client = new RecordingDaClient()
    const service = createDaService(resolver, client, { operationTimeoutMs: 5 })

    await expectTasCode(service.get({ ref: reference }), 'DA_UNAVAILABLE')
    expect(client.gets).toEqual([])
  })

  it('never starts a write when an abort-ignoring resolver settles after the deadline', async () => {
    let resolveRepository: ((value: RepositorySource) => void) | undefined
    const resolver: RepositoryResolver = {
      resolve: async () => await new Promise<RepositorySource>((resolve) => {
        resolveRepository = resolve
      }),
    }
    const client = new RecordingDaClient()
    const service = createDaService(resolver, client, { operationTimeoutMs: 5 })

    await expectTasCode(service.put({
      destination: { path },
      content: { encoding: 'utf8', value: 'result' },
      credential: { type: 'inline', secret: 'operation-secret' },
    }), 'DA_UNAVAILABLE')
    resolveRepository?.(source)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(client.puts).toEqual([])
    expect(JSON.stringify(service)).not.toContain('operation-secret')
  })

  it('propagates caller cancellation without projecting it as a DA tool failure', async () => {
    const { service } = fixture()
    const controller = new AbortController()
    const reason = new DOMException('caller cancelled', 'AbortError')
    controller.abort(reason)

    await expect(service.get({ ref: reference, signal: controller.signal })).rejects.toBe(reason)
  })
})
