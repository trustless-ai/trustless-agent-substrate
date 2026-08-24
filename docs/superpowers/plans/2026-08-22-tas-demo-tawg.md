# TAS Demo TAWG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Use TDD for every contract behavior.

**Goal:** Add a minimal, developer-readable TAWG under `tawg/demo/` that supports self-registered Contributors, one immutable Evaluator Agent, multiple contribution rounds, deterministic scoring settlement, and cumulative on-chain points.

**Architecture:** The Demo is an ERC-8301 Workflow consumer, not a TAS extension. It records DA references and digests, authenticates Agent IDs through the Profile-selected ERC-8004 Registry, represents actions as Workflow replies, and uses a local pass-through verifier only for steps that intentionally require no external proof. Role Skills explain how Agents operate the contract through general TAS tools.

**Tech Stack:** Solidity `0.8.30`, Foundry, the exact reviewed vendored `agent-ercs` interface sources, a dependency-free local test base, and Markdown Role Skills.

**Spec:** `docs/superpowers/specs/2026-08-22-tas-demo-vertical-slice-design.md` Sections 6-7 and `docs/tawg/WORKFLOW.md`.

## Global Constraints

- The entire example lives below `tawg/demo/` except shared E2E fixtures added by later plans.
- Treat `tawg/demo/` as the contents of a standalone TAWG Repository template. E2E copies its children to a mirror root; do not add a TAS Repository subdirectory override.
- Do not add a TAS Core import, Demo MCP namespace, or scenario switch.
- Every state-changing Agent action authenticates the supplied ERC-8004 `agentId` against its current Authentication Wallet.
- Profile membership is checked when an action is submitted, not assumed from deployment.
- The Evaluator `agentId` is immutable and cannot be transferred or replaced by Workflow governance.
- Contribution content stays in DA; the Workflow stores its immutable reference encoding and digest.
- Every business record has an on-chain query surface sufficient for recovery and recompute.
- The Demo has no timer, Appeal, Bot, Proof Provider, ERC-20, or external asset settlement.
- A pass-through verifier may mark intentionally proof-free ERC-8301 replies as proven, but it must not be described as an evaluation proof.
- Compiler source, settings, metadata, and deployed-bytecode verification material must be reproducible.
- A clean checkout must build without a sibling `agent-ercs` checkout. Vendor only the required upstream interface sources with exact provenance and file digests; do not vendor an implementation or silently fall back to another revision.

## Planned File Structure

```text
tawg/demo/
├── README.md
├── foundry.toml
├── remappings.txt
├── charter/
│   └── README.md
├── knowledge/
│   └── README.md
├── data/
│   └── .gitkeep
├── contracts/
│   ├── Workflow.sol
│   ├── Workflow.metadata.json
│   └── PassThroughVerifier.sol
├── vendor/agent-ercs/
│   ├── PROVENANCE.json
│   └── contracts/
│       ├── execution/ERC8301/IAgentWorkflow.sol
│       └── verify/ERC8274/IAgentVerifier.sol
├── skills/
│   ├── SKILL.md
│   └── roles/
│       ├── contributor.md
│       └── evaluator.md
└── test/
    ├── TestBase.sol
    ├── Workflow.registration.t.sol
    ├── Workflow.contribution.t.sol
    ├── Workflow.rounds.t.sol
    └── Workflow.erc8301.t.sol
```

## Task 1: Scaffold the Developer Example and Role Contracts

**Files:**

- Create: `tawg/demo/README.md`
- Create: `tawg/demo/.gitignore`
- Create: `tawg/demo/foundry.toml`
- Create: `tawg/demo/remappings.txt`
- Create: `tawg/demo/charter/README.md`
- Create: `tawg/demo/knowledge/README.md`
- Create: `tawg/demo/data/.gitkeep`
- Create: `tawg/demo/contracts/.gitkeep`
- Create: `tawg/demo/skills/SKILL.md`
- Create: `tawg/demo/skills/roles/contributor.md`
- Create: `tawg/demo/skills/roles/evaluator.md`
- Create: `tawg/demo/vendor/agent-ercs/PROVENANCE.json`
- Create: `tawg/demo/vendor/agent-ercs/contracts/execution/ERC8301/IAgentWorkflow.sol`
- Create: `tawg/demo/vendor/agent-ercs/contracts/verify/ERC8274/IAgentVerifier.sol`
- Create: `tawg/demo/test/TestBase.sol`
- Create: `test/conformance/demoLayout.test.ts`
- Create: `test/conformance/demoDependencies.test.ts`

