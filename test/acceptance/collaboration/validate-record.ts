import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

const labels = ['Agent A', 'Agent B', 'Agent C'] as const
const maxUint256 = 2n ** 256n - 1n
const requiredCheckIds = [
  'action-approval-gates',
  'authoritative-rechecks',
  'bounded-automation',
  'independent-agent-state',
  'later-round-isolation',
  'message-approval-gates',
  'natural-language-collaboration',
  'rejected-approval-no-effect',
  'restart-and-deduplication',
] as const

const scenarioSchema = z.object({
  id: z.string(),
  expected: z.object({
    action_approval: z.enum(['required', 'covered', 'not_applicable']),
    message_approval: z.enum(['required', 'covered', 'not_applicable']),
  }).passthrough(),
}).passthrough()

const publicUuid = z.string().uuid()
const publicMessageId = z.string().regex(/^message:[0-9a-f]{64}$/)
const agentId = z.string().max(78).regex(/^(?:0|[1-9][0-9]*)$/).refine((value) => BigInt(value) <= maxUint256)
const fullCommit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
const roleSourceSchema = z.object({
  kind: z.literal('repository'),
  repository_url: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
  commit: fullCommit,
  path: z.string().regex(/^skills\/roles\/[a-z][a-z0-9_-]{0,63}\.md$/),
  content_digest: z.object({
    algorithm: z.literal('sha256'), value: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
}).strict()
const approvalSchema = z.object({
  approval_id: publicUuid,
  scenario_id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  agent_label: z.enum(labels),
  kind: z.enum(['action', 'message']),
  decision: z.enum(['approved', 'rejected']),
  decided_at: z.iso.datetime(),
}).strict()
const recordSchema = z.object({
  run_id: publicUuid,
  started_at: z.iso.datetime(),
  completed_at: z.iso.datetime(),
  tawg_address: z.string().regex(/^0x(?!0{40}$)[0-9a-fA-F]{40}$/),
  agents: z.array(z.object({
    label: z.enum(labels),
    erc8004_agent_id: agentId,
    role_skill_sources: z.array(roleSourceSchema).min(1),
  }).strict()).length(3),
  rounds: z.array(z.object({
    round: z.number().int().min(1),
    scenario_ids: z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)).min(1),
    approvals: z.array(approvalSchema),
    message_ids: z.array(publicMessageId),
    commits: z.array(fullCommit),
    transaction_hashes: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)),
    restart_boundaries: z.array(z.object({
      boundary_id: publicUuid, agent_label: z.enum(labels), resumed_from_message_id: publicMessageId,
    }).strict()),
  }).strict()).length(3),
  checks: z.array(z.object({
    id: z.enum(requiredCheckIds),
    passed: z.boolean(),
    note: z.literal('public-note:observed'),
  }).strict()).min(1),
  accepted_by_human: z.boolean(),
}).strict()

const sensitiveMaterial = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/i,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-(?:proj|live)-[A-Za-z0-9_-]{16,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /https?:\/\/[^\s/@:]+:[^\s/@]+@/i,
] as const

const publicHashFields = new Set([
  'commit', 'commits', 'message_ids', 'resumed_from_message_id', 'transaction_hashes', 'value',
])
const approvalAgentByScenario = new Map<string, typeof labels[number]>([
  ['l3-direct-request', 'Agent C'],
  ['human-idea-explicit-start', 'Agent A'],
  ['agent-idea-unrelated-auto', 'Agent B'],
  ['incoming-handoff', 'Agent B'],
  ['uncovered-action', 'Agent A'],
  ['uncovered-outgoing-message', 'Agent A'],
  ['l5-recheck', 'Agent C'],
])
const approvalDecisionByKey = new Map<string, 'approved' | 'rejected'>([
  ['l3-direct-request:action', 'approved'],
  ['human-idea-explicit-start:action', 'approved'],
  ['agent-idea-unrelated-auto:action', 'rejected'],
  ['incoming-handoff:action', 'approved'],
  ['uncovered-action:action', 'approved'],
  ['uncovered-outgoing-message:message', 'approved'],
  ['l5-recheck:action', 'approved'],
  ['l5-recheck:message', 'approved'],
])

function containsSensitiveMaterial(value: unknown, field = ''): boolean {
  if (typeof value === 'string') {
    if (sensitiveMaterial.some((pattern) => pattern.test(value))) return true
    return !publicHashFields.has(field) && /\b(?:0x)?[0-9a-fA-F]{64}\b/.test(value)
  }
  if (Array.isArray(value)) return value.some((item) => containsSensitiveMaterial(item, field))
  if (value === null || typeof value !== 'object') return false
  return Object.entries(value).some(([key, child]) => containsSensitiveMaterial(child, key))
}

