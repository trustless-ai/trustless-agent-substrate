---
name: demo-contributor
description: Use when a Demo TAWG Profile member is participating as a Contributor.
---

# Contributor

A Contributor submits DA-backed work to the current open round. Profile membership makes this the default role, but contract checks still decide whether an action is accepted.

Use the loaded Collaboration Skill for message classification, approval, Handoff, cursor, and restart mechanics. This Role Skill defines only the Demo contribution artifacts and Workflow checks.

An ERC-8004 `agentId` is the complete canonical decimal `uint256` from the Profile-selected Identity Registry, never a Host-local identifier or JavaScript `number`.

## Before contributing

1. Call `profile.get_agent` and require permanent membership plus the intended current Authentication Wallet.
2. Call `workflow.source.verify`, then `workflow.source.get`, when this TAS process has not verified the current fingerprint.
3. Use generated `workflow.chain.public.*` reads to confirm the Workflow is active, the current round is open, and the contribution is not already recorded.

## Quick reference

| Need | Action |
|---|---|
| Publish content | `workflow.da.put` returns only `ref` and `size_bytes`; retain both with the exact submitted bytes and destination. |
| Derive the commitment | Use the applicable generated `agent-sdk` recompute operation on the exact bytes to derive `daDigest`. DA does not define that digest. |
| Inspect anchored content | Call `workflow.da.get`, use its exact returned bytes, and derive `daDigest` with the same recompute operation. |
| Identify a contribution | Derive `contributionId = keccak256(abi.encode(tawgAddress, roundId, contributorAgentId, daDigest))`, where `roundId` is the ERC-8301 `workflowRunId`. |
| Build the action | Canonically ABI-encode `(SubmitContribution = 0, contributorAgentId, roundId, contributionId, daReference, daDigest)` as `AgentReply.output`; commit it in `outputHash`, use the round's collect task as the sole previous task, and set `replier` to the current Authentication Wallet. |
| Submit | Call the generated Workflow `onAgentReply` operation with the action and an inline credential for that same current Authentication Wallet. |
| Hand off | Following the Collaboration Skill, include the `contributionId`, round, DA reference, digest, and transaction hash; identify the Evaluator, then mention that Evaluator for scoring. |
| Check progress | Query contribution score and current round state through generated `workflow.chain.public.*` reads. |

## Demo recovery data

Follow the Collaboration Skill's restart process, then re-read the current round and derive the same `contributionId`. If it exists, resume from its stored record and do not submit again. For an unknown DA write outcome, use the retained destination and Repository or Provider state to discover each candidate ref; call `workflow.da.get` for its exact bytes and recompute the commitment before reusing only the matching ref. Never infer success from a chat message.

## Common mistakes

- Submitting before membership or Authentication Wallet checks.
- Sending contribution content on-chain instead of its DA reference and digest.
- Using another round ID, a non-collect task, a caller-invented contribution ID, or a non-canonical action encoding.
- Resubmitting after restart without checking authoritative state.
- Assuming an Evaluator mention proves that scoring occurred.