- [ ] **Step 1: Write the failing layout conformance test**

Assert that `tawg/demo` contains the canonical `charter/`, `knowledge/`, `data/`, `contracts/`, and `skills/` repository roots, the two accepted Role Skills, and no third role. Task 1 does not create Solidity sources, so Task 2 begins from a real missing-contract RED. The persistent layout conformance rule is a recursive allowlist for only the planned `Workflow.sol` and `PassThroughVerifier.sol` names; it does not permanently require `contracts/` to remain empty. Assert the Role Skills do not reference `demo.*` MCP tools and identify ERC-8004 `agentId` unambiguously.

Assert `PROVENANCE.json` pins `trustless-ai/agent-ercs` commit `00605871ff33e80ff21804e5d1cd1ba5fa1c2d68`. Require SHA-256 `e551dc81859c03828a55b116ee70720b8c60edfb261f6880c37317ca3bc7ca9e` for `IAgentWorkflow.sol` and `115942e5c66f76e8447f9cae51f80d6820a09c22609022bcd8443455b49baa36` for `IAgentVerifier.sol`. Reject any other vendored Solidity source. `TestBase.sol` defines only the minimal Foundry cheatcode/assertion interfaces required by these tests, so the template needs no test-framework checkout.

- [ ] **Step 2: Run the focused test**

```bash
npm test -- test/conformance/demoLayout.test.ts test/conformance/demoDependencies.test.ts
```

Expected: FAIL because the Demo and its pinned interface sources do not exist.

- [ ] **Step 3: Create the minimum Charter and Role Skills**

Contributor guidance covers membership check, DA put/get, deterministic contribution ID, submission, Evaluator mention, score lookup, round state, and restart recovery. Evaluator guidance covers event discovery, DA inspection, score-once behavior, settlement, next-round opening, completion, and notifications.

Copy the two pinned upstream interface files byte-for-byte, record their source URL/commit/path/digest/license in `PROVENANCE.json`, and map `@agent-ercs/` to `vendor/agent-ercs/contracts/` in `remappings.txt`.

- [ ] **Step 4: Verify and commit the scaffold**

```bash
npm test -- test/conformance/demoLayout.test.ts test/conformance/demoDependencies.test.ts
git diff --check
git add tawg/demo test/conformance/demoLayout.test.ts test/conformance/demoDependencies.test.ts
git commit -m "docs: scaffold Demo TAWG roles"
```

## Task 2: Implement the Pass-through Verifier and Workflow Read Model

**Files:**

- Create: `tawg/demo/contracts/PassThroughVerifier.sol`
- Create: `tawg/demo/contracts/Workflow.sol`
- Create: `tawg/demo/test/Workflow.erc8301.t.sol`

- [ ] **Step 1: Write failing ERC-8301 interface tests**

Assert `run`, `result`, `getAgentTask`, `getAgentReply`, `onAgentReply`, and `onAgentProve` satisfy the pinned ERC-8301 ABI. Assert unknown task/reply/run queries fail with explicit custom errors and that proof-free replies record the pass-through verifier address and `proven = true`.

- [ ] **Step 2: Run the focused contract test**

```bash
forge test --root tawg/demo --match-path test/Workflow.erc8301.t.sol -vvv
```

Expected: FAIL because both contracts are missing.

- [ ] **Step 3: Implement the minimum ERC-8301 storage and hashing**

Use the exact task and reply hash formulas from the installed ERC-8301 interface. Store task/reply records and proof fields. Route intentionally proof-free action replies through an internal pass-through result instead of fabricating external Provider evidence.

- [ ] **Step 4: Verify and commit**

