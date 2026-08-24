# TAS v0.1 Implementation Roadmap

## 1. Purpose

This document turns the accepted TAS v0.1 design into a vertical implementation sequence. It defines delivery slices, dependencies, and release gates. Detailed task instructions live in slice-specific plans under `docs/superpowers/plans/`.

TAS v0.1 remains a local TypeScript MCP stdio service. A normal TAS instance belongs to exactly one Agent identity and one TAWG. It resolves that TAWG from its on-chain Profile and repository, then delegates protocol-specific operations to typed Clients and generated Manifests.

Development starts with a small, multi-round TAWG under `tawg/demo/`. The Demo is both a walking skeleton for TAS and a reference for future TAWG developers. Daily Contribution is integrated only after the general TAS path works without Demo-specific interfaces.

## 2. Design Inputs

| Area | Source of truth |
|---|---|
| Product and architecture | `docs/DESIGN.md`, `docs/TAS.md` |
| TAWG model | `docs/TAWG.md` |
| Vertical-slice acceptance design | `docs/superpowers/specs/2026-08-22-tas-demo-vertical-slice-design.md` |
| Local configuration and credentials | `docs/tas/CONFIG.md` |
| Host Credential File | `docs/tas/CREDENTIALS.md` |
| MCP contract | `docs/tas/MCP.md` |
| Skill delivery and onboarding | `docs/tas/SKILLS.md` |
| Generated operations | `docs/tas/MANIFEST.md` |
| Profile contract and projections | `docs/tawg/PROFILE.md` |
| Workflow source and verification | `docs/tawg/WORKFLOW.md` |
| Repository layout | `docs/PROJECT_STRUCTURE.md` |

## 3. Runtime Baseline

- Node.js `>=24 <25` on Windows, macOS, and Linux.
- TypeScript 7 in strict ESM mode.
- npm with an exact lockfile.
- MCP TypeScript SDK v2 over local stdio.
- Vitest for unit, integration, protocol-conformance, and deterministic E2E tests.
- A local Anvil chain for the first complete acceptance path.
- Standard output is reserved for MCP protocol frames. Logs use standard error and must redact credentials and secret-bearing parameters.

## 4. TAS Execution Phases

Execution phase and delivery slice are different concepts. The implementation must support the following three process phases without sharing credentials, Accounts, or member state between them.

### 4.1 Identity setup

Identity setup is a short-lived process selected by:

```text
(chainId, identityRegistryAddress)
```

It lets an Agent create or load its own wallet, provide its credential per sensitive operation, register its own ERC-8004 identity, and record the resulting public `agentId`. All four Skill names are discoverable, but only `tas.get` succeeds; the three member-phase-only calls return `SKILL_MEMBER_CONTEXT_REQUIRED`. The phase also exposes generated viem Public and Wallet Actions needed for identity inspection and registration. It has no TAWG, Profile, Repository, Workflow, DA, Chat, Proof Provider, or member state.

### 4.2 TAWG setup

TAWG setup is a short-lived process selected by:

```text
(chainId, tawgAddress)
```

It lets an Agent load the release-matched TAS Skill, discover the Profile-selected Identity Registry, create or load its ERC-8004 identity when needed, inspect its own Profile record, and register or update its own permanent membership. The Agent supplies its own credential and submits every Agent-authorized transaction; neither a Host nor a test harness may register or join on its behalf.

### 4.3 Member TAS

The normal member process is bound to:

```text
(chainId, tawgAddress, ERC-8004 agentId)
```

It exposes the Profile, Repository, verified Workflow, DA, Chat, Proof Provider, and all four Skill surfaces allowed by configuration. One Agent owns one process. Separate Agents never share a member instance, transaction Account, credential, Chat cursor, approval, automation grant, accepted-work record, or mutable local state.

## 5. Delivery Slices

### Slice 0: Plan Alignment

Reconcile the roadmap, detailed implementation plans, MCP contracts, Skills, test conventions, and deferred-integration boundaries with the accepted vertical-slice design.

**Deliverables:**

- the reordered roadmap and slice-specific implementation plans;
- a documented `tawg/demo/` location and ignored runtime-area convention;
- consistent identity setup, TAWG setup, and member terminology; and
- removal of any first-slice requirement for live Chat or a concrete Proof Provider.

**Exit gate:** design and planning documents agree on the vertical sequence and do not claim that live Telegram, live Discord, InvinoVeritas, or another concrete Provider is required for local acceptance.

### Slice A: Bootable TAS

Establish the TypeScript package, strict TOML configuration, the three execution phases, instance isolation, redacted logging, MCP result model, Bootstrap Skill, the four flat Skill names, Profile reads, and deterministic viem Chain operations.

