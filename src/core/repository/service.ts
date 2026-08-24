import { TasError } from '../errors.js'
import type { ChainSelector } from '../profile/types.js'
import type { RepositoryActivityClient } from './client.js'
import {
  assertRepositoryCursorContext,
  decodeRepositoryCursor,
  encodeRepositoryCursor,
  type RepositoryActivityTool,
} from './cursor.js'
import type { RepositoryResolver } from './resolver.js'
import type {
  ActivityWindow,
  RepositoryCommit,
  RepositoryCredential,
  RepositoryIssue,
  RepositoryPage,
  RepositoryPullRequest,
  RepositorySource,
} from './types.js'

export type { RepositoryActivityTool } from './cursor.js'

export interface RepositoryActivityItemByTool {
  readonly 'repo.issue.list': RepositoryIssue
  readonly 'repo.pull_request.list': RepositoryPullRequest
  readonly 'repo.commit.list': RepositoryCommit
}

type RepositoryActivityItem = RepositoryActivityItemByTool[RepositoryActivityTool]

export interface RepositoryActivityInput<TTool extends RepositoryActivityTool = RepositoryActivityTool> {
  readonly tool: TTool
  readonly since: string
  readonly limit?: number
  readonly cursor?: string
  readonly selector?: ChainSelector
  readonly credential?: RepositoryCredential
}

export interface RepositoryActivityResult<T> {
  readonly source: RepositorySource
  readonly observedAt: string
  readonly items: readonly T[]
  readonly page: {
    readonly consistency: 'live'
    readonly nextCursor?: string
  }
}

export interface RepositoryService {
  getRepository(selector: ChainSelector): Promise<RepositorySource>
  listActivity(input: RepositoryActivityInput<'repo.issue.list'>): Promise<RepositoryActivityResult<RepositoryIssue>>
  listActivity(input: RepositoryActivityInput<'repo.pull_request.list'>): Promise<RepositoryActivityResult<RepositoryPullRequest>>
  listActivity(input: RepositoryActivityInput<'repo.commit.list'>): Promise<RepositoryActivityResult<RepositoryCommit>>
  listActivity(input: RepositoryActivityInput): Promise<RepositoryActivityResult<RepositoryActivityItem>>
}

const rfc3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/
const canonicalUtcSecond = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

function invalidArgument(): never {
  throw new TasError('INVALID_ARGUMENT', 'The request arguments are invalid.')
}

function normalizeTimestamp(value: string): string {
  const match = rfc3339.exec(value)
  if (!match) return invalidArgument()
  const [, year, month, day, hour, minute, second, fraction, zone] = match
  if (!year || !month || !day || !hour || !minute || !second || !zone) return invalidArgument()
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return invalidArgument()
  if (zone !== 'Z') {
    const offsetHour = Number(zone.slice(1, 3))
    const offsetMinute = Number(zone.slice(4, 6))
    if (offsetHour > 23 || offsetMinute > 59) return invalidArgument()
  }

  const local = `${year}-${month}-${day}T${hour}:${minute}:${second}${fraction ? `.${fraction}` : ''}Z`
  const localTime = Date.parse(local)
  if (!Number.isFinite(localTime)) return invalidArgument()
  const localDate = new Date(localTime)
  if (
    localDate.getUTCFullYear() !== Number(year)
    || localDate.getUTCMonth() + 1 !== Number(month)
    || localDate.getUTCDate() !== Number(day)
    || localDate.getUTCHours() !== Number(hour)
    || localDate.getUTCMinutes() !== Number(minute)
    || localDate.getUTCSeconds() !== Number(second)
  ) return invalidArgument()

  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return invalidArgument()
  const normalized = new Date(Math.floor(timestamp / 1_000) * 1_000).toISOString().replace('.000Z', 'Z')
  return canonicalUtcSecond.test(normalized) ? normalized : invalidArgument()
}

function captureClock(clock: () => Date): Date {
  const now = clock()
  return now instanceof Date && Number.isFinite(now.getTime()) ? now : invalidArgument()
}

function normalizeLimit(limit: number | undefined): number {
  const normalized = limit ?? 50
  return Number.isSafeInteger(normalized) && normalized >= 1 && normalized <= 100
    ? normalized
    : invalidArgument()
}

function isActivityTool(value: string): value is RepositoryActivityTool {
  return value === 'repo.issue.list' || value === 'repo.pull_request.list' || value === 'repo.commit.list'
}

