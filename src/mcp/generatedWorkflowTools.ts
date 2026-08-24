import { McpServer } from '@modelcontextprotocol/server'

import type { WorkflowOperationService } from '../core/workflow/types.js'
import { generatedOutputEnvelopeSchema, generatedStandardSchema } from './generatedToolHelpers.js'
import type { ManifestRegistry } from './manifest/registry.js'
import { createTasResultBuilder, type TasPublicInstance } from './results.js'

/** Registers the complete, already-reviewed agent-sdk Manifest group. */
export function registerGeneratedWorkflowTools(
  server: McpServer,
  registry: ManifestRegistry,
  service: WorkflowOperationService,
  instance: Extract<TasPublicInstance, { readonly phase: 'member' }>,
): void {
  const results = createTasResultBuilder(instance)
  for (const entry of registry.list('agent-sdk')) {
    server.registerTool(entry.name, {
      description: entry.description,
      inputSchema: generatedStandardSchema(entry.input_schema),
      outputSchema: generatedStandardSchema(generatedOutputEnvelopeSchema(entry)),
      annotations: entry.annotations,
    }, async (input, context) => {
      try {
        const data = await service.invoke({
          toolName: entry.name,
          arguments: input as Readonly<Record<string, unknown>>,
        }, { signal: context.mcpReq.signal })
        return results.success(data)
      } catch (error) {
        if (context.mcpReq.signal.aborted && error instanceof Error && error.name === 'AbortError') throw error
        return results.toolError(error)
      }
    })
  }
}