The Evaluator must be able to use identity setup before the Demo TAWG exists, because its ERC-8004 `agentId` is fixed when the Demo Workflow is deployed. After a TAWG exists, every Agent uses TAWG setup to register or update its own Profile membership and then starts its isolated member TAS.

Existing foundation and viem work is described by:

1. `docs/superpowers/plans/2026-08-18-tas-foundation-profile.md`; and
2. `docs/superpowers/plans/2026-08-22-tas-viem-chain-onboarding.md`.

These plans must be executed according to this roadmap's three-phase lifecycle where their older phase wording differs.

#### Slice A implementation milestone

The current repository implements the TypeScript `@trustless-ai/tas` v0.1 Slice A baseline. It requires Node.js `>=24 <25`, uses the committed exact npm lockfile, and serves one MCP connection over stdio. The complete reviewed viem Public and Wallet Action groups are mechanically registered from the shipped Manifests in every phase.

| Phase | Public TOML selector | Fixed Slice A tools in addition to complete generated viem groups |
|---|---|---|
| Identity setup | `[identity_setup]` selects `(chainId, identityRegistryAddress)` | four Skill names; only `tas.get` succeeds; no Profile or later-slice capability |
| TAWG setup | `[tawg_setup]` selects `(chainId, tawgAddress)` | four Skill names with three member-phase-only call errors, plus `profile.get`, `profile.get_agent` |
| Member | `[instance]` selects `(chainId, tawgAddress, ERC-8004 agentId)` | four Skill calls pass the phase gate, plus `profile.get`, `profile.get_agent`; normal operation errors remain possible |

Identity setup constructs no Profile service, state directory, or member lock. TAWG setup constructs public Profile discovery but no member state or lock. Member startup owns a canonical process directory and lock for its exact identity tuple. Every Wallet call receives an inline credential, constructs one operation-scoped Account, verifies the current Authentication Wallet in member mode, then releases Account and credential references when that MCP invocation completes, including failure or unknown outcome. Only public source-native handles remain for later reconciliation. TAS does not retain a private key, Account, discovered `agentId`, retry journal, or automatic side-effect replay state.

The Agent owns wallet generation/loading, canonical-decimal `agentId` recording, source-native transaction hashes, and reconciliation after restart. It uses identity setup to self-register or inspect ERC-8004, then stops it; in TAWG setup it reads the immutable Identity Registry from `profile.get`, self-registers or reconciles membership, writes the resulting public member configuration, and starts member TAS. A new Agent can begin with the TAWG locator and discover the Registry before its own identity registration. Proof Provider and Chat remain reserved later-slice surfaces.

Every Profile operation first resolves a block number and hash, performs all contract reads through the EIP-1898 selector `{ blockHash, requireCanonical: true }`, and rechecks the canonical block before returning. It propagates caller cancellation and applies a bounded local deadline. It never degrades to a number-only or current-state read. Only public Profile data is returned. TAS does not open, retain, or migrate the Host Credential File.

Slice A is verified from a clean install with:

```bash
npm ci
npm run manifest:check
npm run typecheck
npm test
npm run test:coverage
npm run build
npm exec -- tas --version
npm exec -- tas --config /absolute/path/to/tas.toml
npm pack --dry-run
```

Use `npm run manifest:generate` only after an intentional dependency review; runtime validates shipped artifacts before it imports viem. The package gate admits only compiled `dist/**`, the reviewed Manifest artifacts, the release-matched `skills/tas/SKILL.md` and `skills/tawg-collaboration/SKILL.md`, `docs/tas/CREDENTIALS.md`, and npm-required metadata. Scoped coverage gates require at least 80% statements, branches, functions, and lines independently for `src/core/profile/**`, `src/core/repository/**`, `src/core/skill/**`, `src/clients/repository/**`, `src/local/config/**`, and `src/local/instance/**`, in addition to the global 80% floor.

The Repository, four-layer Skill, Workflow-source verification, production `agent-sdk` binding, Git DA, offline Chat port, and Proof Provider abstraction portions are implemented as described below. The deterministic collaboration scenario pack, Jimmy-operated three-Agent acceptance, live Chat bindings, and concrete Proof Provider integration remain incomplete. The repository makes no claim of npm publication, production Profile deployment, live Telegram or Discord connectivity, or a concrete Proof Provider adapter.

**Exit gate:** against local Anvil fixtures, an Agent can use identity setup to self-register an ERC-8004 identity, use TAWG setup to self-register its Profile membership, and start one member TAS from the resulting public configuration. The harness may fund wallets and observe public state but performs none of those Agent-authorized operations.

