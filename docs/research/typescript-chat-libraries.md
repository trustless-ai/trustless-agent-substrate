# TypeScript Chat Libraries for Telegram and Discord

## 1. Conclusion

For TAS v0.1, use:

1. **Telegram: [grammY](https://grammy.dev/)**. It is TypeScript-first, exposes the Telegram Bot API, supports long polling and webhooks, and provides a runner when concurrent update processing is needed. Telegraf is also viable, but does not provide a material advantage for the TAS abstraction. [grammY deployment modes](https://grammy.dev/guide/deployment-types), [grammY runner](https://grammy.dev/ref/runner/run), [Telegraf API](https://telegraf.js.org/classes/Telegraf.html)
2. **Discord: [discord.js](https://discord.js.org/docs)**. It combines Discord Gateway events with REST message operations and already handles the normal connection lifecycle. [Discord Gateway](https://docs.discord.com/developers/events/gateway), [discord.js MessageManager](https://discord.js.org/docs/packages/discord.js/14.27.0/MessageManager:Class)
3. Share only TAS's internal target resolution and delivery-state mechanics. Keep the public MCP surface split into `chat.telegram.*` and `chat.discord.*`, generated from grammY and discord.js Manifests, so platform-native message capabilities and recovery semantics remain visible.

## 2. Platform Semantics

### 2.1 Telegram

Telegram bots receive updates through mutually exclusive `getUpdates` long polling or webhooks. TAS should use long polling because it is a local process and does not require a public endpoint. `update_id` is the receive-stream position; calling `getUpdates` with a higher `offset` confirms earlier updates. Telegram retains incoming updates for no more than 24 hours. [Telegram Bot API: Getting updates](https://core.telegram.org/bots/api#getting-updates), [Telegram Bot API: getUpdates](https://core.telegram.org/bots/api#getupdates)

A Telegram `message_id` is meaningful together with its `chat_id`; it is not the receive cursor. The Bot API does not provide general group-history pagination, so TAS cannot promise arbitrary historical backfill after the 24-hour update-retention window. TAS therefore returns its next Delivery Cursor to the Agent and advances Telegram's offset only when the Agent supplies that cursor to a later wait.

Telegram supports text, typed media/file sending, replies through `reply_parameters`, and message editing/deletion subject to Bot API rules. Attachments are represented by Telegram-specific media fields and `file_id`; downloading uses `getFile`. [sendMessage](https://core.telegram.org/bots/api#sendmessage), [sendDocument](https://core.telegram.org/bots/api#senddocument), [ReplyParameters](https://core.telegram.org/bots/api#replyparameters), [editMessageText](https://core.telegram.org/bots/api#editmessagetext), [deleteMessage](https://core.telegram.org/bots/api#deletemessage), [getFile](https://core.telegram.org/bots/api#getfile)

In groups, privacy mode is enabled by default. A bot must be an administrator or have privacy mode disabled to receive ordinary group messages; this is a deployment requirement, not something the adapter can hide. [Telegram Bot Features: Privacy mode](https://core.telegram.org/bots/features#privacy-mode)

### 2.2 Discord

Discord delivers live message events over its Gateway WebSocket. Gateway intents select the events and data the application can receive; ordinary guild message content requires the privileged `MESSAGE_CONTENT` intent. Discord emits create, update, and delete message events. [Discord Gateway](https://docs.discord.com/developers/events/gateway), [Gateway events](https://docs.discord.com/developers/events/gateway-events), [Message Content intent](https://docs.discord.com/developers/events/gateway#message-content-intent)

For a temporary disconnect, Discord can resume a Gateway session and replay events after its last sequence number. Resume is not permanent: an invalid session requires a new Identify. A Gateway sequence number is therefore a connection-session cursor, not a durable message-history cursor. [Discord Gateway: Resuming](https://docs.discord.com/developers/events/gateway#resuming)

Discord also exposes channel message history over REST. It can page with mutually exclusive `before`, `after`, or `around` message Snowflakes, subject to channel permissions. This can recover the current messages created during longer downtime, but it cannot reconstruct every edit or deletion event that happened while TAS was offline. [Discord Message Resource: Get Channel Messages](https://docs.discord.com/developers/resources/message#get-channel-messages)

Discord supports message creation, replies through message references, file attachments, editing, and deletion. discord.js exposes history retrieval, edit, and delete through `MessageManager`, while text-based channels expose sending. [Discord Message Resource](https://docs.discord.com/developers/resources/message), [discord.js MessageManager](https://discord.js.org/docs/packages/discord.js/14.27.0/MessageManager:Class), [discord.js Message](https://discord.js.org/docs/packages/discord.js/14.27.0/Message:Class)

## 3. Shared Internal Boundary

The final TAS design does not expose this research sketch as a public generic message API. A small internal boundary may still carry the TAS-owned mechanics needed by both platform Clients:

```text
ChatAdapter
├── resolveTarget(name)
├── waitForEvents(deadline)
└── close()
```

Use a normalized message reference:

```text
MessageRef
├── platform
├── conversation_id           Telegram chat ID or Discord channel ID
└── message_id
```

The public message operations remain platform-specific and are generated from the selected SDK. TAS may use a minimal event envelope for delivery bookkeeping, but it preserves each platform event payload and does not pretend that all message kinds, history, editing, or deletion rules are equivalent.

## 4. Semantics That Must Remain Distinct

1. **Delivery position:** Telegram uses a Bot-wide, durable but at-most-24-hour `update_id` queue. Discord Gateway uses an App-session sequence. These positions are not group-level cursors. TAS returns one opaque platform-specific Delivery Cursor per configured chat source to the Agent and accepts it on a later event wait; TAS does not retain the checkpoint itself.
2. **History:** Discord supports REST channel-history pagination. Telegram Bot API does not support general group-history listing. `listMessages` must therefore report a capability or mean only messages already observed by TAS; it must not promise equivalent remote history.
3. **Identifiers:** Telegram operations need `(chat_id, message_id)`. Discord APIs normally use `(channel_id, message_id)`, even though Discord Snowflakes carry time and are broadly unique.
4. **Visibility:** Telegram privacy mode and Discord intents/permissions determine which messages and fields TAS can observe. `getCapabilities()` should surface these effective limitations.
5. **Attachments:** Normalize attachment metadata and content inputs, but preserve Telegram media/file IDs and Discord attachment IDs/URLs as platform-specific fields.
6. **Recovery:** Gateway Resume and Telegram pending updates improve short-disconnect recovery, but neither platform guarantees a complete event history after arbitrary downtime. TAS must not describe message delivery as exactly once.

## 5. Implication for TAS MCP

The approved MCP boundary is platform-specific:

```text
chat.telegram.<generated_grammy_namespace>.*
chat.telegram.events.wait

chat.discord.<generated_discord_js_namespace>.*
chat.discord.events.wait
```

Each message call selects a configured target name that already binds a chat source, platform, and group or channel. The platform Manifest preserves representable send, reply, attachment, edit, delete, and history operations instead of forcing them through one common tool. Each event wait selects the Bot or App source, accepts the Agent's last cursor, and returns target-tagged events plus `next_cursor`; TAS retains neither the cursor nor duplicate-suppression state.
