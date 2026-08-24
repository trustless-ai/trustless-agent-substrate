# TAS Slice A2 Generated viem Chain Tools and Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Slice A (Bootable TAS) with reviewed, build-time-generated viem Public and Wallet Action MCP tools so an Agent can create or inspect its own ERC-8004 identity in identity setup, then register or update itself through TAWG setup before starting member TAS.

**Architecture:** A build-time generator reads the exact installed viem `PublicActions` and `WalletActions` TypeScript interfaces and emits deterministic Manifests plus a complete inclusion/exclusion report. The runtime Manifest Registry validates those shipped artifacts and registers tools through phase-specific composition. Chain Service injects the configured transport and operation-scoped Account, while the Agent creates or loads its wallet, supplies one inline credential per Wallet call, records its own ERC-8004 `agentId`, and owns replay and source-native handles.

**Tech Stack:** Slice A1 stack plus the TypeScript `7.0.2` `typescript/unstable/sync` project API, `canonicalize@4.0.0` for RFC 8785 serialization, and committed `tas-manifest/v1` JSON artifacts generated from `viem@2.55.19`. TypeScript 7 no longer exposes the legacy compiler API from the package root, so generator code must use this exact versioned API rather than `createProgram`-style assumptions.

**Spec:** `docs/superpowers/specs/2026-08-22-tas-demo-vertical-slice-design.md`, `docs/tas/MANIFEST.md`, `docs/tas/MCP.md` Sections 4.9 and 4.15, `docs/tas/CREDENTIALS.md`, `docs/tas/SKILLS.md`, `docs/tawg/PROFILE.md`, and the Slice A1 plan.

## Global Constraints

- Complete Slice A1 before executing this plan.
- Work in an isolated Git worktree and use red-green-refactor per task.
- Do not handwrite a per-action exposure allowlist or action schema.
- Generate Manifests only through an explicit developer command; never generate, download, or reflect over dependencies at TAS startup.
- Every viem Public or Wallet Action property must appear as included or structurally excluded in the generation report. An eligible action that cannot be projected fails generation.
- Structurally exclude a Wallet Action that cannot receive TAS's injected Account and a Public Action that could submit an authenticated Chain write without deterministic Agent-wallet binding. Raw signed-transaction submission cannot bypass this rule.
- Public and Wallet Action package names, versions, and integrity must match the installed release at build and startup.
- The caller cannot override configured chain, transport, or injected Account.
- Wallet credentials remain inline for one call. TAS constructs the Account for that call and retains neither key nor Account state.
- TAS reads no Host Credential File and exposes no secret-return or generic proxy tool.
- TAS defines no common `operation_id`, retry registry, or automatic side-effect replay. Preserve source-native nonce/idempotency fields only when they belong to the viem action itself.
- Identity setup is bound only to `(chainId, identityRegistryAddress)`. It has no configured Agent or Profile, so ERC-8004 registration uses the pending wallet without a member-wallet precheck.
- TAWG setup is bound only to `(chainId, tawgAddress)`. It has no configured Agent, so initial ERC-8004 registration and Profile self-registration use the pending wallet without a member-wallet precheck.
- Member mode requires the inline key's derived address to match the configured Agent's current ERC-8004 Authentication Wallet before every Wallet Action.
- Identity setup exposes only `skill.tas.get` plus the complete reviewed generated viem Public and Wallet groups. It never constructs or exposes Profile, Repository, Role Skill, Workflow SDK, DA, Chat, or Proof Provider services. The complete generated groups are the reviewed Chain surface; do not introduce a handwritten identity-operation allowlist.
- TAWG setup and member mode expose their Slice A1 fixed tools plus the same complete reviewed generated viem groups.
- Generated values crossing MCP JSON encode `bigint` as canonical decimal strings. Analyzer-proven byte arrays use an explicit `{ "encoding": "hex", "value": "0x..." }` binary envelope so they remain distinguishable from source-native Hex strings and ordinary objects.
- Preserve the legacy Go scaffold.

---

## Planned File Structure

```text
trustless-agent-substrate/
├── manifests/
│   ├── viem-public.v1.json
│   ├── viem-wallet.v1.json
│   └── viem-report.v1.json
├── tools/
│   └── manifest/
│       ├── generate.ts
│       ├── analyzeViem.ts
│       ├── schemaEncoder.ts
│       └── canonicalJson.ts
├── src/
│   ├── mcp/
│   │   ├── generatedChainTools.ts
│   │   └── manifest/
│   │       ├── types.ts
│   │       ├── load.ts
│   │       └── registry.ts
│   ├── core/
│   │   └── workflow/
│   │       └── chainService.ts
│   └── clients/
│       └── chain/
│           ├── jsonCodec.ts
│           └── viemActions.ts
└── test/
    ├── fixtures/manifest/
    ├── unit/manifest/
    ├── conformance/viemManifest.test.ts
    └── integration/chainOnboarding.test.ts
```

