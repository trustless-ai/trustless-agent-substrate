import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { TasError } from '../../../src/core/errors.js'
import {
  assertRepositoryCursorContext,
  decodeRepositoryCursor,
  encodeRepositoryCursor,
  type RepositoryCursorPayload,
} from '../../../src/core/repository/cursor.js'
import type { RepositorySource } from '../../../src/core/repository/types.js'

const profileBlockHash = `0x${'a'.repeat(64)}` as const
const alternateBlockHash = `0x${'b'.repeat(64)}` as const
const observedNow = new Date('2026-08-23T02:03:04Z')
const deterministicCursor = 'eyJ2ZXJzaW9uIjoxLCJ0b29sIjoicmVwby5pc3N1ZS5saXN0IiwicmVwb3NpdG9yeSI6Imh0dHBzOi8vZ2l0aHViLmNvbS90cnVzdGxlc3MtYWkvdGF3Zy1kZW1vIiwicHJvZmlsZUJsb2NrSGFzaCI6IjB4YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYSIsInNpbmNlIjoiMjAyNi0wOC0yM1QwMTowMjowM1oiLCJvYnNlcnZlZEF0IjoiMjAyNi0wOC0yM1QwMjowMzowNFoiLCJvcmRlciI6Im5ld2VzdF9maXJzdCIsInByb3ZpZGVyUGFnZSI6MiwicHJvdmlkZXJPZmZzZXQiOjd9'

function payload(overrides: Partial<RepositoryCursorPayload> = {}): RepositoryCursorPayload {
  return {
    version: 1,
    tool: 'repo.issue.list',
    repository: 'https://github.com/trustless-ai/tawg-demo',
    profileBlockHash,
    since: '2026-08-23T01:02:03Z',
    observedAt: '2026-08-23T02:03:04Z',
    order: 'newest_first',
    providerPage: 2,
    providerOffset: 7,
    ...overrides,
  }
}

