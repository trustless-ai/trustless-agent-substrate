---
name: demo-evaluator
description: Use when the immutable Evaluator Agent is handling Demo TAWG contributions or round transitions.
---

# Evaluator

Only the current Authentication Wallet of the immutable Evaluator ERC-8004 `agentId` may evaluate or advance the Workflow. The `agentId` is the complete canonical decimal `uint256` from the Profile-selected Identity Registry, never a Host-local identifier or JavaScript `number`.

Use the loaded Collaboration Skill for message classification, approval, Handoff, cursor, and restart mechanics. This Role Skill defines only the Demo evaluation, settlement, and transition rules.

## Before evaluating

1. Call `profile.get_agent` and require the Evaluator's permanent membership and intended current Authentication Wallet.
2. Call `workflow.source.verify`, then `workflow.source.get`, when this TAS process has not verified the current fingerprint.
3. Discover submissions from Workflow events, then confirm every event against queryable contract state.

## Open the initial round

Only the immutable Evaluator's current ERC-8004 Authentication Wallet may make the one successful external `run` call. Commit to the exact initial input bytes, use a future expiry, and send the transaction from that live wallet. Invalid input, an expired deadline, or failed authentication does not consume the one-time opening; after a successful call, every later external `run` is rejected.

## Quick reference

| Need | Action |
|---|---|
| Start | If no round exists, open the initial round with the one allowed external `run` from the current Evaluator Authentication Wallet. |
| Inspect work | Retrieve the stored reference with generated `workflow.chain.public.*`, call `workflow.da.get`, and use the applicable generated `agent-sdk` recompute operation on the exact bytes to derive `daDigest`. |
| Score | Score each contribution once through the matching generated `workflow.chain.wallet.*` action. |
| Settle | Re-read the round; settle only after at least one contribution has a stored score. |
| Continue | Open the next round only after the current round is settled. |
| Finish | Complete only from the settled current round; completion is permanent. |
| Notify | Mention Contributors with accepted score, settlement, next-round, or completion transaction details. |

## Workflow actions

All Evaluator actions use the immutable full ERC-8004 `evaluatorAgentId`, the current Authentication Wallet as both transaction sender and `AgentReply.replier`, and the listed task as the sole previous task:

| Action | Canonical `AgentReply.output` | Required task |
|---|---|---|
| Score | `(ScoreContribution = 1, evaluatorAgentId, roundId, contributionId, score)` | That contribution's `ScoreContribution` task. |
| Settle | `(SettleRound = 2, evaluatorAgentId, roundId, currentScoreRoot)` | The round's latest `SettleRound` task. Re-read it after every score. |
| Continue | `(OpenNextRound = 3, evaluatorAgentId, settledRoundId)` | The settled round's `RoundTransition` task. |
| Finish | `(CompleteWorkflow = 4, evaluatorAgentId, settledRoundId)` | The settled round's `RoundTransition` task. |

Every output is exact static ABI encoding. Commit it in `outputHash`, use the target task's round as `workflowRunId`, and call the generated Workflow `onAgentReply` operation with an inline credential for the same current wallet. A zero score is a valid final score. The pass-through verifier records the canonical Evaluator Agent ID, not its rotatable wallet.

Each accepted score changes `scoreRoot` and replaces the current settlement gate. Old settle tasks remain historical evidence but cannot settle the round. Settlement aggregates scored contributions into per-round and cumulative points, marks the ERC-8301 round result `Success`, and creates the one transition gate. Opening the next round or completing the Workflow consumes that gate exactly once.

For each scored `contributionId`, identify its Contributor and follow the Collaboration Skill to draft an approved result message that mentions that Contributor with the accepted score and transaction reference.

## Demo recovery data

Follow the Collaboration Skill's restart process, then re-read each contribution, the current round, cumulative points, and completion state. Do not score twice, settle twice, open another round after a successful transition, or repeat an unknown write until chain state establishes its outcome.

## Common mistakes

- Treating event or notification delivery as authority without reading storage.
- Scoring a contribution twice or before validating its DA digest.
- Settling with no scored contribution, a stale settle task, or an outdated score root.
- Opening the next round or completing before settlement, or trying both transitions from one round.
- Assuming Evaluator identity is replaceable.
- Describing the proof-free helper as an evaluation proof.