---

### Task 1: Define the Runtime Manifest Types and Deterministic Artifact Contract

**Files:**

- Create: `src/mcp/manifest/types.ts`
- Create: `tools/manifest/canonicalJson.ts`
- Create: `test/unit/manifest/types.test.ts`
- Create: `test/unit/manifest/canonicalJson.test.ts`
- Modify: `package.json`
- Create: `tsconfig.tools.json`

**Interfaces:**

- Consumes: `tas-manifest/v1` in `docs/tas/MANIFEST.md`.
- Produces: strict TypeScript/Zod Manifest types and canonical JSON serialization used by generator and runtime.

- [ ] **Step 1: Write failing Manifest schema tests**

Define and test this minimal runtime contract:

```ts
type ManifestSourceProfile = 'viem-public' | 'viem-wallet'
type OperationEffect = 'read' | 'side_effect'
type OperationCompletion = 'synchronous' | 'bounded_wait' | 'external_handle'

interface GeneratedToolEntry {
  readonly name: string
  readonly description: string
  readonly source: {
    readonly entrypoint: string
    readonly export: 'PublicActions' | 'WalletActions'
    readonly member: string
  }
  readonly binding: { readonly kind: 'client_action'; readonly target: string }
  readonly input_schema: Readonly<Record<string, unknown>>
  readonly output_schema: Readonly<Record<string, unknown>>
  readonly operation: {
    readonly effect: OperationEffect
    readonly completion: OperationCompletion
  }
  readonly runtime_dependencies: readonly ('chain_client' | 'account')[]
  readonly credential: 'none' | 'evm_private_key'
  readonly annotations: {
    readonly readOnlyHint: boolean
    readonly destructiveHint: boolean
    readonly idempotentHint: boolean
    readonly openWorldHint: boolean
  }
}

interface DependencyManifest {
  readonly schema_version: 'tas-manifest/v1'
  readonly manifest_id: 'viem-public' | 'viem-wallet'
  readonly kind: 'dependency'
  readonly source_profile: ManifestSourceProfile
  readonly source: {
    readonly package: 'viem'
    readonly version: string
    readonly package_integrity: string
    readonly entrypoint_digest: `sha256:${string}`
    readonly entrypoints: readonly string[]
  }
  readonly generator: {
    readonly name: '@trustless-ai/tas-manifest'
    readonly version: string
    readonly typescript_version: '7.0.2'
  }
  readonly tools: readonly GeneratedToolEntry[]
}
```

Reject unknown fields, duplicate tool names, malformed namespaces, missing package integrity, Wallet entries without `account`/credential injection, and Public entries that request an Account.

- [ ] **Step 2: Run and observe missing type/serializer failures**

Run: `npm test -- test/unit/manifest/types.test.ts test/unit/manifest/canonicalJson.test.ts`

Expected: FAIL because Manifest types and canonical serialization do not exist.

- [ ] **Step 3: Implement canonical JSON serialization**

Add exact development dependency `canonicalize@4.0.0`. `canonicalJson(value)` validates plain JSON input and emits RFC 8785 JSON Canonicalization Scheme bytes with no formatting whitespace or trailing newline. It rejects `undefined`, function, symbol, non-finite number, `bigint`, cyclic input, and prototype-bearing non-plain objects before calling the canonicalizer.

- [ ] **Step 4: Add build-time tooling scripts**

Add exact scripts:

```json
{
  "manifest:generate": "tsx tools/manifest/generate.ts",
  "manifest:check": "tsx tools/manifest/generate.ts --check"
}
```

`tsconfig.tools.json` extends the production compiler options but includes `tools/**/*.ts` and excludes `dist`.

- [ ] **Step 5: Verify and commit**

```bash
npm test -- test/unit/manifest/types.test.ts test/unit/manifest/canonicalJson.test.ts
npm run typecheck
git add package.json package-lock.json tsconfig.tools.json src/mcp/manifest/types.ts tools/manifest/canonicalJson.ts test/unit/manifest
git commit -m "feat: define TAS Manifest artifact contract"
```

---

### Task 2: Analyze viem Public and Wallet Action Interfaces

**Files:**

