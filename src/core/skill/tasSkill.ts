import { loadBundledSkill, type LoadBundledSkillOptions } from './bundled.js'
import type { TasSkillArtifact } from './types.js'

const descriptor = {
  name: 'tas',
  path: 'skills/tas/SKILL.md',
  segments: ['skills', 'tas', 'SKILL.md'],
} as const

export type { TasSkillArtifact } from './types.js'
export type LoadBundledTasSkillOptions = LoadBundledSkillOptions

export function loadBundledTasSkill(
  options: LoadBundledTasSkillOptions = {},
): TasSkillArtifact {
  return loadBundledSkill(descriptor, options)
}
