import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { TasError } from '../../../src/core/errors.js'
import { loadBundledSkill } from '../../../src/core/skill/bundled.js'
import { loadBundledCollaborationSkill } from '../../../src/core/skill/collaborationSkill.js'
import { loadBundledTasSkill } from '../../../src/core/skill/tasSkill.js'

const validTasSkill = [
  '---',
  'name: tas',
  'description: Use when loading the release-matched TAS Skill.',
  '---',
  '',
  '# TAS',
  '',
].join('\n')

const validCollaborationSkill = [
  '---',
  'name: tawg-collaboration',
  'description: Use when coordinating work in a TAWG.',
  '---',
  '',
  '# TAWG Collaboration',
  '',
].join('\n')

function createPackageRoot(collaborationContent: string | Buffer = validCollaborationSkill): string {
  const root = mkdtempSync(join(tmpdir(), 'tas-collaboration-skill-'))
  mkdirSync(join(root, 'skills', 'tas'), { recursive: true })
  mkdirSync(join(root, 'skills', 'tawg-collaboration'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: '@trustless-ai/tas',
    version: '9.8.7',
  }))
  writeFileSync(join(root, 'skills', 'tas', 'SKILL.md'), validTasSkill)
  writeFileSync(join(root, 'skills', 'tawg-collaboration', 'SKILL.md'), collaborationContent)
  return root
}

function expectBundleInvalid(action: () => unknown): void {
  expect(action).toThrow(TasError)
  try {
    action()
  } catch (error) {
    expect(error).toMatchObject({ code: 'TAS_SKILL_BUNDLE_INVALID' })
    expect(String(error)).not.toContain('tas-collaboration-skill-')
  }
}

