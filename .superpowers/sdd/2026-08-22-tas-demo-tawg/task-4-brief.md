# Task 4 brief — Demo evaluation, settlement, and rounds

## Goal

Implement Task 4 of `docs/superpowers/plans/2026-08-22-tas-demo-tawg.md` with strict Solidity TDD. The immutable Evaluator Agent scores contributions once, settles the current round deterministically into per-round and cumulative points, then either opens the next round or permanently completes the Demo. Exercise at least three linked rounds. Do not add a timer, Appeal, Bot, ERC-20, external assets, or Proof Provider.

## Owned files

- Modify `tawg/demo/contracts/Workflow.sol`
- Modify demonstrated helpers in existing Demo tests only as needed
- Create `tawg/demo/test/Workflow.rounds.t.sol`
- Update `tawg/demo/skills/roles/evaluator.md`
- Update Contributor guidance only if current-round behavior changes its instructions
- Update Demo README state description when needed
- Task 4 SDD report/progress

## Global and round state

1. The Demo has one global state: Active or permanently Completed.
2. Each ERC-8301 `workflowRunId` is one round ID. A round is Open or Settled.
3. Expose the current round ID and storage-backed round view. Only the current ERC-8004 Authentication Wallet of the immutable Evaluator may call the first `run` and start the initial round. Validate the input commitment and future expiry, then authenticate that live wallet, before consuming the one-time initial-round latch; a failed attempt must not consume it. A second successful external `run` is forbidden; later rounds can only be opened through the Evaluator transition action.
4. The immutable `evaluatorAgentId` cannot be replaced. Every Evaluator action resolves that exact Agent's current Profile membership and current ERC-8004 Authentication Wallet at submission time. Wallet rotation must require no Workflow update.
5. Contributions are accepted only for the current Open round. A settled, non-current, or globally completed Workflow cannot accept them.

## Stages and evidence chain

Use explicit developer-defined ERC-8301 stages at minimum:

- `Collect`: the round's initial task for Contributor actions;
- `ScoreContribution`: one task created from each proven contribution reply;
- `SettleRound`: the latest gate task created from each proven score reply;
- `RoundTransition`: the terminal task created from the proven settlement reply.

Maintain a monotonic `taskSeq` per run. Every derived task stores the reply hash that caused it in `prevReplyHashes`, has an exact input commitment, is announced through `NewAgentTask`, and is `proven` iff its prerequisite reply is proven.

One current settlement gate is sufficient. After every accepted score, update the round's deterministic score root and create a new `SettleRound` task whose input commits to `(roundId, scoreRoot, scoredCount, totalScore)` and whose sole previous reply is that score reply. Older settle tasks remain queryable but are no longer valid transition gates.

## Canonical actions

Keep `SubmitContribution = 0` and add canonical action envelopes routed only through `onAgentReply`:

```solidity
abi.encode(ActionKind.ScoreContribution, evaluatorAgentId, roundId, contributionId, score)
abi.encode(ActionKind.SettleRound, evaluatorAgentId, roundId, expectedScoreRoot)
abi.encode(ActionKind.OpenNextRound, evaluatorAgentId, settledRoundId)
abi.encode(ActionKind.CompleteWorkflow, evaluatorAgentId, settledRoundId)
```

Every payload must be byte-for-byte canonical for its exact static shape. Unsupported action values return `UnsupportedAction`; malformed encodings return `MalformedAction`. Do not add parallel business mutation functions or a Demo MCP namespace.

Action/task binding:

- `ScoreContribution` targets that contribution's current `ScoreContribution` task.
- `SettleRound` targets the round's latest `SettleRound` task and must match the current score root.
- `OpenNextRound` and `CompleteWorkflow` target the settled round's `RoundTransition` task.

All four actions are intentionally proof-free in this Demo and use the immutable pass-through verifier with the canonical full ERC-8004 Evaluator Agent ID. This records the declared no-external-proof gate; it is not proof that the score is correct.

## Scoring

