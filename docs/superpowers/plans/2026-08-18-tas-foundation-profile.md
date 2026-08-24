# TAS Slice A1 Foundation, TAS Skill, and Profile Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundation of Slice A (Bootable TAS): strict identity-setup, TAWG-setup, and member processes over MCP stdio that expose the release-bundled TAS Skill, with exact-block `profile.get` and `profile.get_agent` discovery only where a TAWG exists.

**Architecture:** `src/mcp` is Layer 1 and owns native MCP schemas and results. `src/core` is Layer 2 and owns TAS Skill loading and Profile projection. `src/clients/chain` is Layer 3 and owns viem reads. `src/local` owns public configuration and member-process isolation without storing credentials. Slice A2 adds generated viem Chain tools to the same three-phase composition root so identity setup becomes a short-lived ERC-8004 registration path.

**Tech Stack:** Node.js `>=24 <25`, TypeScript `7.0.2`, npm, `@modelcontextprotocol/core@2.0.0`, `@modelcontextprotocol/server@2.0.0`, `viem@2.55.19`, `zod@4.4.3`, `smol-toml@1.8.0`, `pino@10.3.1`, `proper-lockfile@4.1.2`, and Vitest `4.1.11`.

**Spec:** `docs/superpowers/specs/2026-08-22-tas-demo-vertical-slice-design.md`, `docs/TAS.md`, `docs/tas/CONFIG.md`, `docs/tas/CREDENTIALS.md`, `docs/tas/MCP.md`, `docs/tas/SKILLS.md`, and `docs/tawg/PROFILE.md`.

## Global Constraints

- Work in an isolated Git worktree at execution time; do not disturb the current dirty design worktree.
- Use red-green-refactor for every task and commit only after its focused tests pass.
- Preserve the legacy Go scaffold through Slice A1.
- Keep dependency direction `app -> mcp -> core -> clients`; clients never import MCP code.
- Reserve stdout exclusively for MCP frames. Diagnostics go to stderr.
- TAS never reads the Host Credential File and never logs, returns, snapshots, or persists an RPC URL, private key, token, or inline credential.
- An identity-setup process is bound only to `(chainId, identityRegistryAddress)`, creates no member directory or member lock, and cannot resolve or expose a TAWG Profile.
- A TAWG-setup process is bound only to `(chainId, tawgAddress)` and creates no member directory or member lock.
- A member process is bound to `(chainId, tawgAddress, ERC-8004 agentId)` and owns one exclusive member lock.
- Preserve chain IDs, Profile versions, block numbers, and ERC-8004 Agent IDs as canonical decimal strings at public boundaries.
- Resolve every Profile projection at one exact block number and hash.
- TAS defines no common `operation_id`, business-operation journal, automatic side-effect replay, or exactly-once abstraction.
- At the Slice A1 milestone, identity setup registers only `skill.tas.get`; TAWG setup and member mode register `skill.tas.get`, `profile.get`, and `profile.get_agent`. Slice A2 adds the complete reviewed viem Chain namespaces before Slice A is complete.

---

## Planned File Structure

```text
trustless-agent-substrate/
├── package.json
├── package-lock.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── app/
│   │   ├── main.ts
│   │   └── createTasApp.ts
│   ├── mcp/
│   │   ├── server.ts
│   │   ├── results.ts
│   │   ├── profileTools.ts
│   │   └── skillTools.ts
│   ├── core/
│   │   ├── errors.ts
│   │   ├── profile/
│   │   │   ├── types.ts
│   │   │   ├── reader.ts
│   │   │   └── resolver.ts
│   │   └── skill/
│   │       └── tasSkill.ts
│   ├── clients/
│   │   └── chain/
│   │       ├── profileAbi.ts
│   │       └── viemProfileReader.ts
│   └── local/
│       ├── config/
│       │   ├── types.ts
│       │   └── loadConfig.ts
│       ├── instance/
│       │   ├── paths.ts
│       │   └── lock.ts
│       └── logging.ts
└── test/
    ├── fixtures/
    ├── unit/
    ├── integration/
    └── conformance/
```

