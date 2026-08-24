# Task 2 brief — Demo ERC-8301 read model

## Goal

Implement Task 2 of `docs/superpowers/plans/2026-08-22-tas-demo-tawg.md` with strict Solidity TDD: one directly deployed ERC-8301 Workflow foundation and one explicitly proof-free pass-through ERC-8274 verifier. Do not implement contribution, membership, scoring, settlement, or rounds yet.

## Owned files

- `tawg/demo/contracts/Workflow.sol`
- `tawg/demo/contracts/PassThroughVerifier.sol`
- `tawg/demo/test/Workflow.erc8301.t.sol`
- demonstrated additions only to `tawg/demo/test/TestBase.sol`
- Task 2 SDD report/progress

## Required behavior

1. Write failing Foundry tests before either contract exists. Record the missing-contract RED.
2. Implement the exact vendored `IAgentWorkflow` ABI: `run`, `result`, `getAgentTask`, `getAgentReply`, `onAgentReply`, and `onAgentProve`.
3. Use the exact ERC-8301 task/reply hash formulas from the vendored interface. Never use `abi.encode` where the nested previous-hash term requires `keccak256(abi.encodePacked(array))`.
4. Distinguish unknown run/task/reply records with explicit custom errors; do not infer existence from ambiguous default fields alone.
5. `run` creates a deterministic unique run and one initial stored/announced task with empty previous replies and `proven = true`. Validate the input commitment. Keep the run pending; later tasks own completion.
6. `onAgentReply` requires `reply.replier == msg.sender`, exact output commitment, one known/proven previous task in the same run, nonfuture execution time, and an unexpired task. Reject duplicate hashes. Store the full reply.
7. Every Demo Task 2 reply is intentionally proof-free. It is verified immediately through the immutable `PassThroughVerifier`, stores that verifier, `proven = true`, and a nonzero deterministic verification digest. This is bookkeeping for an intentionally ungated reply, never evidence of evaluation quality.
8. `PassThroughVerifier` implements exact `IAgentVerifier.verify`, returns `true`, produces a deterministic digest from the documented fields and its own verifier identity, and emits `VerificationCompleted`. It must not inspect or claim a cryptographic proof.
9. `onAgentProve` remains ABI-conforming. In the Task 2 proof-free model, an anchored reply is already proven; reject unknown, malformed batches, and already-proven submissions explicitly. Do not invent a Proof Provider.
10. Use a future-compatible constructor with immutable `profile`, `passThroughVerifier`, and `evaluatorAgentId`; only enforce configuration invariants available before Profile deployment (the deployment plan may pass a predicted nonzero Profile address). Do not read Profile membership in this task.
11. Keep reusable internal task/reply storage helpers suitable for Tasks 3-4 without adding their business behavior. Direct deployment only; no proxy/delegatecall.
12. Add no external package or unreviewed Solidity source. Imports must resolve only through the pinned vendored interfaces.
13. Run the focused Foundry test, the complete Demo Foundry suite, Demo conformance tests, typecheck, and diff check. Remove/ignore generated Foundry output. Do not commit.

## Security invariants

- Reject a zero/non-contract pass-through verifier.
- Use check-effects-interactions plus a narrow verifier-call reentrancy guard.
- Never mark a reply proven unless the configured verifier returned true.
- Verifier return data and digest are recorded but never described as an evaluation proof.
- No arbitrary verifier supplied by a caller.

## Collaboration

You are not alone in the codebase. Own only the files above, do not revert others, do not commit, and do not spawn subagents.

## Report

Write `.superpowers/sdd/2026-08-22-tas-demo-tawg/task-2-report.md` with RED/GREEN evidence, ABI/hash choices, proof-free scope, verification commands, and concerns.