function source(overrides: Partial<RepositorySource> = {}): RepositorySource {
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

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function encodeJsonText(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function expectCursorError(action: () => unknown, code: 'REPOSITORY_CURSOR_INVALID' | 'REPOSITORY_CURSOR_CONTEXT_MISMATCH'): void {
  expect(action).toThrow(TasError)
  try {
    action()
  } catch (error) {
    expect(error).toMatchObject({ code })
  }
}

describe('Repository cursor codec', () => {
  it('encodes the ordered payload deterministically as unpadded base64url', () => {
    const encoded = encodeRepositoryCursor(payload())

    expect(encoded).toBe(deterministicCursor)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(encoded).not.toContain('=')
  })

  it('round trips a strict payload without adding protocol state', () => {
    expect(decodeRepositoryCursor(deterministicCursor, observedNow)).toEqual(payload())
  })

  it.each([
    '',
    '*not-base64url*',
    `${deterministicCursor}=`,
    `${deterministicCursor}\n`,
    '/w==',
    'a',
    'AB',
  ])('rejects malformed or non-canonical base64url input: %s', (cursor) => {
    expectCursorError(() => decodeRepositoryCursor(cursor, observedNow), 'REPOSITORY_CURSOR_INVALID')
  })

  it('rejects malformed JSON and a cursor larger than the 2 KiB encoded-input limit', () => {
    expectCursorError(
      () => decodeRepositoryCursor(Buffer.from('not JSON', 'utf8').toString('base64url'), observedNow),
      'REPOSITORY_CURSOR_INVALID',
    )
    expectCursorError(
      () => decodeRepositoryCursor('a'.repeat(2_049), observedNow),
      'REPOSITORY_CURSOR_INVALID',
    )
  })

  it.each([
    ['reordered fields', JSON.stringify({ providerOffset: 7, ...payload() })],
    ['insignificant whitespace', JSON.stringify(payload(), undefined, 2)],
    [
      'a duplicate key',
      JSON.stringify(payload()).replace('"version":1', '"version":1,"version":1'),
    ],
    ['an exponent number', JSON.stringify(payload()).replace('"providerPage":2', '"providerPage":2e0')],
    ['negative zero', JSON.stringify(payload()).replace('"providerOffset":7', '"providerOffset":-0')],
  ])('rejects otherwise valid JSON encoded with %s', (_description, json) => {
    expectCursorError(
      () => decodeRepositoryCursor(encodeJsonText(json), observedNow),
      'REPOSITORY_CURSOR_INVALID',
    )
  })

  it.each([
    ['unknown field', { ...payload(), credential: { type: 'inline', secret: 'must-not-enter-cursor' } }],
    ['unsupported version', { ...payload(), version: 2 }],
    ['unknown tool', { ...payload(), tool: 'repo.branch.list' }],
    ['non-canonical Repository', { ...payload(), repository: 'https://github.com/trustless-ai/tawg-demo.git' }],
    ['invalid Profile hash', { ...payload(), profileBlockHash: '0x1234' }],
    ['wrong order', { ...payload(), order: 'oldest_first' }],
    ['zero provider page', { ...payload(), providerPage: 0 }],
    ['fractional provider page', { ...payload(), providerPage: 1.5 }],
    ['unsafe provider page', { ...payload(), providerPage: Number.MAX_SAFE_INTEGER + 1 }],
    ['negative provider offset', { ...payload(), providerOffset: -1 }],
    ['fractional provider offset', { ...payload(), providerOffset: 0.5 }],
    ['unsafe provider offset', { ...payload(), providerOffset: Number.MAX_SAFE_INTEGER + 1 }],
    ['fractional since', { ...payload(), since: '2026-08-23T01:02:03.000Z' }],
    ['offset observed time', { ...payload(), observedAt: '2026-08-23T02:03:04+00:00' }],
    ['invalid calendar time', { ...payload(), since: '2026-02-30T01:02:03Z' }],
    ['since after observation', { ...payload(), since: '2026-08-23T02:03:05Z' }],
  ])('strictly rejects a payload with %s', (_description, invalidPayload) => {
    expectCursorError(
      () => decodeRepositoryCursor(encodeJson(invalidPayload), observedNow),
      'REPOSITORY_CURSOR_INVALID',
    )
  })

  it('rejects an observation from the future while accepting equality with the injected clock', () => {
    expect(decodeRepositoryCursor(deterministicCursor, observedNow)).toEqual(payload())
    expectCursorError(
      () => decodeRepositoryCursor(
        encodeJson(payload({ observedAt: '2026-08-23T02:03:05Z' })),
        observedNow,
      ),
      'REPOSITORY_CURSOR_INVALID',
    )
  })

  it('applies the same strict payload boundary while encoding', () => {
    const withCredential = { ...payload(), credential: { type: 'inline', secret: 'must-not-enter-cursor' } }
    expectCursorError(
      () => Reflect.apply(encodeRepositoryCursor, undefined, [withCredential]),
      'REPOSITORY_CURSOR_INVALID',
    )
  })
})

describe('Repository cursor context', () => {
  const expected = {
    tool: 'repo.issue.list' as const,
    source: source(),
    since: '2026-08-23T01:02:03Z',
  }

  it('accepts an exact tool, Repository, Profile block, and since binding', () => {
    expect(() => assertRepositoryCursorContext(payload(), expected)).not.toThrow()
  })

  it.each([
    ['tool', payload({ tool: 'repo.pull_request.list' })],
    ['Repository', payload({ repository: 'https://github.com/trustless-ai/other-repo' })],
    ['Profile block hash', payload({ profileBlockHash: alternateBlockHash })],
    ['since boundary', payload({ since: '2026-08-23T01:02:04Z' })],
  ])('rejects a changed %s as a cursor context mismatch', (_description, candidate) => {
    expectCursorError(
      () => assertRepositoryCursorContext(candidate, expected),
      'REPOSITORY_CURSOR_CONTEXT_MISMATCH',
    )
  })
})
