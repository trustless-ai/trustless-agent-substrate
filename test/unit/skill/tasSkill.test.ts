import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { TasError } from '../../../src/core/errors.js'
import { loadBundledTasSkill } from '../../../src/core/skill/tasSkill.js'

const validSkill = [
  '---',
  'name: tas',
  'description: Use when loading the release-matched TAS Skill.',
  '---',
  '',
  '# TAS',
  '',
].join('\n')
const credentialsPath = fileURLToPath(new URL('../../../docs/tas/CREDENTIALS.md', import.meta.url))

function createPackageRoot(skillContent = validSkill): string {
  const root = mkdtempSync(join(tmpdir(), 'tas-skill-'))
  mkdirSync(join(root, 'skills', 'tas'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@trustless-ai/tas', version: '9.8.7' }))
  writeFileSync(join(root, 'skills', 'tas', 'SKILL.md'), skillContent)
  return root
}

function expectBundleInvalid(action: () => unknown): void {
  expect(action).toThrow(TasError)
  try {
    action()
  } catch (error) {
    expect(error).toMatchObject({ code: 'TAS_SKILL_BUNDLE_INVALID' })
    expect(String(error)).not.toContain('tas-skill-')
  }
}

describe('release-bundled TAS Skill', () => {
  it('ships self-contained identity-to-TAWG credential handoff guidance', () => {
    const artifact = loadBundledTasSkill()

    expect(artifact.content.value).toContain('~/.tas/credentials/eip155-<chainId>-<lowercase-identityRegistryAddress>/pending/<lowercase-walletAddress>/credentials.toml')
    expect(artifact.content.value).toContain('~/.tas/credentials/eip155-<chainId>-<lowercase-identityRegistryAddress>/agents/<canonical-decimal-agentId>/credentials.toml')
    expect(artifact.content.value).toContain('~/.tas/credentials/eip155-<chainId>-<lowercase-tawgAddress>/agents/<canonical-decimal-agentId>/credentials.toml')
    expect(artifact.content.value).toMatch(/platform-native atomic no-replace rename.*If unavailable, leave the pending file unchanged and fail closed for explicit migration/i)
    expect(artifact.content.value).toMatch(/exclusive create-new destination.*O_CREAT\|O_EXCL.*equivalent.*owner-only permissions.*write and flush.*EEXIST.*reconciliation.*never removes identity-final/i)
    expect(artifact.content.value).toContain('`tawgAddress` means the deployed TAWG Profile address.')
    expect(artifact.content.value).toMatch(/tas\.get[\s\S]*collaboration\.get[\s\S]*tawg\.get[\s\S]*role\.get/)
    expect(artifact.content.value).not.toContain(['skill', 'tas', 'get'].join('.'))
    expect(artifact.content.value).not.toContain(['skill', 'role', 'get'].join('.'))
  })

  it('keeps the credential contract consistent with the loaded Skill handoff safety rules', () => {
    const skill = loadBundledTasSkill().content.value
    const credentials = readFileSync(credentialsPath, 'utf8')

    for (const contract of [skill, credentials]) {
      expect(contract).toMatch(/platform-native atomic no-replace rename.*If unavailable, leave the pending file unchanged and fail closed for explicit migration/i)
      expect(contract).toMatch(/exclusive create-new destination.*O_CREAT\|O_EXCL.*equivalent.*owner-only permissions.*write and flush.*EEXIST.*reconciliation.*never removes identity-final/i)
    }
  })

  it('loads the fixed package Skill as verified UTF-8 bytes', () => {
    const root = createPackageRoot()
    try {
      const artifact = loadBundledTasSkill({ packageRoot: root })

      expect(artifact).toEqual({
        skill: { name: 'tas', package: '@trustless-ai/tas', version: '9.8.7' },
        source: {
          kind: 'release',
          path: 'skills/tas/SKILL.md',
          contentDigest: {
            algorithm: 'sha256',
            value: createHash('sha256').update(Buffer.from(validSkill, 'utf8')).digest('hex'),
          },
        },
        content: {
          mediaType: 'text/markdown; charset=utf-8',
          encoding: 'utf8',
          value: validSkill,
        },
      })
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('returns the cached release artifact after the source file changes', () => {
    const root = createPackageRoot()
    try {
      const first = loadBundledTasSkill({ packageRoot: root })
      writeFileSync(join(root, 'skills', 'tas', 'SKILL.md'), validSkill.replace('# TAS', '# replaced after startup'))

      expect(loadBundledTasSkill({ packageRoot: root })).toBe(first)
      expect(first.content.value).toBe(validSkill)
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it.each([
    ['missing', (root: string) => rmSync(join(root, 'skills', 'tas', 'SKILL.md'))],
    ['non-regular', (root: string) => {
      rmSync(join(root, 'skills', 'tas', 'SKILL.md'))
      mkdirSync(join(root, 'skills', 'tas', 'SKILL.md'))
    }],
    ['malformed frontmatter', (root: string) => writeFileSync(join(root, 'skills', 'tas', 'SKILL.md'), '---\nname: other\n---\n')],
    ['invalid UTF-8', (root: string) => writeFileSync(join(root, 'skills', 'tas', 'SKILL.md'), Buffer.from([0xff, 0xfe]))],
    ['wrong package name', (root: string) => writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@other/tas', version: '9.8.7' }))],
    ['missing package version', (root: string) => writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@trustless-ai/tas' }))],
  ])('fails closed for a %s bundle boundary', (_description, mutate) => {
    const root = createPackageRoot()
    try {
      mutate(root)
      expectBundleInvalid(() => loadBundledTasSkill({ packageRoot: root }))
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
    ['package metadata', (root: string, external: string) => {
      rmSync(join(root, 'package.json'))
      writeFileSync(join(external, 'package.json'), JSON.stringify({ name: '@trustless-ai/tas', version: '9.8.7' }))
      symlinkSync(join(external, 'package.json'), join(root, 'package.json'))
      return root
    }],
    ['skills ancestor', (root: string, external: string) => {
      rmSync(join(root, 'skills'), { force: true, recursive: true })
      mkdirSync(join(external, 'skills', 'tas'), { recursive: true })
      writeFileSync(join(external, 'skills', 'tas', 'SKILL.md'), validSkill)
      symlinkSync(join(external, 'skills'), join(root, 'skills'))
      return root
    }],
    ['skills/tas ancestor', (root: string, external: string) => {
      rmSync(join(root, 'skills', 'tas'), { force: true, recursive: true })
      mkdirSync(join(external, 'tas'), { recursive: true })
      writeFileSync(join(external, 'tas', 'SKILL.md'), validSkill)
      symlinkSync(join(external, 'tas'), join(root, 'skills', 'tas'))
      return root
    }],
    ['Skill file', (root: string, external: string) => {
      rmSync(join(root, 'skills', 'tas', 'SKILL.md'))
      writeFileSync(join(external, 'SKILL.md'), validSkill)
      symlinkSync(join(external, 'SKILL.md'), join(root, 'skills', 'tas', 'SKILL.md'))
      return root
    }],
  ])('fails closed when the %s boundary is a symlink', (_description, arrange) => {
    const root = createPackageRoot()
    const external = mkdtempSync(join(tmpdir(), 'tas-skill-external-'))
    try {
      const packageRoot = arrange(root, external)
      expectBundleInvalid(() => loadBundledTasSkill({ packageRoot }))
    } finally {
      rmSync(root, { force: true, recursive: true })
      rmSync(external, { force: true, recursive: true })
    }
  })

  it('rejects a relative package-root test seam', () => {
    expectBundleInvalid(() => loadBundledTasSkill({ packageRoot: 'relative-package-root' }))
  })
})