export function validateAcceptanceRecord(record: unknown, scenarios: unknown): readonly string[] {
  const secretBearing = containsSensitiveMaterial(record)
  const parsedRecord = recordSchema.safeParse(record)
  const parsedScenarios = z.array(scenarioSchema).min(1).safeParse(scenarios)
  if (!parsedRecord.success || !parsedScenarios.success) return [
    'record or scenario input has an invalid shape',
    ...(secretBearing ? ['record contains recognizable secret or authentication material'] : []),
  ]

  const errors: string[] = []
  const labelsSeen = parsedRecord.data.agents.map(({ label }) => label)
  const agentIds = parsedRecord.data.agents.map(({ erc8004_agent_id }) => erc8004_agent_id)
  if (parsedRecord.data.agents.length !== labels.length) errors.push('exactly three Agents are required')
  if (labels.some((label) => labelsSeen.filter((candidate) => candidate === label).length !== 1)) {
    errors.push('Agent A, Agent B, and Agent C must each appear exactly once')
  }
  if (agentIds.some((id) => !/^(?:0|[1-9][0-9]*)$/.test(id))) errors.push('ERC-8004 Agent IDs must be canonical decimals')
  if (new Set(agentIds).size !== labels.length) errors.push('ERC-8004 Agent IDs must be distinct')
  if (parsedRecord.data.rounds.length !== 3) errors.push('exactly three collaboration rounds are required')
  const roundNumbers = parsedRecord.data.rounds.map(({ round }) => round)
  if (new Set(roundNumbers).size !== roundNumbers.length) errors.push('round numbers must be unique')

  const requirements = new Map(parsedScenarios.data.map((scenario) => [scenario.id, scenario.expected]))
  const coveredScenarios = new Set(parsedRecord.data.rounds.flatMap(({ scenario_ids }) => scenario_ids))
  for (const scenarioId of requirements.keys()) {
    if (!coveredScenarios.has(scenarioId)) errors.push(`scenario is not covered: ${scenarioId}`)
  }
  for (const scenarioId of coveredScenarios) {
    if (!requirements.has(scenarioId)) errors.push(`unknown scenario: ${scenarioId}`)
  }
  const approvals = parsedRecord.data.rounds.flatMap(({ approvals: roundApprovals }) => roundApprovals)
  const approvalKeys = approvals.map(({ scenario_id, kind }) => `${scenario_id}:${kind}`)
  if (new Set(approvalKeys).size !== approvalKeys.length) errors.push('approval evidence must be unique per scenario and kind')
  for (const approval of approvals) {
    const key = `${approval.scenario_id}:${approval.kind}`
    const expectedDecision = approvalDecisionByKey.get(key)
    if (expectedDecision === undefined) {
      errors.push(`unexpected ${approval.kind} approval evidence for ${approval.scenario_id}`)
      continue
    }
    if (approval.agent_label !== approvalAgentByScenario.get(approval.scenario_id)) {
      errors.push(`approval Agent mismatch for ${approval.scenario_id}`)
    }
    if (approval.decision !== expectedDecision) {
      errors.push(`approval decision must be ${expectedDecision} for ${approval.scenario_id}`)
    }
  }
  for (const [key] of approvalDecisionByKey) {
    const [scenarioId, kind] = key.split(':') as [string, 'action' | 'message']
    const round = parsedRecord.data.rounds.find(({ scenario_ids }) => scenario_ids.includes(scenarioId))
    const matchingApprovals = round?.approvals.filter((approval) => approval.scenario_id === scenarioId
      && approval.kind === kind && approval.agent_label === approvalAgentByScenario.get(scenarioId)) ?? []
    if (matchingApprovals.length !== 1) {
      errors.push(`missing ${kind} approval evidence for ${scenarioId}`)
    }
  }

  const approvalIds = approvals.map(({ approval_id }) => approval_id)
  if (new Set(approvalIds).size !== approvalIds.length) errors.push('approval IDs must be globally unique')

  if (!parsedRecord.data.rounds.some(({ restart_boundaries }) => restart_boundaries.length > 0)) {
    errors.push('at least one restart boundary is required')
  }
  const checks = new Map(parsedRecord.data.checks.map((check) => [check.id, check.passed]))
  if (checks.size !== parsedRecord.data.checks.length) errors.push('human check IDs must be unique')
  for (const id of requiredCheckIds) {
    if (checks.get(id) !== true) errors.push(`required human check did not pass: ${id}`)
  }
  if (parsedRecord.data.checks.some(({ passed }) => !passed)) errors.push('every recorded human check must pass')
  if (!parsedRecord.data.accepted_by_human) errors.push('accepted_by_human must reflect Jimmy acceptance')

  if (secretBearing) {
    errors.push('record contains recognizable secret or authentication material')
  }
  return errors
}

function runFromCommandLine(): void {
  const recordPath = process.argv[2]
  if (recordPath === undefined) throw new Error('usage: validate-record.ts <acceptance-record.json>')
  const packRoot = dirname(fileURLToPath(import.meta.url))
  const record = JSON.parse(readFileSync(resolve(recordPath), 'utf8')) as unknown
  const scenarios = JSON.parse(readFileSync(resolve(packRoot, 'scenarios.json'), 'utf8')) as unknown
  const errors = validateAcceptanceRecord(record, scenarios)
  if (errors.length > 0) throw new Error(`COLLABORATION_ACCEPTANCE_INVALID\n${errors.join('\n')}`)
  process.stdout.write('COLLABORATION_ACCEPTANCE_VALID\n')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runFromCommandLine()