async function dispatch(
  client: RepositoryActivityClient,
  tool: 'repo.issue.list',
  source: RepositorySource,
  window: ActivityWindow,
  credential?: RepositoryCredential,
): Promise<RepositoryPage<RepositoryIssue>>
async function dispatch(
  client: RepositoryActivityClient,
  tool: 'repo.pull_request.list',
  source: RepositorySource,
  window: ActivityWindow,
  credential?: RepositoryCredential,
): Promise<RepositoryPage<RepositoryPullRequest>>
async function dispatch(
  client: RepositoryActivityClient,
  tool: 'repo.commit.list',
  source: RepositorySource,
  window: ActivityWindow,
  credential?: RepositoryCredential,
): Promise<RepositoryPage<RepositoryCommit>>
async function dispatch(
  client: RepositoryActivityClient,
  tool: RepositoryActivityTool,
  source: RepositorySource,
  window: ActivityWindow,
  credential?: RepositoryCredential,
): Promise<RepositoryPage<RepositoryIssue | RepositoryCommit>> {
  if (tool === 'repo.issue.list') return client.listIssues(source, window, credential)
  if (tool === 'repo.pull_request.list') return client.listPullRequests(source, window, credential)
  return client.listCommits(source, window, credential)
}

export function createRepositoryService(
  repositoryResolver: RepositoryResolver,
  activityClient: RepositoryActivityClient,
  clock: () => Date = () => new Date(),
): RepositoryService {
  async function listActivity(
    input: RepositoryActivityInput<'repo.issue.list'>,
  ): Promise<RepositoryActivityResult<RepositoryIssue>>
  async function listActivity(
    input: RepositoryActivityInput<'repo.pull_request.list'>,
  ): Promise<RepositoryActivityResult<RepositoryPullRequest>>
  async function listActivity(
    input: RepositoryActivityInput<'repo.commit.list'>,
  ): Promise<RepositoryActivityResult<RepositoryCommit>>
  async function listActivity(
    input: RepositoryActivityInput,
  ): Promise<RepositoryActivityResult<RepositoryActivityItem>>
  async function listActivity(
    input: RepositoryActivityInput,
  ): Promise<RepositoryActivityResult<RepositoryActivityItem>> {
    let source: RepositorySource
    let observedAt: string
    let providerPage: number
    let providerOffset: number
    let since: string
    let limit: number

    if (input.cursor !== undefined) {
      const cursor = decodeRepositoryCursor(input.cursor, captureClock(clock))
      if (input.selector !== undefined) return invalidArgument()
      if (!isActivityTool(input.tool)) return invalidArgument()
      limit = normalizeLimit(input.limit)
      since = normalizeTimestamp(input.since)
      source = await repositoryResolver.resolve({ kind: 'block_hash', blockHash: cursor.profileBlockHash })
      assertRepositoryCursorContext(cursor, { tool: input.tool, source, since })
      observedAt = cursor.observedAt
      providerPage = cursor.providerPage
      providerOffset = cursor.providerOffset
    } else {
      if (!isActivityTool(input.tool)) return invalidArgument()
      limit = normalizeLimit(input.limit)
      since = normalizeTimestamp(input.since)
      source = await repositoryResolver.resolve(input.selector ?? { kind: 'latest' })
      observedAt = normalizeTimestamp(captureClock(clock).toISOString())
      if (Date.parse(since) > Date.parse(observedAt)) return invalidArgument()
      providerPage = 1
      providerOffset = 0
    }

    const window = { since, observedAt, limit, providerPage, providerOffset }
    let result: RepositoryPage<RepositoryActivityItem>
    if (input.tool === 'repo.issue.list') {
      result = await dispatch(activityClient, input.tool, source, window, input.credential)
    } else if (input.tool === 'repo.pull_request.list') {
      result = await dispatch(activityClient, input.tool, source, window, input.credential)
    } else {
      result = await dispatch(activityClient, input.tool, source, window, input.credential)
    }

    const nextCursor = result.nextPosition === undefined
      ? undefined
      : encodeRepositoryCursor({
          version: 1,
          tool: input.tool,
          repository: source.locator,
          profileBlockHash: source.profile.blockHash,
          since,
          observedAt,
          order: 'newest_first',
          providerPage: result.nextPosition.providerPage,
          providerOffset: result.nextPosition.providerOffset,
        })
    const page = nextCursor === undefined
      ? { consistency: 'live' as const }
      : { consistency: 'live' as const, nextCursor }
    return { source, observedAt, items: result.items, page }
  }

  return {
    getRepository: (selector) => repositoryResolver.resolve(selector),
    listActivity,
  }
}
