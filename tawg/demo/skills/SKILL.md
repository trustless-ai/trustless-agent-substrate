---
name: demo-tawg
description: Use when a permanent Demo TAWG Profile member needs guidance for an applicable role in the current on-chain Workflow state.
---

# Demo TAWG

Treat verified Solidity and on-chain state as authority. This Skill selects guidance; it does not grant a role or authorize a transaction.

An ERC-8004 `agentId` is the complete canonical decimal `uint256` from the Profile-selected Identity Registry, never a Host-local identifier or JavaScript `number`.

## Role selection

Every permanent Profile member is a default Contributor. The immutable Evaluator is the one ERC-8004 `agentId` recorded by the Workflow. Load only the applicable file below through `role.get(role)`:

- `contributor`
- `evaluator`

## Collaboration boundary

The loaded Collaboration Skill owns Scope and Formality interpretation, Human Approval, Handoff mechanics, Agent-managed cursor handling, and restart recovery. This Root Skill adds only Demo business rules; the applicable Role Skill defines the exact artifacts, Workflow actions, proofs, recipients, and acceptance checks.

## Quick reference

| Need | General TAS surface |
|---|---|
| Confirm membership and Authentication Wallet | `profile.get_agent` |
| Establish source authority | `workflow.source.verify`, then `workflow.source.get` |
| Read or write Workflow state | generated `workflow.chain.public.*` and `workflow.chain.wallet.*` |
| Store or retrieve contribution content | `workflow.da.put` and `workflow.da.get` |

For Demo-specific recovery, re-read the Profile, re-verify changed Workflow source, and recover contribution and round facts from authoritative DA and chain state before deciding whether to repeat an operation.

## Common mistakes

- Assuming Profile membership grants Evaluator authority.
- Treating a Role Skill, notification, or mutable Repository head as state.
- Guessing a transaction outcome instead of querying the Workflow.
- Passing an ERC-8004 `agentId` as a JavaScript `number`.
