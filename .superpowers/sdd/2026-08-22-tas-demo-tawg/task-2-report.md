# Task 2 report — Demo ERC-8301 read model

## Result

Task 2 is implemented without a commit. The Demo now has one directly deployed ERC-8301 `Workflow`, one immutable proof-free `PassThroughVerifier`, and a dependency-free 18-test Foundry suite. Contribution, membership, scoring, settlement, rounds, completion, Profile reads, and Proof Provider behavior remain absent.

## RED evidence

`Workflow.erc8301.t.sol` was created before either contract. The first focused run failed only at import resolution:

```text
forge test --root tawg/demo --match-path test/Workflow.erc8301.t.sol -vvv
Source "contracts/PassThroughVerifier.sol" not found
Source "contracts/Workflow.sol" not found
Compilation failed
```

After the initial minimum implementation, a separate time-boundary RED demonstrated that a reply timestamp earlier than its previous task was incorrectly accepted. The new `ReplyBeforeTask` gate made that test pass.

The review RED added both behavior and artifact checks. Foundry showed that a two-element unknown batch was still collapsed to `InvalidProofBatch`; the new artifact test showed that `onAgentProve` was `view` with an unnamed `bytes` parameter and `verify` also had an unnamed `bytes` parameter. Each failure matched the requested change exactly.

## GREEN evidence

```text
forge test --root tawg/demo --match-path test/Workflow.erc8301.t.sol -vvv
Ran 18 tests: 18 passed, 0 failed

forge test --root tawg/demo -vvv
Ran 18 tests: 18 passed, 0 failed
```

The first implementation run had six assertion failures because this Foundry version treats `expectRevert(bytes4)` as an exact payload expectation for parameterized custom errors. Traces showed that every actual selector and argument was correct. The tests now use complete `abi.encodeWithSelector(...)` payloads for those errors rather than weakening the checks.

## ABI and hash choices

The contract implements the six exact vendored `IAgentWorkflow` operations through interface dispatch:

- `run`
- `result`
- `getAgentTask`
- `getAgentReply`
- `onAgentReply`
- `onAgentProve`

`demoSolidityAbi.test.ts` compiles into fresh temporary `out` and `cache` directories with `forge inspect`. It compares the complete JSON metadata of all six inherited functions and both inherited events with `IAgentWorkflow`, and compares `verify` plus `VerificationCompleted` with `IAgentVerifier`. Implementation-specific constructors, getters, errors, and events remain allowed. This catches parameter-name and state-mutability drift that Solidity's selector-level override check does not catch.

Task hashes use exactly:

```text
keccak256(abi.encode(
  stage,
  taskSeq,
  inputHash,
  timestamp,
  expiresAt,
  keccak256(abi.encodePacked(prevReplyHashes)),
  workflowRunId
))
```

Reply hashes use exactly:

```text
keccak256(abi.encode(
  outputHash,
  timestamp,
  replier,
  keccak256(abi.encodePacked(prevTaskHashes)),
  workflowRunId
))
```

Run IDs are deterministic and unique per Workflow sequence:

```text
keccak256(abi.encode(
  workflowAddress,
  block.chainid,
  sequence,
  caller,
  inputHash,
  expiresAt
))
```

Independent existence mappings distinguish unknown runs, tasks, and replies from valid records containing default-valued fields.

## Reply and proof-free scope

An accepted reply requires:

1. `reply.replier == msg.sender`;
2. exact output commitment;
3. exactly one known and proven previous task;
4. the same run;
5. a timestamp from task creation through the current block time; and
6. an unexpired task and nonduplicate reply hash.

The Workflow stores the complete reply and immutable verifier before the external verifier call. A narrow guard blocks state-mutating reentry during that call. The reply becomes proven only when the configured verifier returns `true` with a nonzero digest.

The pass-through digest is deterministic:

```text
keccak256(abi.encode(
  taskId,
  agentId,
  inputHash,
  outputHash,
  true,
  passThroughVerifierAddress
))
```

The verifier deliberately ignores proof bytes through a named `proof` parameter and a private no-op sink. Its result records that Workflow rules intentionally impose no external proof gate. It is not cryptographic proof, Proof Provider evidence, or an evaluation-quality judgment.

Because all Task 2 replies are already proven atomically, `onAgentProve` treats only an empty hash list as malformed. A nonempty list is scanned in caller order: its first unknown hash produces `UnknownReply(hash)`, and its first known-proven hash produces `ReplyAlreadyProven(hash)`. Only the theoretical case where every listed reply is known but unproven reaches `ProofSubmissionUnsupported`. No Proof Provider or arbitrary verifier path is created.

## Constructor boundary

The constructor stores immutable `profile`, `passThroughVerifier`, and `evaluatorAgentId`. It requires a nonzero predicted Profile address and deployed verifier bytecode. It does not require Profile bytecode or query membership before the separately planned Profile deployment, and it permits ERC-8004 Agent ID zero.

## Verification commands

```text
forge test --root tawg/demo --match-path test/Workflow.erc8301.t.sol -vvv
forge test --root tawg/demo -vvv
forge fmt --root tawg/demo --check
forge build --root tawg/demo --sizes
npm test -- test/conformance/demoLayout.test.ts test/conformance/demoDependencies.test.ts
npm test -- test/conformance/demoSolidityAbi.test.ts
npm run typecheck
git diff --check
```

All behavioral, ABI, conformance, type, formatting, size, and diff gates pass. The complete focused conformance run has 10 passing tests across three files. Workflow runtime size is 6,302 bytes and the pass-through verifier is 456 bytes under the current settings.

## Concerns

There is no known Task 2 blocker. Solc reports that `onAgentProve` could be `view`, but the vendored ABI explicitly requires `nonpayable`; the artifact conformance gate prevents accepting that suggested restriction. Foundry also emits advisory lint notes for public immutable lower-camel-case ABI getters and suggests assembly for the two explicit standard hash formulas. The exact ABI names and transparent ERC formulas are retained instead of obscuring the protocol contract for a micro-optimization.
