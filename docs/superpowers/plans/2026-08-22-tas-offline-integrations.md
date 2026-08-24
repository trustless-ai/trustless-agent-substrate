# TAS Offline Chat and Proof Provider Ports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Keep every external network call behind an injected Client and test the first slice entirely offline.

**Goal:** Implement the production Chat MCP contracts with offline Telegram/Discord Clients and establish the concrete-independent Proof Provider adapter boundary required by the TAS Demo vertical slice.

**Architecture:** Build-time source profiles generate Telegram and Discord operation Manifests from exact locked package types. Runtime Chat Services inject configured source/target identity and delegate to platform Clients; test-only Clients use a shared in-memory/local broker. Proof Provider Registry owns standardized discovery/generate/validate contracts and may contain zero adapters. A Fake adapter proves conformance without becoming a shipped Provider integration.

**Tech Stack:** Existing TypeScript TAS stack, exact lockfile-pinned grammY and discord.js releases, TypeScript compiler APIs, canonical JSON, Zod, Vitest, and test-only local transports.

**Spec:** `docs/tas/MANIFEST.md` Chat and Provider source profiles, `docs/tas/MCP.md` Sections 4.2.2, 4.15.3, and 4.17, `docs/tas/CONFIG.md` Chat/Provider configuration, and the accepted vertical-slice design Sections 8-9.

## Global Constraints

- Do not perform a Telegram, Discord, or Proof Provider network call in this plan.
- Do not add `chat.test.*`, `proof_provider.fake.*`, or another test-only public namespace.
- Agents see the production `chat.telegram.*`, `chat.discord.*`, and standardized `proof_provider.attestation.*` shapes.
- Fake implementations are dependency-injected only by tests and are not selectable through production TOML.
- TAS injects configured source/target identifiers; a caller cannot select an arbitrary conversation.
- The Agent/Host owns every Chat delivery cursor and advances it only after handling the returned events.
- TAS stores no Chat delivery position, duplicate-suppression state, message operation ID, Provider credential, or proof acceptance state.
- A bounded wait returns an empty success at timeout.
- No concrete Provider adapter ships in the first slice. `attestation.list` returns an empty list in the default production composition.
- `validate` returns `{ valid, reason }`; an invalid proof is negative data, while transport/adapter failure is a tool error.
- Workflow/ERC-8274 logic alone decides on-chain proof acceptance.

## Planned File Structure

```text
manifests/
├── telegram.v1.json
├── telegram-report.v1.json
├── discord.v1.json
└── discord-report.v1.json
tools/manifest/
├── analyzeTelegram.ts
├── analyzeDiscord.ts
└── generate.ts
src/
├── mcp/
│   ├── generatedChatTools.ts
│   ├── chatWaitTools.ts
│   └── proofProviderTools.ts
├── core/
│   ├── chat/
│   │   ├── types.ts
│   │   ├── client.ts
│   │   └── service.ts
│   └── proof-provider/
│       ├── types.ts
│       ├── adapter.ts
│       └── registry.ts
└── clients/chat/
    ├── telegramClient.ts
    └── discordClient.ts
test/
├── fakes/chat/
│   ├── broker.ts
│   ├── fakeTelegramClient.ts
│   └── fakeDiscordClient.ts
├── fakes/proof-provider/fakeAttestationAdapter.ts
├── unit/chat/
├── unit/proof-provider/
├── conformance/chatManifest.test.ts
├── conformance/chatMcp.test.ts
└── conformance/proofProviderMcp.test.ts
```

## Task 1: Generate Telegram and Discord Manifests

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `tools/manifest/analyzeTelegram.ts`
- Create: `tools/manifest/analyzeDiscord.ts`
- Modify: `tools/manifest/generate.ts`
- Create: `test/unit/manifest/chatAnalysis.test.ts`
- Create: `test/conformance/chatManifest.test.ts`
- Create: `manifests/telegram.v1.json`
- Create: `manifests/telegram-report.v1.json`
- Create: `manifests/discord.v1.json`
- Create: `manifests/discord-report.v1.json`