- Create: `tools/manifest/analyzeViem.ts`
- Create: `test/fixtures/manifest/viem-mini.d.ts`
- Create: `test/unit/manifest/analyzeViem.test.ts`

**Interfaces:**

- Consumes: installed viem package metadata and TypeScript declarations.
- Produces: `analyzeViemActions(input): ViemAnalysis` containing every included or excluded action.

- [ ] **Step 1: Define analyzer outputs and failing fixture tests**

```ts
type ViemProjection = null | boolean | number | string | readonly ViemProjection[] | {
  readonly [key: string]: ViemProjection
}

interface ViemActionProjectionContext {
  readonly sourceProfile: 'viem-public' | 'viem-wallet'
  readonly sourceName: string
  readonly toolName: string
  readonly signature: string
  readonly completion: OperationCompletion
  readonly checker: import('typescript/unstable/sync').Checker
  readonly inputType: import('typescript/unstable/sync').Type
  readonly outputType: import('typescript/unstable/sync').Type
}

interface IncludedAction<Projection extends ViemProjection | undefined = undefined> {
  readonly sourceProfile: 'viem-public' | 'viem-wallet'
  readonly sourceName: string
  readonly toolName: string
  readonly signature: string
  readonly projection: Projection
  readonly completion: OperationCompletion
}

interface ExcludedAction {
  readonly sourceProfile: 'viem-public' | 'viem-wallet'
  readonly sourceName: string
  readonly reasonCode: 'callback_input' | 'callback_output' | 'subscription' | 'opaque_runtime_object' | 'non_finite_request' | 'non_finite_response' | 'account_not_injectable' | 'authenticated_write_not_bound'
  readonly reason: string
}

interface ViemAnalysis<Projection extends ViemProjection | undefined = undefined> {
  readonly packageVersion: string
  readonly packageIntegrity: string
  readonly included: readonly IncludedAction<Projection>[]
  readonly excluded: readonly ExcludedAction[]
}
```

`analyzeViemActions` accepts an optional synchronous `project(context)` callback. The context includes the source profile/name, generated tool name, rendered signature, completion semantics, checker, input type, and output type, so downstream projection never guesses action identity from call order. The callback runs only while the TypeScript snapshot and checker are live, and its result must be a plain JSON projection. TAS clones that projection before returning. `IncludedAction` never exposes `Type`, `Checker`, or another compiler-session handle. Calling without a projector returns `projection: undefined`; Task 3 supplies the schema projector.

The mini fixture must include a zero-argument read, one finite read, one Wallet write, a callback subscription, a function-valued result, and an unsupported opaque client object. Assert snake_case names under `workflow.chain.public.*` and `workflow.chain.wallet.*`.

- [ ] **Step 2: Run and observe the missing analyzer**

Run: `npm test -- test/unit/manifest/analyzeViem.test.ts`

Expected: FAIL because `analyzeViemActions` does not exist.

- [ ] **Step 3: Implement TypeScript interface analysis**

Resolve viem through Node package resolution, read its exact `package.json`, lockfile integrity, `PublicActions` declaration, and `WalletActions` declaration. Use a TypeScript 7 `API` snapshot and a generator-owned in-memory probe that imports `PublicActions` and `WalletActions` without explicit type arguments; this makes the checker apply the installed declarations' default generic parameters. Resolve the probe through its default Project, then enumerate the instantiated type's symbol members rather than scanning function filenames. The virtual filesystem must return `undefined` for paths it does not own so TypeScript falls back to the real filesystem and resolves `node_modules` normally.

While the same live Program is open, collect every non-probe, non-default-library third-party SourceFile it actually read; none may be skipped merely because it is outside the viem/abitype semantic-trust roots. Walk upward to the nearest npm package manifest. A nested `package.json` with neither `name` nor `version` is only a module/exports marker and may be skipped; one with exactly one identity field is malformed; one with both is a hard package boundary. That boundary must have an exact package-lock v3 entry and may never fall back to a locked ancestor. Derive the expected npm name from the exact lock key after its last `node_modules/` segment, including scoped and nested packages, and require it to equal `package.json.name`; primary viem/abitype resolution applies the same check against its caller-expected name. Require source and package metadata to be regular non-symlink paths, prove their real paths remain inside the real lock/package roots, and bind package.json version to canonical SHA-512 lock integrity. The analyzer returns sorted unique `reviewedPackages` and detached `{ packageName, packageVersion, packageRelativePath, sha256 }` declarations. Duplicate package names from multiple roots fail closed in v0.1. Both lists leak no absolute path, are bounded by fixed file-count and total-byte limits, and become part of Task 4's entrypoint digest. `trustedDependencies` remains the narrower semantic-trust list and is not reused as the content-integrity closure.

