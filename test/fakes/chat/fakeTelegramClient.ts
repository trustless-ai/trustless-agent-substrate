import type { ChatAuthenticatedClient, ChatClientFactory } from '../../../src/core/chat/types.js'
import type { FakeChatBroker } from './broker.js'

/** Test-only Telegram factory implementing the production Chat Client contracts. */
export function createFakeTelegramClient(broker: FakeChatBroker): ChatClientFactory {
  return {
    create(authentication) {
      const client: ChatAuthenticatedClient = {
        async invoke(operation) {
          broker.capture('telegram', authentication.source.name, operation)
          return true
        },
        wait: (request, options) => broker.wait('telegram', authentication.source.name, request, options),
      }
      return client
    },
  }
}