### Slice B: Demo TAWG

Add a version-controlled reference TAWG under `tawg/demo/`. It contains the Charter, reproducible Workflow source and compiler material, Contributor and Evaluator Role Skills, deployment guidance, and useful example DA material or schemas.

The Demo has two roles:

- every registered member may act as a Contributor; and
- one immutable ERC-8004 `agentId` is the Evaluator and alone may score, settle, advance rounds, or complete the Workflow.

The Demo is deliberately multi-round. Contributors may submit multiple contributions to the current open round. Each contribution may be scored once. Settlement closes the round and adds its scores to an on-chain cumulative points ledger. The Evaluator may then open another round or complete the Workflow. It does not issue an ERC-20 token and does not require a Proof Provider.

**Exit gate:** contract tests pass for at least three rounds, cumulative points, completion, and invalid transitions including late submission, duplicate scoring, unauthorized settlement, premature round advancement, and mutation after completion. The Demo adds no `demo.*` or other TAWG-specific TAS API.

### Slice C: Participating TAS

Complete the general surfaces needed for an Agent to participate in the Demo: Repository resolution and activity queries, commit-pinned Root and Role Skill loading, reproducible Workflow source verification, generated Workflow operations, generated Chain operations, and fixed DA operations.

`workflow.source.verify` must compile the repository source reproducibly and compare deployed runtime code before `workflow.source.get` can return source as operational guidance. A changed Workflow fingerprint invalidates the prior result. Transaction Accounts are constructed per operation from caller-supplied secret material and are never retained.

Repository and Role Skill work begins from:

- `docs/superpowers/plans/2026-08-19-tas-repository-skill.md`.

#### Repository and TAWG Skill implementation milestone

This portion of Slice C is complete. Member TAS composes the Profile Resolver into a Repository Resolver, a read-only Repository Service, one stateless GitHub Client, and Root and Role Skill Loaders. The four flat Skill names remain discoverable in every phase. The cumulative member inventory includes:

```text
repo.get
repo.issue.list
repo.pull_request.list
repo.commit.list
tawg.get
role.get
```

`repo.get` returns the Profile-selected canonical GitHub URL and Charter reference without a provider request. The three activity tools use an inclusive `since` boundary, newest-first results, source-native IDs or full hashes, one captured `observed_at`, and an opaque caller-held cursor. Cursor pages re-resolve the first exact Profile block; TAS retains neither delivery position nor deduplication state. A GitHub credential is optional and attached only to the individual provider call.

`tawg.get` derives only `skills/SKILL.md`; `role.get` derives only `skills/roles/<role>.md`. Each call resolves the latest Profile-selected Repository and current default-branch HEAD internally, then reads from that full commit. The caller cannot select a Repository, path, or commit. TAS retains no active Skill commit, validates no role ownership, executes no returned content, and rejects file bytes above 1 MiB or invalid/empty UTF-8.

Acceptance fixtures cover Profile-to-Repository discovery; two-page Issue polling across an advancing latest Profile and clock; Pull Request and default-branch commit discovery; Root and Contributor/Evaluator loading at TAS-resolved commits; later refreshed HEADs; exact SHA-256 digests; and credential absence from results and retained test transport state. The clean release gates require at least 80% statements, branches, functions, and lines for `src/core/repository/**`, `src/core/skill/**`, and `src/clients/repository/**` before this milestone may remain marked complete.

#### Workflow source verification milestone

This portion of Slice C is complete. Member TAS exposes exactly `workflow.source.verify` and `workflow.source.get`, resolves the Profile-selected immutable source closure, validates compiler metadata and source hashes, runs the bundled exact solc through constrained Standard JSON, and compares the result with canonical deployed runtime code. Only a successful fingerprint and material identity remain in process memory; source content and Repository credentials are operation-scoped.

The same process-scoped Gate protects source delivery and every generated Workflow operation. Before verification, or after a Workflow address, material locator, compilation identity, or runtime-code change, both paths fail with `WORKFLOW_SOURCE_VERIFICATION_REQUIRED`. Moving to a later block or Profile version alone preserves the accepted fingerprint when the immutable Workflow material and deployed runtime are unchanged.

The generated `agent-sdk` inventory has a statically reviewed production binding. TAS validates every shipped binding tuple at composition time, constructs a fresh SDK Client and per-call Account for each invocation, preserves Manifest argument order, normalizes a source `undefined` result to `null`, and retains neither Client nor Account state. With `agent-sdk@0.3.0`, chain-bound operations are deliberately limited to local Anvil (`chainId = 31337`) because the upstream SDK currently selects its Foundry chain statically; pure recompute operations remain chain-independent. The Profile-authoritative ERC-8301 Workflow address is the only contract address TAS resolves automatically. Other contract namespaces fail explicitly with `MANIFEST_BINDING_UNSUPPORTED` until their authority source is designed.

