import { loadBundledSkill, type LoadBundledSkillOptions } from './bundled.js'
import type { CollaborationSkillArtifact } from './types.js'

const descriptor = {
  name: 'tawg-collaboration',
  path: 'skills/tawg-collaboration/SKILL.md',
  segments: ['skills', 'tawg-collaboration', 'SKILL.md'],
} as const

export type { CollaborationSkillArtifact } from './types.js'
export type LoadBundledCollaborationSkillOptions = LoadBundledSkillOptions

export function loadBundledCollaborationSkill(
  options: LoadBundledCollaborationSkillOptions = {},
): CollaborationSkillArtifact {
  return loadBundledSkill(descriptor, options)
}