1. Only the current Authentication Wallet of `evaluatorAgentId` may score.
2. Reject an unknown contribution, a contribution outside the current Open round, an incorrect score task, and a second score.
3. `score` remains unrestricted `uint256`, including zero, exactly as accepted in the implementation plan.
4. Store `scored`, exact `score`, and `scoreReplyHash` on the contribution before exposing it as evaluated.
5. Update the deterministic score root in score-acceptance order:

   ```text
   nextScoreRoot = keccak256(abi.encode(previousScoreRoot, contributionId, score, scoreReplyHash))
   ```

6. Track scored count and total score with Solidity checked arithmetic.

## Settlement and points

1. Settlement requires the current Open round and at least one scored contribution.
2. The action's `expectedScoreRoot` must equal the live round score root.
3. Anchor and prove the settlement reply before applying settlement effects.
4. Settle exactly once. Iterate the round's authoritative contribution ID list; credit only scored contributions.
5. Store exact per-round points per Agent and add the same values to cumulative points. Multiple contributions by one Agent aggregate deterministically. Zero scores remain valid scored records and add zero points.
6. Store round settled time, total score, settlement reply hash, and terminal transition task hash. Mark the ERC-8301 run `Success`, return that terminal hash/time from `result`, and emit `WorkflowCompleted` exactly once for the round.
7. Queries expose round status/counts/root/totals/task hashes, per-round Agent points, and cumulative Agent points without relying on events.

## Next round and completion

1. From the current Settled round, the Evaluator may submit exactly one transition reply:
   - `OpenNextRound` anchors the transition reply, derives a unique deterministic next run ID, creates its initial Collect task, and makes it current; or
   - `CompleteWorkflow` anchors the transition reply and permanently marks the global Workflow completed.
2. The next run ID must include the Workflow domain, chain, monotonic run sequence, and previous round ID so the round chain is independently recomputable. Use no wall-clock timer to trigger it.
3. A settled round cannot be reopened. A new round cannot open before settlement. Completion cannot occur before settlement. After completion, every business mutation and external `run` fails permanently.
4. Historical rounds, tasks, replies, contributions, scores, points, results, and transitions remain queryable.

## TDD matrix

Write failure-first tests covering at minimum:

- immutable Evaluator ID and current-wallet authorization for every action;
- Evaluator wallet rotation;
- score unknown contribution, wrong round/task, and duplicate score;
- stable full ERC-8004 Evaluator ID in verifier event/digest;
- settlement with no score, wrong root, wrong/latest task, duplicate settlement, and non-Evaluator settlement;
- exact score root, per-round points, cumulative points, zero score, and multiple contributions for one Agent;
- three complete rounds with deterministic unique IDs and no contribution-ID reuse;
- next round before settlement and second transition from one settled round;
- completion before settlement and permanent post-completion rejection;
- exact `result`/terminal task/`WorkflowCompleted` semantics;
- canonical and malformed action encodings for every new action;
- full Task 2/3 regression and ABI conformance.

## Security constraints

- Never cache an Authentication Wallet or accept caller-supplied identity authority.
- Check action, task, run, round, role, duplicate, and state gates before external verifier interaction.
- Preserve the narrow verifier-call reentrancy guard and atomic rollback.
- Mark scores, settlement, transitions, points, and run completion only after the corresponding reply is proven.
- Set state before any loop whose later failure must roll the transaction back; no external calls occur inside settlement aggregation.
- Do not call arbitrary member verifiers or add a caller-selected verifier.
- No unbounded historical scan in read methods; settlement's bounded-by-transaction round iteration is explicit Demo behavior and must be documented as non-production scalability guidance.

## Verification and review

Run the focused rounds suite, all Demo Foundry suites, ABI/layout/dependency conformance, formatting/build/size, TypeScript typecheck, and diff check. Remove generated `out/` and `cache/`. Obtain independent Solidity/spec and security reviews before commit.

## Collaboration

The worker owns only the files listed above, is not alone in the repository, must not revert others, must not commit, and must not spawn subagents.
