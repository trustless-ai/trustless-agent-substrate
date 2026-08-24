import { McpServer } from '@modelcontextprotocol/server'

import type { ChatPlatform } from '../core/chat/types.js'
import type { ChatService } from '../core/chat/service.js'
import { generatedOutputEnvelopeSchema, generatedStandardSchema } from './generatedToolHelpers.js'
import type { GeneratedToolEntry } from './manifest/types.js'
import { createTasResultBuilder, type TasPublicInstance } from './results.js'

export type ChatGeneratedToolEntry = GeneratedToolEntry & {
  readonly binding: { readonly kind: 'chat_operation'; readonly target: string }
}

function entryPlatform(name: string): ChatPlatform | undefined {
  if (name.startsWith('chat.telegram.')) return 'telegram'
  if (name.startsWith('chat.discord.')) return 'discord'
  return undefined
}

export function isChatGeneratedToolEntry(entry: GeneratedToolEntry): entry is ChatGeneratedToolEntry {
  return entry.binding.kind === 'chat_operation' && entryPlatform(entry.name) !== undefined
}

/** Registers only reviewed generated entries belonging to configured platform groups. */
export function registerGeneratedChatTools(
  server: McpServer,
  entries: readonly ChatGeneratedToolEntry[],
  service: ChatService,
  instance: Extract<TasPublicInstance, { readonly phase: 'member' }>,
): void {
  const results = createTasResultBuilder(instance)
  const enabled = new Set(service.platforms())
  for (const entry of entries) {
    const platform = entryPlatform(entry.name)
    if (platform === undefined || !enabled.has(platform)) continue
    server.registerTool(entry.name, {
      description: entry.description,
      inputSchema: generatedStandardSchema(entry.input_schema),
      outputSchema: generatedStandardSchema(generatedOutputEnvelopeSchema(entry as unknown as GeneratedToolEntry)),
      annotations: entry.annotations,
    }, async (input, context) => {
      try {
        const data = await service.invoke({
          platform,
          toolName: entry.name,
          bindingTarget: entry.binding.target,
          arguments: input as Readonly<Record<string, unknown>>,
        })
        return results.success(data)
      } catch (error) {
        if (context.mcpReq.signal.aborted && error instanceof Error && error.name === 'AbortError') throw error
        return results.toolError(error)
      }
    })
  }
}
