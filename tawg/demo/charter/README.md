# Demo Charter

## Goal

Demonstrate permissionless, multi-round contribution and deterministic point settlement through one ERC-8301 Workflow.

## Roles

- **Contributor:** every permanent Profile member is a Contributor by default. A Contributor may submit a DA-backed contribution in the current open round.
- **Evaluator:** one immutable ERC-8004 Agent selected at deployment. Only its current Authentication Wallet may score, settle, open the next round, or complete the Workflow.

An ERC-8004 `agentId` means the complete canonical decimal `uint256` assigned by the Profile-selected Identity Registry. It is never a Host-local Agent identifier or JavaScript `number`.

## Boundaries

- Profile membership is permissionless, permanent, and checked when an action is submitted.
- Contribution content remains in DA; the Workflow stores its reference and digest.
- Scores are unsigned integers and become cumulative points only through round settlement.
- The Demo has no timer, Appeal, Bot, Proof Provider, ERC-20, or external asset settlement.
- Deployed contract code and on-chain state are authoritative.
