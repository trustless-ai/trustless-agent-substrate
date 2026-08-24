# Task 8 report — Slice A identity-to-TAWG-to-member onboarding

## Outcome

Task 8 is implemented and ready for controller review. The deterministic local-Anvil integration path proves Agent-owned ERC-8004 registration, Registry-wallet establishment, Profile membership, restart reconciliation, second-Agent discovery, and member startup entirely through TAS MCP tools. No Agent key is stored in the repository, fixture, test snapshot, package, or TAS state.

## RED / GREEN

- RED: `chainOnboarding.test.ts` first failed because the deterministic contract fixtures did not exist. The completed behavioral test defines the actual path: Anvil and contracts are harness-owned, while each Agent wallet is generated after TAS startup and every identity/member operation reaches the chain through MCP `workflow.chain.*` tools.
- RED: the first live execution exposed a direct harness deployment client missing a chain definition. The harness was corrected to use Anvil's default unlocked JSON-RPC account, not a generated/private deployment key passed to Anvil.
- GREEN: system `solc 0.8.30` compiled the fixture Solidity outside the repository. The checked-in ABI/bytecode constants now have reviewable source plus exact source/compiler digests and generation instructions; tests never invoke the compiler. The live test passes through identity setup, restart/reconcile, two isolated TAWG-setup processes, and member TAS.
- RED: the Slice A package gate initially timed out because `npm pack --dry-run` invokes `prepack`. The test declares the bounded package gate timeout; it then passes with Manifest checking, package inventory checks, and fixture/built-text scanning.
- RED: review assertions proved the original path never called `skill.tas.get`, reused the evaluator's TAWG-setup process for the contributor, and did not restart after an unknown Profile-write outcome. The reviewed harness now makes each process boundary and call observable and passes those assertions.
- RED: package conformance failed while the reviewable Solidity source and provenance README were absent. Both are now present and explicitly excluded from npm output.

## Evidence covered

1. Identity setup exposes exactly the TAS Skill plus all reviewed generated viem groups and no Profile tools.
2. Every identity-setup, TAWG-setup, and member startup calls `skill.tas.get` and verifies the release package plus non-empty TAS Skill body. The evaluator Agent creates its own ephemeral key after TAS starts, registers over MCP, bounded-polls its receipt over MCP, decodes `Registered`, and records a canonical decimal `agentId` greater than `Number.MAX_SAFE_INTEGER`.
3. MCP reads confirm `ownerOf` and the initially zero Registry wallet. A TAS restart reconciles `registrationCount` through public Chain reads without an automatic duplicate write.
4. The harness deploys the Profile only after receiving the evaluator's public `agentId`. It deploys infrastructure only; it never submits an Agent-authorized identity or membership transaction.
5. TAWG setup reads the immutable Registry and confirms a nonmember. The zero-wallet Profile write returns `OPERATION_OUTCOME_UNKNOWN`; the Agent closes and restarts its TAWG-setup TAS, reconciles `profile.get_agent` as still false, then establishes its Registry wallet and self-registers. Every successful write retains its hash and uses a bounded Agent-side MCP receipt-polling helper before dependent work.
6. Re-registering an existing member returns `OPERATION_OUTCOME_UNKNOWN` rather than causing TAS replay. A second Agent starts its own TAWG-setup TAS with only the Profile locator, gets the Registry from its own `profile.get`, and uses only that discovered address for identity and membership operations. Zero and nonzero EOA/no-code verifier addresses both fail; `profile.get_agent` remains false before the deployed verifier succeeds. Its identity, wallet-establishment, and member-registration hashes are all bounded-polled to successful receipts.
7. Member TAS exposes the fixed Slice A plus generated inventory. A wrong key is rejected as `WALLET_MISMATCH`; the correct key signs once, and the following credential-less call returns `CREDENTIAL_REQUIRED`. After sensitive operations, the test recursively scans regular text under its temporary config/state root and proves the evaluator, contributor, and wrong keys are absent.
8. The package gate runs `manifest:check`, requires only the three shipped Manifest artifacts, confirms all contract fixtures including Solidity source/provenance are excluded from npm output, and scans fixture and built JavaScript text for credential-bearing assignments and authenticated endpoints.

Anvil teardown is bounded: it waits after `SIGTERM`, escalates to `SIGKILL` if needed, and destroys all child stdio streams.

## Documentation

`README.md`, `docs/PROJECT_STRUCTURE.md`, and `docs/tas/IMPLEMENTATION.md` now describe Slice A as complete, list actual inventories, specify `npm run manifest:check`/`npm run manifest:generate`, and state Agent-owned wallet, `agentId`, transaction-handle, replay, and reconciliation responsibilities. Chat and Proof Provider remain explicit later-slice reservations.

## Verification

```text
npm test -- test/integration/chainOnboarding.test.ts test/conformance/sliceAPackage.test.ts
  2 files passed, 2 tests passed

npm run typecheck
  passed

npm ci && npm run manifest:check && npm test
  clean install passed; Manifests current; 32 files / 651 tests passed

npm run test:coverage
  statements 88.16%; branches 85.44%; functions 98.88%; lines 94.66%

npm run build && npm pack --dry-run --json
  passed; 64 package files

npm audit --omit=dev
  0 vulnerabilities

git diff --check
  passed
```

Independent TypeScript/specification and security re-reviews both approved the final changes with no remaining findings. This task report does not itself commit.