Any type-dependent downstream work runs through the synchronous projector before the analyzer's `finally` disposes the snapshot and closes the API. The projector result is validated and cloned as a session-independent plain JSON tree. A projector that returns a `Type`, `Checker`, Promise, function, prototype-bearing object, cycle, or other non-JSON value fails analysis. Compiler cleanup remains analyzer-owned and is never delegated to callers.

An action is structurally excluded when its finite request/response boundary contains callbacks, subscriptions returning unsubscribe functions, opaque runtime clients/transports, symbols, streams, iterators, or another non-JSON runtime object; when a Wallet Action cannot receive the TAS-injected Account; or when a Public Action would submit an authenticated Chain write without deterministic Agent-wallet binding. For the last rule, TypeScript shape alone is insufficient: the viem source profile also reads the callable's installed declaration documentation and JSON-RPC method metadata. An `eth_sendRawTransaction` operation is excluded as `authenticated_write_not_bound`; missing or contradictory write semantics fail closed instead of being inferred from the generated MCP name. This is a source-profile security classification, not an operation inclusion allowlist. Record every exclusion. Duplicate generated names and an action that is neither included nor assigned a reviewed structural exclusion fail generation.

- [ ] **Step 4: Verify against installed viem coverage**

Add a test that the union of included and excluded source names equals the exact property set of installed `PublicActions` and `WalletActions`. Do not assert a handwritten count; snapshot the sorted report so a dependency upgrade produces a reviewable diff.

- [ ] **Step 5: Verify and commit**

```bash
npm test -- test/unit/manifest/analyzeViem.test.ts
npm run typecheck
git add tools/manifest/analyzeViem.ts test/fixtures/manifest/viem-mini.d.ts test/unit/manifest/analyzeViem.test.ts
git commit -m "feat: analyze viem action interfaces"
```

---

### Task 3: Generate JSON Schemas and EVM JSON Codecs

**Files:**

- Create: `tools/manifest/schemaEncoder.ts`
- Create: `src/clients/chain/jsonCodec.ts`
- Create: `test/unit/manifest/schemaEncoder.test.ts`
- Create: `test/unit/clients/jsonCodec.test.ts`

**Interfaces:**

- Consumes: live `ViemActionProjectionContext` values through Task 2's synchronous projector callback.
- Produces: finite MCP JSON Schemas and reversible input/output normalization.

- [ ] **Step 1: Write failing schema cases**

Cover string, boolean, bounded number, `bigint`, hex/address, arrays, readonly tuples, optional fields, string-key records, discriminated unions, literal unions, ABI arrays, nullable values, and `Promise<T>` unwrapping. Reject Map, Set, Date, class instances, functions, symbols, streams, recursive unbounded types, and ambiguous unions that cannot be represented without losing invocation meaning.

For ABI-dependent generic outputs such as `readContract`, emit the recursive JSON-value schema and rely on viem plus the supplied ABI for runtime validation. Do not encode such results as JavaScript `any` in runtime code.

- [ ] **Step 2: Write failing codec round-trip tests**

Require:

```ts
encodeEvmJson(2n ** 255n) === '57896044618658097711785492504343953926634992332820282019728792003956564819968'
decodeBySchema({ type: 'string', format: 'uint256' }, '340282366920938463463374607431768211457') === 340282366920938463463374607431768211457n
```

Reject unsafe JSON numbers for bigint fields, noncanonical decimal strings, malformed hex, undefined output, cycles, and unsupported objects.

- [ ] **Step 3: Implement the schema encoder**

Implement the schema encoder as a plain-JSON projector passed to `analyzeViemActions`. It uses the live TypeScript checker types, not handwritten action names, and returns only detached input/output schemas and projection metadata. Runtime dependency fields `chain`, `transport`, `client`, and `account` are removed from caller schemas only when the analyzer resolves them to the shared viem runtime types. Wallet tools add the common inline credential object; Public tools do not.

- [ ] **Step 4: Implement JSON codecs**

Decode MCP input according to the generated schema before calling viem. Encode viem output recursively into JSON-compatible values. Preserve source-native hashes, addresses, receipts, message signatures, and call identifiers without treating them as TAS operation records.

- [ ] **Step 5: Verify and commit**

```bash
npm test -- test/unit/manifest/schemaEncoder.test.ts test/unit/clients/jsonCodec.test.ts
npm run typecheck
git add tools/manifest/schemaEncoder.ts src/clients/chain/jsonCodec.ts test/unit/manifest/schemaEncoder.test.ts test/unit/clients/jsonCodec.test.ts
git commit -m "feat: encode viem MCP schemas and values"
```

