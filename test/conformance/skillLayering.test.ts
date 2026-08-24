import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../', import.meta.url))
const paths = {
  bootstrap: `${root}/skills/tas-bootstrap/SKILL.md`,
  tas: `${root}/skills/tas/SKILL.md`,
  collaboration: `${root}/skills/tawg-collaboration/SKILL.md`,
  tawg: `${root}/tawg/demo/skills/SKILL.md`,
  contributor: `${root}/tawg/demo/skills/roles/contributor.md`,
  evaluator: `${root}/tawg/demo/skills/roles/evaluator.md`,
} as const

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

function positions(content: string, values: readonly string[]): readonly number[] {
  return values.map((value) => content.indexOf(value))
}

describe('four-layer TAS and TAWG Skill guidance', () => {
  it('bootstraps only TAS while expecting the complete flat tool surface', () => {
    const content = read(paths.bootstrap)

    for (const tool of ['tas.get', 'collaboration.get', 'tawg.get', 'role.get']) expect(content).toContain(tool)
    expect(content).toMatch(/tools\/list[\s\S]{0,500}all four|all four[\s\S]{0,500}tools\/list/i)
    expect(content).toMatch(/call only `tas\.get`|only call `tas\.get`/i)
    expect(content).toMatch(/SKILL_MEMBER_CONTEXT_REQUIRED[\s\S]{0,300}(?:expected|intentional)/i)
    expect(content).not.toMatch(/call `(?:collaboration|tawg|role)\.get`/i)
  })

  it('loads the complete member guidance stack in the approved order', () => {
    const content = read(paths.tas)
    const memberStack = content.slice(
      content.indexOf('Load the complete guidance stack in this order:'),
      content.indexOf('Then operate the member context:'),
    )
    const order = ['`tas.get`', '`collaboration.get`', '`tawg.get`', '`role.get(role)`', '`workflow.source.verify`']
    const orderedPositions = positions(memberStack, order)

    expect(memberStack).not.toBe('')
    expect(orderedPositions.every((position) => position >= 0)).toBe(true)
    expect(orderedPositions).toEqual(orderedPositions.toSorted((left, right) => left - right))
    expect(memberStack).toMatch(/role\.get\(role\)[\s\S]{0,200}each applicable role/i)
    expect(content).toMatch(/Collaboration Skill[\s\S]{0,300}Human Approval|Human Approval[\s\S]{0,300}Collaboration Skill/i)
    expect(content).not.toMatch(/(?:tawg|role)\.get[^(\n]*(?:commit|repository|path)\s*=/i)
  })

  it('uses the intended business and collaboration authority order', () => {
    const content = read(paths.tas)
    const order = [
      'deployed contracts and current chain state',
      'Charter',
      'TAWG Root and Role Skills',
      'Collaboration Skill',
      'TAS Skill',
      'messages',
    ]
    const orderedPositions = positions(content, order)

    expect(orderedPositions.every((position) => position >= 0)).toBe(true)
    expect(orderedPositions).toEqual(orderedPositions.toSorted((left, right) => left - right))
  })

  it('keeps Demo Root guidance business-specific and delegates collaboration mechanics', () => {
    const rootSkill = read(paths.tawg)

    expect(rootSkill).toContain('`role.get(role)`')
    expect(rootSkill).toMatch(/immutable[\s\S]{0,120}Evaluator/i)
    expect(rootSkill).toMatch(/default[\s\S]{0,80}Contributor/i)
    expect(rootSkill).toMatch(/Collaboration Skill/i)
    expect(rootSkill).toMatch(/Scope[\s\S]{0,120}Formality[\s\S]{0,160}Human Approval[\s\S]{0,160}Handoff[\s\S]{0,160}cursor[\s\S]{0,160}restart/i)
    expect(rootSkill).not.toMatch(/\bL[0-5]\b/)
  })

  it.each([
    ['Contributor', paths.contributor, /contributionId[\s\S]{0,500}Evaluator[\s\S]{0,300}mention/i],
    ['Evaluator', paths.evaluator, /contributionId[\s\S]{0,900}Contributor[\s\S]{0,300}mention/i],
  ] as const)('keeps %s guidance business-specific without duplicating the generic loop', (_role, path, handoff) => {
    const content = read(path)

    expect(content).toMatch(/Collaboration Skill/i)
    expect(content).toMatch(handoff)
    expect(content).toMatch(/AgentReply/)
    expect(content).toMatch(/workflow\.da\.(?:put|get)/)
    expect(content).not.toMatch(/\bL[0-5]\b/)
    expect(content).not.toContain('Observe → Select → Clarify → Approve → Execute')
    expect(content).not.toMatch(/^## (?:Participation modes and Human Approval|Interpret Collaboration Messages|Run the collaboration loop)$/m)
  })

  it('uses only the four flat Skill tool names across every current Skill', () => {
    const content = Object.values(paths).map(read).join('\n')

    expect(content).not.toContain(['skill', 'tas', 'get'].join('.'))
    expect(content).not.toContain(['skill', 'role', 'get'].join('.'))
    for (const tool of ['tas.get', 'collaboration.get', 'tawg.get', 'role.get']) expect(content).toContain(tool)
  })
})