---

### Task 1: Establish the TypeScript Package and CLI Contract

**Files:**

- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/app/main.ts`
- Create: `test/unit/package.test.ts`
- Create: `test/integration/cli.test.ts`

**Interfaces:**

- Consumes: the package and process contract in `docs/tas/CONFIG.md` Section 4.12.
- Produces: executable `tas`, `tas --version`, and build/test scripts used by every later task.

- [ ] **Step 1: Write the failing package-contract test**

Assert this exact public contract:

```ts
expect(pkg).toMatchObject({
  name: '@trustless-ai/tas',
  type: 'module',
  bin: { tas: 'dist/app/main.js' },
  engines: { node: '>=24 <25' },
})
expect(pkg.files).toEqual(expect.arrayContaining([
  'dist',
  'skills/tas/SKILL.md',
  'docs/tas/CREDENTIALS.md',
]))
```

Also assert exact dependency versions and scripts named `build`, `typecheck`, `test`, `test:coverage`, `start`, and `prepack`.

- [ ] **Step 2: Run the test and observe the missing package**

Run: `npm test -- test/unit/package.test.ts`

Expected: FAIL because `package.json` and the TypeScript package do not exist.

- [ ] **Step 3: Create the exact package and compiler configuration**

Use these runtime dependencies:

```text
@modelcontextprotocol/core@2.0.0
@modelcontextprotocol/server@2.0.0
pino@10.3.1
proper-lockfile@4.1.2
smol-toml@1.8.0
viem@2.55.19
zod@4.4.3
```

Use these development dependencies:

```text
@types/node@24.13.3
@types/proper-lockfile@4.1.4
@vitest/coverage-v8@4.1.11
tsx@4.23.12
typescript@7.0.2
vitest@4.1.11
```

Configure strict ESM with `module` and `moduleResolution` set to `NodeNext`, `target` set to `ES2024`, declarations enabled, `rootDir = src`, and `outDir = dist`. The production compiler includes only `src/**/*.ts`.

- [ ] **Step 4: Implement the initial CLI boundary**

Parse only these forms:

```text
tas --version
tas --config <absolute-or-relative-path>
```

`tas --version` prints the exact package version followed by one newline and exits `0`. A missing `--config`, unknown flag, or duplicate flag prints a safe usage error to stderr, writes nothing to stdout, and exits `2`. Until Task 8 composes MCP, a valid `--config` reports `TAS_STARTUP_NOT_IMPLEMENTED` on stderr and exits `1`.

- [ ] **Step 5: Verify package, CLI, type checking, and build**

Run:

```bash
npm install
npm test -- test/unit/package.test.ts test/integration/cli.test.ts
npm run typecheck
npm run build
npm run start -- --version
```

Expected: all tests pass and the final command prints the exact package version only.

- [ ] **Step 6: Commit the package foundation**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src/app/main.ts test/unit/package.test.ts test/integration/cli.test.ts
git commit -m "build: establish TypeScript TAS package"
```

---

### Task 2: Implement Strict Identity-Setup, TAWG-Setup, and Member TOML Configuration

**Files:**

- Create: `src/core/errors.ts`
- Create: `src/local/config/types.ts`
- Create: `src/local/config/loadConfig.ts`
- Create: `test/unit/config/loadConfig.test.ts`
- Create: `test/fixtures/config/identity-setup-valid.toml`
- Create: `test/fixtures/config/tawg-setup-valid.toml`
- Create: `test/fixtures/config/member-valid.toml`

**Interfaces:**

- Consumes: `tas --config <path>` from Task 1.
- Produces: `loadTasConfig(path, environment): Promise<ResolvedTasConfig>` and the `TasError` used across all layers.

- [ ] **Step 1: Define the discriminated configuration types**

Use this boundary:

