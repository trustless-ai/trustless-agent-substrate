import { McpServer } from '@modelcontextprotocol/server'

import type { ChainService } from '../core/workflow/chainService.js'
import { generatedOutputEnvelopeSchema, generatedStandardSchema } from './generatedToolHelpers.js'
import type { ManifestRegistry } from './manifest/registry.js'
import { createTasResultBuilder, type TasPublicInstance } from './results.js'

/** Registers both complete, already-reviewed viem Manifest groups. */
export function registerGeneratedChainTools(
  server: McpServer,
  registry: ManifestRegistry,
  service: ChainService,
  instance: TasPublicInstance,
): void {
  const results = createTasResultBuilder(instance)
  for (const profile of ['viem-public', 'viem-wallet'] as const) {
    for (const entry of registry.list(profile)) {
      server.registerTool(entry.name, {
        description: entry.description,
        inputSchema: generatedStandardSchema(entry.input_schema),
        outputSchema: generatedStandardSchema(generatedOutputEnvelopeSchema(entry)),
        annotations: entry.annotations,
      }, async (input) => {
        try {
          const data = await service.invoke({
            toolName: entry.name,
            arguments: input as Readonly<Record<string, unknown>>,
          })
          return results.success(data)
        } catch (error) {
          return results.toolError(error)
        }
      })
    }
  }
}