Verification uses a bounded single flight shared by at most two callers for the same descriptor and credential identity. It fails fast for unrelated or excess work, propagates request cancellation and a total deadline, and aborts underlying work when every subscriber detaches or TAS closes. Unit and integration fixtures cover source closure changes, runtime changes, stale concurrent checks, exact compilation, cancellation, shutdown, and secret/source non-retention.

#### Workflow operation and Git DA milestone

This portion of Slice C is complete. Member TAS exposes generated Workflow operations only through the verified-source Gate. Git DA exposes exactly `workflow.da.capabilities`, `workflow.da.get`, and `workflow.da.put`. Paths are confined below the Profile-selected Repository's `data/` directory. Reads resolve immutable content by commit; writes create immutable Git commits and return the resulting full commit and path. TAS retains no DA cursor or mutable worktree state, and IPFS remains only a reserved Client boundary.

The integration fixture runs two independently configured Agents against local Anvil. Each Agent registers its own ERC-8004 identity and Profile membership. One Agent publishes exact contribution bytes through Git DA and the other retrieves them; the Contributor then recomputes the reply hash, submits the contribution through the real generated ERC-8301 binding, and both sides read the authoritative on-chain result. Chat delivery, Proof Provider behavior, multi-round Demo settlement, process restarts, and Subagent usability remain later acceptance work.

**Exit gate:** one Agent can use only general MCP interfaces to load its Role Skill, publish and retrieve contribution content through DA, submit a contribution, inspect and score it as the Evaluator, settle multiple rounds, and query cumulative points. The same surface works for both Demo roles without TAS branching on Demo business logic.

### Slice D: Offline Integration Ports

Define the production Chat and Proof Provider boundaries without requiring unavailable external services.

For Chat, expose the production Telegram and Discord MCP schemas and Client boundaries. Tests inject offline Fake Clients behind those boundaries; there is no public test-only Chat namespace. Each Agent retains its own cursor, while TAS only performs bounded waits and sends through the configured Client.

For Proof Providers, implement the adapter interface, adapter registry and discovery behavior, an empty `proof_provider.attestation.list` result when none is configured, normalized generate and validate contracts, and Fake adapter conformance tests. Do not integrate a concrete Provider in this slice.

**Exit gate:** offline tests cover Chat wait, cursor, send, source/target routing, multiple actors, and process isolation through the production MCP schemas. Proof Provider conformance tests demonstrate that Fede's later adapter can be added without changing TAS Core or the MCP contract.

#### Four-layer collaboration Skill milestone

The implementation and automated conformance portion is complete. TAS ships release-bundled TAS and Collaboration Skills; member composition reads the TAWG Root and requested Role Skills from the latest Profile-selected Repository. `tas.get`, `collaboration.get`, `tawg.get`, and `role.get` are registered in every phase. Outside member phase, only `tas.get` succeeds and the other calls return `SKILL_MEMBER_CONTEXT_REQUIRED`; this boundary does not validate Profile membership or role authority.

The Collaboration Skill defines natural group communication, four Work Origins, Scope and Formality interpretation, separate Action and Message Approval, bounded automation, Handoffs, Agent-owned cursors/work state, restart recovery, and outcome verification. Root and Role Skills retain TAWG business rules. TAS stores no collaboration state and defines no production message wire schema.

The deterministic acceptance pack and Jimmy-operated three-Agent run remain open. This milestone MUST NOT be marked human-accepted until the Task 9 run records `accepted_by_human = true` under the public evidence schema.

### Slice E: Deterministic E2E

Build the repeatable local acceptance harness. It prepares only public infrastructure: Anvil, an ERC-8004 Registry, test funding, a Profile-compatible fixture, Demo deployment inputs, Repository/DA mirrors, and Fake Chat transport.

Runtime state belongs under an ignored per-run directory such as:

```text
.tas-e2e/<run-id>/
├── chain/
├── repository/
├── chat/
└── actors/
    ├── contributor-a/
    ├── contributor-b/
    └── evaluator/
```

Actor directory labels describe scenario roles, not preassigned Agent IDs. The Evaluator first self-registers through identity setup and reveals only its public `agentId`; only then may the harness deploy the Demo using that ID. All three actors subsequently self-register or load their identities, self-join the Profile, and start separate member TAS processes.

The deterministic scenario runs at least three rounds. It restarts one Contributor before round two and the Evaluator before round three, preserves authoritative Chain, DA, and Chat state, and exercises both happy paths and invalid operations.

