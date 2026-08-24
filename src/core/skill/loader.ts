import { createHash } from 'node:crypto'

import { TasError } from '../errors.js'
import type { RepositoryContentClient } from '../repository/client.js'
import type { RepositoryResolver } from '../repository/resolver.js'
import type { RepositoryCredential } from '../repository/types.js'
import type {
  RepositorySkillPath,
  RoleSkillGetResult,
  RoleSkillPath,
  TawgSkillGetResult,
  TawgSkillPath,
} from './types.js'

const rolePattern = /^[a-z][a-z0-9_-]{0,63}$/
const fullCommitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const maxContentBytes = 1_048_576

export interface RoleSkillGetInput {
  readonly role: string
  readonly credential?: RepositoryCredential
}

export interface TawgSkillGetInput {
  readonly credential?: RepositoryCredential
}

export interface RoleSkillLoader {
  get(input: RoleSkillGetInput): Promise<RoleSkillGetResult>
}

export interface TawgSkillLoader {
  get(input: TawgSkillGetInput): Promise<TawgSkillGetResult>
}

function invalidRole(): never {
  throw new TasError('SKILL_ROLE_INVALID', 'The Role Skill identifier is invalid.')
}

function invalidContent(): never {
  throw new TasError('SKILL_INVALID', 'The requested Skill content is invalid.')
}

function requireRole(value: unknown): string {
  return typeof value === 'string' && rolePattern.test(value) ? value : invalidRole()
}

function requireCommit(value: unknown): string {
  return typeof value === 'string' && fullCommitPattern.test(value) ? value : invalidContent()
}

function mapContentClientFailure(error: unknown): never {
  if (error instanceof TasError) {
    if (error.code === 'CREDENTIAL_REQUIRED') {
      throw new TasError('CREDENTIAL_REQUIRED', 'A valid operation credential is required.')
    }
    if (error.code === 'REPOSITORY_RATE_LIMITED') {
      throw new TasError('REPOSITORY_RATE_LIMITED', 'The Repository provider rate limit was reached.')
    }
    if (error.code === 'REPOSITORY_NOT_FOUND') {
      throw new TasError('SKILL_NOT_FOUND', 'The requested Skill was not found.')
    }
  }
  throw new TasError('SKILL_FETCH_FAILED', 'The requested Skill could not be read.')
}

async function loadRepositorySkill<Path extends RepositorySkillPath>(
  repositoryResolver: RepositoryResolver,
  contentClient: RepositoryContentClient,
  path: Path,
  credential: RepositoryCredential | undefined,
): Promise<{
  readonly source: {
    readonly kind: 'repository'
    readonly repositoryUrl: `https://github.com/${string}/${string}`
    readonly commit: string
    readonly path: Path
    readonly profile: {
      readonly blockNumber: string
      readonly blockHash: `0x${string}`
      readonly version: string
    }
    readonly contentDigest: { readonly algorithm: 'sha256'; readonly value: string }
  }
  readonly content: {
    readonly mediaType: 'text/markdown; charset=utf-8'
    readonly encoding: 'utf8'
    readonly value: string
  }
}> {
  const source = await repositoryResolver.resolve({ kind: 'latest' })
  const commit = requireCommit(await contentClientCall(
    () => contentClient.resolveDefaultHead(source, credential),
  ))
  const file = await contentClientCall(
    () => contentClient.readFile(source, commit, path, credential),
  )

  if (file.path !== path || file.commit !== commit) invalidContent()
  if (file.bytes.byteLength > maxContentBytes) {
    throw new TasError('SKILL_CONTENT_TOO_LARGE', 'The requested Skill exceeds the content size limit.')
  }
  if (file.bytes.byteLength === 0) invalidContent()

  let value: string
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)
  } catch {
    return invalidContent()
  }
  if (value.length === 0) invalidContent()

  return {
    source: {
      kind: 'repository',
      repositoryUrl: source.locator,
      commit,
      path,
      profile: {
        blockNumber: source.profile.blockNumber,
        blockHash: source.profile.blockHash,
        version: source.profile.version,
      },
      contentDigest: {
        algorithm: 'sha256',
        value: createHash('sha256').update(file.bytes).digest('hex'),
      },
    },
    content: {
      mediaType: 'text/markdown; charset=utf-8',
      encoding: 'utf8',
      value,
    },
  }
}

export function createTawgSkillLoader(
  repositoryResolver: RepositoryResolver,
  contentClient: RepositoryContentClient,
): TawgSkillLoader {
  const path: TawgSkillPath = 'skills/SKILL.md'
  return {
    async get(input: TawgSkillGetInput): Promise<TawgSkillGetResult> {
      const loaded = await loadRepositorySkill(repositoryResolver, contentClient, path, input.credential)
      return { skill: { name: 'tawg' }, ...loaded }
    },
  }
}

async function contentClientCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    return mapContentClientFailure(error)
  }
}

export function createRoleSkillLoader(
  repositoryResolver: RepositoryResolver,
  contentClient: RepositoryContentClient,
): RoleSkillLoader {
  return {
    async get(input: RoleSkillGetInput): Promise<RoleSkillGetResult> {
      const role = requireRole(input.role)
      const path = `skills/roles/${role}.md` as RoleSkillPath
      const loaded = await loadRepositorySkill(repositoryResolver, contentClient, path, input.credential)
      return { skill: { name: 'role', role }, ...loaded }
    },
  }
}
