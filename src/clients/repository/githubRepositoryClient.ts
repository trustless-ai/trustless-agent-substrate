import { Buffer } from 'node:buffer'

import { z } from 'zod'

import { TasError } from '../../core/errors.js'
import type { RepositoryClient, RepositoryFile, RepositoryReadOptions } from '../../core/repository/client.js'
import type {
  ActivityWindow,
  RepositoryCommit,
  RepositoryCredential,
  RepositoryIssue,
  RepositoryPage,
  RepositorySource,
} from '../../core/repository/types.js'
import type { GitHubRequest } from './githubRequest.js'

const apiHeaders = { 'x-github-api-version': '2026-03-10' } as const
const fullCommit = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const canonicalUtcSecond = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const maxFileBytes = 1_048_576
const maxBase64Characters = Math.ceil(maxFileBytes / 3) * 4
const maxBase64TransportCharacters = maxBase64Characters + Math.ceil(maxBase64Characters / 60) * 2
const maxProviderPages = 20
const maxProviderPageItems = 100
const maxOpaqueIdCharacters = 512
const maxTitleCharacters = 1_024
const maxMessageCharacters = 65_536
const maxNameCharacters = 1_024
const maxLoginCharacters = 256
const maxUrlCharacters = 8_192
const maxRefCharacters = 1_024
const maxPathCharacters = 4_096

function isCanonicalTimestamp(value: string): boolean {
  if (!canonicalUtcSecond.test(value)) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().replace('.000Z', 'Z') === value
}

function isCanonicalGitHubWebUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && url.port === ''
      && url.username === ''
      && url.password === ''
      && url.search === ''
      && url.hash === ''
      && url.href === value
  } catch {
    return false
  }
}

const timestampSchema = z.string().refine(isCanonicalTimestamp)
const githubWebUrlSchema = z.string().max(maxUrlCharacters).refine(isCanonicalGitHubWebUrl)
const issueSchema = z.object({
  node_id: z.string().min(1).max(maxOpaqueIdCharacters),
  number: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  title: z.string().max(maxTitleCharacters),
  state: z.enum(['open', 'closed']),
  user: z.object({ login: z.string().min(1).max(maxLoginCharacters) }).passthrough().nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  html_url: githubWebUrlSchema,
}).passthrough()
const commitSchema = z.object({
  sha: z.string().regex(fullCommit),
  commit: z.object({
    message: z.string().max(maxMessageCharacters),
    author: z.object({ name: z.string().max(maxNameCharacters) }).passthrough().nullable().optional(),
    committer: z.object({ date: timestampSchema }).passthrough(),
  }).passthrough(),
  author: z.object({ login: z.string().min(1).max(maxLoginCharacters) }).passthrough().nullable().optional(),
  html_url: githubWebUrlSchema,
}).passthrough()
const repositorySchema = z.object({ default_branch: z.string().min(1).max(maxRefCharacters) }).passthrough()
const resolvedCommitSchema = z.object({ sha: z.string().regex(fullCommit) }).passthrough()
const fileSchema = z.object({
  type: z.literal('file'),
  encoding: z.literal('base64'),
  content: z.string().max(maxBase64TransportCharacters),
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  path: z.string().min(1).max(maxPathCharacters),
}).passthrough()

function fetchFailed(): never {
  throw new TasError('REPOSITORY_FETCH_FAILED', 'The Profile-selected Repository could not be read.')
}

