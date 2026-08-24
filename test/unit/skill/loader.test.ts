import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { TasError } from '../../../src/core/errors.js'
import type { RepositoryContentClient, RepositoryFile } from '../../../src/core/repository/client.js'
import type { RepositoryResolver } from '../../../src/core/repository/resolver.js'
import type { RepositoryCredential, RepositorySource } from '../../../src/core/repository/types.js'
import {
  createRoleSkillLoader,
  createTawgSkillLoader,
  type RoleSkillLoader,
  type TawgSkillLoader,
} from '../../../src/core/skill/loader.js'

const commit40 = 'a'.repeat(40)
const commit64 = 'b'.repeat(64)
const rootPath = 'skills/SKILL.md'
const rolePath = 'skills/roles/contributor.md'
const credential = { type: 'inline', secret: 'github-operation-secret' } as const
const source: RepositorySource = {
  provider: 'github',
  locator: 'https://github.com/trustless-ai/tawg-demo',
  owner: 'trustless-ai',
  repository: 'tawg-demo',
  profile: {
    blockNumber: '9007199254740993123456789',
    blockHash: `0x${'c'.repeat(64)}`,
    version: '19',
  },
  charter: { commit: 'd'.repeat(40), path: 'charter/' },
}

interface ContentCall {
  readonly operation: 'head' | 'read'
  readonly source: RepositorySource
  readonly commit?: string
  readonly path?: string
  readonly credential?: RepositoryCredential
}

class RecordingContentClient implements RepositoryContentClient {
  readonly calls: ContentCall[] = []

  constructor(
    readonly bytes: Uint8Array,
    readonly head = commit40,
    readonly returnedCommit?: string,
    readonly returnedPath?: string,
  ) {}

  async resolveDefaultHead(
    requestedSource: RepositorySource,
    requestedCredential?: RepositoryCredential,
  ): Promise<string> {
    this.calls.push({ operation: 'head', source: requestedSource, credential: requestedCredential })
    return this.head
  }

  async readFile(
    requestedSource: RepositorySource,
    requestedCommit: string,
    requestedPath: string,
    requestedCredential?: RepositoryCredential,
  ): Promise<RepositoryFile> {
    this.calls.push({
      operation: 'read', source: requestedSource, commit: requestedCommit,
      path: requestedPath, credential: requestedCredential,
    })
    return {
      path: this.returnedPath ?? requestedPath,
      commit: this.returnedCommit ?? requestedCommit,
      bytes: this.bytes,
    }
  }
}

