import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server'

import { decodeBySchema, encodeEvmJson, type EvmJsonValue } from '../clients/chain/jsonCodec.js'
import type { GeneratedToolEntry } from './manifest/types.js'

type JsonSchema = Readonly<Record<string, unknown>>

const canonicalDecimal = { type: 'string', pattern: '^(?:0|[1-9][0-9]*)$' } as const
const address = { type: 'string', format: 'evm-address' } as const
const requestContextSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['instance', 'request_id'],
  properties: {
    instance: {
      oneOf: [
        {
          type: 'object', additionalProperties: false,
          required: ['phase', 'chain_id', 'identity_registry_address'],
          properties: { phase: { const: 'identity_setup' }, chain_id: canonicalDecimal, identity_registry_address: address },
        },
        {
          type: 'object', additionalProperties: false,
          required: ['phase', 'chain_id', 'tawg_address'],
          properties: { phase: { const: 'tawg_setup' }, chain_id: canonicalDecimal, tawg_address: address },
        },
        {
          type: 'object', additionalProperties: false,
          required: ['phase', 'chain_id', 'tawg_address', 'agent_id'],
          properties: { phase: { const: 'member' }, chain_id: canonicalDecimal, tawg_address: address, agent_id: canonicalDecimal },
        },
      ],
    },
    request_id: { type: 'string', minLength: 1 },
  },
} as const

const publicErrorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'category', 'message', 'retryable', 'recovery'],
  properties: {
    code: { type: 'string', minLength: 1 },
    category: { enum: ['configuration', 'conflict', 'unavailable', 'integrity', 'internal'] },
    message: { type: 'string', minLength: 1 },
    retryable: { type: 'boolean' },
    recovery: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: { action: { enum: ['retry', 'change_request', 'reconcile', 'user_action', 'abort'] } },
    },
  },
} as const

export function generatedOutputEnvelopeSchema(entry: GeneratedToolEntry): JsonSchema {
  const definitions = entry.output_schema.$defs
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    ...(definitions === undefined ? {} : { $defs: definitions }),
    oneOf: [
      {
        type: 'object', additionalProperties: false, required: ['context', 'data'],
        properties: { context: requestContextSchema, data: entry.output_schema },
      },
      {
        type: 'object', additionalProperties: false, required: ['context', 'error'],
        properties: { context: requestContextSchema, error: publicErrorSchema },
      },
    ],
  }
}

export function generatedStandardSchema(schema: JsonSchema): StandardSchemaWithJSON<unknown, EvmJsonValue> {
  return Object.freeze({
    '~standard': Object.freeze({
      version: 1 as const,
      vendor: '@trustless-ai/tas',
      jsonSchema: Object.freeze({ input: () => schema, output: () => schema }),
      validate(value: unknown) {
        try {
          return { value: encodeEvmJson(decodeBySchema(schema, value)) }
        } catch {
          return { issues: [{ message: 'Value does not match the generated TAS schema.' }] }
        }
      },
    }),
  })
}