function ownData(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && 'value' in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function responseHeaders(error: unknown): Readonly<Record<string, unknown>> {
  const response = ownData(error, 'response')
  const headers = ownData(response, 'headers')
  return headers !== null && typeof headers === 'object' && !Array.isArray(headers)
    ? headers as Readonly<Record<string, unknown>>
    : {}
}

function mapRequestError(error: unknown): never {
  const status = ownData(error, 'status')
  if (status === 401) throw new TasError('CREDENTIAL_REQUIRED', 'A valid operation credential is required.')
  if (status === 404) throw new TasError('REPOSITORY_NOT_FOUND', 'The Profile-selected Repository was not found.')
  const headers = responseHeaders(error)
  if (
    status === 429
    || (status === 403 && (
      ownData(headers, 'x-ratelimit-remaining') === '0'
      || ownData(headers, 'retry-after') !== undefined
    ))
  ) {
    throw new TasError('REPOSITORY_RATE_LIMITED', 'The Repository provider rate limit was reached.')
  }
  return fetchFailed()
}

function commonParameters(source: RepositorySource): Record<string, unknown> {
  return { owner: source.owner, repo: source.repository }
}

function requestParameters(source: RepositorySource, values: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { ...commonParameters(source), ...values, headers: apiHeaders }
}

function hasNext(headers: Readonly<Record<string, string | undefined>>): boolean {
  const lower = ownData(headers, 'link')
  const link = lower ?? ownData(headers, 'Link')
  return typeof link === 'string' && /<[^>]+>;\s*rel="next"/i.test(link)
}

function validateWindow(window: ActivityWindow): { since: number; observedAt: number } {
  if (
    !isCanonicalTimestamp(window.since)
    || !isCanonicalTimestamp(window.observedAt)
    || !Number.isSafeInteger(window.limit)
    || window.limit < 1
    || !Number.isSafeInteger(window.providerPage)
    || window.providerPage < 1
    || !Number.isSafeInteger(window.providerOffset)
    || window.providerOffset < 0
  ) return fetchFailed()
  const since = Date.parse(window.since)
  const observedAt = Date.parse(window.observedAt)
  return since <= observedAt ? { since, observedAt } : fetchFailed()
}

function beforeInclusiveBoundary(value: string): string {
  return new Date(Date.parse(value) - 1_000).toISOString().replace('.000Z', 'Z')
}

function mapIssue(raw: z.infer<typeof issueSchema>): RepositoryIssue {
  return {
    id: raw.node_id,
    number: String(raw.number),
    title: raw.title,
    state: raw.state,
    author: raw.user?.login ?? null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    url: raw.html_url,
  }
}

function nextAfterPage(page: number, headers: Readonly<Record<string, string | undefined>>): { providerPage: number; providerOffset: number } | undefined {
  if (!hasNext(headers)) return undefined
  const providerPage = page + 1
  return Number.isSafeInteger(providerPage)
    ? { providerPage, providerOffset: 0 }
    : fetchFailed()
}

export function createGitHubRepositoryClient(
  request: GitHubRequest,
  _clock: () => Date = () => new Date(),
): RepositoryClient {
  async function call<T>(
    route: string,
    parameters: Readonly<Record<string, unknown>>,
    credential?: RepositoryCredential,
    signal?: AbortSignal,
  ) {
    try {
      return await request.request<T>(
        route,
        signal === undefined ? parameters : { ...parameters, request: { signal } },
        credential,
      )
    } catch (error) {
      if (signal?.aborted && error instanceof Error && error.name === 'AbortError') throw error
      return mapRequestError(error)
    }
  }

  async function listIssueKind(
    kind: 'issue' | 'pull_request',
    source: RepositorySource,
    window: ActivityWindow,
    credential?: RepositoryCredential,
  ): Promise<RepositoryPage<RepositoryIssue>> {
    const bounds = validateWindow(window)
    const items: RepositoryIssue[] = []
    let page = window.providerPage
    let offset = window.providerOffset
    let calls = 0
    let continuation: { providerPage: number; providerOffset: number } | undefined

    while (calls < maxProviderPages) {
      const response = await call<unknown>('GET /repos/{owner}/{repo}/issues', requestParameters(source, {
        state: 'all', sort: 'created', direction: 'desc', since: beforeInclusiveBoundary(window.since),
        per_page: 100, page,
      }), credential)
      calls += 1
      if (
        !Array.isArray(response.data)
        || response.data.length > maxProviderPageItems
        || offset > response.data.length
      ) return fetchFailed()

      let reachedLowerBound = false
      for (let index = offset; index < response.data.length; index += 1) {
        const parsed = issueSchema.safeParse(response.data[index])
        if (!parsed.success) return fetchFailed()
        const createdAt = Date.parse(parsed.data.created_at)
        if (createdAt < bounds.since) {
          reachedLowerBound = true
          break
        }
        const isPullRequest = Object.hasOwn(response.data[index] as object, 'pull_request')
        if (createdAt <= bounds.observedAt && (kind === 'pull_request') === isPullRequest) {
          items.push(mapIssue(parsed.data))
          if (items.length === window.limit) {
            const position = index + 1 < response.data.length
              ? { providerPage: page, providerOffset: index + 1 }
              : nextAfterPage(page, response.headers)
            items.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
            return position === undefined ? { items } : { items, nextPosition: position }
          }
        }
      }
      if (reachedLowerBound) {
        continuation = undefined
        break
      }
      continuation = nextAfterPage(page, response.headers)
      if (!continuation) break
      page = continuation.providerPage
      offset = 0
    }

    items.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    return continuation === undefined ? { items } : { items, nextPosition: continuation }
  }

  async function listCommits(
    source: RepositorySource,
    window: ActivityWindow,
    credential?: RepositoryCredential,
  ): Promise<RepositoryPage<RepositoryCommit>> {
    const bounds = validateWindow(window)
    const items: RepositoryCommit[] = []
    let page = window.providerPage
    let offset = window.providerOffset
    let calls = 0
    let continuation: { providerPage: number; providerOffset: number } | undefined

    while (calls < maxProviderPages) {
      const response = await call<unknown>('GET /repos/{owner}/{repo}/commits', requestParameters(source, {
        since: window.since, until: window.observedAt, per_page: 100, page,
      }), credential)
      calls += 1
      if (
        !Array.isArray(response.data)
        || response.data.length > maxProviderPageItems
        || offset > response.data.length
      ) return fetchFailed()
      let reachedLowerBound = false
      for (let index = offset; index < response.data.length; index += 1) {
        const parsed = commitSchema.safeParse(response.data[index])
        if (!parsed.success) return fetchFailed()
        const committedAt = Date.parse(parsed.data.commit.committer.date)
        if (committedAt < bounds.since) {
          reachedLowerBound = true
          break
        }
        if (committedAt <= bounds.observedAt) {
          items.push({
            commit: parsed.data.sha,
            message: parsed.data.commit.message,
            authorName: parsed.data.commit.author?.name ?? null,
            authorLogin: parsed.data.author?.login ?? null,
            committedAt: parsed.data.commit.committer.date,
            url: parsed.data.html_url,
          })
          if (items.length === window.limit) {
            const position = index + 1 < response.data.length
              ? { providerPage: page, providerOffset: index + 1 }
              : nextAfterPage(page, response.headers)
            items.sort((left, right) => Date.parse(right.committedAt) - Date.parse(left.committedAt))
            return position === undefined ? { items } : { items, nextPosition: position }
          }
        }
      }
      if (reachedLowerBound) {
        continuation = undefined
        break
      }
      continuation = nextAfterPage(page, response.headers)
      if (!continuation) break
      page = continuation.providerPage
      offset = 0
    }
    items.sort((left, right) => Date.parse(right.committedAt) - Date.parse(left.committedAt))
    return continuation === undefined ? { items } : { items, nextPosition: continuation }
  }

  async function resolveDefaultHead(source: RepositorySource, credential?: RepositoryCredential): Promise<string> {
    const repository = repositorySchema.safeParse((await call<unknown>(
      'GET /repos/{owner}/{repo}', requestParameters(source), credential,
    )).data)
    if (!repository.success) return fetchFailed()
    const resolved = resolvedCommitSchema.safeParse((await call<unknown>(
      'GET /repos/{owner}/{repo}/commits/{ref}',
      requestParameters(source, { ref: repository.data.default_branch }),
      credential,
    )).data)
    return resolved.success ? resolved.data.sha : fetchFailed()
  }

  async function readFile(
    source: RepositorySource,
    commit: string,
    path: string,
    credential?: RepositoryCredential,
    options?: RepositoryReadOptions,
  ): Promise<RepositoryFile> {
    if (!fullCommit.test(commit) || path.length === 0) return fetchFailed()
    const parsed = fileSchema.safeParse((await call<unknown>(
      'GET /repos/{owner}/{repo}/contents/{path}',
      requestParameters(source, { path, ref: commit }),
      credential,
      options?.signal,
    )).data)
    if (!parsed.success || parsed.data.path !== path || parsed.data.size > maxFileBytes) return fetchFailed()
    const normalized = parsed.data.content.replace(/\r?\n/g, '')
    if (
      normalized.length > maxBase64Characters
      || /[^A-Za-z0-9+/=]/.test(normalized)
      || normalized.length % 4 !== 0
    ) return fetchFailed()
    let bytes: Buffer
    try { bytes = Buffer.from(normalized, 'base64') } catch { return fetchFailed() }
    if (bytes.toString('base64') !== normalized || bytes.length !== parsed.data.size || bytes.length > maxFileBytes) {
      return fetchFailed()
    }
    return { path, commit, bytes }
  }

  return {
    listIssues: (source, window, credential) => listIssueKind('issue', source, window, credential),
    listPullRequests: (source, window, credential) => listIssueKind('pull_request', source, window, credential),
    listCommits,
    resolveDefaultHead,
    readFile,
  }
}