```bash
forge test --root tawg/demo --match-path test/Workflow.erc8301.t.sol -vvv
git add tawg/demo/contracts tawg/demo/test/Workflow.erc8301.t.sol
git commit -m "feat: establish Demo ERC-8301 workflow"
```

## Task 3: Enforce Membership, Authentication, and Contribution Identity

**Files:**

- Modify: `tawg/demo/contracts/Workflow.sol`
- Create: `tawg/demo/test/Workflow.registration.t.sol`
- Create: `tawg/demo/test/Workflow.contribution.t.sol`

- [ ] **Step 1: Write failing authentication tests**

Cover:

1. unregistered ERC-8004 ID;
2. registered identity that is not a Profile member;
3. member called by a wallet other than its current Authentication Wallet;
4. successful member submission;
5. wallet rotation followed by successful use of the new wallet and rejection of the old wallet; and
6. malformed/empty DA reference or zero digest.

- [ ] **Step 2: Write failing contribution-identity tests**

Require:

```text
contributionId = keccak256(tawgAddress, roundId, contributorAgentId, daDigest)
```

Reject a caller-supplied ID that does not match, duplicate submission of the same ID, submission to another round, submission after settlement, and mutation after completion.

- [ ] **Step 3: Implement Profile/Registry reads and contribution storage**

Store contributor Agent ID, round ID, DA reference bytes, digest, submit reply hash, score state, and score. Expose paginated or indexed on-chain queries sufficient to enumerate a round and retrieve one contribution without event-only reconstruction.

- [ ] **Step 4: Verify and commit**

```bash
forge test --root tawg/demo --match-path test/Workflow.registration.t.sol -vvv
forge test --root tawg/demo --match-path test/Workflow.contribution.t.sol -vvv
git add tawg/demo/contracts/Workflow.sol tawg/demo/test/Workflow.registration.t.sol tawg/demo/test/Workflow.contribution.t.sol
git commit -m "feat: accept authenticated Demo contributions"
```

## Task 4: Implement Evaluation, Settlement, and Multiple Rounds

**Files:**

- Modify: `tawg/demo/contracts/Workflow.sol`
- Create: `tawg/demo/test/Workflow.rounds.t.sol`

- [ ] **Step 1: Write failing Evaluator tests**

Assert the fixed `evaluatorAgentId` is immutable. Only its current Authentication Wallet may score, settle, open the next round, or complete the Workflow. Reject a duplicate score and an unknown contribution.

- [ ] **Step 2: Write failing settlement tests**

Cover at least three rounds and assert:

1. settlement requires one scored contribution;
2. settlement credits only scored contributions in that round;
3. cumulative points equal the sum of settled round scores;
4. a round settles once;
5. the next round opens only after settlement;
6. round IDs increase deterministically and do not reuse contribution IDs; and
7. completion is permanent and requires a settled current round.

- [ ] **Step 3: Implement score and round transitions**

Keep `score` as an unrestricted `uint256` for the Demo and store exact per-round/per-Agent totals before updating cumulative points. Emit events for contribution submission, score recording, round settlement, next-round opening, and permanent completion while preserving queryable storage as the authority.

- [ ] **Step 4: Run the complete contract suite and commit**

```bash
forge test --root tawg/demo -vvv
git add tawg/demo/contracts/Workflow.sol tawg/demo/test/Workflow.rounds.t.sol
git commit -m "feat: settle multi-round Demo points"
```

## Task 5: Add Reproducible Compilation and Deployment Guidance

**Files:**

- Modify: `tawg/demo/foundry.toml`
- Modify: `tawg/demo/.gitignore`
- Create: `tawg/demo/contracts/Workflow.metadata.json`
- Create: `tawg/demo/script/Deploy.s.sol`
- Create: `tawg/demo/test/Deploy.t.sol`
- Modify: `tawg/demo/README.md`
- Create: `test/conformance/demoMetadata.test.ts`
- Create: `test/conformance/demoCleanCheckout.test.ts`
- Modify: `test/conformance/demoLayout.test.ts`

- [ ] **Step 1: Write the failing metadata test**

