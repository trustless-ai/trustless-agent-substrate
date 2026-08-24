import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createGitHubRepositoryClient } from '../../src/clients/repository/githubRepositoryClient.js'
import type { ProfileReader } from '../../src/core/profile/reader.js'
import { ProfileResolver } from '../../src/core/profile/resolver.js'
import type { ChainSelector, ProfileSnapshot } from '../../src/core/profile/types.js'
import { createRepositoryResolver } from '../../src/core/repository/resolver.js'
import { createRepositoryService } from '../../src/core/repository/service.js'
import { createRoleSkillLoader, createTawgSkillLoader } from '../../src/core/skill/loader.js'
import { RecordingGitHubRequest } from '../fixtures/repository/github.js'

const fullCommitSchema = z.string().regex(/^[0-9a-f]{40}$/)
const blockHashSchema = z.string().regex(/^0x[0-9a-f]{64}$/)
const canonicalDecimalSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/)
const profilePointSchema = z.object({
  block_number: canonicalDecimalSchema,
  block_hash: blockHashSchema,
  version: canonicalDecimalSchema,
  charter_commit: fullCommitSchema,
}).strict()
const activityItemSchema = z.object({
  kind: z.enum(['issue', 'pull_request']),
  node_id: z.string().min(1),
  provider_number: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expected_number: canonicalDecimalSchema,
  title: z.string(),
  state: z.enum(['open', 'closed']),
  author: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  url: z.string().url(),
}).strict()
const commitSchema = z.object({
  commit: fullCommitSchema,
  message: z.string(),
  author_name: z.string().nullable(),
  author_login: z.string().nullable(),
  committed_at: z.string(),
  url: z.string().url(),
}).strict()
const fixtureSchema = z.object({
  profile: z.object({
    chain_id: canonicalDecimalSchema,
    tawg_address: z.string().regex(/^0x[0-9a-f]{40}$/),
    governance: z.string().regex(/^0x[0-9a-f]{40}$/),
    identity_registry: z.string().regex(/^0x[0-9a-f]{40}$/),
    workflow_address: z.string().regex(/^0x[0-9a-f]{40}$/),
    repository_url: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
    initial: profilePointSchema,
    advanced: profilePointSchema,
  }).strict(),
  activity: z.object({
    since: z.string(),
    observed_at: z.string(),
    advanced_clock: z.string(),
    issues_and_pull_requests: z.array(activityItemSchema),
    commits: z.array(commitSchema),
  }).strict(),
  skills: z.object({
    initial_head: fullCommitSchema,
    advanced_head: fullCommitSchema,
    root: z.object({
      path: z.literal('skills/SKILL.md'),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }).strict(),
    contributor: z.object({
      path: z.literal('skills/roles/contributor.md'),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }).strict(),
    evaluator: z.object({
      path: z.literal('skills/roles/evaluator.md'),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }).strict(),
  }).strict(),
}).strict()

const fixtureUrl = new URL('../fixtures/repository/activity-window.json', import.meta.url)
const fixtureText = readFileSync(fixtureUrl, 'utf8')
const fixture = fixtureSchema.parse(JSON.parse(fixtureText))
const rootBytes = readFileSync(new URL('../fixtures/skill/tawg.md', import.meta.url))
const contributorBytes = readFileSync(new URL('../fixtures/skill/contributor.md', import.meta.url))
const evaluatorBytes = readFileSync(new URL('../fixtures/skill/evaluator.md', import.meta.url))

type ProfilePoint = z.infer<typeof profilePointSchema>

function snapshot(point: ProfilePoint): ProfileSnapshot {
  return {
    chainId: fixture.profile.chain_id,
    tawgAddress: fixture.profile.tawg_address,
    blockNumber: point.block_number,
    blockHash: point.block_hash,
    version: point.version,
    governance: fixture.profile.governance,
    identityRegistry: fixture.profile.identity_registry,
    charter: {
      repository: fixture.profile.repository_url,
      commitHash: point.charter_commit,
      path: 'charter/',
    },
    agentIds: [],
    dataEntries: [],
    workflow: { workflowAddress: fixture.profile.workflow_address, data: '{}' },
  }
}

class MutableProfileReader implements ProfileReader {
  readonly calls: ChainSelector[] = []
  latest: 'initial' | 'advanced' = 'initial'

  async readProfile(selector: ChainSelector): Promise<ProfileSnapshot> {
    this.calls.push(selector)
    if (selector.kind === 'latest') return snapshot(fixture.profile[this.latest])
    if (selector.kind === 'block_hash') {
      if (selector.blockHash === fixture.profile.initial.block_hash) return snapshot(fixture.profile.initial)
      if (selector.blockHash === fixture.profile.advanced.block_hash) return snapshot(fixture.profile.advanced)
    }
    throw new Error('Acceptance Profile selector was not prepared.')
  }

  async readAgent(): Promise<never> {
    throw new Error('Agent reads are not part of this acceptance flow.')
  }
}

