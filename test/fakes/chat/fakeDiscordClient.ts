import type { ChatAuthenticatedClient, ChatClientFactory } from '../../../src/core/chat/types.js'
import type { FakeChatBroker } from './broker.js'

/** Test-only Discord factory implementing the production Chat Client contracts. */
export function createFakeDiscordClient(broker: FakeChatBroker): ChatClientFactory {
  return {
    create(authentication) {
      const client: ChatAuthenticatedClient = {
        async invoke(operation) {
          broker.capture('discord', authentication.source.name, operation)
          return null
        },
        wait: (request, options) => broker.wait('discord', authentication.source.name, request, options),
      }
      return client
    },
  }
}
