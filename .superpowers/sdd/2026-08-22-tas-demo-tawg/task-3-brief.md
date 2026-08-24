# Task 3 brief — Demo membership and contributions

## Goal

Implement Task 3 of `docs/superpowers/plans/2026-08-22-tas-demo-tawg.md` with strict Solidity TDD. A current Profile member uses its live ERC-8004 Authentication Wallet to submit one DA-backed contribution as an ERC-8301 reply. Do not implement scoring, settlement, next-round opening, completion, a timer, or a Proof Provider.

## Owned files

- Modify `tawg/demo/contracts/Workflow.sol`
- Modify demonstrated helpers in `tawg/demo/test/TestBase.sol` only when required
- Create `tawg/demo/test/Workflow.registration.t.sol`
- Create `tawg/demo/test/Workflow.contribution.t.sol`
- Update affected Demo Role Skill wording only if the implemented public ABI makes existing guidance inaccurate
- Task 3 SDD report/progress

## Contract model

1. Add only the minimal local read interfaces required from the accepted v0.1 Profile and ERC-8004 Registry:
   - Profile `identityRegistry()` and `getAgent(agentId)`;
   - Registry `ownerOf(agentId)` and `getAgentWallet(agentId)`.
   Do not vendor another source tree or import the production Profile implementation.
2. Authentication is evaluated at action submission time:
   - the ERC-8004 identity must exist;
   - the Profile must report it as a permanent member;
   - its current Authentication Wallet must be nonzero; and
   - `msg.sender`, `reply.replier`, and that current wallet must agree.
   Distinguish identity-not-found, nonmember, unset-wallet, and wrong-wallet failures with explicit errors where the external contracts provide enough information.
3. Wallet rotation requires no Workflow update. Every new action reads the current wallet; the old wallet immediately stops working.
4. Represent contribution submission through `onAgentReply`, following the same ERC-8301 action-envelope pattern used by the Daily reference. Do not add a parallel `submitContribution` function or a Demo MCP namespace.
5. The only accepted Task 3 action payload is deterministically ABI-encoded as:

   ```solidity
   abi.encode(
       ActionKind.SubmitContribution,
       contributorAgentId,
       roundId,
       contributionId,
       daReference,
       daDigest
   )
   ```

   `roundId` is the ERC-8301 `workflowRunId` (`bytes32`) for this round. `daReference` is opaque nonempty `bytes`; the Workflow does not parse a provider-specific locator. `daDigest` is nonzero and commits to exact DA content under the applicable off-chain recompute rule.
6. The supplied business identifier must equal:

   ```solidity
   keccak256(abi.encode(address(this), roundId, contributorAgentId, daDigest))
   ```

   It is a contribution identifier, not a TAS operation ID. Reject mismatches and duplicates explicitly.
7. A contribution reply must point to the initial collect task for the same run. Preserve all Task 2 caller, hash, task, time, expiry, verifier, reentrancy, and proof-free rules. The reply must become proven before the business record is accepted; verifier failure atomically leaves no reply or contribution.
8. Store one authoritative contribution record containing at least:
   - existence;
   - round/workflow run ID;
   - contributor ERC-8004 Agent ID;
   - exact DA reference bytes;
   - DA digest;
   - submit reply hash;
   - score state and score fields reserved for Task 4 without exposing a way to mutate them now.
9. Provide storage-backed query surfaces sufficient to recover without events:
   - retrieve one known contribution by ID with an explicit unknown error;
   - count contributions in a round;
   - retrieve a contribution ID by round and index with an explicit bounds error.
   Events aid discovery but are not the authority.
10. A contributor may submit multiple different contributions in one round. Because the identifier intentionally excludes the DA reference, the same Agent/round/digest is the same logical contribution even if a locator changes.
11. Reject an unknown run, a non-current/incorrect round-task pairing, empty DA reference, zero digest, malformed/unsupported action encoding, mismatched ID, duplicate ID, and a reply that does not target the round's collect task.
12. Do not freeze Task 4 state transitions prematurely. If current-round state must be introduced for correctness, keep it minimal and do not implement settlement/completion behavior or permit a second active round.

## TDD matrix

### Authentication RED

- nonexistent ERC-8004 ID;
- existing identity that is not a Profile member;
- member with an unset Authentication Wallet;
- member called by a different wallet;
- successful current-wallet submission;
- wallet rotation: new wallet succeeds, old wallet fails;
- member data/verifier changes do not substitute for Authentication Wallet authority.

### Contribution RED

- exact contribution ID and exact stored fields;
- exact reply hash retained and queryable;
- multiple distinct contributions by one member;
- mismatched caller-supplied ID;
- duplicate logical contribution;
- wrong run/round or non-collect previous task;
- empty DA reference and zero digest;
- malformed or unsupported action payload;
- verifier rejection leaves no contribution;
- round enumeration, unknown ID, and out-of-bounds query behavior.

## Security constraints

- Never trust a caller-supplied wallet, Profile membership flag, Registry address, verifier, contribution ID, or reply hash.
- Query the Profile-selected Registry on every action; do not cache a mutable wallet.
- External Profile/Registry reads occur before business effects. The existing verifier guard and atomic rollback remain intact.
- Do not describe Profile membership or a pass-through result as proof of contribution quality.
- Store no credential or private material.

## Verification

Run focused registration and contribution tests, the complete Demo Forge suite, Demo conformance including ABI, formatting/build/size, TypeScript typecheck, and diff check. Remove generated `out/` and `cache/`. Do not commit until independent Solidity/spec and security reviews approve.

## Collaboration

The worker owns only the files listed above, is not alone in the repository, must not revert others, must not commit, and must not spawn subagents.