function rawActivityItems() {
  return fixture.activity.issues_and_pull_requests.map((item) => ({
    node_id: item.node_id,
    number: item.provider_number,
    title: item.title,
    state: item.state,
    user: item.author === null ? null : { login: item.author },
    created_at: item.created_at,
    updated_at: item.updated_at,
    html_url: item.url,
    ...(item.kind === 'pull_request' ? { pull_request: {} } : {}),
  }))
}

function rawCommits() {
  return fixture.activity.commits.map((item) => ({
    sha: item.commit,
    commit: {
      message: item.message,
      author: item.author_name === null ? null : { name: item.author_name },
      committer: { date: item.committed_at },
    },
    author: item.author_login === null ? null : { login: item.author_login },
    html_url: item.url,
  }))
}

function rawFile(path: string, bytes: Buffer) {
  return {
    type: 'file',
    encoding: 'base64',
    content: bytes.toString('base64'),
    size: bytes.byteLength,
    path,
  }
}

function setup() {
  const reader = new MutableProfileReader()
  const profileResolver = new ProfileResolver(reader, {
    chainId: fixture.profile.chain_id,
    tawgAddress: fixture.profile.tawg_address,
  })
  const repositoryResolver = createRepositoryResolver(profileResolver)
  const transport = new RecordingGitHubRequest()
  const client = createGitHubRepositoryClient(transport)
  let now = fixture.activity.observed_at
  return {
    reader,
    transport,
    setClock: (value: string) => { now = value },
    repository: createRepositoryService(repositoryResolver, client, () => new Date(now)),
    skills: {
      tawg: createTawgSkillLoader(repositoryResolver, client),
      role: createRoleSkillLoader(repositoryResolver, client),
    },
  }
}

