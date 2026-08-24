import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { TasError } from '../core/errors.js'
import type { RoleSkillLoader, TawgSkillLoader } from '../core/skill/loader.js'
import type {
  CollaborationSkillArtifact,
  RoleSkillGetResult,
  TasSkillArtifact,
  TawgSkillGetResult,
} from '../core/skill/types.js'
import {
  createTasResultBuilder,
  type PublicJsonObject,
  type TasPublicInstance,
} from './results.js'

const maxUint256 = 2n ** 256n - 1n
const canonicalDecimalSchema = z.string().max(78).regex(/^(?:0|[1-9][0-9]*)$/).refine((value) => {
  try { return BigInt(value) <= maxUint256 } catch { return false }
})
const positiveCanonicalDecimalSchema = z.string().max(78).regex(/^[1-9][0-9]*$/).refine((value) => {
  try { return BigInt(value) <= maxUint256 } catch { return false }
})
const evmAddressSchema = z.string().regex(/^0x(?!0{40}$)[0-9a-fA-F]{40}$/)
const blockHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const fullCommitSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/)
const roleSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
const repositoryUrlSchema = z.string().regex(/^https:\/\/github\.com\/[^/]+\/[^/]+$/)
const credentialSchema = z.object({
  type: z.literal('inline'),
  secret: z.string().min(1).max(4_096).meta({ writeOnly: true }),
}).strict()

const emptyInputSchema = z.object({}).strict()
const tawgSkillInputSchema = z.object({ credential: credentialSchema.optional() }).strict()
const roleSkillInputSchema = z.object({ role: roleSchema, credential: credentialSchema.optional() }).strict()

const instanceSchema = z.discriminatedUnion('phase', [
  z.object({
    phase: z.literal('identity_setup'), chain_id: positiveCanonicalDecimalSchema,
    identity_registry_address: evmAddressSchema,
  }).strict(),
  z.object({ phase: z.literal('tawg_setup'), chain_id: positiveCanonicalDecimalSchema, tawg_address: evmAddressSchema }).strict(),
  z.object({
    phase: z.literal('member'), chain_id: positiveCanonicalDecimalSchema, tawg_address: evmAddressSchema,
    agent_id: canonicalDecimalSchema,
  }).strict(),
])
const resolutionSchema = z.object({
  chain: z.object({ block_number: canonicalDecimalSchema, block_hash: blockHashSchema }).strict().optional(),
  profile: z.object({ version: positiveCanonicalDecimalSchema }).strict().optional(),
  repository: z.object({ url: repositoryUrlSchema, commit: fullCommitSchema }).strict().optional(),
}).strict()
const contentSchema = z.object({
  media_type: z.literal('text/markdown; charset=utf-8'), encoding: z.literal('utf8'), value: z.string().min(1),
}).strict()
const contentDigestSchema = z.object({ algorithm: z.literal('sha256'), value: digestSchema }).strict()
function releaseSourceSchema<Path extends 'skills/tas/SKILL.md' | 'skills/tawg-collaboration/SKILL.md'>(path: Path) {
  return z.object({
    kind: z.literal('release'), package: z.literal('@trustless-ai/tas'), version: z.string().min(1),
    path: z.literal(path), content_digest: contentDigestSchema,
  }).strict()
}
function repositorySourceSchema<Path extends 'skills/SKILL.md'>(path: Path) {
  return z.object({
    kind: z.literal('repository'), repository_url: repositoryUrlSchema, commit: fullCommitSchema,
    path: z.literal(path), content_digest: contentDigestSchema,
  }).strict()
}
const roleSourceSchema = z.object({
  kind: z.literal('repository'), repository_url: repositoryUrlSchema, commit: fullCommitSchema,
  path: z.string().regex(/^skills\/roles\/[a-z][a-z0-9_-]{0,63}\.md$/), content_digest: contentDigestSchema,
}).strict()
const skillResultContextSchema = z.object({
  instance: instanceSchema,
  request_id: z.string().uuid(),
  resolved: resolutionSchema.optional(),
}).strict()
function skillToolResultSchema<Data extends z.ZodType>(data: Data) {
  return z.object({ context: skillResultContextSchema, data }).strict()
}
const tasSkillResultSchema = skillToolResultSchema(z.object({
  skill: z.object({ name: z.literal('tas') }).strict(),
  source: releaseSourceSchema('skills/tas/SKILL.md'),
  content: contentSchema,
}).strict())
const collaborationSkillResultSchema = skillToolResultSchema(z.object({
  skill: z.object({ name: z.literal('tawg-collaboration') }).strict(),
  source: releaseSourceSchema('skills/tawg-collaboration/SKILL.md'),
  content: contentSchema,
}).strict())
const tawgSkillResultSchema = skillToolResultSchema(z.object({
  skill: z.object({ name: z.literal('tawg') }).strict(),
  source: repositorySourceSchema('skills/SKILL.md'),
  content: contentSchema,
}).strict())
const roleSkillResultSchema = skillToolResultSchema(z.object({
  skill: z.object({ name: z.literal('role'), role: roleSchema }).strict(),
  source: roleSourceSchema,
  content: contentSchema,
}).strict())

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const

