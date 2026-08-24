# Task 4 report — Demo evaluation, settlement, and rounds

## Result

Task 4 is implemented without a commit. The Demo now has one immutable ERC-8004 Evaluator, a linked ERC-8301 task/evidence chain, deterministic score roots, latest-settlement gates, per-round and cumulative points, deterministic round chaining, and permanent completion.

The implementation does not add a timer, Appeal, Bot, ERC-20, external asset, Proof Provider, Demo-specific MCP surface, or Task 5 deployment metadata.

## RED evidence

`Workflow.rounds.t.sol` was written before production changes. The first focused run failed at the first missing Task 4 production type:

```text
Identifier not found or not unique:
Workflow.Stage
Compilation failed
```

The initial suite then reached 10 passing Task 4 tests. Protocol review added three stronger requirements before completion:

1. a next-round Collect task must be an ERC-8301 initial task with no previous replies;
2. latest Settle and RoundTransition gates must not expire with the collection window; and
3. an already-scored round must still be settleable after that window expires.

The resulting RED was exact:

```text
7 passed, 4 failed
testScoreStoresRootLatestGateAndFullEvaluatorIdentityOnce: AssertionFailed
testScoredRoundCanSettleAfterCollectWindowExpires: TaskExpired
testSettlementAggregatesExactRoundAndCumulativePointsAndTerminalResult: AssertionFailed
testThreeRoundsHaveDeterministicChainUniqueContributionsAndCumulativePoints: AssertionFailed
```

Settle and transition tasks now use `type(uint256).max`. A next round's sequence-zero Collect task has `prevReplyHashes=[]`; its input retains `(previousRoundId, transitionReplyHash)`, while the next run ID also commits to the previous round.

Independent review then identified that the initial external `run` was not yet bound to the immutable Evaluator's live Authentication Wallet. Two failure-first regressions demonstrated the issue: an arbitrary caller and the Evaluator's rotated-out wallet could each open the initial round. The fix validates the input commitment and future expiry, authenticates the Evaluator against the live Profile/ERC-8004 registry, and only then consumes the initial-run latch. A rejected caller cannot consume that latch. A third regression proves that the current wallet succeeds and that the resulting run ID commits to the actual Evaluator caller.

Two additional state-order regressions prove that contributions and scores against a settled current round fail with `RoundNotOpen`, while the same operations against that historical round after a transition fail with `RoundNotCurrent`.

The first full regression identified three expected Task 4 semantic changes rather than production regressions: action value `1` became supported, and a second external `run` became forbidden. The Task 3 unsupported-action fixture now uses value `5`; the Task 2 foundation expects `InitialRoundAlreadyStarted` and uses a second Workflow instance to exercise ERC-8301 run mismatch.

No `via_ir`, compiler-setting change, or new dependency was used. One stack-too-deep compilation error was resolved by grouping contribution action fields in a local struct and splitting an oversized test.

## State and role model

The Workflow has global `Active` and permanently `Completed` states. Each ERC-8301 run is one `Open` or `Settled` round. `currentRoundId`, `getRound`, `roundPoints`, `cumulativePoints`, contribution enumeration, and the inherited run/task/reply queries recover all authoritative state without event dependence.

Only the immutable Evaluator's current Authentication Wallet can make the first successful external `run`. It creates the initial Open round and sequence-zero Collect task. Failed input, expiry, or authentication checks do not consume the opening latch. Later rounds can be created only by an authenticated `OpenNextRound` transition from the current Settled round. After global completion, every business reply and external `run` fails with `WorkflowIsCompleted`.

All Evaluator actions require the immutable full ERC-8004 `evaluatorAgentId`. Every action re-reads Profile membership and the current Authentication Wallet from the Profile-selected Registry. The wallet can rotate without a Workflow update. The pass-through verifier receives `bytes32(evaluatorAgentId)`, never the wallet.

## Canonical actions

All mutations remain routed through ERC-8301 `onAgentReply`:

