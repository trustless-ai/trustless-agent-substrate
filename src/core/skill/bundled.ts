import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TasError } from '../errors.js'
import type { BundledSkillArtifact } from './types.js'

const packageName = '@trustless-ai/tas' as const
const packageRootFromModule = fileURLToPath(new URL('../../../', import.meta.url))
const cachedArtifacts = new Map<string, unknown>()
const skillNamePattern = /^[a-z][a-z0-9-]{0,63}$/
const pathSegmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export interface BundledSkillDescriptor<Name extends string, Path extends string> {
  readonly name: Name
  readonly path: Path
  readonly segments: readonly string[]
}

export interface LoadBundledSkillOptions {
  /** Test-only startup seam. The Skill subpath remains fixed by its wrapper module. */
  readonly packageRoot?: string
}

function invalidBundle(): never {
  throw new TasError('TAS_SKILL_BUNDLE_INVALID', 'Invalid TAS Skill bundle.')
}

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function requireDirectory(path: string): void {
  let stat
  try { stat = lstatSync(path) } catch { return invalidBundle() }
  if (stat.isSymbolicLink() || !stat.isDirectory()) invalidBundle()
}

function readVerifiedRegularFile(path: string): Buffer {
  let stat
  try { stat = lstatSync(path) } catch { return invalidBundle() }
  if (stat.isSymbolicLink() || !stat.isFile()) invalidBundle()

  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    if (!fstatSync(descriptor).isFile()) invalidBundle()
    return readFileSync(descriptor)
  } catch {
    return invalidBundle()
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function decodeUtf8(bytes: Buffer): string {
  const content = bytes.toString('utf8')
  if (!Buffer.from(content, 'utf8').equals(bytes)) invalidBundle()
  return content
}

function parsePackageVersion(bytes: Buffer): string {
  let parsed: unknown
  try { parsed = JSON.parse(decodeUtf8(bytes)) } catch { return invalidBundle() }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) invalidBundle()
  const { name, version } = parsed as Record<string, unknown>
  if (name !== packageName || typeof version !== 'string' || version.trim() === '') invalidBundle()
  return version
}

function hasValidFrontmatter(markdown: string, expectedName: string): boolean {
  const normalized = markdown.startsWith('\uFEFF') ? markdown.slice(1) : markdown
  const lines = normalized.split(/\r?\n/)
  if (lines[0] !== '---') return false
  const end = lines.indexOf('---', 1)
  if (end < 0) return false

  let name: string | undefined
  let description: string | undefined
  for (const line of lines.slice(1, end)) {
    const match = /^(name|description):[ ]*(.+)$/.exec(line)
    if (!match) return false
    if (match[1] === 'name') {
      if (name !== undefined) return false
      name = match[2]
    } else {
      if (description !== undefined) return false
      description = match[2]
    }
  }
  return name === expectedName && description !== undefined && description.startsWith('Use when')
}

function freezeArtifact<Name extends string, Path extends string>(
  artifact: BundledSkillArtifact<Name, Path>,
): BundledSkillArtifact<Name, Path> {
  Object.freeze(artifact.skill)
  Object.freeze(artifact.source.contentDigest)
  Object.freeze(artifact.source)
  Object.freeze(artifact.content)
  return Object.freeze(artifact)
}

function validateDescriptor<Name extends string, Path extends string>(
  descriptor: BundledSkillDescriptor<Name, Path>,
): void {
  if (!skillNamePattern.test(descriptor.name) || descriptor.segments.length < 2) invalidBundle()
  if (descriptor.segments.some((segment) => !pathSegmentPattern.test(segment))) invalidBundle()
  if (descriptor.path !== descriptor.segments.join('/')) invalidBundle()
}

export function loadBundledSkill<Name extends string, Path extends string>(
  descriptor: BundledSkillDescriptor<Name, Path>,
  options: LoadBundledSkillOptions = {},
): BundledSkillArtifact<Name, Path> {
  validateDescriptor(descriptor)
  const suppliedRoot = options.packageRoot ?? packageRootFromModule
  if (typeof suppliedRoot !== 'string' || !isAbsolute(suppliedRoot)) invalidBundle()

  requireDirectory(suppliedRoot)
  let root: string
  try { root = realpathSync(suppliedRoot) } catch { return invalidBundle() }
  requireDirectory(root)

  const cacheKey = JSON.stringify([root, descriptor.name, descriptor.path])
  const cached = cachedArtifacts.get(cacheKey)
  if (cached !== undefined) return cached as BundledSkillArtifact<Name, Path>

  const fixedPath = resolve(root, ...descriptor.segments)
  if (!isContained(root, fixedPath)) invalidBundle()
  for (let depth = 1; depth < descriptor.segments.length; depth += 1) {
    requireDirectory(resolve(root, ...descriptor.segments.slice(0, depth)))
  }

  let resolvedSkillPath: string
  try { resolvedSkillPath = realpathSync(fixedPath) } catch { return invalidBundle() }
  if (!isContained(root, resolvedSkillPath) || resolvedSkillPath !== fixedPath) invalidBundle()

  const version = parsePackageVersion(readVerifiedRegularFile(resolve(root, 'package.json')))
  const bytes = readVerifiedRegularFile(fixedPath)
  const content = decodeUtf8(bytes)
  if (!hasValidFrontmatter(content, descriptor.name)) invalidBundle()

  const artifact = freezeArtifact({
    skill: { name: descriptor.name, package: packageName, version },
    source: {
      kind: 'release',
      path: descriptor.path,
      contentDigest: {
        algorithm: 'sha256',
        value: createHash('sha256').update(bytes).digest('hex'),
      },
    },
    content: { mediaType: 'text/markdown; charset=utf-8', encoding: 'utf8', value: content },
  })
  cachedArtifacts.set(cacheKey, artifact)
  return artifact
}