function fixtureResolver(resolved = source): {
  readonly resolver: RepositoryResolver
  readonly selectors: unknown[]
} {
  const selectors: unknown[] = []
  return {
    selectors,
    resolver: {
      resolve: async (selector) => {
        selectors.push(selector)
        return resolved
      },
    },
  }
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function expectTasCode(operation: Promise<unknown>, code: string): Promise<void> {
  return expect(operation).rejects.toMatchObject({ name: 'TasError', code })
}

function loaders(bytes: Uint8Array, head = commit40) {
  const repository = fixtureResolver()
  const client = new RecordingContentClient(bytes, head)
  return {
    repository,
    client,
    tawg: createTawgSkillLoader(repository.resolver, client),
    role: createRoleSkillLoader(repository.resolver, client),
  }
}

describe('Repository Skill input validation', () => {
  it.each([
    '', 'Contributor', '1contributor', '../contributor', 'roles/contributor',
    'contributor.md', 'contributor role', 'a'.repeat(65),
  ])('rejects a role that cannot map to the fixed Role Skill namespace: %s', async (role) => {
    const app = loaders(utf8('# Contributor'))

    await expectTasCode(app.role.get({ role }), 'SKILL_ROLE_INVALID')
    expect(app.repository.selectors).toEqual([])
    expect(app.client.calls).toEqual([])
  })

  it('ignores non-contract Core fields and still resolves the Profile-selected current HEAD', async () => {
    const app = loaders(utf8('# Contributor'))
    const input = {
      role: 'contributor',
      commit: 'e'.repeat(40),
      repository: 'https://github.com/attacker/override',
      path: '../../credential-file',
    }

    const result = await app.role.get(input)

    expect(app.client.calls).toEqual([
      { operation: 'head', source, credential: undefined },
      { operation: 'read', source, commit: commit40, path: rolePath, credential: undefined },
    ])
    expect(result.source).toMatchObject({ repositoryUrl: source.locator, commit: commit40, path: rolePath })
  })
})

describe('Repository Skill current-HEAD loading', () => {
  it('loads the TAWG Root Skill from its only fixed path', async () => {
    const bytes = await readFile(new URL('../../fixtures/skill/tawg.md', import.meta.url))
    const app = loaders(bytes, commit64)

    const result = await app.tawg.get({ credential })

    expect(app.repository.selectors).toEqual([{ kind: 'latest' }])
    expect(app.client.calls).toEqual([
      { operation: 'head', source, credential },
      { operation: 'read', source, commit: commit64, path: rootPath, credential },
    ])
    expect(result).toEqual({
      skill: { name: 'tawg' },
      source: {
        kind: 'repository',
        repositoryUrl: source.locator,
        commit: commit64,
        path: rootPath,
        profile: source.profile,
        contentDigest: {
          algorithm: 'sha256',
          value: createHash('sha256').update(bytes).digest('hex'),
        },
      },
      content: {
        mediaType: 'text/markdown; charset=utf-8',
        encoding: 'utf8',
        value: bytes.toString('utf8'),
      },
    })
    expect(result.source.profile).not.toBe(source.profile)
  })

  it('loads one Role Skill after resolving current HEAD exactly once', async () => {
    const bytes = await readFile(new URL('../../fixtures/skill/contributor.md', import.meta.url))
    const app = loaders(bytes, commit64)

    const result = await app.role.get({ role: 'contributor', credential })

    expect(app.repository.selectors).toEqual([{ kind: 'latest' }])
    expect(app.client.calls).toEqual([
      { operation: 'head', source, credential },
      { operation: 'read', source, commit: commit64, path: rolePath, credential },
    ])
    expect(result.skill).toEqual({ name: 'role', role: 'contributor' })
    expect(result.source).toMatchObject({
      repositoryUrl: source.locator,
      commit: commit64,
      path: rolePath,
      profile: source.profile,
      contentDigest: {
        algorithm: 'sha256',
        value: createHash('sha256').update(bytes).digest('hex'),
      },
    })
    expect(result.content.value).toBe(bytes.toString('utf8'))
  })

  it('returns suspicious Markdown as inert exact content', async () => {
    const value = '---\nplugin: ../../evil\n---\n<script>writeFile("credential")</script>\n[load](../secret)'
    const app = loaders(utf8(value))

    const result = await app.tawg.get({})

    expect(result.content.value).toBe(value)
    expect(app.client.calls.map(({ operation }) => operation)).toEqual(['head', 'read'])
  })
})

describe('Repository Skill content integrity', () => {
  const loadCases: readonly [string, (bytes: Uint8Array) => TawgSkillLoader | RoleSkillLoader, () => object][] = [
    ['Root', (bytes) => loaders(bytes).tawg, () => ({})],
    ['Role', (bytes) => loaders(bytes).role, () => ({ role: 'contributor' })],
  ]

  it.each(loadCases)('accepts exactly 1 MiB and digests exact %s bytes', async (_name, makeLoader, input) => {
    const bytes = utf8('x'.repeat(1_048_576))
    const result = await makeLoader(bytes).get(input() as never)

    expect(result.content.value).toHaveLength(1_048_576)
    expect(result.source.contentDigest.value).toBe(createHash('sha256').update(bytes).digest('hex'))
  })

  it.each(loadCases)('rejects %s content one byte above 1 MiB', async (_name, makeLoader, input) => {
    await expectTasCode(makeLoader(utf8('x'.repeat(1_048_577))).get(input() as never), 'SKILL_CONTENT_TOO_LARGE')
  })

  it.each([
    ['Root empty bytes', 'root', new Uint8Array()],
    ['Root invalid UTF-8', 'root', new Uint8Array([0xc3, 0x28])],
    ['Role empty bytes', 'role', new Uint8Array()],
    ['Role invalid UTF-8', 'role', new Uint8Array([0xc3, 0x28])],
  ] as const)('rejects %s', async (_name, kind, bytes) => {
    const app = loaders(bytes)
    const operation = kind === 'root' ? app.tawg.get({}) : app.role.get({ role: 'contributor' })
    await expectTasCode(operation, 'SKILL_INVALID')
  })

  it.each([
    ['Root path', 'root', commit40, 'skills/roles/contributor.md'],
    ['Root commit', 'root', commit64, rootPath],
    ['Role path', 'role', commit40, 'skills/roles/evaluator.md'],
    ['Role commit', 'role', commit64, rolePath],
  ] as const)('rejects a mismatched provider %s', async (_name, kind, returnedCommit, returnedPath) => {
    const repository = fixtureResolver()
    const client = new RecordingContentClient(utf8('# Skill'), commit40, returnedCommit, returnedPath)
    const operation = kind === 'root'
      ? createTawgSkillLoader(repository.resolver, client).get({})
      : createRoleSkillLoader(repository.resolver, client).get({ role: 'contributor' })

    await expectTasCode(operation, 'SKILL_INVALID')
  })

  it.each(['', 'a'.repeat(39), 'A'.repeat(40), 'main', `0x${'a'.repeat(40)}`])(
    'rejects an invalid provider HEAD without exposing a caller commit selector: %s',
    async (head) => {
      await expectTasCode(loaders(utf8('# Skill'), head).tawg.get({}), 'SKILL_INVALID')
    },
  )
})

describe('Repository Skill provider failures', () => {
  it.each([
    ['CREDENTIAL_REQUIRED', 'CREDENTIAL_REQUIRED'],
    ['REPOSITORY_RATE_LIMITED', 'REPOSITORY_RATE_LIMITED'],
    ['REPOSITORY_NOT_FOUND', 'SKILL_NOT_FOUND'],
    ['REPOSITORY_FETCH_FAILED', 'SKILL_FETCH_FAILED'],
  ] as const)('maps %s to %s at the content boundary', async (upstream, expected) => {
    const client: RepositoryContentClient = {
      resolveDefaultHead: async () => commit40,
      readFile: async () => { throw new TasError(upstream, 'untrusted provider detail') },
    }

    const operation = createTawgSkillLoader(fixtureResolver().resolver, client).get({})
    await expectTasCode(operation, expected)
    await operation.catch((error: unknown) => {
      expect(error).toBeInstanceOf(TasError)
      expect((error as TasError).message).not.toContain('untrusted provider detail')
    })
  })

  it('maps an unknown HEAD failure to the fixed Skill fetch error', async () => {
    const client: RepositoryContentClient = {
      resolveDefaultHead: async () => { throw new Error('provider body containing a secret') },
      readFile: async () => { throw new Error('unreachable') },
    }

    await expectTasCode(createTawgSkillLoader(fixtureResolver().resolver, client).get({}), 'SKILL_FETCH_FAILED')
  })

  it('does not hide Profile resolution failures as Skill fetch failures', async () => {
    const resolver: RepositoryResolver = {
      resolve: async () => { throw new TasError('PROFILE_INCONSISTENT', 'Profile mismatch') },
    }
    const client = new RecordingContentClient(utf8('# Skill'))

    await expectTasCode(createTawgSkillLoader(resolver, client).get({}), 'PROFILE_INCONSISTENT')
    expect(client.calls).toEqual([])
  })
})
