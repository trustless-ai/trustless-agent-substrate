# TAS Workflow Source, agent-sdk, and DA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Use TDD and commit after each focused task.

**Goal:** Extend a member TAS with reproducible Workflow source verification, generated `agent-sdk` operations, and the fixed Git DA interface required to participate in the Demo TAWG without adding scenario-specific APIs.

**Architecture:** The build-time Manifest generator projects the exact installed `@trustless-ai/agent-sdk` public TypeScript surface into reviewed `workflow.*` tools. Workflow Source Service resolves Profile-selected immutable source and metadata, recompiles them, and compares runtime bytecode before returning source guidance. DA Service exposes three backend-neutral tools over a provider-specific Git DA Client selected by the Profile Repository.

**Tech Stack:** Slice A stack plus exact `@trustless-ai/agent-sdk@0.3.0`, TypeScript compiler APIs, `solc` pinned to the Demo compiler, Node crypto, `@octokit/request`, canonical JSON, and Vitest.

**Spec:** `docs/tas/MANIFEST.md`, `docs/tas/MCP.md` Sections 4.12, 4.15.1, and 4.16, `docs/tawg/WORKFLOW.md`, and the accepted vertical-slice design.

## Global Constraints

- Begin only after Slice A, the Demo contract plan, and the Repository/Role Skill plan pass.
- Do not handwrite the installed `agent-sdk` operation inventory.
- Keep `governance/InvinoVeritas` Provider-reserved and absent from generic `workflow.*` tools until a reviewed concrete Provider Adapter claims and maps it. Its public exports still appear in the generation report as excluded Provider candidates.
- Generate Manifests only through an explicit developer command and check them into the release.
- A TAWG Repository cannot supply executable code, a Manifest, a compiler, compiler settings outside its committed metadata, or a dependency override.
- `workflow.source.get` is unavailable until `workflow.source.verify` succeeds for the current in-process Workflow fingerprint.
- Any Profile Workflow address/data change invalidates the previous verification before another Workflow source or generated Workflow call.
- The caller cannot select another Repository, Workflow, chain, transport, source path, compiler path, DA root, or Account.
- Wallet operations construct an Account from the current call's inline credential and retain no Account state.
- Git DA paths remain below `data/`; reads use immutable commits and writes return a full immutable commit plus path.
- DA never anchors, evaluates, scores, proves, or settles content.
- TAS stores no DA replay record or generated business digest.
- IPFS remains an interface seam only.

## Planned File Structure

```text
manifests/
├── agent-sdk.v1.json
└── agent-sdk-report.v1.json
tools/manifest/
├── analyzeAgentSdk.ts
└── generate.ts
src/
├── mcp/
│   ├── generatedWorkflowTools.ts
│   ├── workflowSourceTools.ts
│   └── daTools.ts
├── core/
│   ├── workflow/
│   │   ├── types.ts
│   │   ├── sourceResolver.ts
│   │   ├── sourceVerifier.ts
│   │   └── operationService.ts
│   └── da/
│       ├── types.ts
│       ├── path.ts
│       ├── client.ts
│       └── service.ts
└── clients/
    ├── workflow/
    │   ├── agentSdkClient.ts
    │   ├── solcCompiler.ts
    │   └── viemWorkflowCodeReader.ts
    └── da/
        └── gitDaClient.ts
test/
├── fixtures/workflow/
├── fixtures/da/
├── unit/workflow/
├── unit/da/
├── integration/workflowSource.test.ts
├── integration/gitDaClient.test.ts
└── conformance/workflowDaMcp.test.ts
```

