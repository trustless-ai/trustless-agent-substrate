import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import type { ChainSelector } from '../core/profile/types.js'
import type {
  WorkflowSourceGetResult,
  WorkflowSourceService,
} from '../core/workflow/sourceService.js'
import type { WorkflowVerificationResult } from '../core/workflow/sourceVerifier.js'
import {
  createTasResultBuilder,
  type PublicJsonObject,
  type ResolutionContext,
  type TasPublicInstance,
} from './results.js'

const maxUint256 = 2n ** 256n - 1n
const canonicalDecimalSchema = z.string().max(78).regex(/^(?:0|[1-9][0-9]*)$/).refine((value) => {
  try { return BigInt(value) <= maxUint256 } catch { return false }
})
const positiveCanonicalDecimalSchema = z.string().max(78).regex(/^[1-9][0-9]*$/).refine((value) => {
  try { return BigInt(value) <= maxUint256 } catch { return false }
})
const blockHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const evmAddressSchema = z.string().regex(/^0x(?!0{40}$)[0-9a-fA-F]{40}$/)
const fullCommitSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const keccakSchema = z.string().regex(/^0x[0-9a-f]{64}$/)
const repositorySchema = z.string().regex(/^https:\/\/github\.com\/[^/]+\/[^/]+$/)

const selectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('latest') }).strict(),
  z.object({ kind: z.literal('safe') }).strict(),
  z.object({ kind: z.literal('finalized') }).strict(),
  z.object({ kind: z.literal('block_number'), block_number: canonicalDecimalSchema }).strict(),
  z.object({ kind: z.literal('block_hash'), block_hash: blockHashSchema }).strict(),
])
const credentialSchema = z.object({
  type: z.literal('inline'),
  secret: z.string().min(1).max(4_096).meta({ writeOnly: true }),
}).strict()
const inputSchema = z.object({
  selector: selectorSchema.optional(),
  credential: credentialSchema.optional(),
}).strict()

const memberInstanceSchema = z.object({
  phase: z.literal('member'),
  chain_id: positiveCanonicalDecimalSchema,
  tawg_address: evmAddressSchema,
  agent_id: canonicalDecimalSchema,
}).strict()
const resolutionSchema = z.object({
  chain: z.object({ block_number: canonicalDecimalSchema, block_hash: blockHashSchema }).strict(),
  profile: z.object({ version: positiveCanonicalDecimalSchema }).strict(),
  repository: z.object({ url: repositorySchema, commit: fullCommitSchema }).strict(),
}).strict()
const contextSchema = z.object({
  instance: memberInstanceSchema,
  request_id: z.string().uuid(),
  resolved: resolutionSchema,
}).strict()
const compilerSchema = z.object({ version: z.string(), settings_hash: sha256Schema }).strict()
const identityShape = {
  fingerprint: sha256Schema,
  workflow_address: evmAddressSchema,
  deployed_code_hash: keccakSchema,
  repository: repositorySchema,
  commit: fullCommitSchema,
  source_path: z.string().min(1),
  source_hash: keccakSchema,
  source_closure_hash: sha256Schema,
  metadata_path: z.string().min(1),
  metadata_hash: z.string().regex(/^[0-9a-f]{64}$/),
  compiler: compilerSchema,
} as const
const verifiedDataSchema = z.object({
  valid: z.literal(true),
  reason: z.literal('verified'),
  ...identityShape,
}).strict()
const rejectedDataSchema = z.object({
  valid: z.literal(false),
  reason: z.enum(['source_mismatch', 'metadata_mismatch', 'runtime_mismatch']),
  ...identityShape,
}).strict()
const verifyOutputSchema = z.object({
  context: contextSchema,
  data: z.discriminatedUnion('valid', [verifiedDataSchema, rejectedDataSchema]),
}).strict()
const getOutputSchema = z.object({
  context: contextSchema,
  data: verifiedDataSchema.extend({
    source: z.object({ path: z.string().min(1), hash: keccakSchema, content: z.string() }).strict(),
  }).strict(),
}).strict()

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const

function selectorFromInput(input: z.infer<typeof selectorSchema> | undefined): ChainSelector {
  if (input === undefined) return { kind: 'latest' }
  if (input.kind === 'block_number') return { kind: input.kind, blockNumber: input.block_number }
  if (input.kind === 'block_hash') return { kind: input.kind, blockHash: input.block_hash as `0x${string}` }
  return { kind: input.kind }
}

function publicVerification(result: WorkflowVerificationResult): PublicJsonObject {
  return {
    valid: result.valid,
    reason: result.reason,
    fingerprint: result.fingerprint,
    workflow_address: result.context.workflowAddress,
    deployed_code_hash: result.deployedCodeHash,
    repository: result.context.repository,
    commit: result.context.commit,
    source_path: result.context.sourcePath,
    source_hash: result.source.keccak256,
    source_closure_hash: result.source.closureHash,
    metadata_path: result.context.metadataPath,
    metadata_hash: result.source.metadataSha256,
    compiler: { version: result.compiler.version, settings_hash: result.compiler.settingsHash },
  }
}

function resolution(result: WorkflowVerificationResult): ResolutionContext {
  return {
    chain: { block_number: result.context.blockNumber, block_hash: result.context.blockHash },
    profile: { version: result.context.profileVersion },
    repository: { url: result.context.repository, commit: result.context.commit },
  }
}

function serviceInput(
  input: z.infer<typeof inputSchema>,
  signal: AbortSignal,
) {
  return {
    selector: selectorFromInput(input.selector),
    signal,
    ...(input.credential === undefined ? {} : { credential: input.credential }),
  }
}

function isCallerCancellation(signal: AbortSignal, error: unknown): boolean {
  return signal.aborted && error instanceof Error && error.name === 'AbortError'
}

/** Registers member-only, process-scoped Workflow source verification tools. */
export function registerWorkflowSourceTools(
  server: McpServer,
  service: WorkflowSourceService,
  instance: Extract<TasPublicInstance, { readonly phase: 'member' }>,
): void {
  server.registerTool('workflow.source.verify', {
    title: 'Verify Workflow source',
    description: 'Reproduces the Profile-selected Workflow and compares it with canonical deployed runtime code. An optional inline credential reads a private Repository.',
    inputSchema,
    outputSchema: verifyOutputSchema,
    annotations,
  }, async (input, context) => {
    try {
      const result = await service.verify(serviceInput(input, context.mcpReq.signal))
      return createTasResultBuilder(instance, resolution(result)).success(publicVerification(result))
    } catch (error) {
      if (isCallerCancellation(context.mcpReq.signal, error)) throw error
      return createTasResultBuilder(instance).toolError(error)
    }
  })

  server.registerTool('workflow.source.get', {
    title: 'Get verified Workflow source',
    description: 'Returns the complete Profile-selected Workflow source only when its fresh fingerprint matches this process verification.',
    inputSchema,
    outputSchema: getOutputSchema,
    annotations,
  }, async (input, context) => {
    try {
      const result: WorkflowSourceGetResult = await service.get(serviceInput(input, context.mcpReq.signal))
      return createTasResultBuilder(instance, resolution(result)).success({
        ...publicVerification(result),
        source: { path: result.context.sourcePath, hash: result.source.keccak256, content: result.sourceContent },
      })
    } catch (error) {
      if (isCallerCancellation(context.mcpReq.signal, error)) throw error
      return createTasResultBuilder(instance).toolError(error)
    }
  })
}