```ts
type CanonicalDecimal = string
type EvmAddress = `0x${string}`

interface ResolvedChainConfig {
  readonly family: 'evm'
  readonly rpcUrl: string
  readonly rpcSource: 'config' | 'environment'
}

interface IdentitySetupTasConfig {
  readonly configVersion: 1
  readonly mode: 'identity_setup'
  readonly identitySetup: {
    readonly chainId: CanonicalDecimal
    readonly identityRegistryAddress: EvmAddress
  }
  readonly chain: ResolvedChainConfig
}

interface TawgSetupTasConfig {
  readonly configVersion: 1
  readonly mode: 'tawg_setup'
  readonly tawgSetup: {
    readonly chainId: CanonicalDecimal
    readonly tawgAddress: EvmAddress
  }
  readonly chain: ResolvedChainConfig
}

interface MemberTasConfig {
  readonly configVersion: 1
  readonly mode: 'member'
  readonly instance: {
    readonly chainId: CanonicalDecimal
    readonly tawgAddress: EvmAddress
    readonly agentId: CanonicalDecimal
  }
  readonly chain: ResolvedChainConfig
  readonly repository: { readonly client: 'github' }
  readonly da: { readonly client: 'git' }
  readonly chat: {
    readonly sources: readonly ChatSourceConfig[]
    readonly targets: readonly ChatTargetConfig[]
  }
  readonly proofProviders: readonly ProofProviderConfig[]
}

type ResolvedTasConfig = IdentitySetupTasConfig | TawgSetupTasConfig | MemberTasConfig
```

The canonical identity-setup fixture is:

```toml
config_version = 1
mode = "identity_setup"

[identity_setup]
chain_id = "31337"
identity_registry_address = "0x8004000000000000000000000000000000000001"

[chain]
family = "evm"
rpc_url_env = "TAS_RPC_URL"
```

`identity_registry_address` is a public locator, not a credential. Identity setup has no `agent_id`, `tawg_address`, Repository, DA, Chat, or Proof Provider configuration.

`TasError` contains stable `code`, safe `message`, and optional redacted `details`; it never wraps an unsafe upstream response body.

- [ ] **Step 2: Write failing three-phase validation tests**

Cover all three valid fixtures plus:

```text
CONFIG_FILE_NOT_FOUND
CONFIG_PARSE_FAILED
CONFIG_VERSION_UNSUPPORTED
CONFIG_FIELD_INVALID
CONFIG_CONFLICT
CONFIG_ENV_REQUIRED
CONFIG_REFERENCE_INVALID
CONFIG_CLIENT_UNSUPPORTED
```

Assert identity setup requires `mode = "identity_setup"` plus `[identity_setup]`, forbids `[tawg_setup]` and `[instance]`, and rejects Profile, Repository, DA, Chat, and Proof Provider sections. Its only identity locator is `(chain_id, identity_registry_address)`. Assert TAWG setup requires `mode = "tawg_setup"` plus `[tawg_setup]`, forbids `[identity_setup]` and `[instance]`, and rejects Repository, DA, Chat, and Proof Provider sections. Assert member requires `[instance]`, Repository, and DA and forbids both setup tables. Reject unknown fields at every level, two or zero phase tables, noncanonical decimal strings, `uint256` overflow, zero or invalid addresses, both/neither RPC selectors, missing environment values, embedded URL credentials, duplicate names, dangling Chat targets, polling outside `1s..60s`, and unsupported Provider declarations.

- [ ] **Step 3: Run the tests and observe missing loader failures**

Run: `npm test -- test/unit/config/loadConfig.test.ts`

Expected: FAIL because `loadTasConfig` does not exist.

- [ ] **Step 4: Implement strict parse, normalization, and secret-safe resolution**

Implement:

```ts
async function loadTasConfig(
  path: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<ResolvedTasConfig>
```

Use `smol-toml` plus strict Zod objects. Normalize EVM addresses with viem. Keep numeric identifiers as canonical decimal strings. Resolve the RPC environment variable exactly once into process memory; errors may name the environment variable but never its value. Do not read any Credential File.