## Task 1: Generate the Reviewed agent-sdk Manifest

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tools/manifest/generate.ts`
- Create: `tools/manifest/analyzeAgentSdk.ts`
- Create: `test/unit/manifest/agentSdkAnalysis.test.ts`
- Create: `test/conformance/agentSdkManifest.test.ts`
- Create: `manifests/agent-sdk.v1.json`
- Create: `manifests/agent-sdk-report.v1.json`

- [ ] **Step 1: Add the exact dependency and failing analyzer fixtures**

Pin `@trustless-ai/agent-sdk` exactly. Test eligible functions, recompute reads, side effects, unsupported callbacks/generics, source-module collisions, JSON/bigint/bytes codecs, and a public callable that cannot be projected. Assert `governance/InvinoVeritas` is completely reported as Provider-reserved and produces no generic Workflow tool while no Provider Adapter is shipped.

- [ ] **Step 2: Run focused tests**

```bash
npm test -- test/unit/manifest/agentSdkAnalysis.test.ts test/conformance/agentSdkManifest.test.ts
```

Expected: FAIL because the source profile and artifacts are missing.

- [ ] **Step 3: Extend the deterministic generator**

Analyze installed public exports and TypeScript types using the naming and classification rules in `docs/tas/MANIFEST.md`. Every callable must be included or reported as structurally excluded; an eligible unprojectable callable fails generation.

- [ ] **Step 4: Generate, review, and verify byte stability**

```bash
npm run manifest:generate
cp manifests/agent-sdk.v1.json /tmp/tas-agent-sdk-manifest.json
npm run manifest:generate
cmp /tmp/tas-agent-sdk-manifest.json manifests/agent-sdk.v1.json
npm test -- test/unit/manifest/agentSdkAnalysis.test.ts test/conformance/agentSdkManifest.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tools/manifest manifests/agent-sdk.v1.json manifests/agent-sdk-report.v1.json test/unit/manifest/agentSdkAnalysis.test.ts test/conformance/agentSdkManifest.test.ts
git commit -m "feat: generate agent-sdk workflow manifest"
```

## Task 2: Bind Generated Workflow Operations

**Files:**

- Create: `src/core/workflow/types.ts`
- Create: `src/core/workflow/sourceGate.ts`
- Create: `src/core/workflow/operationService.ts`
- Create: `src/clients/workflow/agentSdkClient.ts`
- Create: `src/mcp/generatedWorkflowTools.ts`
- Create: `test/unit/workflow/operationService.test.ts`
- Create: `test/conformance/generatedWorkflowMcp.test.ts`
- Modify: `test/conformance/toolInventory.expected.ts`

- [ ] **Step 1: Write failing read/write binding tests**

Assert every generated Workflow operation fails closed with `WORKFLOW_SOURCE_VERIFICATION_REQUIRED` before a matching successful verification fingerprint exists. After a test gate is satisfied, assert configured chain/Workflow injection, MCP JSON codecs, public reads without a credential, side effects with one inline EVM key, current Authentication Wallet enforcement, Account destruction after the call, source-native result preservation, and no automatic retry.

- [ ] **Step 2: Implement the provider-neutral operation boundary**

The Client retains only connection and contract addressing state. The Service requires `WorkflowVerificationGate.assertCurrent()` before every read or write, resolves the configured Agent wallet at the selected chain state before each write, and passes an operation-scoped Account into the generated SDK binding. The initial Gate has no accepted fingerprint and therefore rejects every operation until Task 4 connects the real verifier.

- [ ] **Step 3: Register only reviewed Manifest tools in member mode**

Identity setup and TAWG setup must not expose `workflow.*` generated agent-sdk tools. Member `tools/list` is stable for the process lifetime.

Update the shared cumulative inventory fixture with every generated Workflow tool. Do not add a second permanently exact member-inventory test that would conflict with later DA or Chat additions.

Registration is not enablement: at this intermediate commit all generated Workflow calls remain fail-closed because no production verification result can yet satisfy the Gate.

- [x] **Step 4: Verify and commit**

```bash
npm test -- test/unit/workflow/operationService.test.ts test/conformance/generatedWorkflowMcp.test.ts
npm run typecheck
git add src/core/workflow src/clients/workflow src/mcp/generatedWorkflowTools.ts test/unit/workflow test/conformance/generatedWorkflowMcp.test.ts test/conformance/toolInventory.expected.ts
git commit -m "feat: bind generated workflow operations"
```

## Task 3: Reproduce and Verify Workflow Source

**Files:**

- Create: `src/core/workflow/sourceResolver.ts`
- Create: `src/core/workflow/sourceVerifier.ts`
- Create: `src/clients/workflow/solcCompiler.ts`
- Create: `src/clients/workflow/viemWorkflowCodeReader.ts`
- Modify: `src/core/repository/client.ts`
- Modify: `src/clients/repository/githubRepositoryClient.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `test/fixtures/workflow/valid/`
- Create: `test/fixtures/workflow/mismatch/`
- Create: `test/unit/workflow/sourceResolver.test.ts`
- Create: `test/unit/workflow/sourceVerifier.test.ts`
- Create: `test/unit/clients/solcCompiler.test.ts`
- Create: `test/unit/clients/viemWorkflowCodeReader.test.ts`
- Create: `test/integration/workflowSourceVerification.test.ts`

- [x] **Step 1: Write failing authority and mismatch tests**

Cover canonical Repository locator/commit/path resolution, metadata parsing, exact compiler version, optimizer/EVM settings, source digest mismatch, missing dependency source, proxy/replaceable implementation, metadata mismatch, deployed runtime mismatch, and a valid Demo fixture.

- [x] **Step 2: Implement immutable source resolution**

Read only the Profile Workflow JSON `source` object and the Profile-selected Repository at its full commit. Normalize paths and prevent traversal. Fetch all compiler inputs named by committed metadata through the internal Repository file boundary.

- [x] **Step 3: Implement reproducible compilation and comparison**

Compile Standard JSON input with the exact pinned compiler, apply Solidity metadata/runtime comparison rules from `docs/tawg/WORKFLOW.md`, and return a structured `{ valid, reason, fingerprint, compiler, deployedCodeHash }` result. A negative comparison is data, while unavailable or malformed inputs are typed tool errors.

- [x] **Step 4: Verify and commit**

```bash
npm test -- test/unit/workflow/sourceResolver.test.ts test/unit/workflow/sourceVerifier.test.ts
git add src/core/workflow/sourceResolver.ts src/core/workflow/sourceVerifier.ts test/fixtures/workflow test/unit/workflow
git commit -m "feat: verify deployed workflow source"
```

## Task 4: Expose Workflow Source MCP Tools and Invalidation

