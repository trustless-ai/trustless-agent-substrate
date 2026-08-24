import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import type {
  RepositoryActivityInput,
  RepositoryActivityResult,
  RepositoryActivityTool,
  RepositoryService,
} from '../core/repository/service.js'
import type {
  RepositoryCommit,
  RepositoryIssue,
  RepositorySource,
} from '../core/repository/types.js'
import type { ChainSelector } from '../core/profile/types.js'
import {
  createTasResultBuilder,
  type PublicJsonObject,
  type ResolutionContext,
  type TasPublicInstance,
} from './results.js'

const maxUint256 = 2n ** 256n - 1n
const canonicalDecimalSchema = z.string().max(78).regex(/^(?:0|[1-9][0-9]*)$/).refine((value) => {
  try { return BigInt(value) <= maxUint256 } catch { return false }
})
const positiveCanonicalDecimalSchema = z.string().max(78).regex(/^[1-9][0-9]*$/).refine((value) => {
  try { return BigInt(value) <= maxUint256 } catch { return false }
})
const blockHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const evmAddressSchema = z.string().regex(/^0x(?!0{40}$)[0-9a-fA-F]{40}$/)
const fullCommitSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
const githubRepositorySchema = z.string().regex(/^https:\/\/github\.com\/[^/]+\/[^/]+$/)
const timestampSchema = z.string().max(35).regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/,
)

const selectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('latest') }).strict(),
  z.object({ kind: z.literal('safe') }).strict(),
  z.object({ kind: z.literal('finalized') }).strict(),
  z.object({ kind: z.literal('block_number'), block_number: canonicalDecimalSchema }).strict(),
  z.object({ kind: z.literal('block_hash'), block_hash: blockHashSchema }).strict(),
])
const credentialSchema = z.object({
  type: z.literal('inline'),
  secret: z.string().min(1).max(4_096).meta({ writeOnly: true }),
}).strict()
const repoGetInputSchema = z.object({ selector: selectorSchema.optional() }).strict()
const activityInputSchema = z.object({
  since: timestampSchema,
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(2_048).optional(),
  selector: selectorSchema.optional(),
  credential: credentialSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.cursor !== undefined && value.selector !== undefined) {
    context.addIssue({ code: 'custom', message: 'selector cannot be combined with cursor' })
  }
})

const memberInstanceSchema = z.object({
  phase: z.literal('member'),
  chain_id: positiveCanonicalDecimalSchema,
  tawg_address: evmAddressSchema,
  agent_id: canonicalDecimalSchema,
}).strict()
const resolutionSchema = z.object({
  chain: z.object({ block_number: canonicalDecimalSchema, block_hash: blockHashSchema }).strict(),
  profile: z.object({ version: positiveCanonicalDecimalSchema }).strict(),
}).strict()
const contextSchema = z.object({
  instance: memberInstanceSchema,
  request_id: z.string().uuid(),
  resolved: resolutionSchema,
}).strict()
const pageSchema = z.object({
  consistency: z.literal('live'),
  next_cursor: z.string().min(1).optional(),
}).strict()
const issueSchema = z.object({
  id: z.string(),
  number: canonicalDecimalSchema,
  title: z.string(),
  state: z.enum(['open', 'closed']),
  author: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  url: z.string(),
}).strict()
const commitSchema = z.object({
  commit: fullCommitSchema,
  message: z.string(),
  author_name: z.string().nullable(),
  author_login: z.string().nullable(),
  committed_at: z.string(),
  url: z.string(),
}).strict()
const repoGetOutputSchema = z.object({
  context: contextSchema,
  data: z.object({
    repository_url: githubRepositorySchema,
    charter: z.object({ commit: fullCommitSchema, path: z.literal('charter/') }).strict(),
  }).strict(),
}).strict()
const issueListOutputSchema = z.object({
  context: contextSchema,
  data: z.object({ observed_at: z.string(), items: z.array(issueSchema), page: pageSchema }).strict(),
}).strict()
const commitListOutputSchema = z.object({
  context: contextSchema,
  data: z.object({ observed_at: z.string(), items: z.array(commitSchema), page: pageSchema }).strict(),
}).strict()

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const

function selectorFromInput(input: z.infer<typeof selectorSchema> | undefined): ChainSelector {
  if (!input) return { kind: 'latest' }
  if (input.kind === 'block_number') return { kind: input.kind, blockNumber: input.block_number }
  if (input.kind === 'block_hash') return { kind: input.kind, blockHash: input.block_hash as `0x${string}` }
  return { kind: input.kind }
}