- [ ] **Step 5: Verify and commit configuration**

```bash
npm test -- test/unit/config/loadConfig.test.ts
npm run typecheck
git add src/core/errors.ts src/local/config test/unit/config test/fixtures/config
git commit -m "feat: load three-phase TAS configuration"
```

---

### Task 3: Implement Member Instance Paths and Exclusive Ownership

**Files:**

- Create: `src/local/instance/paths.ts`
- Create: `src/local/instance/lock.ts`
- Create: `test/unit/instance/paths.test.ts`
- Create: `test/integration/memberLock.test.ts`

**Interfaces:**

- Consumes: `ResolvedTasConfig` from Task 2.
- Produces: `memberInstancePath(root, identity)` and `acquireMemberLock(path)` for the application root.

- [ ] **Step 1: Write failing canonical-path tests**

Require this exact member layout:

```text
<root>/instances/eip155-<chainId>-<lowercase-tawgAddress>/agents/<canonical-decimal-agentId>/
```

Test that no Host-local Agent ID, wallet address, Repository URL, or secret participates in the path. Test that identity setup and TAWG setup return no member instance path.

- [ ] **Step 2: Write failing lock-ownership tests**

The first owner of `<member-directory>/tas.lock` succeeds. A second owner fails immediately with `INSTANCE_ALREADY_RUNNING`. After idempotent release, a new owner succeeds. Neither setup phase creates this directory or lock.

- [ ] **Step 3: Implement the path and lock modules**

Use `proper-lockfile` with `realpath: false`, no retry, stale timeout `30000`, and update interval `10000`. Return an idempotent async release function. Keep signal handlers in `src/app`, not in the lock module.

- [ ] **Step 4: Verify and commit isolation**

```bash
npm test -- test/unit/instance/paths.test.ts test/integration/memberLock.test.ts
npm run typecheck
git add src/local/instance test/unit/instance test/integration/memberLock.test.ts
git commit -m "feat: isolate member TAS processes"
```

---

### Task 4: Add Safe Logging and Native MCP Results

**Files:**

- Create: `src/local/logging.ts`
- Create: `src/mcp/results.ts`
- Create: `test/unit/logging.test.ts`
- Create: `test/unit/mcp/results.test.ts`

**Interfaces:**

- Consumes: identity-setup, TAWG-setup, or member context from Task 2 and `TasError` from Task 2.
- Produces: stderr-only logger and native MCP success/error builders.

- [ ] **Step 1: Write failing redaction and result-shape tests**

Assert recursive redaction for keys matching `credential`, `secret`, `privateKey`, `token`, `authorization`, and `rpcUrl`. Assert Error causes and upstream response bodies cannot bypass redaction. Assert success returns `{ context, data }`, tool failure returns `{ context, error }` with native `isError: true`, and neither shape contains an `ok`, `success`, retry journal, or business-operation ID.

Use this context union:

```ts
type TasPublicContext =
  | { instance: { phase: 'identity_setup'; chain_id: string; identity_registry_address: EvmAddress }; request_id: string }
  | { instance: { phase: 'tawg_setup'; chain_id: string; tawg_address: EvmAddress }; request_id: string; resolved?: ResolutionContext }
  | { instance: { phase: 'member'; chain_id: string; tawg_address: EvmAddress; agent_id: string }; request_id: string; resolved?: ResolutionContext }
```

- [ ] **Step 2: Implement stderr logging and MCP builders**

Create a pino logger whose destination is file descriptor `2`. Generate one UUID request ID per invocation. Return native `CallToolResult` objects with `structuredContent`; any compact text is a human summary, never a second machine protocol. No logger or result builder receives the resolved RPC URL unless it has already been redacted.

- [ ] **Step 3: Verify and commit**

```bash
npm test -- test/unit/logging.test.ts test/unit/mcp/results.test.ts
npm run typecheck
git add src/local/logging.ts src/mcp/results.ts test/unit/logging.test.ts test/unit/mcp/results.test.ts
git commit -m "feat: add safe TAS result boundary"
```