**Files:**

- Create: `src/mcp/workflowSourceTools.ts`
- Modify: `src/app/createTasApp.ts`
- Create: `test/conformance/workflowSourceMcp.test.ts`
- Create: `test/integration/workflowInvalidation.test.ts`

- [x] **Step 1: Write failing MCP tests**

Assert `workflow.source.verify` returns boolean plus reason and fingerprint. Assert `workflow.source.get` is blocked before verification, returns exact source after success, and becomes blocked again when address, source commit/path, metadata path/digest, compiler settings, chain ID, or deployed code hash changes. A block or Profile-version-only change preserves an otherwise identical immutable Workflow fingerprint.

- [x] **Step 2: Implement process-local verification state**

Cache only the successful fingerprint and material identity, not source content, credentials, or a cross-process trust decision. Publish successful verification to the fail-closed `WorkflowVerificationGate`. Recheck the current material locator and canonical deployed runtime before source retrieval and every generated Workflow operation; a mismatch clears the accepted fingerprint before returning an error. Permit at most one verification pipeline in flight per TAS process, share it for at most two callers with the same immutable descriptor and credential identity, fail fast for unrelated or excess concurrent verification, apply one total deadline, and propagate cancellation through Profile, Repository, canonical runtime-code read, and solc. One caller may detach without aborting another; the underlying work is aborted when all callers detach or TAS closes.

- [x] **Step 3: Verify and commit**

```bash
npm test -- test/conformance/workflowSourceMcp.test.ts test/integration/workflowInvalidation.test.ts
git add src/mcp/workflowSourceTools.ts src/app/createTasApp.ts test/conformance/workflowSourceMcp.test.ts test/integration/workflowInvalidation.test.ts
git commit -m "feat: gate workflow source access"
```

## Task 5: Implement the Git DA Domain and Client

**Files:**

- Create: `src/core/da/types.ts`
- Create: `src/core/da/path.ts`
- Create: `src/core/da/client.ts`
- Create: `src/core/da/service.ts`
- Create: `src/clients/da/gitDaClient.ts`
- Create: `test/unit/da/path.test.ts`
- Create: `test/unit/da/service.test.ts`
- Create: `test/integration/gitDaClient.test.ts`

- [ ] **Step 1: Write failing reference/path/content tests**

Cover full Git commit validation, `data/` confinement, UTF-8/base64 decoding, media type pass-through, exact byte preservation, maximum inline size, private Repository credential injection, immutable get, successful put, upstream head race, and credential redaction.

- [ ] **Step 2: Implement the backend-neutral service**

Define `capabilities`, `get`, and `put` only. A Git put creates exact bytes below `data/`, obtains a full immutable commit, and returns `{ type: 'git', commit, path }`. Do not anchor or compute an ERC-specific digest.

- [ ] **Step 3: Implement the production GitHub-backed Client and injectable test Client seam**

Use the Profile-selected Repository only. Construct authenticated request state per call. The offline E2E mirror implements the same Client interface in the E2E plan and is never selectable through production TOML.

- [ ] **Step 4: Verify and commit**

```bash
npm test -- test/unit/da/path.test.ts test/unit/da/service.test.ts test/integration/gitDaClient.test.ts
git add src/core/da src/clients/da test/unit/da test/integration/gitDaClient.test.ts
git commit -m "feat: add immutable Git DA client"
```

## Task 6: Expose DA MCP Tools and Demo Integration

**Files:**

- Create: `src/mcp/daTools.ts`
- Modify: `src/app/createTasApp.ts`
- Create: `test/conformance/workflowDaMcp.test.ts`
- Create: `test/integration/demoWorkflowDa.test.ts`
- Modify: `test/conformance/toolInventory.expected.ts`

- [ ] **Step 1: Write failing MCP conformance tests**

Assert exact tool names, schemas, read/write annotations, common context, inline credential handling, canonical references, size failures, path failures, and absence from both setup modes.

Add the three DA tools to the shared cumulative member inventory fixture.

- [ ] **Step 2: Write the failing Demo round-trip test**

Put contribution bytes, read them back by immutable reference, recompute their digest through the generated SDK/Workflow operation when applicable, submit the reference/digest to the Demo Workflow, and query the stored record.

- [ ] **Step 3: Compose tools and verify**

```bash
npm test -- test/conformance/workflowDaMcp.test.ts test/integration/demoWorkflowDa.test.ts
npm run typecheck
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add src/mcp/daTools.ts src/app/createTasApp.ts test/conformance/workflowDaMcp.test.ts test/conformance/toolInventory.expected.ts test/integration/demoWorkflowDa.test.ts
git commit -m "feat: expose workflow and DA participation"
```

## Completion Criteria

1. The installed SDK fully accounts for every public callable through a reviewed Manifest/report.
2. Workflow reads and writes bind the configured chain/address and operation-scoped Account.
3. Unverified or changed Workflow source blocks source guidance and related operations.
4. Git DA preserves exact bytes and immutable references below `data/`.
5. Setup processes expose none of the member-only tools.
6. A Demo contribution completes the DA-to-Workflow round trip without scenario-specific TAS code.