describe('release-bundled Collaboration Skill', () => {
  it('loads fixed verified bytes with release identity and an exact digest', () => {
    const root = createPackageRoot()
    try {
      const artifact = loadBundledCollaborationSkill({ packageRoot: root })

      expect(artifact).toEqual({
        skill: {
          name: 'tawg-collaboration',
          package: '@trustless-ai/tas',
          version: '9.8.7',
        },
        source: {
          kind: 'release',
          path: 'skills/tawg-collaboration/SKILL.md',
          contentDigest: {
            algorithm: 'sha256',
            value: createHash('sha256').update(Buffer.from(validCollaborationSkill)).digest('hex'),
          },
        },
        content: {
          mediaType: 'text/markdown; charset=utf-8',
          encoding: 'utf8',
          value: validCollaborationSkill,
        },
      })
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('caches each fixed Skill independently and freezes the returned artifacts', () => {
    const root = createPackageRoot()
    try {
      const tas = loadBundledTasSkill({ packageRoot: root })
      const collaboration = loadBundledCollaborationSkill({ packageRoot: root })
      expect(tas).not.toBe(collaboration)
      expect(tas.skill.name).toBe('tas')
      expect(collaboration.skill.name).toBe('tawg-collaboration')
      expect(tas.source.path).toBe('skills/tas/SKILL.md')
      expect(collaboration.source.path).toBe('skills/tawg-collaboration/SKILL.md')

      writeFileSync(join(root, 'skills', 'tas', 'SKILL.md'), validTasSkill.replace('# TAS', '# changed'))
      writeFileSync(
        join(root, 'skills', 'tawg-collaboration', 'SKILL.md'),
        validCollaborationSkill.replace('# TAWG Collaboration', '# changed'),
      )

      expect(loadBundledTasSkill({ packageRoot: root })).toBe(tas)
      expect(loadBundledCollaborationSkill({ packageRoot: root })).toBe(collaboration)
      expect(tas.content.value).toBe(validTasSkill)
      expect(collaboration.content.value).toBe(validCollaborationSkill)
      expect(Object.isFrozen(collaboration)).toBe(true)
      expect(Object.isFrozen(collaboration.skill)).toBe(true)
      expect(Object.isFrozen(collaboration.source)).toBe(true)
      expect(Object.isFrozen(collaboration.source.contentDigest)).toBe(true)
      expect(Object.isFrozen(collaboration.content)).toBe(true)
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it.each([
    ['missing file', (root: string) => rmSync(join(root, 'skills', 'tawg-collaboration', 'SKILL.md'))],
    ['empty file', (root: string) => writeFileSync(join(root, 'skills', 'tawg-collaboration', 'SKILL.md'), '')],
    ['invalid UTF-8', (root: string) => writeFileSync(join(root, 'skills', 'tawg-collaboration', 'SKILL.md'), Buffer.from([0xff]))],
    ['wrong frontmatter name', (root: string) => writeFileSync(
      join(root, 'skills', 'tawg-collaboration', 'SKILL.md'),
      validCollaborationSkill.replace('name: tawg-collaboration', 'name: other'),
    )],
    ['wrong package name', (root: string) => writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: '@other/tas', version: '9.8.7' }),
    )],
    ['missing package version', (root: string) => writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: '@trustless-ai/tas' }),
    )],
  ] as const)('fails closed for a %s', (_label, mutate) => {
    const root = createPackageRoot()
    try {
      mutate(root)
      expectBundleInvalid(() => loadBundledCollaborationSkill({ packageRoot: root }))
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it.each([
    ['package root', (root: string, external: string) => {
      const alias = join(external, 'package-root')
      symlinkSync(root, alias)
      return alias
    }],
    ['skills ancestor', (root: string, external: string) => {
      rmSync(join(root, 'skills'), { force: true, recursive: true })
      mkdirSync(join(external, 'skills', 'tawg-collaboration'), { recursive: true })
      writeFileSync(join(external, 'skills', 'tawg-collaboration', 'SKILL.md'), validCollaborationSkill)
      symlinkSync(join(external, 'skills'), join(root, 'skills'))
      return root
    }],
    ['Skill directory', (root: string, external: string) => {
      rmSync(join(root, 'skills', 'tawg-collaboration'), { force: true, recursive: true })
      mkdirSync(join(external, 'tawg-collaboration'))
      writeFileSync(join(external, 'tawg-collaboration', 'SKILL.md'), validCollaborationSkill)
      symlinkSync(join(external, 'tawg-collaboration'), join(root, 'skills', 'tawg-collaboration'))
      return root
    }],
    ['Skill file', (root: string, external: string) => {
      rmSync(join(root, 'skills', 'tawg-collaboration', 'SKILL.md'))
      writeFileSync(join(external, 'SKILL.md'), validCollaborationSkill)
      symlinkSync(join(external, 'SKILL.md'), join(root, 'skills', 'tawg-collaboration', 'SKILL.md'))
      return root
    }],
  ] as const)('fails closed when the %s boundary is a symlink', (_label, arrange) => {
    const root = createPackageRoot()
    const external = mkdtempSync(join(tmpdir(), 'tas-collaboration-external-'))
    try {
      const packageRoot = arrange(root, external)
      expectBundleInvalid(() => loadBundledCollaborationSkill({ packageRoot }))
    } finally {
      rmSync(root, { force: true, recursive: true })
      rmSync(external, { force: true, recursive: true })
    }
  })

  it('rejects a relative package-root test seam', () => {
    expectBundleInvalid(() => loadBundledCollaborationSkill({ packageRoot: 'relative-package-root' }))
  })

  it('rejects descriptor control characters that could alias cache identities', () => {
    const root = createPackageRoot()
    mkdirSync(join(root, 'custom'), { recursive: true })
    writeFileSync(join(root, 'custom', 'SKILL.md'), [
      '---',
      'name: unsafe\0name',
      'description: Use when exercising a malicious descriptor.',
      '---',
      '',
      '# Unsafe',
    ].join('\n'))

    try {
      expectBundleInvalid(() => loadBundledSkill({
        name: 'unsafe\0name',
        path: 'custom/SKILL.md',
        segments: ['custom', 'SKILL.md'],
      }, { packageRoot: root }))
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it.each([
    { name: 'parent segment', path: 'skills/../outside.md', segments: ['skills', '..', 'outside.md'] },
    { name: 'absolute segment', path: 'skills//tmp/outside.md', segments: ['skills', '/tmp', 'outside.md'] },
    { name: 'path mismatch', path: '../outside.md', segments: ['skills', 'outside.md'] },
  ] as const)('rejects a $name descriptor before reading outside the bundle', (descriptor) => {
    const root = createPackageRoot()
    try {
      expectBundleInvalid(() => loadBundledSkill({
        name: 'unsafe',
        path: descriptor.path,
        segments: descriptor.segments,
      }, { packageRoot: root }))
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })
})
