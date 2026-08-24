import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import type { AttestationAdapter } from '../core/proof-provider/adapter.js'
import type { ProofProviderRegistry } from '../core/proof-provider/registry.js'
import type { AttestationAdapterManifest } from '../core/proof-provider/types.js'
import { createTasResultBuilder, type PublicJsonObject, type TasPublicInstance } from './results.js'

const credentialSchema = z.object({
  type: z.literal('inline'),
  secret: z.string().min(1).max(4_096).meta({ writeOnly: true }),
}).strict()
const generateInputSchema = z.object({ input: z.json(), credential: credentialSchema }).strict()
const validateInputSchema = z.object({ proof: z.json() }).strict()
const manifestSchema = z.object({
  provider: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  type: z.literal('attestation'),
  operations_namespace: z.string().regex(/^proof_provider\.attestation\.[a-z][a-z0-9_]{0,63}$/),
  operations: z.tuple([z.literal('generate'), z.literal('validate')]),
}).strict()
const memberInstanceSchema = z.object({
  phase: z.literal('member'),
  chain_id: z.string(),
  tawg_address: z.string(),
  agent_id: z.string(),
}).strict()
const contextSchema = z.object({ instance: memberInstanceSchema, request_id: z.string().uuid() }).strict()
const listOutputSchema = z.object({ context: contextSchema, data: z.array(manifestSchema) }).strict()
const generateOutputSchema = z.object({ context: contextSchema, data: z.json() }).strict()
const validateOutputSchema = z.object({
  context: contextSchema,
  data: z.object({ valid: z.boolean(), reason: z.string().min(1) }).strict(),
}).strict()

const listAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const
const generateAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const
const validateAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const

function isCallerCancellation(signal: AbortSignal, error: unknown): boolean {
  return signal.aborted && error instanceof Error && error.name === 'AbortError'
}

function registerAttestationAdapterTools(
  server: McpServer,
  manifest: AttestationAdapterManifest,
  adapter: AttestationAdapter,
  instance: Extract<TasPublicInstance, { readonly phase: 'member' }>,
): void {
  server.registerTool(`${manifest.operations_namespace}.generate`, {
    title: `Generate ${manifest.provider} attestation`,
    description: 'Generates a Provider-specific attestation using one inline operation credential.',
    inputSchema: generateInputSchema,
    outputSchema: generateOutputSchema,
    annotations: generateAnnotations,
  }, async (input, context) => {
    try {
      const result = await adapter.generate({ input: input.input, credential: input.credential, signal: context.mcpReq.signal })
      return createTasResultBuilder(instance).success(result)
    } catch (error) {
      if (isCallerCancellation(context.mcpReq.signal, error)) throw error
      return createTasResultBuilder(instance).toolError(error)
    }
  })

  server.registerTool(`${manifest.operations_namespace}.validate`, {
    title: `Validate ${manifest.provider} attestation`,
    description: 'Validates Provider proof data without a generation credential.',
    inputSchema: validateInputSchema,
    outputSchema: validateOutputSchema,
    annotations: validateAnnotations,
  }, async (input, context) => {
    try {
      const result = await adapter.validate({ proof: input.proof, signal: context.mcpReq.signal })
      if (typeof result.reason !== 'string' || result.reason.length === 0) throw new Error('Invalid Provider validation result.')
      return createTasResultBuilder(instance).success({ valid: result.valid, reason: result.reason })
    } catch (error) {
      if (isCallerCancellation(context.mcpReq.signal, error)) throw error
      return createTasResultBuilder(instance).toolError(error)
    }
  })
}

/** Registers fixed Attestation discovery and namespaced tools for bundled adapters only. */
export function registerProofProviderTools(
  server: McpServer,
  registry: ProofProviderRegistry,
  instance: Extract<TasPublicInstance, { readonly phase: 'member' }>,
): void {
  const manifests = registry.listAttestations()
  server.registerTool('proof_provider.attestation.list', {
    title: 'List Attestation Providers',
    description: 'Lists bundled Attestation Providers and their standardized operation namespaces without contacting a Provider.',
    inputSchema: z.object({}).strict(),
    outputSchema: listOutputSchema,
    annotations: listAnnotations,
  }, async () => createTasResultBuilder(instance).success(manifests.map((manifest): PublicJsonObject => ({
    provider: manifest.provider,
    type: manifest.type,
    operations_namespace: manifest.operations_namespace,
    operations: [...manifest.operations],
  }))))
  for (const manifest of manifests) {
    const adapter = registry.getAttestation(manifest.provider)
    if (adapter === undefined) throw new TypeError('Invalid Proof Provider registry.')
    registerAttestationAdapterTools(server, manifest, adapter, instance)
  }
}
