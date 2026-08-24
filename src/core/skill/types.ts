export interface SkillContentDigest {
  readonly algorithm: 'sha256'
  readonly value: string
}

export interface SkillMarkdownContent {
  readonly mediaType: 'text/markdown; charset=utf-8'
  readonly encoding: 'utf8'
  readonly value: string
}

export interface BundledSkillArtifact<Name extends string, Path extends string> {
  readonly skill: {
    readonly name: Name
    readonly package: '@trustless-ai/tas'
    readonly version: string
  }
  readonly source: {
    readonly kind: 'release'
    readonly path: Path
    readonly contentDigest: SkillContentDigest
  }
  readonly content: SkillMarkdownContent
}

export type TasSkillArtifact = BundledSkillArtifact<'tas', 'skills/tas/SKILL.md'>

export type CollaborationSkillArtifact = BundledSkillArtifact<
  'tawg-collaboration',
  'skills/tawg-collaboration/SKILL.md'
>

export type TawgSkillPath = 'skills/SKILL.md'
export type RoleSkillPath = `skills/roles/${string}.md`
export type RepositorySkillPath = TawgSkillPath | RoleSkillPath

export interface RepositorySkillSource<Path extends RepositorySkillPath> {
  readonly kind: 'repository'
  readonly repositoryUrl: `https://github.com/${string}/${string}`
  readonly commit: string
  readonly path: Path
  /** Exact Profile snapshot that selected the Repository for this same content read. */
  readonly profile: {
    readonly blockNumber: string
    readonly blockHash: `0x${string}`
    readonly version: string
  }
  readonly contentDigest: SkillContentDigest
}

export interface TawgSkillGetResult {
  readonly skill: { readonly name: 'tawg' }
  readonly source: RepositorySkillSource<TawgSkillPath>
  readonly content: SkillMarkdownContent
}

export interface RoleSkillGetResult {
  readonly skill: {
    readonly name: 'role'
    readonly role: string
  }
  readonly source: RepositorySkillSource<RoleSkillPath>
  readonly content: SkillMarkdownContent
}
