import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, expectTypeOf, it } from 'vitest'

import type {
  ActivityWindow,
  RepositoryCommit,
  RepositoryCredential,
  RepositoryIssue,
  RepositoryPage,
  RepositoryPullRequest,
  RepositorySource,
} from '../../../src/core/repository/types.js'
import type {
  RepositoryActivityClient,
  RepositoryClient,
  RepositoryContentClient,
  RepositoryFile,
} from '../../../src/core/repository/client.js'
import type {
  RepositorySkillSource,
  RoleSkillGetResult,
  RoleSkillPath,
  TawgSkillGetResult,
  TawgSkillPath,
} from '../../../src/core/skill/types.js'

const packagePath = fileURLToPath(new URL('../../../package.json', import.meta.url))

type IfEqual<X, Y, Then = true, Else = false> =
  (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? Then : Else
type IsReadonly<T, K extends keyof T> = IfEqual<
  { [P in K]: T[P] },
  { -readonly [P in K]: T[P] },
  false,
  true
>
type Assert<T extends true> = T

describe('Repository and Role Skill domain contracts', () => {
  it('pins the GitHub request adapter dependency', () => {
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      dependencies?: Record<string, unknown>
    }

    expect(pkg.dependencies?.['@octokit/request']).toBe('10.0.14')
  })

  it('keeps Repository source, activity, and page contracts provider-neutral and readonly', () => {
    expectTypeOf<RepositorySource['provider']>().toEqualTypeOf<'github'>()
    expectTypeOf<RepositorySource['locator']>().toEqualTypeOf<`https://github.com/${string}/${string}`>()
    expectTypeOf<RepositorySource['charter']['path']>().toEqualTypeOf<'charter/'>()
    expectTypeOf<RepositoryCredential>().toEqualTypeOf<{
      readonly type: 'inline'
      readonly secret: string
    }>()
    expectTypeOf<RepositoryPullRequest>().toEqualTypeOf<RepositoryIssue>()
    expectTypeOf<RepositoryPage<RepositoryCommit>['items']>().toEqualTypeOf<readonly RepositoryCommit[]>()
    expectTypeOf<RepositoryPage<RepositoryCommit>['nextPosition']>().toEqualTypeOf<
      { readonly providerPage: number; readonly providerOffset: number } | undefined
    >()

    type _SourceProviderReadonly = Assert<IsReadonly<RepositorySource, 'provider'>>
    type _IssueIdReadonly = Assert<IsReadonly<RepositoryIssue, 'id'>>
    type _CommitHashReadonly = Assert<IsReadonly<RepositoryCommit, 'commit'>>
    type _WindowSinceReadonly = Assert<IsReadonly<ActivityWindow, 'since'>>
    type _PageItemsReadonly = Assert<IsReadonly<RepositoryPage<RepositoryIssue>, 'items'>>
    const compileTimeAssertions: readonly [
      _SourceProviderReadonly,
      _IssueIdReadonly,
      _CommitHashReadonly,
      _WindowSinceReadonly,
      _PageItemsReadonly,
    ] = [true, true, true, true, true]
    expect(compileTimeAssertions).toEqual([true, true, true, true, true])
  })

  it('defines separate activity and content ports and their intersection', () => {
    expectTypeOf<RepositoryActivityClient['listIssues']>().parameter(0).toEqualTypeOf<RepositorySource>()
    expectTypeOf<RepositoryActivityClient['listIssues']>().parameter(1).toEqualTypeOf<ActivityWindow>()
    expectTypeOf<RepositoryActivityClient['listIssues']>().parameter(2).toEqualTypeOf<RepositoryCredential | undefined>()
    expectTypeOf<ReturnType<RepositoryActivityClient['listIssues']>>()
      .toEqualTypeOf<Promise<RepositoryPage<RepositoryIssue>>>()
    expectTypeOf<ReturnType<RepositoryActivityClient['listPullRequests']>>()
      .toEqualTypeOf<Promise<RepositoryPage<RepositoryPullRequest>>>()
    expectTypeOf<ReturnType<RepositoryActivityClient['listCommits']>>()
      .toEqualTypeOf<Promise<RepositoryPage<RepositoryCommit>>>()
    expectTypeOf<ReturnType<RepositoryContentClient['resolveDefaultHead']>>()
      .toEqualTypeOf<Promise<string>>()
    expectTypeOf<ReturnType<RepositoryContentClient['readFile']>>()
      .toEqualTypeOf<Promise<RepositoryFile>>()
    expectTypeOf<RepositoryClient>().toMatchTypeOf<RepositoryActivityClient>()
    expectTypeOf<RepositoryClient>().toMatchTypeOf<RepositoryContentClient>()
  })

  it('matches the immutable TAWG Root and Role Skill logical result contracts', () => {
    expectTypeOf<TawgSkillGetResult['skill']>().toEqualTypeOf<{ readonly name: 'tawg' }>()
    expectTypeOf<TawgSkillGetResult['source']>().toEqualTypeOf<RepositorySkillSource<TawgSkillPath>>()
    expectTypeOf<TawgSkillGetResult['source']['path']>().toEqualTypeOf<'skills/SKILL.md'>()
    expectTypeOf<RoleSkillGetResult['skill']>().toEqualTypeOf<{
      readonly name: 'role'
      readonly role: string
    }>()
    expectTypeOf<RoleSkillGetResult['source']>().toEqualTypeOf<RepositorySkillSource<RoleSkillPath>>()
    expectTypeOf<RoleSkillGetResult['source']['repositoryUrl']>()
      .toEqualTypeOf<`https://github.com/${string}/${string}`>()
    expectTypeOf<RoleSkillGetResult['source']['path']>()
      .toEqualTypeOf<`skills/roles/${string}.md`>()
    expectTypeOf<RoleSkillGetResult['source']['contentDigest']['algorithm']>()
      .toEqualTypeOf<'sha256'>()
    expectTypeOf<RoleSkillGetResult['content']['mediaType']>()
      .toEqualTypeOf<'text/markdown; charset=utf-8'>()
    expectTypeOf<RoleSkillGetResult['content']['encoding']>().toEqualTypeOf<'utf8'>()

    type _TawgSkillReadonly = Assert<IsReadonly<TawgSkillGetResult, 'skill'>>
    type _RoleSkillReadonly = Assert<IsReadonly<RoleSkillGetResult, 'skill'>>
    type _SourceReadonly = Assert<IsReadonly<RoleSkillGetResult, 'source'>>
    type _ContentReadonly = Assert<IsReadonly<RoleSkillGetResult, 'content'>>
    const compileTimeAssertions: readonly [
      _TawgSkillReadonly,
      _RoleSkillReadonly,
      _SourceReadonly,
      _ContentReadonly,
    ] = [true, true, true, true]
    expect(compileTimeAssertions).toEqual([true, true, true, true])
  })
})