---

### Task 5: Load the Release-Bundled TAS Skill

**Files:**

- Create: `src/core/skill/tasSkill.ts`
- Create: `src/mcp/skillTools.ts`
- Create: `test/unit/skill/tasSkill.test.ts`
- Create: `test/conformance/tasSkillTool.test.ts`
- Modify: `skills/tas/SKILL.md`
- Modify: `docs/tas/CREDENTIALS.md`
- Modify: `src/core/errors.ts`
- Modify: `src/mcp/results.ts`

**Interfaces:**

- Consumes: package version and `skills/tas/SKILL.md` from Task 1.
- Produces: `loadBundledTasSkill()` and MCP tool `skill.tas.get`.

- [ ] **Step 1: Write failing bundle-integrity tests**

Before editing the TAS Skill, run a baseline Agent scenario against the current bundled Skill. Prove whether it can distinguish `identity_setup`, `tawg_setup`, and `member`, create an ERC-8004 identity before a TAWG exists, use an identity-scoped Host credential path, and hand off into a separate TAWG-setup process. Record the failure, then update the Skill and credential reference before the GREEN scenario.

Require:

```ts
interface TasSkillArtifact {
  readonly tas: { readonly package: '@trustless-ai/tas'; readonly version: string }
  readonly source: {
    readonly path: 'skills/tas/SKILL.md'
    readonly content_digest: { readonly algorithm: 'sha256'; readonly value: string }
  }
  readonly content: {
    readonly media_type: 'text/markdown; charset=utf-8'
    readonly encoding: 'utf8'
    readonly value: string
  }
}
```

Test exact package version matching, UTF-8 decoding, SHA-256 over the returned bytes, and rejection of a missing, symlinked, non-regular, malformed-frontmatter, or package-external file as `TAS_SKILL_BUNDLE_INVALID`. The fixed 1 MiB limit in the MCP design applies to Repository-loaded Role Skills, not this release-bundled TAS Skill.

- [ ] **Step 2: Run the tests and observe missing loader failures**

Run: `npm test -- test/unit/skill/tasSkill.test.ts`

Expected: FAIL because the bundle loader does not exist.

- [ ] **Step 3: Implement the immutable bundle loader**

Resolve the Skill relative to the installed package root, not the current working directory. Load and validate it once during startup. Do not execute Markdown, follow links, or read TAWG Repository content.

Update the bundled Skill to guide the accepted `identity_setup -> tawg_setup -> member` lifecycle. The file-backed Host credential contract uses an identity-scoped pending/final path keyed by `(chainId, identityRegistryAddress)` before a TAWG exists. After Profile membership succeeds, the Host copies the required identity credential into the TAWG/member-specific path without overwriting either copy. TAS never reads either file.

- [ ] **Step 4: Register and test `skill.tas.get`**

Register a no-input, read-only, non-destructive tool returning the cached `TasSkillArtifact`. Test it in identity-setup, TAWG-setup, and member contexts through the SDK in-memory transport. Its output must match the running package version and exact file digest.

- [ ] **Step 5: Verify and commit**

```bash
npm test -- test/unit/skill/tasSkill.test.ts test/conformance/tasSkillTool.test.ts
npm run typecheck
git add src/core/skill src/mcp/skillTools.ts test/unit/skill test/conformance/tasSkillTool.test.ts
git commit -m "feat: expose release-matched TAS Skill"
```

---

### Task 6: Implement the Exact-Block Profile Reader

**Files:**

- Create: `src/core/profile/types.ts`
- Create: `src/core/profile/reader.ts`
- Create: `src/clients/chain/profileAbi.ts`
- Create: `src/clients/chain/viemProfileReader.ts`
- Create: `test/unit/clients/profileAbi.test.ts`
- Create: `test/integration/viemProfileReader.test.ts`
- Create: `test/fixtures/profile/blocks.ts`

**Interfaces:**

