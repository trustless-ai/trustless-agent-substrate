import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const demoRoot = resolve(repositoryRoot, 'tawg/demo')

interface SkillDocument {
  readonly name: string
  readonly description: string
  readonly body: string
}

function readSkill(path: string): SkillDocument {
  const source = readFileSync(path, 'utf8')
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/.exec(source)
  if (match === null) throw new Error(`${path} must have YAML frontmatter`)

  const fields = Object.fromEntries(match[1]!.split('\n').map((line) => {
    const separator = line.indexOf(':')
    if (separator < 1) throw new Error(`${path} has invalid YAML frontmatter`)
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]
  }))
  expect(Object.keys(fields).sort()).toEqual(['description', 'name'])
  return { name: fields.name!, description: fields.description!, body: match[2]! }
}

function expectValidSkill(path: string): SkillDocument {
  const skill = readSkill(path)
  expect(skill.name).toMatch(/^[A-Za-z0-9-]+$/)
  expect(skill.description).toMatch(/^Use when\b/)
  expect(skill.description).not.toMatch(/\b(?:first|then|call|submit|settle|load)\b/i)
  expect(skill.body).toContain('## Quick reference')
  expect(skill.body).toContain('## Common mistakes')
  expect(skill.body.split('\n').length).toBeLessThan(140)
  expect(`${skill.description}\n${skill.body}`).toContain('ERC-8004 `agentId`')
  return skill
}

function solidityFiles(directory: string, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return solidityFiles(path, relativePath)
    return entry.isFile() && entry.name.endsWith('.sol') ? [relativePath] : []
  }).sort()
}

describe('Demo TAWG repository layout', () => {
  it('provides the canonical standalone TAWG repository roots', () => {
    for (const root of ['charter', 'knowledge', 'data', 'contracts', 'skills']) {
      const path = resolve(demoRoot, root)
      expect(existsSync(path), `${root}/ is missing`).toBe(true)
      expect(statSync(path).isDirectory(), `${root}/ is not a directory`).toBe(true)
    }

    for (const path of [
      '.gitignore',
      'README.md',
      'foundry.toml',
      'remappings.txt',
      'charter/README.md',
      'contracts/Workflow.metadata.json',
      'knowledge/README.md',
      'data/.gitkeep',
      'script/Deploy.s.sol',
      'skills/SKILL.md',
      'test/Deploy.t.sol',
    ]) {
      expect(existsSync(resolve(demoRoot, path)), `${path} is missing`).toBe(true)
    }

    expect(readFileSync(resolve(demoRoot, '.gitignore'), 'utf8')).toBe('/out/\n/cache/\n/broadcast/\n')
  })

  it('allows only the planned business Workflow and proof-free helper Solidity sources', () => {
    const sources = solidityFiles(resolve(demoRoot, 'contracts'))

    expect(sources.every((source) => ['PassThroughVerifier.sol', 'Workflow.sol'].includes(source))).toBe(true)
  })

  it('defines exactly Contributor and Evaluator Role Skills with Contributor as the default', () => {
    const roleDirectory = resolve(demoRoot, 'skills/roles')
    const roles = readdirSync(roleDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort()
    expect(roles).toEqual(['contributor.md', 'evaluator.md'])

    const rootSkill = expectValidSkill(resolve(demoRoot, 'skills/SKILL.md'))
    expect(rootSkill.body).toMatch(/Profile member[^.]*default[^.]*Contributor/i)
    expect(rootSkill.body).toContain('`role.get(role)`')
    expect(rootSkill.body).toMatch(/Collaboration Skill/i)

    const contributor = expectValidSkill(resolve(roleDirectory, 'contributor.md'))
    expect(contributor.name).toBe('demo-contributor')
    expect(contributor.description).toMatch(/contribut/i)
    expect(contributor.body).toMatch(/profile\.get_agent/)
    expect(contributor.body).toMatch(/workflow\.da\.(?:put|get)/)
    expect(contributor.body).toMatch(/workflow\.da\.put[^.\n]*returns only[^.\n]*\bref\b[^.\n]*\bsize_bytes\b/i)
    expect(contributor.body).not.toMatch(/workflow\.da\.put[^.\n]*(?:returns?|provides?|yields?|retain)[^.\n]*(?:digest|commitment)/i)
    expect(contributor.body).toMatch(/applicable generated `agent-sdk` recompute operation/i)
    expect(contributor.body).toMatch(/exact bytes[^.\n]*daDigest/i)
    expect(contributor.body).toMatch(/contributionId/)
    expect(contributor.body).toMatch(/Evaluator/)
    expect(contributor.body).toMatch(/score/)
    expect(contributor.body).toMatch(/round/)
    expect(contributor.body).toMatch(/restart|recovery/i)
    expect(contributor.body).toMatch(/unknown DA write[^.]*destination[^.]*candidate ref[^.]*workflow\.da\.get[^.]*recompute/i)
    expect(contributor.body).toMatch(/Collaboration Skill/i)

    const evaluator = expectValidSkill(resolve(roleDirectory, 'evaluator.md'))
    expect(evaluator.name).toBe('demo-evaluator')
    expect(evaluator.description).toMatch(/evaluat/i)
    expect(evaluator.body).toMatch(/event/i)
    expect(evaluator.body).toMatch(/workflow\.da\.get/)
    expect(evaluator.body).toMatch(/applicable generated `agent-sdk` recompute operation/i)
    expect(evaluator.body).toMatch(/exact bytes[^.\n]*daDigest/i)
    expect(evaluator.body).toMatch(/score[^.]*once/i)
    expect(evaluator.body).toMatch(/settle/i)
    expect(evaluator.body).toMatch(/next round/i)
    expect(evaluator.body).toMatch(/complete/i)
    expect(evaluator.body).toMatch(/notif|mention/i)
    expect(evaluator.body).toMatch(/Collaboration Skill/i)
  })

  it('uses only general TAS surfaces and never invents a Demo MCP namespace', () => {
    const files = [
      resolve(demoRoot, 'skills/SKILL.md'),
      resolve(demoRoot, 'skills/roles/contributor.md'),
      resolve(demoRoot, 'skills/roles/evaluator.md'),
    ]
    const guidance = files.map((path) => readFileSync(path, 'utf8')).join('\n')

    expect(guidance).not.toMatch(/\bdemo\.[a-z0-9_.-]+/i)
    expect(guidance).toMatch(/profile\.get_agent/)
    expect(guidance).toMatch(/workflow\.source\.verify/)
    expect(guidance).toMatch(/workflow\.chain\.(?:public|wallet)/)
    expect(guidance).toMatch(/workflow\.da\.(?:put|get)/)
  })
})