function resolutionFromSource(source: RepositorySource): ResolutionContext {
  return {
    chain: { block_number: source.profile.blockNumber, block_hash: source.profile.blockHash },
    profile: { version: source.profile.version },
  }
}

function projectIssue(item: RepositoryIssue): PublicJsonObject {
  return {
    id: item.id,
    number: item.number,
    title: item.title,
    state: item.state,
    author: item.author,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    url: item.url,
  }
}

function projectCommit(item: RepositoryCommit): PublicJsonObject {
  return {
    commit: item.commit,
    message: item.message,
    author_name: item.authorName,
    author_login: item.authorLogin,
    committed_at: item.committedAt,
    url: item.url,
  }
}

function pageData(result: RepositoryActivityResult<unknown>): PublicJsonObject {
  return result.page.nextCursor === undefined
    ? { consistency: result.page.consistency }
    : { consistency: result.page.consistency, next_cursor: result.page.nextCursor }
}

function issueActivityData(result: RepositoryActivityResult<RepositoryIssue>): PublicJsonObject {
  return { observed_at: result.observedAt, items: result.items.map(projectIssue), page: pageData(result) }
}

function commitActivityData(result: RepositoryActivityResult<RepositoryCommit>): PublicJsonObject {
  return { observed_at: result.observedAt, items: result.items.map(projectCommit), page: pageData(result) }
}

function activityInput<TTool extends RepositoryActivityTool>(
  tool: TTool,
  input: z.infer<typeof activityInputSchema>,
): RepositoryActivityInput<TTool> {
  return {
    tool,
    since: input.since,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.selector === undefined ? {} : { selector: selectorFromInput(input.selector) }),
    ...(input.credential === undefined ? {} : { credential: input.credential }),
  }
}

function listIssueActivity(
  service: RepositoryService,
  tool: 'repo.issue.list' | 'repo.pull_request.list',
  input: z.infer<typeof activityInputSchema>,
): Promise<RepositoryActivityResult<RepositoryIssue>> {
  return tool === 'repo.issue.list'
    ? service.listActivity(activityInput('repo.issue.list', input))
    : service.listActivity(activityInput('repo.pull_request.list', input))
}

/** Registers Profile-bound Repository discovery and live activity tools. */
export function registerRepositoryTools(
  server: McpServer,
  service: RepositoryService,
  instance: Extract<TasPublicInstance, { readonly phase: 'member' }>,
): void {
  server.registerTool('repo.get', {
    title: 'Get TAWG Repository',
    description: 'Returns the canonical Repository and Charter reference selected by the TAWG Profile.',
    inputSchema: repoGetInputSchema,
    outputSchema: repoGetOutputSchema,
    annotations,
  }, async (input) => {
    try {
      const source = await service.getRepository(selectorFromInput(input.selector))
      return createTasResultBuilder(instance, resolutionFromSource(source)).success({
        repository_url: source.locator,
        charter: { commit: source.charter.commit, path: source.charter.path },
      })
    } catch (error) {
      return createTasResultBuilder(instance).toolError(error)
    }
  })

  function registerIssueActivityTool(
    tool: 'repo.issue.list' | 'repo.pull_request.list',
    title: string,
    description: string,
  ): void {
    server.registerTool(tool, {
      title,
      description,
      inputSchema: activityInputSchema,
      outputSchema: issueListOutputSchema,
      annotations,
    }, async (input) => {
      try {
        const result = await listIssueActivity(service, tool, input)
        return createTasResultBuilder(instance, resolutionFromSource(result.source))
          .success(issueActivityData(result))
      } catch (error) {
        return createTasResultBuilder(instance).toolError(error)
      }
    })
  }

  registerIssueActivityTool('repo.issue.list', 'List Repository Issues', 'Lists new Issues in the Profile-selected Repository.')
  registerIssueActivityTool('repo.pull_request.list', 'List Repository Pull Requests', 'Lists new Pull Requests in the Profile-selected Repository.')
  server.registerTool('repo.commit.list', {
    title: 'List Repository commits',
    description: 'Lists new commits on the Profile-selected Repository default branch.',
    inputSchema: activityInputSchema,
    outputSchema: commitListOutputSchema,
    annotations,
  }, async (input) => {
    try {
      const result = await service.listActivity(activityInput('repo.commit.list', input))
      return createTasResultBuilder(instance, resolutionFromSource(result.source))
        .success(commitActivityData(result))
    } catch (error) {
      return createTasResultBuilder(instance).toolError(error)
    }
  })
}