---

### Task 4: Generate and Check In the Reviewed viem Manifests

**Files:**

- Create: `tools/manifest/generate.ts`
- Create: `manifests/viem-public.v1.json`
- Create: `manifests/viem-wallet.v1.json`
- Create: `manifests/viem-report.v1.json`
- Create: `test/conformance/viemManifest.test.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: analyzer, schema encoder, and canonical serializer.
- Produces: shipped reviewed artifacts and `npm run manifest:check`.

- [ ] **Step 1: Write the failing deterministic-generation test**

Generate twice into separate temporary directories and require byte-identical public, wallet, and report files. Require package/version/integrity, globally unique names, sorted entries, complete source-member accounting, correct read/side-effect classification, correct MCP annotations, and no inline executable expression.

- [ ] **Step 2: Run and observe missing generated artifacts**

Run: `npm test -- test/conformance/viemManifest.test.ts`

Expected: FAIL because the generator and checked-in artifacts do not exist.

- [ ] **Step 3: Implement generation and check modes**

Normal mode writes all three canonical artifacts. `--check` generates in memory, byte-compares against the checked-in files, and exits nonzero with changed filenames when they differ. It never rewrites files in check mode.

Classify viem Public Actions as reads unless the source signature contradicts that classification. Classify Wallet Actions as side effects unless proven read-only. `waitForTransactionReceipt` is a bounded wait; transaction submissions return external handles. Preserve native idempotency or nonce fields only when present in the source action schema.

Annotations follow one conservative rule: reads set `readOnlyHint = true`, `destructiveHint = false`, and `idempotentHint = true`; side effects set `readOnlyHint = false`, `destructiveHint = true`, and `idempotentHint = false`. There is no per-action annotation allowlist.

The entrypoint digest includes the complete sorted declaration closure returned by the analyzer. Normal publication coordinates all four outputs through preflight, staging, rollback, and retained recovery backups when restoration cannot complete. It is recoverable for ordinary in-process failures, but it is not atomic across destination directories: a crash or concurrent reader can observe a mixed generation. Generation and consumption require an exclusive workspace, and a fresh `npm run manifest:check` must pass immediately before any build, package, or release step consumes the artifacts. Check mode never creates a missing directory, rejects symlinks and special files, compares size before opening, and performs only bounded non-blocking reads.

- [ ] **Step 4: Generate and review the installed viem diff**

Run:

```bash
npm run manifest:generate
npm run manifest:check
npm test -- test/conformance/viemManifest.test.ts
```

Review every exclusion in `manifests/viem-report.v1.json`. The task is not complete if an action disappears without a report entry or if an eligible action failed schema generation.

- [ ] **Step 5: Package and commit artifacts**

Add `manifests` to `package.json.files`, then:

```bash
git add package.json package-lock.json tools/manifest/generate.ts manifests test/conformance/viemManifest.test.ts
git commit -m "build: generate reviewed viem manifests"
```

---

### Task 5: Validate Manifests and Build the Runtime Registry

**Files:**

- Create: `src/mcp/manifest/load.ts`
- Create: `src/mcp/manifest/registry.ts`
- Create: `test/unit/manifest/load.test.ts`
- Create: `test/unit/manifest/registry.test.ts`

**Interfaces:**

- Consumes: checked-in Manifest artifacts and installed package metadata.
- Produces: immutable `ManifestRegistry` for MCP tool registration.

- [ ] **Step 1: Write failing startup-validation tests**

Reject malformed JSON, unknown schema version, duplicate names, invalid annotations, source profile mismatch, installed version/integrity mismatch, unknown runtime dependency, missing binding adapter, any JSON artifact whose raw bytes differ from the compiled generated digest constants, a missing or malformed bundled generation report, any reviewed package name/version/integrity/tree-digest/count/byte-total mismatch, duplicate package-name locator ambiguity, any declaration-closure path that is absolute or escapes its package, any symlink/special/oversized declaration or package-tree entry, nested package `node_modules`, exceeded package-tree budget, and any declaration hash or recomputed entrypoint-digest mismatch. Require both complete viem profile groups. Focused fixtures must prove that modifying, adding, or deleting a runtime JavaScript or other package file fails startup validation even when declarations are unchanged.

- [ ] **Step 2: Implement package-relative loading**

Load only the two package-bundled Manifest paths and their one bundled generation report. Configuration, Repository content, environment variables, and callers cannot supply another path. Before parsing, compare their exact raw bytes with the generated digest constant compiled into TAS. Parse with strict schemas and freeze the accepted records. Resolve every `reviewed_packages` entry to one exact installed npm package, verify its package.json version and lock integrity, then use the same published bounded scanner and framed-hash implementation as generation to recompute its complete package tree before recomputing the report-listed declaration closure. Runtime never starts TypeScript, discovers a new type/tool closure, or imports viem during this validation phase. The reviewed TAS installation tree must remain non-concurrently-writable from validation start through process exit; use a read-only installation, a separate owner/service UID, or an immutable image/mount. Static pre-start tampering is detected, while a same-UID adversarial writer able to alter TAS itself is outside the v0.1 pure-Node threat boundary.

- [ ] **Step 3: Implement registry lookup and group selection**

```ts
interface ManifestRegistry {
  list(profile: 'viem-public' | 'viem-wallet'): readonly GeneratedToolEntry[]
  get(toolName: string): GeneratedToolEntry | undefined
}
```

The registry selects whole reviewed groups. It has no per-operation allowlist and never changes for the process lifetime.

- [ ] **Step 4: Verify and commit**

```bash
npm test -- test/unit/manifest/load.test.ts test/unit/manifest/registry.test.ts
npm run typecheck
git add src/mcp/manifest/load.ts src/mcp/manifest/registry.ts test/unit/manifest/load.test.ts test/unit/manifest/registry.test.ts
git commit -m "feat: validate runtime TAS manifests"
```

---

### Task 6: Bind viem Public and Wallet Actions Safely

**Files:**

- Create: `src/clients/chain/viemActions.ts`
- Create: `src/core/workflow/chainService.ts`
- Create: `test/unit/clients/viemActions.test.ts`
- Create: `test/unit/workflow/chainService.test.ts`

**Interfaces:**

- Consumes: Manifest entry, configured viem transport, JSON codec, execution phase, optional Profile Resolver, and optional inline credential.
- Produces: `ChainService.invoke(entry, input)` for generated MCP handlers.

- [ ] **Step 1: Define the invocation boundary**

```ts
interface InlineCredential {
  readonly type: 'inline'
  readonly secret: string
}