Assert a fresh artifact's `rawMetadata` exactly equals the checked file plus its single final LF. Check exact compiler build `0.8.30+commit.73712a01`, `contracts/Workflow.sol:Workflow`, optimizer, Cancun EVM, non-IR pipeline, empty libraries, IPFS/CBOR metadata, output, source-unit names, and every source Keccak. Compiler metadata records source bytes and settings; the exact upstream revision remains in `vendor/agent-ercs/PROVENANCE.json` and is cross-checked there rather than added to compiler metadata.

Pin Foundry to Solidity 0.8.30 with auto-detection off, optimizer 200, Cancun, `via_ir = false`, IPFS bytecode hash, CBOR enabled, FFI off, automatic remapping detection off, and only the checked `remappings.txt`. Reject absolute and parent-directory paths. Assert runtime bytecode retains the Solidity IPFS/CBOR trailer.

The clean-copy test walks only `tawg/demo/` using Node filesystem APIs, rejects links and non-regular files, omits `out/`, `cache/`, and `broadcast/`, validates provenance SHA-256 and metadata source Keccak before compilation, and runs the complete Foundry suite in a temporary directory. It invokes reviewed system `forge` directly through `execFileSync('forge', argumentArray)` with `--offline`, `--force`, and a timeout; it executes no Repository script, package hook, RPC call, FFI, shell, parent TAS file, or sibling checkout. Compare fresh metadata and runtime trailer, then remove the temporary copy.

- [ ] **Step 2: Implement deterministic deployment sequencing**

The Evaluator identity already exists before deployment and has a nonzero current ERC-8004 Authentication Wallet. A one-shot factory rejects an invalid Registry or identity, deploys the pass-through verifier as child CREATE nonce 1, predicts the Profile fixture at child nonce 3, deploys Workflow at nonce 2 with that immutable Profile address and Evaluator ID, and deploys the narrow Profile fixture at nonce 3. Fail if prediction or any cross-reference/code invariant differs, and reject reuse of the same factory.

The fixture starts with no members, makes no production Profile or ERC-165 claim, and exposes only the reads required by the Demo plus live-wallet self-registration. It never pre-registers or impersonates an Agent. The Evaluator supplies a deployed Agent verifier, self-registers from its current Authentication Wallet, and opens the initial round itself. Deployment tests bind the helper verifier's deployed runtime code separately from Workflow metadata.

- [ ] **Step 3: Generate and verify compiler material**

```bash
forge clean --root tawg/demo
forge build --root tawg/demo --offline --force
npm test -- test/conformance/demoMetadata.test.ts
forge test --root tawg/demo --match-path test/Deploy.t.sol -vvv
forge test --root tawg/demo --offline --force -vvv
npm test -- test/conformance/demoCleanCheckout.test.ts
```

- [ ] **Step 4: Document the example and commit**

Explain the contract roles, multi-round state/evidence flow, deployment inputs and CREATE order, self-registration boundary, DA reference, proof-free verifier scope, source/metadata authority, helper-code binding, and general TAS namespaces. Do not present E2E-only injection as product behavior or the fixture as the future Profile.

Also explain that a developer copies the contents of `tawg/demo/` into the root of a new TAWG Repository so the canonical `charter/`, `contracts/`, `skills/`, and `data/` paths remain unchanged.

```bash
git add tawg/demo test/conformance/demoMetadata.test.ts test/conformance/demoCleanCheckout.test.ts
git commit -m "docs: complete reproducible Demo TAWG"
```

## Completion Criteria

1. The Demo is understandable without reading TAS implementation code.
2. Its contract implements the pinned ERC-8301 interface and query surfaces.
3. Membership and authorization follow current ERC-8004 Authentication Wallets.
4. One immutable Evaluator scores and controls round transitions.
5. At least three rounds settle into reproducible cumulative points.
6. All invalid transitions have focused tests and explicit errors.
7. Compiler metadata can reproduce the deployed runtime bytecode.
8. Role Skills use only general TAS interfaces.
9. The copied standalone template builds and tests from a clean directory using only its committed pinned interface sources.