```text
0 SubmitContribution(existing dynamic envelope)
1 ScoreContribution(evaluatorAgentId, roundId, contributionId, score)
2 SettleRound(evaluatorAgentId, roundId, expectedScoreRoot)
3 OpenNextRound(evaluatorAgentId, settledRoundId)
4 CompleteWorkflow(evaluatorAgentId, settledRoundId)
```

Each new action has an exact static ABI length and rejects appended, truncated, or otherwise malformed bytes with `MalformedAction`. Values above the implemented range return `UnsupportedAction(value)`. No parallel business mutation function exists.

## Task and evidence chain

Each round uses developer-defined stages:

```text
Collect
  -> proven contribution reply
ScoreContribution task
  -> proven score reply
latest SettleRound task
  -> proven settlement reply
RoundTransition task
  -> proven OpenNextRound or CompleteWorkflow reply
```

Every derived task has a per-run monotonic `taskSeq`, an exact stored input and commitment, the triggering reply as its sole `prevReplyHashes` entry, a `NewAgentTask` event, and proven state inherited from that already-proven reply. Every accepted score creates a new Settle task over:

```text
(roundId, scoreRoot, scoredCount, totalScore)
```

Older settle tasks remain queryable but cannot settle. Settle and RoundTransition tasks are long-lived gates. Score tasks inherit their Collect window. A new round's sequence-zero Collect task follows the ERC-8301 initial-task rule and has no previous replies; cross-round evidence remains explicit in its input and run ID.

## Scoring and settlement

A contribution can be scored once. The exact unrestricted `uint256` score, including zero, and score reply hash are stored only after verifier success. Score roots advance in acceptance order:

```text
keccak256(abi.encode(previousRoot, contributionId, score, scoreReplyHash))
```

Settlement requires the current Open round, at least one score, the latest Settle task, and the live score root. The settlement reply is anchored and proven before effects. The round is marked Settled before its contribution loop; that loop makes no external calls and credits only scored records. Scores for the same Agent aggregate into exact round points and cumulative points. Checked arithmetic and transaction rollback apply throughout.

Settlement creates the terminal RoundTransition task, stores settlement data, marks the ERC-8301 run `Success`, returns that task and timestamp from `result`, and emits inherited `WorkflowCompleted` exactly once for the round. The round contribution loop is intentionally bounded only by transaction capacity for this small Demo; the README warns production developers not to copy it for unbounded rounds.

## Round transitions

The current Settled round has one transition reply. It either opens a next round or permanently completes the Workflow. A round cannot transition twice and cannot be reopened.

Next run IDs are independently recomputable:

```text
keccak256(abi.encode(
  workflowAddress,
  block.chainid,
  monotonicRunSequence,
  previousRoundId
))
```

The tests execute three complete linked rounds, reuse the same DA digest safely across distinct round-scoped contribution IDs, settle scores `1`, `2`, and `3`, and observe cumulative points `6` before permanent completion.

## GREEN evidence

```text
forge test --root tawg/demo --match-path test/Workflow.rounds.t.sol -vv
Ran 16 tests: 16 passed, 0 failed

forge test --root tawg/demo -vv
Ran 53 tests across 4 suites: 53 passed, 0 failed

npm test -- test/conformance/demoLayout.test.ts test/conformance/demoDependencies.test.ts test/conformance/demoSolidityAbi.test.ts
3 files passed; 10 tests passed

npm run typecheck
passed

forge build --root tawg/demo --sizes
Workflow runtime size: 16,185 bytes
Workflow runtime margin: 8,391 bytes
```

The exact inherited ERC-8301 and ERC-8274 ABI metadata remains conformant. Task 4 adds only implementation-specific getters, events, errors, enums, and views.

## Warnings and concerns

There is no known Task 4 blocker. Solc continues to suggest that `onAgentProve` could be `view`, while the pinned ERC-8301 interface requires `nonpayable`. Forge lint retains the existing public-immutable naming and transparent-hash micro-optimization notes.

The settlement contribution loop is suitable only for this deliberately small Demo. There are no external calls in the loop, state changes roll back atomically on overflow or gas exhaustion, and the scalability limitation is now explicit in the README and Evaluator guidance.
