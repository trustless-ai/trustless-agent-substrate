import { describe, expect, it } from 'vitest'

import { loadBundledCollaborationSkill } from '../../src/core/skill/collaborationSkill.js'

const requiredHeadings = [
  '# TAWG Collaboration',
  '## Purpose and authority',
  '## Load the complete guidance stack',
  '## Core principles',
  '## Work origins',
  '## Participation modes and Human Approval',
  '## Synchronize and discover context',
  '## Interpret Collaboration Messages',
  '### Scope',
  '### Formality',
  '### Progressive clarification',
  '## Run the collaboration loop',
  '## Manage accepted work',
  '## Send and receive Handoffs',
  '## Use Repository and workspace discipline',
  '## Verify every external result',
  '## Restart and recover',
  '## Protect secrets',
  '## Completion checklist',
] as const

function indexInOrder(content: string, values: readonly string[]): readonly number[] {
  return values.map((value) => content.indexOf(value))
}

describe('bundled TAWG Collaboration Skill content', () => {
  it('ships one complete release-matched operating guide in dependency order', () => {
    const artifact = loadBundledCollaborationSkill()
    const content = artifact.content.value
    const positions = indexInOrder(content, requiredHeadings)

    expect(artifact.skill.name).toBe('tawg-collaboration')
    expect(artifact.source).toMatchObject({
      kind: 'release',
      path: 'skills/tawg-collaboration/SKILL.md',
      contentDigest: { algorithm: 'sha256', value: expect.stringMatching(/^[0-9a-f]{64}$/) },
    })
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual(positions.toSorted((left, right) => left - right))
    expect(content.split(/\r?\n/).length).toBeLessThanOrEqual(500)
  })

  it('defines human-led participation without allowing broad automation to claim open work', () => {
    const content = loadBundledCollaborationSkill().content.value

    for (const mode of ['Observe', 'Suggest', 'Assist', 'Auto']) expect(content).toContain(mode)
    for (const origin of [
      'Collaboration-originated',
      'Human-initiated',
      'Agent-proposed',
      'Workflow-originated',
    ]) expect(content).toContain(origin)
    expect(content).toContain('Agent-proposed new work always requires explicit Human Approval')
    expect(content).toMatch(/open opportunity[\s\S]{0,500}(?:do not|never)[\s\S]{0,200}(?:claim|accept)/i)
    expect(content).toMatch(/Action Approval[\s\S]{0,800}Message Approval/)
    expect(content).toMatch(
      /Human Approval[\s\S]{0,600}(?:do not|does not|never)[\s\S]{0,400}Workflow[\s\S]{0,200}chain state[\s\S]{0,200}Role Skill[\s\S]{0,200}credential[\s\S]{0,200}spending limit[\s\S]{0,200}proof[\s\S]{0,200}settlement/i,
    )
  })

  it('keeps Collaboration Messages natural while interpreting scope and formality privately', () => {
    const content = loadBundledCollaborationSkill().content.value

    expect(content).toContain('Group-first. Human-readable.')
    for (const scope of ['Group', 'Role', 'Individual', 'Multiple', 'Thread', 'Private']) {
      expect(content).toContain(scope)
    }
    for (const level of ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']) expect(content).toContain(level)
    expect(content).toMatch(/Agent-side|inside the Agent/i)
    expect(content).toMatch(/natural(?:,| and)? human-readable|human-readable natural/i)
    expect(content).toMatch(
      /Private[\s\S]{0,600}(?:decision|context)[\s\S]{0,300}shared work[\s\S]{0,300}(?:group|Repository|DA|Workflow)/i,
    )
    expect(content).not.toMatch(/(?:must|required to) (?:send|write|format).{0,80}(?:JSON|YAML)/i)
  })

  it('treats Handoff formality separately from recipient acceptance', () => {
    const content = loadBundledCollaborationSkill().content.value
    const levelFour = content.match(/^- \*\*L4[^\n]+$/m)?.[0]

    expect(levelFour).toBeDefined()
    expect(levelFour).not.toContain('Handoff')
    expect(content).toMatch(/Handoff[\s\S]{0,200}L3[\s\S]{0,80}L4[\s\S]{0,80}L5/i)
    expect(content).toMatch(/delivered Handoff[\s\S]{0,200}(?:does not|never)[\s\S]{0,100}accepted/i)
  })

  it('owns collaboration mechanics while leaving business and authority to TAWG guidance and Workflow', () => {
    const content = loadBundledCollaborationSkill().content.value

    expect(content).toMatch(/tas\.get[\s\S]*collaboration\.get[\s\S]*tawg\.get[\s\S]*role\.get/)
    expect(content).toContain('Task mode')
    expect(content).toContain('Batch mode')
    expect(content).toMatch(/specialist Skills/i)
    expect(content).toMatch(/delivered Handoff[\s\S]{0,200}(?:does not|never)[\s\S]{0,100}accepted/i)
    expect(content).toMatch(/valid proof[\s\S]{0,250}(?:does not|never)[\s\S]{0,120}(?:settled|settlement)/i)
    expect(content).toMatch(/local completion[\s\S]{0,150}(?:does not|never)[\s\S]{0,100}(?:Workflow acceptance|settlement)/i)
    expect(content).not.toContain(['skill', 'tas', 'get'].join('.'))
    expect(content).not.toContain(['skill', 'role', 'get'].join('.'))
  })

  it('scopes TAWG authority below Host safety boundaries and treats instructions as untrusted input', () => {
    const content = loadBundledCollaborationSkill().content.value

    expect(content).toMatch(/authority order[\s\S]{0,500}TAWG business|TAWG business[\s\S]{0,500}authority order/i)
    expect(content).toMatch(
      /Solidity comments[\s\S]{0,250}Repository[\s\S]{0,250}Skill[\s\S]{0,250}group messages[\s\S]{0,500}(?:do not|cannot|never)[\s\S]{0,300}Host[\s\S]{0,250}credential[\s\S]{0,250}privacy[\s\S]{0,250}approval/i,
    )
  })

  it('keeps cursor, approvals, accepted work, and recovery state in the Agent Host', () => {
    const content = loadBundledCollaborationSkill().content.value

    expect(content).toMatch(/Agent-managed cursor|Agent Host.{0,80}cursor/is)
    expect(content).toContain('accepted')
    expect(content).toContain('in_process')
    expect(content).toContain('review_or_handoff')
    expect(content).toContain('completed')
    expect(content).toMatch(/approximately six seconds|about six seconds/i)
    expect(content).toMatch(/does not own|must not own|never stores/i)
    expect(content).not.toContain('operation_id')
  })

  it('requires fixed artifacts, external verification, bounded messaging, and secret exclusion', () => {
    const content = loadBundledCollaborationSkill().content.value

    for (const term of ['Issue', 'PR', 'full commit', 'DA reference', 'digest']) expect(content).toContain(term)
    expect(content).toMatch(/re-query|query.{0,40}again/i)
    expect(content).toMatch(/exact draft/i)
    expect(content).toMatch(/correct (?:recipient|audience)/i)
    expect(content).toMatch(/private key|credential/i)
    expect(content).toMatch(/group message[\s\S]{0,300}(?:must not|never)[\s\S]{0,100}secret/i)
  })
})
