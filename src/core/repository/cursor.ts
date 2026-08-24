import { Buffer } from 'node:buffer'
import { TextDecoder } from 'node:util'

import { z } from 'zod'

import { TasError } from '../errors.js'
import { parseGitHubLocator } from './locator.js'
import type { RepositorySource } from './types.js'

const maxEncodedBytes = 2_048
const canonicalUtcSecond = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const blockHash = /^0x[0-9a-fA-F]{64}$/
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

export type RepositoryActivityTool =
  | 'repo.issue.list'
  | 'repo.pull_request.list'
  | 'repo.commit.list'

export interface RepositoryCursorPayload {
  readonly version: 1
  readonly tool: RepositoryActivityTool
  readonly repository: `https://github.com/${string}/${string}`
  readonly profileBlockHash: `0x${string}`
  readonly since: string
  readonly observedAt: string
  readonly order: 'newest_first'
  readonly providerPage: number
  readonly providerOffset: number
}

export interface RepositoryCursorContext {
  readonly tool: RepositoryActivityTool
  readonly source: RepositorySource
  readonly since: string
}

function invalid(): never {
  throw new TasError('REPOSITORY_CURSOR_INVALID', 'The Repository cursor is invalid.')
}

function contextMismatch(): never {
  throw new TasError(
    'REPOSITORY_CURSOR_CONTEXT_MISMATCH',
    'The Repository cursor does not match the current request context.',
  )
}

function isCanonicalTimestamp(value: string): boolean {
  if (!canonicalUtcSecond.test(value)) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp)
    && new Date(timestamp).toISOString().replace('.000Z', 'Z') === value
}

function isCanonicalRepository(value: unknown): value is `https://github.com/${string}/${string}` {
  if (typeof value !== 'string') return false
  try {
    return parseGitHubLocator(value).locator === value
  } catch {
    return false
  }
}

const cursorPayloadSchema = z.object({
  version: z.literal(1),
  tool: z.enum(['repo.issue.list', 'repo.pull_request.list', 'repo.commit.list']),
  repository: z.custom<`https://github.com/${string}/${string}`>(isCanonicalRepository),
  profileBlockHash: z.custom<`0x${string}`>((value) => typeof value === 'string' && blockHash.test(value)),
  since: z.string().refine(isCanonicalTimestamp),
  observedAt: z.string().refine(isCanonicalTimestamp),
  order: z.literal('newest_first'),
  providerPage: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  providerOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.since) > Date.parse(value.observedAt)) {
    context.addIssue({ code: 'custom', message: 'The observation precedes the inclusive boundary.' })
  }
})

function parsePayload(value: unknown): RepositoryCursorPayload {
  const parsed = cursorPayloadSchema.safeParse(value)
  return parsed.success ? parsed.data : invalid()
}

function orderedPayload(payload: RepositoryCursorPayload): RepositoryCursorPayload {
  return {
    version: payload.version,
    tool: payload.tool,
    repository: payload.repository,
    profileBlockHash: payload.profileBlockHash,
    since: payload.since,
    observedAt: payload.observedAt,
    order: payload.order,
    providerPage: payload.providerPage,
    providerOffset: payload.providerOffset,
  }
}

export function encodeRepositoryCursor(payload: RepositoryCursorPayload): string {
  const encoded = Buffer.from(JSON.stringify(orderedPayload(parsePayload(payload))), 'utf8').toString('base64url')
  return encoded.length <= maxEncodedBytes ? encoded : invalid()
}

export function decodeRepositoryCursor(cursor: string, now: Date = new Date()): RepositoryCursorPayload {
  if (
    typeof cursor !== 'string'
    || cursor.length === 0
    || cursor.length > maxEncodedBytes
    || !/^[A-Za-z0-9_-]+$/.test(cursor)
    || !(now instanceof Date)
    || !Number.isFinite(now.getTime())
  ) return invalid()

  let bytes: Buffer
  try {
    bytes = Buffer.from(cursor, 'base64url')
  } catch {
    return invalid()
  }
  if (bytes.toString('base64url') !== cursor) return invalid()

  let decoded: string
  let json: unknown
  try {
    decoded = utf8Decoder.decode(bytes)
    json = JSON.parse(decoded)
  } catch {
    return invalid()
  }
  const payload = parsePayload(json)
  if (decoded !== JSON.stringify(orderedPayload(payload))) return invalid()
  if (Date.parse(payload.observedAt) > now.getTime()) return invalid()
  return Object.freeze(payload)
}

export function assertRepositoryCursorContext(
  payload: RepositoryCursorPayload,
  expected: RepositoryCursorContext,
): void {
  const parsed = parsePayload(payload)
  if (
    parsed.tool !== expected.tool
    || parsed.repository !== expected.source.locator
    || parsed.profileBlockHash !== expected.source.profile.blockHash
    || parsed.since !== expected.since
  ) return contextMismatch()
}