export interface SkillToolOptions {
  readonly tas: TasSkillArtifact
  readonly collaboration: CollaborationSkillArtifact
  readonly instance: TasPublicInstance
  readonly tawg?: TawgSkillLoader
  readonly role?: RoleSkillLoader
}

function projectBundledSkill(
  artifact: TasSkillArtifact | CollaborationSkillArtifact,
): PublicJsonObject {
  return {
    skill: { name: artifact.skill.name },
    source: {
      kind: artifact.source.kind,
      package: artifact.skill.package,
      version: artifact.skill.version,
      path: artifact.source.path,
      content_digest: {
        algorithm: artifact.source.contentDigest.algorithm,
        value: artifact.source.contentDigest.value,
      },
    },
    content: {
      media_type: artifact.content.mediaType,
      encoding: artifact.content.encoding,
      value: artifact.content.value,
    },
  }
}

function projectRepositorySkill(result: TawgSkillGetResult | RoleSkillGetResult): PublicJsonObject {
  return {
    skill: result.skill.name === 'role'
      ? { name: result.skill.name, role: result.skill.role }
      : { name: result.skill.name },
    source: {
      kind: result.source.kind,
      repository_url: result.source.repositoryUrl,
      commit: result.source.commit,
      path: result.source.path,
      content_digest: {
        algorithm: result.source.contentDigest.algorithm,
        value: result.source.contentDigest.value,
      },
    },
    content: {
      media_type: result.content.mediaType,
      encoding: result.content.encoding,
      value: result.content.value,
    },
  }
}

function memberContextError(instance: TasPublicInstance) {
  return createTasResultBuilder(instance).toolError(new TasError(
    'SKILL_MEMBER_CONTEXT_REQUIRED',
    'A valid TAWG member context is required to load this Skill.',
  ))
}

function repositorySkillResult(
  instance: Extract<TasPublicInstance, { readonly phase: 'member' }>,
  result: TawgSkillGetResult | RoleSkillGetResult,
) {
  return createTasResultBuilder(instance, {
    chain: {
      block_number: result.source.profile.blockNumber,
      block_hash: result.source.profile.blockHash,
    },
    profile: { version: result.source.profile.version },
    repository: { url: result.source.repositoryUrl, commit: result.source.commit },
  }).success(projectRepositorySkill(result))
}

function invalidLoaderResult(): never {
  throw new TasError('SKILL_INVALID', 'The requested Skill content is invalid.')
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidLoaderResult()
  let prototype: object | null
  try { prototype = Object.getPrototypeOf(value) } catch { return invalidLoaderResult() }
  if (prototype !== Object.prototype && prototype !== null) invalidLoaderResult()
  return value as Record<string, unknown>
}

function ownData(record: Record<string, unknown>, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined
  try { descriptor = Object.getOwnPropertyDescriptor(record, key) } catch { return invalidLoaderResult() }
  if (descriptor === undefined || !('value' in descriptor)) invalidLoaderResult()
  return descriptor.value
}

function ownString(record: Record<string, unknown>, key: string): string {
  const value = ownData(record, key)
  return typeof value === 'string' ? value : invalidLoaderResult()
}

function snapshotRepositorySkill(
  value: unknown,
  expected: 'tawg',
): TawgSkillGetResult
function snapshotRepositorySkill(
  value: unknown,
  expected: 'role',
): RoleSkillGetResult
function snapshotRepositorySkill(
  value: unknown,
  expected: 'tawg' | 'role',
): TawgSkillGetResult | RoleSkillGetResult {
  const result = plainRecord(value)
  const skill = plainRecord(ownData(result, 'skill'))
  const source = plainRecord(ownData(result, 'source'))
  const profile = plainRecord(ownData(source, 'profile'))
  const contentDigest = plainRecord(ownData(source, 'contentDigest'))
  const content = plainRecord(ownData(result, 'content'))

  const stableSource = {
    kind: ownString(source, 'kind'),
    repositoryUrl: ownString(source, 'repositoryUrl'),
    commit: ownString(source, 'commit'),
    path: ownString(source, 'path'),
    profile: {
      blockNumber: ownString(profile, 'blockNumber'),
      blockHash: ownString(profile, 'blockHash'),
      version: ownString(profile, 'version'),
    },
    contentDigest: {
      algorithm: ownString(contentDigest, 'algorithm'),
      value: ownString(contentDigest, 'value'),
    },
  }
  const stableContent = {
    mediaType: ownString(content, 'mediaType'),
    encoding: ownString(content, 'encoding'),
    value: ownString(content, 'value'),
  }
  const name = ownString(skill, 'name')

  if (expected === 'tawg') {
    return {
      skill: { name },
      source: stableSource,
      content: stableContent,
    } as TawgSkillGetResult
  }
  return {
    skill: { name, role: ownString(skill, 'role') },
    source: stableSource,
    content: stableContent,
  } as RoleSkillGetResult
}