- Consumes: configured chain, TAWG address, and exact-block rules.
- Produces: viem-independent `ProfileReader` snapshots for Task 7.

- [ ] **Step 1: Define the core reader port**

```ts
type ChainSelector =
  | { readonly kind: 'latest' }
  | { readonly kind: 'safe' }
  | { readonly kind: 'finalized' }
  | { readonly kind: 'block_number'; readonly blockNumber: string }
  | { readonly kind: 'block_hash'; readonly blockHash: `0x${string}` }

interface ProfileSnapshot {
  readonly chainId: string
  readonly tawgAddress: EvmAddress
  readonly blockNumber: string
  readonly blockHash: `0x${string}`
  readonly version: string
  readonly governance: EvmAddress
  readonly identityRegistry: EvmAddress
  readonly charter: RawCharter
  readonly agentIds: readonly string[]
  readonly dataEntries: readonly RawDataEntry[]
  readonly workflow: RawWorkflow
}

interface ProfileReader {
  readProfile(selector: ChainSelector): Promise<ProfileSnapshot>
  readAgent(agentId: string, selector: ChainSelector): Promise<RawAgentSnapshot>
}
```

`RawAgentSnapshot` includes the same block metadata, Profile Version, immutable Identity Registry, membership, raw Data, Agent Verifier, and Authentication Wallet only when the Profile member exists.

- [ ] **Step 2: Write and test the fixed Profile ABI**

Translate the read-only functions in `docs/tawg/PROFILE.md`, ERC-165 `supportsInterface(bytes4)`, ERC-721 `ownerOf(uint256)`, and ERC-8004 `getAgentWallet(uint256)` into viem ABI constants. Compute the `ITAWGProfile` interface ID from documented selectors in the test instead of pasting an unverified constant. Assert permanent enumeration and the absence of obsolete `addAgent`, `removeAgent`, `AgentAdded`, and `AgentRemoved` entries.

- [ ] **Step 3: Write failing immutable-snapshot tests**

Using a viem custom transport fixture, cover `latest`, `safe`, `finalized`, block number, and block hash; exact-block reads for every Profile domain; same-block Authentication Wallet resolution; full `uint256` strings; unsupported ERC-165 interface; unsupported finality without fallback; unavailable history; inconsistent counts; and a reorganization detected by a changed block hash.

- [ ] **Step 4: Implement exact-block resolution**

Resolve `{blockNumber, blockHash}` first, execute every contract read with EIP-1898 `{blockHash, requireCanonical: true}`, then fetch the block number again and require the same hash. Never fall back to number-only reads or substitute current state for an unavailable historical selector. Propagate caller cancellation and a bounded local operation deadline into every underlying RPC request. Map failures to the existing design codes:

```text
PROFILE_INCONSISTENT
FINALITY_UNSUPPORTED
HISTORICAL_STATE_UNAVAILABLE
RESOLUTION_CONFLICT
EXTERNAL_UNAVAILABLE
```

- [ ] **Step 5: Verify and commit**

```bash
npm test -- test/unit/clients/profileAbi.test.ts test/integration/viemProfileReader.test.ts
npm run typecheck
git add src/core/profile/types.ts src/core/profile/reader.ts src/clients/chain test/unit/clients test/integration/viemProfileReader.test.ts test/fixtures/profile
git commit -m "feat: read TAWG Profile at an exact block"
```

---

### Task 7: Implement Profile Projection and Consistency Rules

**Files:**

- Create: `src/core/profile/resolver.ts`
- Create: `src/mcp/profileTools.ts`
- Create: `test/unit/profile/resolver.test.ts`
- Create: `test/conformance/profileTools.test.ts`

**Interfaces:**

- Consumes: `ProfileReader` from Task 6 and MCP result builders from Task 4.
- Produces: `ProfileResolver`, `profile.get`, and `profile.get_agent`.

- [ ] **Step 1: Write failing projection tests**

Require `profile.get` data:

