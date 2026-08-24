import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import type { DaService } from '../core/da/service.js'
import type { DaCapabilities, DaGetInput, DaGetResult, DaPutInput, DaPutResult, GitDaReference } from '../core/da/types.js'
import type { ChainSelector } from '../core/profile/types.js'
import {
  createTasResultBuilder,
  type PublicJsonObject,
  type ResolutionContext,
  type TasPublicInstance,
} from './results.js'

const maxUint256 = 2n ** 256n - 1n
const maxInlineBytes = 1_048_576
const maxBase64Characters = Math.ceil(maxInlineBytes / 3) * 4
const canonicalDecimalSchema = z.string().max(78).regex(/^(?:0|[1-9][0-9]*)$/).refine((value) => {
  try { return BigInt(value) <= maxUint256 } catch { return false }
})
const positiveCanonicalDecimalSchema = z.string().max(78).regex(/^[1-9][0-9]*$/).refine((value) => {
  try { return BigInt(value) <= maxUint256 } catch { return false }
})
const blockHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const evmAddressSchema = z.string().regex(/^0x(?!0{40}$)[0-9a-fA-F]{40}$/)
const fullCommitSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
const gitDaPathSchema = z.string().min(6).max(4_096).regex(
  /^data\/(?!(?:.*\/)?(?:\.{1,2})(?:\/|$))(?!.*\/\/)(?!.*\/$)[^/\\\u0000-\u001f\u007f]+(?:\/[^/\\\u0000-\u001f\u007f]+)*$/,
)
const repositoryUrlSchema = z.string().regex(/^https:\/\/github\.com\/[^/]+\/[^/]+$/)

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
const gitReferenceSchema = z.object({
  type: z.literal('git'),
  commit: fullCommitSchema,
  path: gitDaPathSchema,
}).strict()
const mediaTypeSchema = z.string().max(1_024)
const utf8ContentSchema = z.object({
  encoding: z.literal('utf8'),
  value: z.string().max(maxInlineBytes + 1),
  media_type: mediaTypeSchema.optional(),
}).strict()
const base64ContentSchema = z.object({
  encoding: z.literal('base64'),
  value: z.string().max(maxBase64Characters + 4),
  media_type: mediaTypeSchema.optional(),
}).strict()
const inputContentSchema = z.discriminatedUnion('encoding', [utf8ContentSchema, base64ContentSchema])
const outputContentSchema = z.object({
  encoding: z.literal('base64'),
  value: z.string().max(maxBase64Characters),
  media_type: mediaTypeSchema.optional(),
}).strict()

const capabilitiesInputSchema = z.object({}).strict()
const getInputSchema = z.object({
  ref: gitReferenceSchema,
  selector: selectorSchema.optional(),
  credential: credentialSchema.optional(),
}).strict()
const putInputSchema = z.object({
  content: inputContentSchema,
  destination: z.object({ path: gitDaPathSchema }).strict().optional(),
  selector: selectorSchema.optional(),
  credential: credentialSchema.optional(),
}).strict()

const memberInstanceSchema = z.object({
  phase: z.literal('member'),
  chain_id: positiveCanonicalDecimalSchema,
  tawg_address: evmAddressSchema,
  agent_id: canonicalDecimalSchema,
}).strict()
const baseContextSchema = z.object({
  instance: memberInstanceSchema,
  request_id: z.string().uuid(),
}).strict()
const resolutionSchema = z.object({
  chain: z.object({ block_number: canonicalDecimalSchema, block_hash: blockHashSchema }).strict(),
  profile: z.object({ version: positiveCanonicalDecimalSchema }).strict(),
  repository: z.object({ url: repositoryUrlSchema, commit: fullCommitSchema }).strict(),
  da: gitReferenceSchema,
}).strict()
const resolvedContextSchema = z.object({
  instance: memberInstanceSchema,
  request_id: z.string().uuid(),
  resolved: resolutionSchema,
}).strict()
const capabilitiesOutputSchema = z.object({
  context: baseContextSchema,
  data: z.object({
    backend: z.literal('git'),
    reference_types: z.tuple([z.literal('git')]),
    read: z.literal(true),
    write: z.literal(true),
    content_encodings: z.tuple([z.literal('utf8'), z.literal('base64')]),
    max_inline_bytes: z.number().int().min(1).max(maxInlineBytes),
  }).strict(),
}).strict()
const getOutputSchema = z.object({
  context: resolvedContextSchema,
  data: z.object({ ref: gitReferenceSchema, content: outputContentSchema, size_bytes: z.number().int().min(0).max(maxInlineBytes) }).strict(),
}).strict()
const putOutputSchema = z.object({
  context: resolvedContextSchema,
  data: z.object({ ref: gitReferenceSchema, size_bytes: z.number().int().min(0).max(maxInlineBytes) }).strict(),
}).strict()

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const
const capabilitiesAnnotations = { ...readAnnotations, openWorldHint: false } as const
const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const