function requireTawgLoaderResult(result: TawgSkillGetResult): void {
  const candidate = result as unknown as {
    readonly skill?: { readonly name?: unknown }
    readonly source?: { readonly kind?: unknown; readonly path?: unknown }
  }
  if (candidate.skill?.name !== 'tawg'
    || candidate.source?.kind !== 'repository'
    || candidate.source.path !== 'skills/SKILL.md') invalidLoaderResult()
}

function requireRoleLoaderResult(result: RoleSkillGetResult, requestedRole: string): void {
  const candidate = result as unknown as {
    readonly skill?: { readonly name?: unknown; readonly role?: unknown }
    readonly source?: { readonly kind?: unknown; readonly path?: unknown }
  }
  if (candidate.skill?.name !== 'role'
    || candidate.skill.role !== requestedRole
    || candidate.source?.kind !== 'repository'
    || candidate.source.path !== `skills/roles/${requestedRole}.md`) invalidLoaderResult()
}

/** Registers the stable, phase-aware Skill surface exposed to every TAS Host. */
export function registerSkillTools(server: McpServer, options: SkillToolOptions): void {
  if (options.instance.phase === 'member' && (options.tawg === undefined || options.role === undefined)) {
    throw new TypeError('Invalid TAS Skill service composition.')
  }

  server.registerTool('tas.get', {
    title: 'Get TAS Skill',
    description: 'Returns the release-matched TAS bootstrap and operating Skill.',
    inputSchema: emptyInputSchema,
    outputSchema: tasSkillResultSchema,
    annotations: readOnlyAnnotations,
  }, async () => createTasResultBuilder(options.instance).success(projectBundledSkill(options.tas)))

  server.registerTool('collaboration.get', {
    title: 'Get TAWG Collaboration Skill',
    description: 'Returns the release-matched collaboration Skill for a TAWG member.',
    inputSchema: emptyInputSchema,
    outputSchema: collaborationSkillResultSchema,
    annotations: readOnlyAnnotations,
  }, async () => {
    if (options.instance.phase !== 'member') return memberContextError(options.instance)
    return createTasResultBuilder(options.instance).success(projectBundledSkill(options.collaboration))
  })

  server.registerTool('tawg.get', {
    title: 'Get TAWG Root Skill',
    description: 'Returns the current Root Skill from the Profile-selected TAWG Repository.',
    inputSchema: tawgSkillInputSchema,
    outputSchema: tawgSkillResultSchema,
    annotations: readOnlyAnnotations,
  }, async (input) => {
    if (options.instance.phase !== 'member') return memberContextError(options.instance)
    try {
      const result = snapshotRepositorySkill(await options.tawg!.get(
        input.credential === undefined ? {} : { credential: input.credential },
      ), 'tawg')
      requireTawgLoaderResult(result)
      return repositorySkillResult(options.instance, result)
    } catch (error) {
      return createTasResultBuilder(options.instance).toolError(error)
    }
  })

  server.registerTool('role.get', {
    title: 'Get TAWG Role Skill',
    description: 'Returns one current role-specific Skill from the Profile-selected TAWG Repository.',
    inputSchema: roleSkillInputSchema,
    outputSchema: roleSkillResultSchema,
    annotations: readOnlyAnnotations,
  }, async (input) => {
    if (options.instance.phase !== 'member') return memberContextError(options.instance)
    try {
      const result = snapshotRepositorySkill(await options.role!.get({
        role: input.role,
        ...(input.credential === undefined ? {} : { credential: input.credential }),
      }), 'role')
      requireRoleLoaderResult(result, input.role)
      return repositorySkillResult(options.instance, result)
    } catch (error) {
      return createTasResultBuilder(options.instance).toolError(error)
    }
  })
}