- [ ] **Step 1: Pin reviewed package releases and write failing source-profile tests**

Record exact versions/integrities in the lockfile and Manifest. Cover callable methods, callback/stream exclusions, injected chat/client/context fields, JSON-ineligible platform types, credential requirements, platform namespace isolation, and a projection failure.

- [ ] **Step 2: Implement deterministic source-profile analysis**

Generate complete include/exclude reports without a handwritten per-method allowlist. The profile may structurally select the public Client/API interface and invocation convention, but every member is mechanically accounted for.

- [ ] **Step 3: Generate twice and compare**

```bash
npm run manifest:generate
cp manifests/telegram.v1.json /tmp/tas-telegram-manifest.json
cp manifests/discord.v1.json /tmp/tas-discord-manifest.json
npm run manifest:generate
cmp /tmp/tas-telegram-manifest.json manifests/telegram.v1.json
cmp /tmp/tas-discord-manifest.json manifests/discord.v1.json
npm test -- test/unit/manifest/chatAnalysis.test.ts test/conformance/chatManifest.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json tools/manifest manifests/telegram* manifests/discord* test/unit/manifest/chatAnalysis.test.ts test/conformance/chatManifest.test.ts
git commit -m "feat: generate chat platform manifests"
```

## Task 2: Implement Chat Ports, Routing, and Bounded Waits

**Files:**

- Create: `src/core/chat/types.ts`
- Create: `src/core/chat/client.ts`
- Create: `src/core/chat/service.ts`
- Create: `src/mcp/generatedChatTools.ts`
- Create: `src/mcp/chatWaitTools.ts`
- Create: `test/unit/chat/service.test.ts`
- Create: `test/conformance/chatMcp.test.ts`

- [ ] **Step 1: Write failing routing and cursor tests**

Cover multiple sources, multiple targets, cross-platform target rejection, arbitrary conversation rejection, missing/invalid credentials, one operation-scoped authenticated Client, caller-supplied opaque cursor, next cursor, timeout-empty result, six-second configured polling fallback, and no cursor retained after a call.

- [ ] **Step 2: Implement platform-neutral delivery contracts**

The common internal event contains source, target, platform-native event ID/type, timestamp, sender projection, and platform payload. Do not claim a cross-platform global ordering or durable universal cursor.

- [ ] **Step 3: Bind generated platform tools and fixed wait bridges**

Register platform namespaces only for configured sources in member mode. Identity and TAWG setup expose no Chat tools. Inject the target's configured conversation ID and source credential into one Client call.

- [ ] **Step 4: Verify and commit**

```bash
npm test -- test/unit/chat/service.test.ts test/conformance/chatMcp.test.ts
npm run typecheck
git add src/core/chat src/mcp/generatedChatTools.ts src/mcp/chatWaitTools.ts test/unit/chat test/conformance/chatMcp.test.ts
git commit -m "feat: add chat routing and waits"
```

## Task 3: Add Offline Telegram and Discord Fake Clients

**Files:**

- Create: `test/fakes/chat/broker.ts`
- Create: `test/fakes/chat/fakeTelegramClient.ts`
- Create: `test/fakes/chat/fakeDiscordClient.ts`
- Create: `test/integration/offlineChat.test.ts`

- [ ] **Step 1: Write the failing shared-group scenario**

Create two isolated TAS compositions against one Fake broker. Inject a contribution mention, wait from each Agent's independent cursor, send an Evaluator reply through the generated platform namespace, restart one composition, and resume from its caller-held cursor.

- [ ] **Step 2: Implement the test-only broker and Clients**

The broker supports deterministic append, bounded wait, platform-specific opaque cursors, multiple sources/targets, and captured sends. Fake Clients implement the exact internal production Client contracts and no additional MCP surface.