interface ChainInvocation {
  readonly toolName: string
  readonly arguments: Readonly<Record<string, unknown>>
  readonly credential?: InlineCredential
}

interface ChainService {
  invoke(invocation: ChainInvocation): Promise<unknown>
}
```

The public MCP input never accepts a `client`, `transport`, `chain`, or `account` runtime object.

The Task 6 binding module belongs to the post-validation module graph. Production code must not statically import it from the pre-validation entry path; it may be dynamically loaded only after Task 5 accepts the bundled artifacts and complete reviewed package trees.

- [ ] **Step 2: Write failing Public Action binding tests**

Require configured-client invocation, schema decoding, bigint output encoding, source error normalization, and no hidden retry. An unknown binding target returns `MANIFEST_BINDING_UNSUPPORTED`; it never falls back to dynamic `eval`, arbitrary import, or arbitrary property traversal.

- [ ] **Step 3: Write failing Wallet Action security tests**

Cover missing/malformed credential, secret redaction, per-call `privateKeyToAccount`, no Account retained after the promise settles, member wallet match, member wallet mismatch, zero member wallet, identity-setup pending wallet, TAWG-setup pending wallet, configured chain injection, caller attempt to override Account/chain, and one client call per MCP invocation.

Identity setup and TAWG setup have no member-wallet comparison because neither has a configured `agentId`. Identity setup must not attempt to construct or call a Profile Resolver. Member mode calls `profile.get_agent` for the configured `agentId` at one current block and requires the derived Account to match `authentication_wallet` before invoking the Wallet Action.

- [ ] **Step 4: Implement explicit binding adapters**

Bind only action members present in the accepted Manifest Registry. Use one configured Public Client and one connection-only Wallet Client without a stored Account. For a Wallet call, construct the Account from the inline key, inject it into the decoded viem arguments, await exactly one source invocation, then release all references. Return the source-native result through the JSON codec.

- [ ] **Step 5: Verify and commit**

```bash
npm test -- test/unit/clients/viemActions.test.ts test/unit/workflow/chainService.test.ts
npm run typecheck
git add src/clients/chain/viemActions.ts src/core/workflow/chainService.ts test/unit/clients/viemActions.test.ts test/unit/workflow/chainService.test.ts
git commit -m "feat: bind generated viem Chain actions"
```

---

### Task 7: Register Generated Chain Tools in All Three TAS Phases

**Files:**

- Create: `src/mcp/generatedChainTools.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/app/createTasApp.ts`
- Modify: `src/app/main.ts`
- Create: `test/conformance/generatedChainTools.test.ts`
- Modify: `test/conformance/fixedToolInventory.test.ts`
- Create: `test/conformance/toolInventory.expected.ts`

**Interfaces:**

- Consumes: Manifest Registry and Chain Service.
- Produces: complete `workflow.chain.public.*` and `workflow.chain.wallet.*` MCP groups.

- [ ] **Step 1: Write failing inventory conformance tests**

For identity setup, require exactly:

```text
skill.tas.get
every included viem-public Manifest name
every included viem-wallet Manifest name
```

Explicitly reject `profile.get`, `profile.get_agent`, Repository, Role Skill, generated agent-sdk Workflow, DA, Chat, and Proof Provider tools.

For TAWG setup and member mode, require:

```text
skill.tas.get
profile.get
profile.get_agent
every included viem-public Manifest name
every included viem-wallet Manifest name
```

At the Slice A gate, reject any extra Repository, Role Skill, agent-sdk Workflow, DA, Chat, or Proof Provider tool. Require `tools/list` to remain stable for the process lifetime even when no credential is available. Composition selects only whole reviewed Manifest groups; it has no phase-specific per-action allowlist.

`toolInventory.expected.ts` is the one cumulative inventory fixture for the repository. At the Slice A commit it contains only the groups above. Every later slice that adds a reviewed tool group must update this same fixture and its assertions rather than preserving a permanently exact Slice A production inventory test. Identity-setup expectations remain permanently exact because later slices add no capability to that phase.

- [ ] **Step 2: Write failing schema and annotation tests**

For every generated tool, compare MCP `inputSchema`, `outputSchema`, description, and annotations with its accepted Manifest. Wallet tools expose one optional write-only inline credential field so TAS can return `CREDENTIAL_REQUIRED`; Public tools expose none.

- [ ] **Step 3: Implement mechanical tool registration**

Iterate the accepted whole groups, register each exact schema, and dispatch by manifest name to `ChainService.invoke`. Do not add per-name switch cases. Return native TAS context and source result/error envelopes.

Production startup must establish the trust boundary before importing viem. Replace the static `main.ts → createTasApp` path with a small preflight path that imports only the bundled validator, generated artifact-digest constant, and shared package-tree scanner. After validation succeeds, dynamically import `createTasApp`; only that post-gate graph may load `loadConfig`, `ProfileReader`, viem, or Task 6 action bindings. Tests that directly import internal modules are not evidence for this production ordering, so add a conformance fixture that detects any pre-gate viem load.

- [ ] **Step 4: Verify and commit**

```bash
npm test -- test/conformance/generatedChainTools.test.ts test/conformance/fixedToolInventory.test.ts
npm run typecheck
git add src/mcp/generatedChainTools.ts src/mcp/server.ts src/app/createTasApp.ts src/app/main.ts test/conformance
git commit -m "feat: expose generated viem Chain tools"
```

---

### Task 8: Prove Identity-to-TAWG-to-Member Onboarding

**Files:**

- Create: `test/fixtures/contracts/identityRegistry.ts`
- Create: `test/fixtures/contracts/tawgProfile.ts`
- Create: `test/integration/chainOnboarding.test.ts`
- Create: `test/conformance/sliceAPackage.test.ts`
- Modify: `README.md`
- Modify: `docs/PROJECT_STRUCTURE.md`
- Modify: `docs/tas/IMPLEMENTATION.md`

**Interfaces:**

- Consumes: complete Slice A1 and A2 tool surfaces.
- Produces: Slice A onboarding evidence for identity setup, TAWG setup, and member TAS plus package gates.

- [ ] **Step 1: Add deterministic contract fixtures**

The harness deploys the fixture chain and contracts and provisions test funds, but it does not create an Agent wallet, register an ERC-8004 identity, register Profile membership, or submit a business transaction for the Agent. The Agent-side test driver creates or loads an ephemeral fixture-only wallet after startup and keeps its key outside TAS. The fixture must implement ERC-8004 `register`, `ownerOf`, `getAgentWallet`, wallet establishment, Profile `registerAgent`, and the Profile reads used by TAS. Use an Agent ID larger than JavaScript's safe integer.

- [ ] **Step 2: Exercise pre-TAWG identity setup**

Through MCP only:

```text
receive only the chain ID and Identity Registry address
start identity-setup TAS
skill.tas.get
tools/list -> TAS Skill plus complete generated viem groups, with no Profile or later-phase tools
Agent-side driver creates or loads its own wallet
workflow.chain.wallet.write_contract -> ERC-8004 register
workflow.chain.public.get_transaction_receipt -> Agent-owned polling until the registration receipt exposes the Registered agentId
workflow.chain.public.read_contract -> ownerOf and getAgentWallet
workflow.chain.wallet.write_contract -> establish Registry wallet when fixture requires it
Agent-side driver records the canonical-decimal agentId
stop identity-setup TAS
```

Pass the credential inline on each Wallet call. Assert TAS retains no key or Account and no Profile service is constructed. Restart identity setup and have the Agent reconcile the existing registration through Public Actions rather than submitting an automatic duplicate.

- [ ] **Step 3: Exercise TAWG setup and member startup**

After the harness uses only the public Evaluator `agentId` to deploy the Profile/TAWG fixture, continue through MCP:

```text
receive the TAWG locator
start TAWG-setup TAS
skill.tas.get
profile.get -> immutable Identity Registry and current Profile state
workflow.chain.wallet.write_contract -> Profile registerAgent
profile.get_agent -> permanent member and exact verifier/Data/wallet
Agent-side driver writes the member configuration containing the returned agentId
stop TAWG-setup TAS
start member TAS with returned decimal agentId
tools/list -> fixed tools plus complete viem groups
```

The Agent-side test driver supplies its own ephemeral key inline per Wallet call. TAS never opens a credential file. Retain and use transaction hashes in the Agent-side path; do not assert a TAS retry registry. Also exercise a second Agent that receives the TAWG locator first, discovers the immutable Identity Registry through `profile.get`, registers its own ERC-8004 identity from TAWG setup, then registers itself into the Profile.

- [ ] **Step 4: Exercise existing identity and failure paths**

Cover existing nonmember registration, already-registered member, zero Registry wallet, wallet mismatch, invalid verifier contract, reverted Profile registration, unknown transaction outcome, TAS restart followed by Agent-side chain reconciliation, and no automatic duplicate submission.

- [ ] **Step 5: Run package and security gates**

Require packaged Manifests to match `manifest:check`. Scan stdout, stderr, errors, snapshots, built files, and package contents for fixture secrets and RPC URLs. Require all generated Wallet tools to construct and release one Account per call.

- [ ] **Step 6: Update documentation and run acceptance**

Document the actual Slice A tool inventories, Manifest regeneration command, identity-setup/TAWG-setup/member path, and Agent-owned wallet, `agentId`, and replay responsibilities. Mark Slice A complete only after:

```bash
npm ci
npm run manifest:check
npm run typecheck
npm test
npm run test:coverage
npm run build
npm pack --dry-run
git diff --check
```

- [ ] **Step 7: Commit Slice A completion**

```bash
git add test/fixtures/contracts test/integration/chainOnboarding.test.ts test/conformance/sliceAPackage.test.ts README.md docs/PROJECT_STRUCTURE.md docs/tas/IMPLEMENTATION.md
git commit -m "feat: complete TAS Slice A onboarding"
```

---

## Slice A2 Completion Criteria

1. Identical dependency inputs generate byte-identical Manifests and report.
2. Every viem Public/Wallet Action is included or has one reviewed structural exclusion.
3. Startup rejects artifact, package version, package integrity, binding, and schema mismatch.
4. Identity setup contains only `skill.tas.get` plus the complete reviewed viem groups; it exposes and constructs no Profile, Repository, Role Skill, Workflow SDK, DA, Chat, or Proof Provider capability.
5. At the Slice A gate, TAWG setup and member inventories contain their Slice A1 fixed tools plus the complete reviewed viem groups. Later slices update the shared cumulative member inventory fixture while TAWG setup remains restricted to onboarding capabilities.
6. The configured chain, transport, and operation-scoped Account cannot be overridden by a caller.
7. An Agent creates or loads its own wallet, registers its own ERC-8004 identity in identity setup, records its own canonical-decimal `agentId`, and passes its credential inline for each Wallet call.
8. TAWG setup can also register an identity after resolving the immutable Registry, can self-register or update Profile membership, and member Wallet calls require the current Authentication Wallet.
9. The complete identity-to-TAWG-to-member path succeeds using decimal-string Agent IDs and source-native transaction hashes without harness-owned Agent transactions.
10. TAS performs no hidden side-effect replay and stores no key, Account, Agent ID discovery state, business-operation ID, or retry journal.
11. stdout remains MCP-only and no secret or authenticated RPC URL appears in results, errors, logs, fixtures shipped to npm, or package contents.
12. `npm ci`, Manifest check, type checking, all tests, coverage, build, and package dry-run pass.
