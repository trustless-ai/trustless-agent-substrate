# Task 3 report — Demo membership and contributions

## Result

Task 3 is implemented without a commit. The Demo `Workflow` now accepts one canonical `SubmitContribution` action through ERC-8301 `onAgentReply`, authenticates the contributor against the live Profile-selected ERC-8004 Registry, anchors the reply through the immutable proof-free verifier, and stores an independently queryable contribution record only after that reply is proven.

Scoring, settlement, completion, next-round creation, timers, appeals, chat, and Proof Provider behavior remain absent.

## RED evidence

The registration and contribution suites were written before the production changes. After correcting a test-only use of Solidity's reserved word `reference`, both focused runs stopped at the first missing production type:

```text
Identifier not found or not unique:
Workflow.ContributionView
Compilation failed
```

That RED covered 16 initial tests: seven registration/authentication cases and nine contribution cases. Two additional security REDs were then demonstrated independently:

```text
testRejectsMalformedAndUnsupportedActionPayloads
[FAIL: next call did not revert as expected]
```

The failure trace showed that a short, non-action payload was being anchored and marked proven. The public compatibility path was removed, so production `onAgentReply` now accepts only a canonical business action.

```text
testRejectsNonCanonicalActionPadding
[FAIL: next call did not revert as expected]
```

The failure trace showed that Solidity decoding ignored nonzero dynamic-bytes padding and accepted an alternate `outputHash` for the same decoded fields. Canonical re-encoding comparison now rejects that ambiguity.

Independent review then found that the proof-free verifier received `reply.replier` converted to `bytes32` instead of the canonical ERC-8004 Agent ID. Two review REDs exposed the identity break directly: the verifier event used `0x...a11ce` for the first wallet and `0x...0b0b` after rotation, while the action carried the same large Agent ID throughout. The anchor helper now receives the authenticated `contributorAgentId` and passes `bytes32(contributorAgentId)` to ERC-8274. Tests assert both the emitted `VerificationCompleted.agentId` and stored digest preimage, including continuity across wallet rotation.

## Authentication model

Every contribution submission resolves authority again from chain state:

1. read `identityRegistry()` from the immutable TAWG Profile address;
2. require `ownerOf(agentId)` to establish that the ERC-8004 identity exists;
3. require current Profile membership through `getAgent(agentId)`;
4. read the current `getAgentWallet(agentId)` and require it to be nonzero; and
5. require `msg.sender == reply.replier == current Authentication Wallet`.

Identity absence, nonmembership, an unset wallet, and a wrong wallet have distinct errors. Wallets, membership, Registry selection, Profile data, and Profile verifier fields are not cached. A Registry wallet rotation therefore authorizes the new wallet and rejects the old one immediately, without a Workflow update. No credentials or private material are stored.

## Contribution envelope and identity

The only accepted action is exactly:

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

The decoder first reads the action word, so an unknown action reports `UnsupportedAction(action)`. A known action must have the exact six-word head, a dynamic-bytes offset of 192, an exact padded length, and byte-for-byte equality with a canonical re-encoding. Short, truncated, shifted, extended, and nonzero-padded encodings report `MalformedAction` rather than a generic ABI panic.

The Workflow derives the authoritative identifier as:

```text
keccak256(abi.encode(
  workflowAddress,
  roundId,
  contributorAgentId,
  daDigest
))
```

The caller-supplied ID must match. Because `daReference` is deliberately excluded, changing only the locator cannot create a second logical contribution for the same Agent, round, and digest. An exact repeated ERC-8301 reply is rejected first as `DuplicateReply`; a different reply carrying the same business ID is `DuplicateContribution`.

## Run, task, proof, and storage rules

`run` records its initial stage-zero task as that run's collect task. A contribution must use the same `workflowRunId` in the ERC-8301 reply and action envelope, target that exact collect task, and pass every Task 2 caller, commitment, task, timestamp, expiry, duplicate, reentrancy, and proof-free verifier rule.

The complete ERC-8301 reply is anchored before the external verifier call, preserving the verifier-observation behavior. The verifier receives the full canonical ERC-8004 contributor Agent ID, never the mutable Authentication Wallet. Reentrancy remains guarded. Any verifier rejection or zero verification digest reverts the entire transaction, leaving neither a reply nor a contribution. The pass-through result means only that this action has no external proof gate; it does not prove contribution quality.

Each stored contribution contains existence, round/run ID, ERC-8004 contributor Agent ID, exact opaque DA reference bytes, nonzero DA digest, submit reply hash, and reserved `scored=false`/`score=0` fields. Storage-backed queries return one contribution, a round count, or a contribution ID by round/index, with explicit unknown-record, unknown-run, and bounds errors. Events are discovery aids only.

The Task 2 ERC-8301 tests now use canonical contribution actions and a local live Profile/Registry fixture. This preserves their public-ABI and bookkeeping assertions without leaving a production reply path that bypasses identity and membership checks.

The Contributor Role Skill now documents the exact `abi.encode` contribution identifier and canonical `onAgentReply` action envelope. The Demo README reports the implemented boundary instead of the original empty-scaffold status.

## GREEN evidence

```text
forge test --root tawg/demo --match-path test/Workflow.registration.t.sol -vvv
Ran 8 tests: 8 passed, 0 failed

forge test --root tawg/demo --match-path test/Workflow.contribution.t.sol -vvv
Ran 11 tests: 11 passed, 0 failed

forge test --root tawg/demo -vvv
Ran 37 tests across 3 suites: 37 passed, 0 failed

npm test -- test/conformance/demoLayout.test.ts test/conformance/demoDependencies.test.ts test/conformance/demoSolidityAbi.test.ts
3 files passed; 10 tests passed

npm run typecheck
passed

forge fmt --root tawg/demo --check
passed

forge build --root tawg/demo --sizes
Workflow runtime size: 9,617 bytes
Workflow runtime margin: 14,959 bytes

git diff --check
passed
```

The ABI conformance test still matches every inherited ERC-8301 and ERC-8274 function/event, including metadata, while permitting the new implementation-specific contribution queries, event, errors, and immutable getters.

## Warnings and concerns

There is no known Task 3 blocker. Solc continues to suggest that `onAgentProve` could be `view`, but the vendored ERC-8301 ABI requires `nonpayable`; artifact conformance deliberately preserves that signature. Forge lint also suggests uppercase immutable names and assembly hash micro-optimizations. Public immutable names are retained as ABI getters, and transparent `keccak256(abi.encode(...))` formulas are retained as protocol definitions.

The Profile and Registry reads are intentionally minimal local interfaces. Unexpected external call failures outside the distinguishable `ownerOf` identity-not-found case may retain external revert behavior; Task 3 does not invent a new Profile/Registry error-translation protocol.