- [ ] **Step 3: Verify and commit**

```bash
npm test -- test/integration/offlineChat.test.ts test/conformance/chatMcp.test.ts
git add test/fakes/chat test/integration/offlineChat.test.ts
git commit -m "test: simulate chat platforms offline"
```

## Task 4: Define the Proof Provider Adapter Registry

**Files:**

- Create: `src/core/proof-provider/types.ts`
- Create: `src/core/proof-provider/adapter.ts`
- Create: `src/core/proof-provider/registry.ts`
- Create: `src/mcp/proofProviderTools.ts`
- Create: `test/fakes/proof-provider/fakeAttestationAdapter.ts`
- Create: `test/unit/proof-provider/registry.test.ts`
- Create: `test/conformance/proofProviderMcp.test.ts`

- [ ] **Step 1: Write failing empty-registry tests**

Assert production composition always exposes `proof_provider.attestation.list`, returns `[]` without configured adapters, and registers no `generate`/`validate` tools for an absent adapter.

- [ ] **Step 2: Write failing adapter conformance tests**

Inject a Fake attestation adapter and assert metadata discovery, namespaced generate, one-call credential injection, `{ valid: true, reason }`, `{ valid: false, reason }`, malformed input error, adapter transport error, and non-retention of proof/credential state.

- [ ] **Step 3: Implement registry and standardized tools**

The Registry accepts only adapters bundled by the composition root and matching a reviewed Adapter Manifest. Do not add a source-package-specific adapter in this slice.

- [ ] **Step 4: Verify and commit**

```bash
npm test -- test/unit/proof-provider/registry.test.ts test/conformance/proofProviderMcp.test.ts
npm run typecheck
git add src/core/proof-provider src/mcp/proofProviderTools.ts test/fakes/proof-provider test/unit/proof-provider test/conformance/proofProviderMcp.test.ts
git commit -m "feat: establish proof provider adapter boundary"
```

## Task 5: Compose Offline Integration Capabilities

**Files:**

- Modify: `src/app/createTasApp.ts`
- Modify: `src/local/config/types.ts`
- Modify: `src/local/config/loadConfig.ts`
- Create: `test/integration/offlineIntegrations.test.ts`
- Modify: `test/conformance/toolInventory.expected.ts`
- Modify: `README.md`

- [ ] **Step 1: Write failing capability-inventory tests**

Assert setup modes expose neither Chat nor Proof operations. Assert a member with no Chat config has no `chat.*`, a member with Telegram/Discord config gets only those reviewed namespaces, and `proof_provider.attestation.list` remains available with an empty result.

Extend the shared cumulative inventory fixture with configuration-conditional Chat groups and the fixed Provider discovery tool. Preserve the same Slice A setup inventories.

- [ ] **Step 2: Compose production and test dependencies separately**

The production composition constructs only configured production Client factories and an empty Provider Registry. The test composition injects Fake Chat Clients and the Fake Provider adapter directly; no TOML field selects a Fake.

- [ ] **Step 3: Verify the slice gate**

```bash
npm test -- test/conformance/chatManifest.test.ts test/conformance/chatMcp.test.ts test/conformance/proofProviderMcp.test.ts test/integration/offlineChat.test.ts test/integration/offlineIntegrations.test.ts
npm run typecheck
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add src/app/createTasApp.ts src/local/config README.md test/conformance/toolInventory.expected.ts test/integration/offlineIntegrations.test.ts
git commit -m "feat: compose offline integration ports"
```

## Completion Criteria

1. Production Chat tool schemas are generated and completely accounted for.
2. Offline Clients exercise those schemas without a test namespace or network access.
3. Chat routing is configuration-bound and cursors remain caller-owned.
4. Empty Proof Provider discovery is a valid production state.
5. A Fake adapter passes the same standardized contract intended for Fede's later adapter.
6. No concrete Provider or live Chat integration is required by the local vertical slice.