function selectorFromInput(input: z.infer<typeof selectorSchema> | undefined): ChainSelector {
  if (!input) return { kind: 'latest' }
  if (input.kind === 'block_number') return { kind: input.kind, blockNumber: input.block_number }
  if (input.kind === 'block_hash') return { kind: input.kind, blockHash: input.block_hash as `0x${string}` }
  return { kind: input.kind }
}

function resolution(result: DaGetResult | DaPutResult): ResolutionContext {
  return {
    chain: { block_number: result.source.profile.blockNumber, block_hash: result.source.profile.blockHash },
    profile: { version: result.source.profile.version },
    repository: { url: result.source.locator, commit: result.ref.commit },
    da: result.ref,
  }
}

function projectReference(ref: GitDaReference): PublicJsonObject {
  return { type: ref.type, commit: ref.commit, path: ref.path }
}

function inputReference(ref: z.infer<typeof gitReferenceSchema>): GitDaReference {
  return { type: 'git', commit: ref.commit, path: ref.path as `data/${string}` }
}

function projectGet(result: DaGetResult): PublicJsonObject {
  return {
    ref: projectReference(result.ref),
    content: {
      encoding: result.content.encoding,
      value: result.content.value,
      ...(result.content.media_type === undefined ? {} : { media_type: result.content.media_type }),
    },
    size_bytes: result.size_bytes,
  }
}

function projectPut(result: DaPutResult): PublicJsonObject {
  return { ref: projectReference(result.ref), size_bytes: result.size_bytes }
}

function projectCapabilities(value: DaCapabilities): PublicJsonObject {
  return {
    backend: value.backend,
    reference_types: value.reference_types,
    read: value.read,
    write: value.write,
    content_encodings: value.content_encodings,
    max_inline_bytes: value.max_inline_bytes,
  }
}

function isCallerCancellation(signal: AbortSignal, error: unknown): boolean {
  if (!signal.aborted) return false
  try { return error instanceof Error && error.name === 'AbortError' } catch { return false }
}

/** Registers the fixed, backend-neutral DA namespace for one member TAS. */
export function registerDaTools(
  server: McpServer,
  service: DaService,
  instance: Extract<TasPublicInstance, { readonly phase: 'member' }>,
): void {
  server.registerTool('workflow.da.capabilities', {
    title: 'Get DA Capabilities',
    description: 'Returns the effective immutable DA interface configured for this TAS instance.',
    inputSchema: capabilitiesInputSchema,
    outputSchema: capabilitiesOutputSchema,
    annotations: capabilitiesAnnotations,
  }, async () => {
    try {
      return createTasResultBuilder(instance).success(projectCapabilities(await service.capabilities()))
    } catch (error) {
      return createTasResultBuilder(instance).toolError(error)
    }
  })

  server.registerTool('workflow.da.get', {
    title: 'Get Immutable DA Content',
    description: 'Reads exact bytes from one immutable Git DA reference in the Profile-selected Repository; a private Repository requires an operation-scoped inline credential.',
    inputSchema: getInputSchema,
    outputSchema: getOutputSchema,
    annotations: readAnnotations,
  }, async (input, context) => {
    const serviceInput: DaGetInput = {
      ref: inputReference(input.ref),
      ...(input.selector === undefined ? {} : { selector: selectorFromInput(input.selector) }),
      ...(input.credential === undefined ? {} : { credential: input.credential }),
      signal: context.mcpReq.signal,
    }
    try {
      const result = await service.get(serviceInput)
      return createTasResultBuilder(instance, resolution(result)).success(projectGet(result))
    } catch (error) {
      if (isCallerCancellation(context.mcpReq.signal, error)) throw error
      return createTasResultBuilder(instance).toolError(error)
    }
  })

  server.registerTool('workflow.da.put', {
    title: 'Put Immutable DA Content',
    description: 'Writes exact bytes below data/ in the Profile-selected Repository and returns the resulting immutable Git reference; a private Repository requires an operation-scoped inline credential.',
    inputSchema: putInputSchema,
    outputSchema: putOutputSchema,
    annotations: writeAnnotations,
  }, async (input, context) => {
    const serviceInput: DaPutInput = {
      content: input.content,
      ...(input.destination === undefined ? {} : { destination: input.destination }),
      ...(input.selector === undefined ? {} : { selector: selectorFromInput(input.selector) }),
      ...(input.credential === undefined ? {} : { credential: input.credential }),
      signal: context.mcpReq.signal,
    }
    try {
      const result = await service.put(serviceInput)
      return createTasResultBuilder(instance, resolution(result)).success(projectPut(result))
    } catch (error) {
      if (isCallerCancellation(context.mcpReq.signal, error)) throw error
      return createTasResultBuilder(instance).toolError(error)
    }
  })
}
