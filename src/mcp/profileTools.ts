import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { TasError } from '../core/errors.js'
import type { ProfileResolver, ProfileJsonObject, ProfileResolution } from '../core/profile/resolver.js'
import type { ChainSelector } from '../core/profile/types.js'
import { createTasResultBuilder, type PublicJsonObject, type TasPublicInstance } from './results.js'

const maxUint256 = 2n ** 256n - 1n
const canonicalDecimalSchema = z.string().max(78).regex(/^(?:0|[1-9][0-9]*)$/).refine((value) => {
  if (value.length > 78) return false
  try { return BigInt(value) <= maxUint256 } catch { return false }
})
const positiveCanonicalDecimalSchema = z.string().max(78).regex(/^[1-9][0-9]*$/).refine((value) => {
  if (value.length > 78) return false
  try { return BigInt(value) <= maxUint256 } catch { return false }
})
const blockHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const evmAddressSchema = z.string().regex(/^0x(?!0{40}$)[0-9a-fA-F]{40}$/)
const repositorySchema = z.string().min(1)
const dataKeySchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/)

const latestSelectorSchema = z.object({ kind: z.literal('latest') }).strict()
const safeSelectorSchema = z.object({ kind: z.literal('safe') }).strict()
const finalizedSelectorSchema = z.object({ kind: z.literal('finalized') }).strict()
const blockNumberSelectorSchema = z.object({
  kind: z.literal('block_number'),
  block_number: canonicalDecimalSchema,
}).strict()
const blockHashSelectorSchema = z.object({
  kind: z.literal('block_hash'),
  block_hash: blockHashSchema,
}).strict()
const selectorSchema = z.discriminatedUnion('kind', [
  latestSelectorSchema,
  safeSelectorSchema,
  finalizedSelectorSchema,
  blockNumberSelectorSchema,
  blockHashSelectorSchema,
])

const profileGetInputSchema = z.object({ selector: selectorSchema.optional() }).strict()
const profileGetAgentInputSchema = z.object({
  agent_id: canonicalDecimalSchema,
  selector: selectorSchema.optional(),
}).strict()

const jsonObjectSchema = z.record(z.string(), z.json())
const instanceSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('tawg_setup'), chain_id: positiveCanonicalDecimalSchema, tawg_address: evmAddressSchema }).strict(),
  z.object({ phase: z.literal('member'), chain_id: positiveCanonicalDecimalSchema, tawg_address: evmAddressSchema, agent_id: canonicalDecimalSchema }).strict(),
])
const resolutionSchema = z.object({
  chain: z.object({ block_number: canonicalDecimalSchema, block_hash: blockHashSchema }).strict(),
  profile: z.object({ version: positiveCanonicalDecimalSchema }).strict(),
}).strict()
const contextSchema = z.object({
  instance: instanceSchema,
  request_id: z.string().uuid(),
  resolved: resolutionSchema,
}).strict()
const profileDataSchema = z.object({
  version: positiveCanonicalDecimalSchema,
  governance: evmAddressSchema,
  charter: z.object({ repository: repositorySchema, commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/), path: z.literal('charter/') }).strict(),
  agents: z.object({ identity_registry: evmAddressSchema, agent_ids: z.array(canonicalDecimalSchema) }).strict(),
  data: z.record(dataKeySchema, jsonObjectSchema),
  workflow: z.object({ address: evmAddressSchema, data: jsonObjectSchema }).strict(),
}).strict()
const memberDataSchema = z.object({
  agent_id: canonicalDecimalSchema,
  is_member: z.literal(true),
  data: jsonObjectSchema,
  agent_verifier: evmAddressSchema,
  authentication_wallet: evmAddressSchema,
}).strict()
const nonmemberDataSchema = z.object({
  agent_id: canonicalDecimalSchema,
  is_member: z.literal(false),
}).strict()
const profileOutputSchema = z.object({ context: contextSchema, data: profileDataSchema }).strict()
const agentOutputSchema = z.object({ context: contextSchema, data: z.discriminatedUnion('is_member', [memberDataSchema, nonmemberDataSchema]) }).strict()

function selectorFromInput(input: z.infer<typeof selectorSchema> | undefined): ChainSelector {
  if (!input) return { kind: 'latest' }
  if (input.kind === 'block_number') return { kind: input.kind, blockNumber: input.block_number }
  if (input.kind === 'block_hash') return { kind: input.kind, blockHash: input.block_hash as `0x${string}` }
  return { kind: input.kind }
}

function publicData(data: ProfileJsonObject): PublicJsonObject {
  return data as PublicJsonObject
}

function isCallerCancellation(signal: AbortSignal, error: unknown): boolean {
  if (!signal.aborted) return false
  try { return error instanceof Error && error.name === 'AbortError' } catch { return false }
}

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const

function results(instance: TasPublicInstance, resolution?: ProfileResolution) {
  return createTasResultBuilder(instance, resolution)
}

/** Registers exact-block Profile discovery tools for one TAWG-bound TAS process. */
export function registerProfileTools(
  server: McpServer,
  resolver: ProfileResolver,
  instance: Exclude<TasPublicInstance, { readonly phase: 'identity_setup' }>,
): void {
  if (instance.chain_id !== resolver.binding.chainId || instance.tawg_address.toLowerCase() !== resolver.binding.tawgAddress.toLowerCase()) {
    throw new TasError('PROFILE_INCONSISTENT', 'The selected TAWG Profile state is inconsistent.')
  }
  server.registerTool('profile.get', {
    title: 'Get TAWG Profile',
    description: 'Returns the configured TAWG Profile projection at one exact chain block.',
    inputSchema: profileGetInputSchema,
    outputSchema: profileOutputSchema,
    annotations,
  }, async (input, context) => {
    try {
      const resolved = await resolver.get(selectorFromInput(input.selector), { signal: context.mcpReq.signal })
      return results(instance, resolved.resolution).success(publicData(resolved.data))
    } catch (error) {
      if (isCallerCancellation(context.mcpReq.signal, error)) throw error
      return results(instance).toolError(error)
    }
  })

  server.registerTool('profile.get_agent', {
    title: 'Get TAWG Agent',
    description: 'Returns membership and member metadata for one ERC-8004 Agent ID at one exact chain block.',
    inputSchema: profileGetAgentInputSchema,
    outputSchema: agentOutputSchema,
    annotations,
  }, async (input, context) => {
    try {
      const resolved = await resolver.getAgent(input.agent_id, selectorFromInput(input.selector), { signal: context.mcpReq.signal })
      return results(instance, resolved.resolution).success(publicData(resolved.data))
    } catch (error) {
      if (isCallerCancellation(context.mcpReq.signal, error)) throw error
      return results(instance).toolError(error)
    }
  })
}