**Exit gate:** a single repeatable test entry point completes the three-round scenario from a clean environment, also passes a preserved-state recovery run, and leaves no tracked or untracked runtime artifacts outside ignored runtime areas.

### Slice F: Subagent Usability

Run two Contributor Subagents and one Evaluator Subagent against the same local acceptance environment. They receive only the applicable Bootstrap input, public locators, the four loaded Skill layers, and scenario messages delivered through the Fake Chat path where Chat behavior is under test.

Every Subagent must create or load its own wallet, self-register its ERC-8004 identity, self-register its Profile membership, start its own TAS instance, load TAS, Collaboration, Root, and appropriate Role Skills, and perform its own Workflow operations. The harness may observe and repair infrastructure, but it may not supply secrets, create identities, join membership, select operations, approve work, or submit business transactions for an Agent.

If an Agent requires hidden operational instructions, treat the result first as a Bootstrap, TAS, Collaboration, Root, Role, or MCP usability defect. Fix the responsible guidance or interface, rerun deterministic E2E, then restart the Subagent acceptance path from authoritative state.

**Exit gate:** the three Subagents complete at least three rounds, survive the required process restarts, recover through state inspection rather than blind replay, and finish without assistance beyond the published Skills and MCP-visible behavior.

### Slice G: Daily Contribution Integration

Replace the Demo inputs with the independent Daily Contribution repository, Profile, Workflow, and Role Skills. Integrate its Bot, rounds, Appeals, summaries, proof-dependent gates where applicable, and settlement behavior through the same general TAS surfaces.

**Exit gate:** Daily Contribution completes its accepted collaboration scenario without `daily.*`, Bot-specific, Appeal-specific, or other TAWG-specific logic entering TAS Core.

### Deferred: Live Adapters and Distribution

The following work begins only after the local vertical slice is stable:

- live Telegram and Discord SDK bindings and external-environment tests;
- Fede's concrete Proof Provider adapter and its external integration tests;
- public testnet validation;
- formal npm publication;
- a reference Host Adapter and additional thin Host Adapters; and
- broader release and platform packaging.

Deferred adapters must preserve the production schemas and internal boundaries proven by Slice D. Host Adapters may locate and start TAS, register MCP, install the Bootstrap Skill, and connect Host-specific approval or notification hooks, but they must not fork TAS Core or package an alternative TAS Skill.

## 6. External Profile Dependency

The production TAWG Profile contract is specified in `docs/tawg/PROFILE.md` but is not implemented inside the TAS package. TAS consumes:

- a fixed Profile ABI;
- immutable chain fixtures for reader and resolver tests; and
- deployed addresses supplied by configuration or discovery input.

Local Anvil acceptance uses a Profile-compatible fixture that preserves the v0.1 membership invariants. It is test infrastructure, not the production Profile reference implementation. Production Profile deployment, governance deployment, and upgrade policy remain separate deliverables.

## 7. Cross-Slice Release Gates

Every slice must satisfy all applicable gates before dependent work begins:

1. Type checking, tests, and production build pass from a clean dependency install.
2. MCP tools conform to `docs/tas/MCP.md`, including stable error codes and snapshot metadata.
3. Secrets never appear in standard output, logs, errors, snapshots, fixtures, or persisted TAS state.
4. Identity setup owns only one short-lived Identity Registry context; TAWG setup owns one short-lived TAWG context and no member state; a member TAS owns exactly one configured TAWG and ERC-8004 Agent identity.
5. A second process cannot claim the same member instance directory.
6. TAS holds no parallel authority for Agent credentials, Host-maintained Chat cursors, approvals, automation grants, accepted work, Git working state, per-call transaction Accounts, business retries, or global operation IDs.
7. An Agent performs its own ERC-8004 registration, Profile registration or update, and Workflow-authorized business transactions. Tests and Hosts may observe but not impersonate it.
8. Generated Manifests are reproducible, reviewed artifacts and match the installed dependency or adapter version.
9. Workflow source verification succeeds against deployed runtime code before source is returned as operational guidance or Workflow operations are enabled.
10. Unknown side-effect results are recovered by reading authoritative state; TAS does not automatically replay transactions or maintain a retry journal.
11. The Demo and Daily Contribution use only general TAS interfaces.
12. Documentation changes accompany every externally visible behavior change.

## 8. Legacy Go Scaffold

The existing Go scaffold remains untouched while the TypeScript vertical slice is under construction so unrelated work is not destroyed. It may be removed only after Slices A through F pass the complete local acceptance suite and the removal is reviewed as a separate change.