```text
version
governance
charter { repository, commit, path }
agents { identity_registry, agent_ids }
data { <key>: JSON object }
workflow { address, data: JSON object }
```

Require member `profile.get_agent` data:

```text
agent_id
is_member = true
data
agent_verifier
authentication_wallet
```

A nonmember is successful data containing only `agent_id` and `is_member = false`. Preserve unknown JSON properties. Reject JSON arrays, scalars, `null`, duplicate Agent IDs, duplicate Data keys, zero required addresses, invalid Charter references, and an inconsistent configured Profile as `PROFILE_INCONSISTENT`.

- [ ] **Step 2: Implement the resolver**

The resolver depends only on `ProfileReader`. Typed Solidity fields override any similarly named JSON extension property. It omits `pendingGovernance`, preserves the exact block and Profile Version for Resolution Context, and never grants a role from Profile membership.

- [ ] **Step 3: Register strict MCP tools**

`profile.get` accepts only an optional chain selector. `profile.get_agent` accepts canonical-decimal `agent_id` plus an optional selector. Callers cannot supply chain, Profile address, configured member ID, Registry address, or wallet address. Both tools are read-only and non-destructive.

- [ ] **Step 4: Verify and commit**

```bash
npm test -- test/unit/profile/resolver.test.ts test/conformance/profileTools.test.ts
npm run typecheck
git add src/core/profile/resolver.ts src/mcp/profileTools.ts test/unit/profile test/conformance/profileTools.test.ts
git commit -m "feat: expose Profile discovery tools"
```

---

### Task 8: Compose MCP stdio for All Three Execution Phases

**Files:**

- Create: `src/mcp/server.ts`
- Create: `src/app/createTasApp.ts`
- Replace: `src/app/main.ts`
- Create: `test/conformance/fixedToolInventory.test.ts`
- Create: `test/integration/stdio.test.ts`

**Interfaces:**

- Consumes: three-phase configuration, optional member lock, logger, Skill loader, optional Profile Resolver, and phase-specific fixed tool registration.
- Produces: `createTasApp(configPath)` and the working `tas --config` stdio process.

- [ ] **Step 1: Write failing mode-composition tests**

At the Slice A1 milestone, identity setup exposes exactly:

```text
skill.tas.get
```

TAWG setup and member mode expose exactly:

```text
skill.tas.get
profile.get
profile.get_agent
```

Identity setup creates neither Profile services nor a member path or lock. TAWG setup creates Profile services but no member path or lock. Member startup acquires the exact member lock but does not turn startup into a new membership-authority check. After connection, the TAS Skill calls `profile.get_agent` and stops member operation if the configured Agent is not registered.

- [ ] **Step 2: Implement the server factory**

Build a fresh `McpServer` per SDK connection and register the fixed tools against shared immutable services. Identity setup registers only `skill.tas.get`; it must not construct Profile Reader or Resolver services. TAWG setup and member mode register all three fixed tools. Use `McpServer.registerTool` with exact input/output schemas and annotations. Do not expose MCP Resources, Prompts, Tasks, Repository, Workflow, DA, Chat, Proof Provider, or generated Chain tools in this milestone.

- [ ] **Step 3: Implement the application startup sequence**

```text
parse CLI
load strict three-phase config
acquire member lock only in member mode
create stderr logger
create viem public client
load bundled TAS Skill
create Profile Reader and Resolver only for TAWG setup and member mode
create MCP server factory
serve stdio
close transport and release lock once
```

Use `serveStdio` from `@modelcontextprotocol/server/stdio`. Install SIGINT and SIGTERM cleanup in the composition root. Do not write a readiness banner to stdout.

- [ ] **Step 4: Exercise modern and legacy stdio paths**

Spawn the source entrypoint through the development runner with temporary identity-setup, TAWG-setup, and member configs plus a fixture RPC. Test MCP initialization, phase-exact `tools/list`, valid calls, rejection of any Profile tool in identity setup, nonmember negative data in member mode, clean signal shutdown, and package-version Skill output. Assert stdout contains only MCP frames and stderr contains neither the fixture RPC URL nor any secret marker.