describe('Repository and Role Skill acceptance fixtures', () => {
  it('contains immutable public sources, mixed opaque activity, full commits, and exact Skill digests', () => {
    expect(fixture.profile.repository_url).toBe('https://github.com/trustless-ai/tawg-demo')
    expect(fixture.activity.issues_and_pull_requests.map(({ kind }) => kind)).toContain('issue')
    expect(fixture.activity.issues_and_pull_requests.map(({ kind }) => kind)).toContain('pull_request')
    for (const item of fixture.activity.issues_and_pull_requests) {
      expect(item.node_id).not.toMatch(/^\d+$/)
      expect(item.expected_number).toBe(String(item.provider_number))
    }
    expect(fixture.activity.commits.at(-1)?.committed_at).toBe(fixture.activity.since)
    expect(createHash('sha256').update(rootBytes).digest('hex')).toBe(fixture.skills.root.sha256)
    expect(createHash('sha256').update(contributorBytes).digest('hex')).toBe(fixture.skills.contributor.sha256)
    expect(createHash('sha256').update(evaluatorBytes).digest('hex')).toBe(fixture.skills.evaluator.sha256)
    expect(fixtureText).not.toMatch(/github_pat_|gh[pousr]_|Bearer |rpc.?url|private.?key|file:\/\/|\/Users\//i)
    expect(fixtureText).not.toMatch(/<script|child_process|exec\(|spawn\(/i)
  })

  it('runs Repository discovery and all activity flows while a cursor pins the first Profile and observation', async () => {
    const app = setup()
    const source = await app.repository.getRepository({ kind: 'latest' })
    expect(source).toMatchObject({
      locator: fixture.profile.repository_url,
      profile: {
        blockNumber: fixture.profile.initial.block_number,
        blockHash: fixture.profile.initial.block_hash,
        version: fixture.profile.initial.version,
      },
      charter: { commit: fixture.profile.initial.charter_commit, path: 'charter/' },
    })
    expect(app.transport.calls).toEqual([])

    app.transport.enqueue(rawActivityItems())
    const first = await app.repository.listActivity({
      tool: 'repo.issue.list',
      since: fixture.activity.since,
      limit: 1,
      credential: { type: 'inline', secret: 'acceptance-operation-secret' },
    })
    expect(first.items).toEqual([{
      id: 'I_kwDONewestOpaque', number: '2147483647', title: 'Newest contribution proposal',
      state: 'open', author: 'alice', createdAt: '2026-08-23T02:30:00Z', updatedAt: '2026-08-23T02:45:00Z',
      url: 'https://github.com/trustless-ai/tawg-demo/issues/2147483647',
    }])
    expect(first.observedAt).toBe(fixture.activity.observed_at)
    expect(first.page.nextCursor).toEqual(expect.any(String))

    app.reader.latest = 'advanced'
    app.setClock(fixture.activity.advanced_clock)
    app.transport.enqueue(rawActivityItems())
    const second = await app.repository.listActivity({
      tool: 'repo.issue.list',
      since: fixture.activity.since,
      limit: 1,
      cursor: first.page.nextCursor,
    })
    expect(second.items).toEqual([{
      id: 'I_kwDOBoundaryOpaque', number: '2147483645', title: 'Inclusive boundary proposal',
      state: 'closed', author: null, createdAt: fixture.activity.since, updatedAt: '2026-08-23T01:30:00Z',
      url: 'https://github.com/trustless-ai/tawg-demo/issues/2147483645',
    }])
    expect(second.observedAt).toBe(fixture.activity.observed_at)
    expect(second.source.profile).toEqual({
      blockNumber: fixture.profile.initial.block_number,
      blockHash: fixture.profile.initial.block_hash,
      version: fixture.profile.initial.version,
    })

    app.transport.enqueue(rawActivityItems())
    const pullRequests = await app.repository.listActivity({
      tool: 'repo.pull_request.list', since: fixture.activity.since,
    })
    expect(pullRequests.items.map(({ id, number }) => ({ id, number }))).toEqual([
      { id: 'PR_kwDOReviewOpaque', number: '2147483646' },
    ])

    app.transport.enqueue(rawCommits())
    const commits = await app.repository.listActivity({
      tool: 'repo.commit.list', since: fixture.activity.since,
    })
    expect(commits.items.map(({ commit, committedAt }) => ({ commit, committedAt }))).toEqual([
      { commit: 'c'.repeat(40), committedAt: '2026-08-23T02:45:00Z' },
      { commit: 'd'.repeat(40), committedAt: fixture.activity.since },
    ])
    expect(app.reader.calls).toEqual([
      { kind: 'latest' },
      { kind: 'latest' },
      { kind: 'block_hash', blockHash: fixture.profile.initial.block_hash },
      { kind: 'latest' },
      { kind: 'latest' },
    ])
    expect(app.transport.calls.map(({ authenticated }) => authenticated)).toEqual([true, false, false, false])
    expect(JSON.stringify([first, second, app.transport.calls])).not.toContain('acceptance-operation-secret')
    app.transport.assertDone()
  })

  it('loads Root and Role Skills through independent current-HEAD resolutions', async () => {
    const app = setup()
    app.transport.enqueue({ default_branch: 'main' })
    app.transport.enqueue({ sha: fixture.skills.initial_head })
    app.transport.enqueue(rawFile(fixture.skills.root.path, rootBytes))
    const root = await app.skills.tawg.get({
      credential: { type: 'inline', secret: 'acceptance-operation-secret' },
    })
    expect(root.source).toMatchObject({
      repositoryUrl: fixture.profile.repository_url,
      commit: fixture.skills.initial_head,
      path: fixture.skills.root.path,
      profile: {
        blockNumber: fixture.profile.initial.block_number,
        blockHash: fixture.profile.initial.block_hash,
        version: fixture.profile.initial.version,
      },
      contentDigest: { algorithm: 'sha256', value: fixture.skills.root.sha256 },
    })

    app.reader.latest = 'advanced'
    app.transport.enqueue({ default_branch: 'main' })
    app.transport.enqueue({ sha: fixture.skills.advanced_head })
    app.transport.enqueue(rawFile(fixture.skills.contributor.path, contributorBytes))
    const contributor = await app.skills.role.get({ role: 'contributor' })
    expect(contributor.source).toMatchObject({
      commit: fixture.skills.advanced_head,
      path: fixture.skills.contributor.path,
      profile: {
        blockNumber: fixture.profile.advanced.block_number,
        blockHash: fixture.profile.advanced.block_hash,
        version: fixture.profile.advanced.version,
      },
      contentDigest: { algorithm: 'sha256', value: fixture.skills.contributor.sha256 },
    })

    app.transport.enqueue({ default_branch: 'main' })
    app.transport.enqueue({ sha: fixture.skills.advanced_head })
    app.transport.enqueue(rawFile(fixture.skills.evaluator.path, evaluatorBytes))
    const evaluator = await app.skills.role.get({ role: 'evaluator' })
    expect(evaluator.source).toMatchObject({
      commit: fixture.skills.advanced_head,
      path: fixture.skills.evaluator.path,
      contentDigest: { algorithm: 'sha256', value: fixture.skills.evaluator.sha256 },
    })
    expect(app.transport.calls.map(({ route }) => route)).toEqual([
      'GET /repos/{owner}/{repo}',
      'GET /repos/{owner}/{repo}/commits/{ref}',
      'GET /repos/{owner}/{repo}/contents/{path}',
      'GET /repos/{owner}/{repo}',
      'GET /repos/{owner}/{repo}/commits/{ref}',
      'GET /repos/{owner}/{repo}/contents/{path}',
      'GET /repos/{owner}/{repo}',
      'GET /repos/{owner}/{repo}/commits/{ref}',
      'GET /repos/{owner}/{repo}/contents/{path}',
    ])
    expect(app.transport.calls[5]?.parameters).toMatchObject({
      path: fixture.skills.contributor.path,
      ref: fixture.skills.advanced_head,
    })
    expect(app.transport.calls[8]?.parameters).toMatchObject({
      path: fixture.skills.evaluator.path,
      ref: fixture.skills.advanced_head,
    })
    expect(app.reader.calls).toEqual([{ kind: 'latest' }, { kind: 'latest' }, { kind: 'latest' }])
    expect(JSON.stringify([root, contributor, evaluator, app.transport.calls])).not.toContain('acceptance-operation-secret')
    app.transport.assertDone()
  })
})
