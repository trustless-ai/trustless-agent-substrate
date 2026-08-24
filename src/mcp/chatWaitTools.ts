import { McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import { z } from 'zod'

import type { ChatConfiguredSource, ChatEvent } from '../core/chat/types.js'
import type { ChatService } from '../core/chat/service.js'
import { generatedOutputEnvelopeSchema } from './generatedToolHelpers.js'
import type { GeneratedToolEntry } from './manifest/types.js'
import { createTasResultBuilder, type PublicJsonObject, type PublicJsonValue, type TasPublicInstance } from './results.js'

type JsonSchema = Readonly<Record<string, unknown>>

const credentialSchema = {
  type: 'object', additionalProperties: false,
  required: ['type', 'secret'],
  properties: { type: { const: 'inline' }, secret: { type: 'string', minLength: 1, maxLength: 4_096, writeOnly: true } },
} as const

const inputSchema = {
  type: 'object', additionalProperties: false,
  required: ['source', 'wait_bound_ms'],
  properties: {
    source: { type: 'string', minLength: 1 },
    cursor: { type: 'string', minLength: 1 },
    wait_bound_ms: { type: 'number', multipleOf: 1, minimum: 1, maximum: 60_000 },
    credential: credentialSchema,
  },
} as const

const outputSchema = {
  type: 'object', additionalProperties: false, required: ['events'],
  properties: {
    events: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['source', 'target', 'platform_event_id', 'platform_event_type', 'timestamp', 'sender', 'platform_payload'],
        properties: {
          source: { type: 'string' }, target: { type: 'string' }, platform_event_id: { type: 'string' },
          platform_event_type: { type: 'string' }, timestamp: { type: 'string' },
          sender: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
          platform_payload: {},
        },
      },
    },
    next_cursor: { type: 'string', minLength: 1 },
  },
} as const

const waitEntry: GeneratedToolEntry = {
  name: 'chat.events.wait',
  description: 'Wait for configured Chat events until the caller\'s bounded deadline.',
  source: { entrypoint: '.', export: 'ChatService', member: 'wait' },
  binding: { kind: 'client_action', target: 'ChatService.wait' },
  input_schema: inputSchema,
  output_schema: outputSchema,
  operation: { effect: 'read', completion: 'bounded_wait' },
  runtime_dependencies: [],
  credential: 'none',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}

const credentialValidator = z.object({ type: z.literal('inline'), secret: z.string().min(1).max(4_096) }).strict()
const inputValidator = z.object({
  source: z.string().min(1),
  cursor: z.string().min(1).optional(),
  wait_bound_ms: z.number().int().min(1).max(60_000),
  credential: credentialValidator.optional(),
}).strict()
const canonicalDecimalValidator = z.string().regex(/^(?:0|[1-9][0-9]*)$/)
const evmAddressValidator = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const instanceValidator = z.discriminatedUnion('phase', [
  z.object({
    phase: z.literal('identity_setup'), chain_id: canonicalDecimalValidator,
    identity_registry_address: evmAddressValidator,
  }).strict(),
  z.object({ phase: z.literal('tawg_setup'), chain_id: canonicalDecimalValidator, tawg_address: evmAddressValidator }).strict(),
  z.object({
    phase: z.literal('member'), chain_id: canonicalDecimalValidator, tawg_address: evmAddressValidator,
    agent_id: canonicalDecimalValidator,
  }).strict(),
])
const contextValidator = z.object({ instance: instanceValidator, request_id: z.string().min(1) }).strict()
const eventValidator = z.object({
  source: z.string(), target: z.string(), platform_event_id: z.string(), platform_event_type: z.string(), timestamp: z.string(),
  sender: z.record(z.string(), z.json()).nullable(), platform_payload: z.json(),
}).strict()
const dataValidator = z.object({ events: z.array(eventValidator), next_cursor: z.string().min(1).optional() }).strict()
const errorValidator = z.object({
  code: z.string().min(1), category: z.enum(['configuration', 'conflict', 'unavailable', 'integrity', 'internal']),
  message: z.string().min(1), retryable: z.boolean(),
  recovery: z.object({ action: z.enum(['retry', 'change_request', 'reconcile', 'user_action', 'abort']) }).strict(),
}).strict()
const outputValidator = z.union([
  z.object({ context: contextValidator, data: dataValidator }).strict(),
  z.object({ context: contextValidator, error: errorValidator }).strict(),
])

function schema<T>(validator: z.ZodType<T>, jsonSchema: JsonSchema): StandardSchemaWithJSON<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: '@trustless-ai/tas',
      jsonSchema: { input: () => jsonSchema, output: () => jsonSchema },
      validate(value: unknown) {
        const result = validator.safeParse(value)
        return result.success ? { value: result.data } : { issues: result.error.issues.map(({ message }) => ({ message })) }
      },
    },
  }
}

function publicEvent(event: ChatEvent): PublicJsonValue {
  return {
    source: event.source,
    target: event.target,
    platform_event_id: event.platformEventId,
    platform_event_type: event.platformEventType,
    timestamp: event.timestamp,
    sender: event.sender,
    platform_payload: event.platformPayload,
  }
}

/** Registers bounded platform waits for selected, configured source groups. */
export function registerChatWaitTools(
  server: McpServer,
  service: ChatService,
  sources: readonly ChatConfiguredSource[],
  instance: Extract<TasPublicInstance, { readonly phase: 'member' }>,
): void {
  const results = createTasResultBuilder(instance)
  const enabled = new Set(service.platforms())
  for (const platform of ['telegram', 'discord'] as const) {
    if (!enabled.has(platform) || !sources.some((source) => source.platform === platform)) continue
    server.registerTool(`chat.${platform}.events.wait`, {
      description: `Wait for configured ${platform} Chat events until the caller's bounded deadline.`,
      inputSchema: schema(inputValidator, inputSchema),
      outputSchema: schema(outputValidator, generatedOutputEnvelopeSchema(waitEntry)),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async (input, context) => {
      try {
        const arguments_ = input as { readonly source: string; readonly cursor?: string; readonly wait_bound_ms: number; readonly credential?: unknown }
        const result = await service.wait({
          platform, source: arguments_.source, cursor: arguments_.cursor, waitBoundMs: arguments_.wait_bound_ms,
          credential: arguments_.credential, signal: context.mcpReq.signal,
        })
        const events = result.events.map(publicEvent)
        const data: PublicJsonObject = result.nextCursor === undefined
          ? { events }
          : { events, next_cursor: result.nextCursor }
        return results.success(data)
      } catch (error) {
        if (context.mcpReq.signal.aborted && error instanceof Error && error.name === 'AbortError') throw error
        return results.toolError(error)
      }
    })
  }
}