- [ ] **Step 5: Verify and commit**

```bash
npm test -- test/conformance/fixedToolInventory.test.ts test/integration/stdio.test.ts
npm run typecheck
npm run build
git add src/app src/mcp/server.ts test/conformance/fixedToolInventory.test.ts test/integration/stdio.test.ts
git commit -m "feat: serve TAS foundation over MCP stdio"
```

---

### Task 9: Add Slice A1 Package and Security Gates

**Files:**

- Create: `test/conformance/profileFixtures.test.ts`
- Create: `test/conformance/packageContents.test.ts`
- Modify: `README.md`
- Modify: `docs/PROJECT_STRUCTURE.md`
- Modify: `docs/tas/IMPLEMENTATION.md`

**Interfaces:**

- Consumes: all Slice A1 artifacts.
- Produces: a reviewable, packaged Slice A1 milestone ready for the Slice A2 Chain plan.

- [ ] **Step 1: Add immutable public fixtures**

Include full addresses, one Agent ID larger than JavaScript's safe integer, full Git commit hashes, Profile Version, block number/hash, unknown JSON extension properties, member, and nonmember cases. Reject any fixture containing a real RPC endpoint, private key, access token, or shortened object identifier.

- [ ] **Step 2: Test package contents**

Run `npm pack --dry-run --json` in the test and require `dist/**`, `skills/tas/SKILL.md`, and `docs/tas/CREDENTIALS.md`. Reject tests, fixtures, coverage, Go sources, `tas.toml`, legacy YAML configuration, local logs, and credential files.

- [ ] **Step 3: Update milestone documentation**

Document Node requirements, `npm ci`, tests, build, `tas --version`, and `tas --config`. Document all three selectors and their exact Slice A1 inventories. State explicitly that identity setup is not yet capable of ERC-8004 registration until Slice A2 adds generated viem Chain tools. Do not mark Slice A complete.

- [ ] **Step 4: Run the complete Slice A1 gate**

```bash
npm ci
npm run typecheck
npm test
npm run test:coverage
npm run build
npm pack --dry-run
git diff --check
```

Require at least 80% statement, branch, function, and line coverage for `src/core/profile`, `src/core/skill`, `src/local/config`, and `src/local/instance`.

- [ ] **Step 5: Commit the milestone**

```bash
git add README.md docs/PROJECT_STRUCTURE.md docs/tas/IMPLEMENTATION.md test/conformance
git commit -m "docs: complete TAS Slice A1 foundation"
```

---

## Slice A1 Completion Criteria

1. Clean install, type checking, tests, coverage, build, and package dry-run pass.
2. `tas --version` matches the exact package version.
3. Identity setup is selected by `(chainId, identityRegistryAddress)`, exposes only `skill.tas.get` in this intermediate milestone, constructs no Profile services, and owns no member lock or state directory.
4. TAWG setup is selected by `(chainId, tawgAddress)`, exposes the TAS Skill and Profile discovery, and owns no member lock or state directory.
5. Member mode is isolated by `(chainId, tawgAddress, agentId)`. Startup itself adds no parallel membership authority; after connection, the bundled TAS Skill requires `profile.get_agent` for the configured Agent and stops member operation when that Agent is not registered.
6. `skill.tas.get` returns the exact release-bundled Skill, version, and SHA-256 digest in all three phases.
7. `profile.get` and `profile.get_agent` resolve all chain-derived values at one reported block number/hash and are absent from identity setup.
8. Nonmembership is successful negative data; inconsistent Profile state is a safe tool error.
9. stdout contains only MCP frames; no secret or RPC endpoint appears in output, logs, errors, fixtures, or package contents.
10. TAS reads no Host Credential File and maintains no business-operation journal.
11. The legacy Go scaffold and unrelated user changes remain intact.
12. Slice A1 does not claim complete onboarding; Slice A2 must add the reviewed viem Chain namespaces.
