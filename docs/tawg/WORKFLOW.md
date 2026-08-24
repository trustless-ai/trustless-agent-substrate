# TAWG Workflow Source and Verification

| Item | Value |
|---|---|
| Status | Approved source and verification baseline |
| Scope | TAWG Workflow v0.1 source authority, verification, and TAS delivery |
| Parent protocol | [TAWG Protocol Design](../TAWG.md) |
| Profile contract | [TAWG Profile Contract](PROFILE.md) |
| TAS consumer | [TAS v0.1 Design](../TAS.md) |
| MCP projection | [TAS MCP Interface Design](../tas/MCP.md) |
| v0.1 instance | [Daily Contribution and Settlement](instances/daily-contribution/README.md) |

> **One TAWG-specific `Workflow.sol` file is the executable specification. Its Solidity behavior is authoritative; marked comments help an Agent understand that behavior but cannot override it.**

## 1. Purpose

A custom ERC-8301 Workflow must be understandable by independently operated Agents without creating a second state machine or a separately maintained description of the contract. It must also be possible to prove that the source read by an Agent corresponds to the bytecode deployed at the Profile-selected Workflow address.

This document fixes the v0.1 source and verification model shared by TAWG-specific Workflows. Concrete Roles, States, Actions, Gates, proof policies, and settlement behavior belong to an Instance, such as [Daily Contribution and Settlement](instances/daily-contribution/README.md). The exact marked-comment convention remains a later design stage.

## 2. Contract-first authority model

TAWG Workflow v0.1 is contract-first:

```text
Workflow.sol
    executable Role, State, Action, Gate, Transition, proof, and settlement logic
        ↓ exact reproducible compilation
deployed ERC-8301 Workflow bytecode
        ↓ execution
authoritative on-chain run state
```

The following authority rules apply:

1. annotated Solidity is the sole manually maintained Workflow design and implementation source;
2. deployed code and on-chain state are authoritative at runtime;
3. comments are Agent guidance attached to the code, not executable authorization or an off-chain override;
4. TAS does not infer or maintain a parallel authoritative state machine;
5. no normative Workflow Model or persistent Workflow Descriptor JSON exists; and
6. an Agent-facing source view is returned only after the source has been matched to the deployed bytecode.

An Agent is expected to read the Solidity behavior itself. Marked comments may explain intent, responsibilities, operation sequences, proof requirements, and other details that help the Agent act correctly. A misleading comment never changes what the contract accepts.

## 3. Single-file Workflow unit

All TAWG-specific Workflow behavior and its Agent guidance are kept in one primary file:

```text
contracts/
├── Workflow.sol
└── Workflow.metadata.json
```

`Workflow.sol` contains the TAWG-specific executable logic and its ordinary Solidity comments. `Workflow.metadata.json` is an exact compiler-produced artifact and MUST NOT be edited by hand.

Standard ERC interfaces, audited dependencies, and compiler-recognized base contracts may be imported. Their exact source units and versions remain part of the reproducible compilation. TAWG-specific business rules MUST NOT be hidden in an unreported custom library, delegatecall target, generated runtime module, or another mutable implementation.

The single-file rule applies to the Workflow layer. It does not merge the TAWG Charter, Profile, shared Knowledge, Data, or general Repository operating instructions into `Workflow.sol`.

## 4. Repository locator

The Profile's extensible Workflow Data locates the exact source and compiler metadata used for the selected deployment. Its required discovery fields have this logical shape:

```json
{
  "source": {
    "repository": "https://github.com/example/example-tawg",
    "commit": "<full immutable Git commit>",
    "sourcePath": "contracts/Workflow.sol",
    "metadataPath": "contracts/Workflow.metadata.json"
  }
}
```

The fields mean:

- `repository` identifies the source repository;
- `commit` selects one complete immutable repository snapshot;
- `sourcePath` selects the single TAWG-specific Workflow source file; and
- `metadataPath` selects the compiler metadata generated from that source revision.

The Workflow Data object may contain additional TAWG-specific discovery fields. Those fields cannot override the typed Workflow address, deployed bytecode, source hashes, compiler settings, or verification result.

In v0.1, `source.repository` MUST be the same canonical Repository selected by the Profile Charter. The Workflow may select a different full commit from the Charter commit, but it cannot redirect source verification to another Repository. Every path is a canonical repository-root-relative POSIX path; absolute paths, backslashes, empty or dot segments, and traversal are invalid.

A branch, tag, abbreviated commit, current working tree, or hosting-provider page is not an immutable Workflow source reference.

## 5. Compiler metadata

`Workflow.metadata.json` is generated by the exact Solidity compiler invocation used for deployment. It supplies the information needed to reproduce and inspect that compilation, including:

```text
compiler version
compiler settings
compilation target
source-unit hashes and locations
library configuration
ABI and compiler documentation output
metadata format version
```

All imported source units must be retrievable and match the hashes recorded by the compiler metadata. A package lockfile and immutable dependency versions SHOULD be committed to make source resolution reproducible, but a lockfile does not replace compiler source hashes.

TAS invokes only exact compiler versions bundled and reviewed with that TAS release. It never downloads a compiler during a Workflow request. A Workflow that requires another compiler remains discoverable but cannot be verified until a TAS release explicitly adds that compiler.

TAWG Workflow v0.1 requires the normal Solidity metadata commitment to be retained in deployed runtime bytecode. A build that disables the bytecode metadata hash is not conforming. The metadata and every required source unit MUST be published at locators from which an independent verifier can retrieve them.

Ordinary comments are part of the source bytes. Changing a comment changes the source hash and compiler metadata, and therefore changes the metadata commitment of the resulting deployment. This binds the Agent guidance to the verified deployment even though the comments are not NatSpec or devdoc fields.

## 6. Deployment constraints

TAWG Workflow v0.1 uses a directly deployed, non-upgradeable Workflow implementation:

1. `workflowAddress` contains the implementation bytecode;
2. the address is not an upgradeable proxy;
3. TAWG-specific execution is not delegated to a replaceable implementation;
4. compiler metadata remains present in the runtime bytecode; and
5. the deployment inputs required for verification remain recoverable.

As a conservative v0.1 boundary, the executable Workflow runtime MUST NOT contain `DELEGATECALL` or legacy `CALLCODE` instructions. TAS disassembles executable bytecode while skipping PUSH data and rejects either opcode. This intentionally excludes proxy patterns and external-library forms that execute in the Workflow's storage context; supporting them requires a more complete implementation-identity and library-link policy in a later version.

An upgradeable or indirection-based Workflow requires implementation-address resolution, upgrade history, code-version selection, and additional historical verification rules. That model is outside v0.1.

## 7. Source verification

Repository location is discovery, not proof. TAS or another conforming verifier establishes the source-to-deployment link with this sequence:

```text
Profile at block B
    ↓
workflowAddress + Workflow Data source locator
    ↓
runtime bytecode at workflowAddress and block B
    ↓
Workflow.sol + Workflow.metadata.json at the pinned commit
    ↓
source-unit hash and metadata validation
    ↓
recompile with the exact compiler version, settings, sources, and libraries
    ↓
compare the reproduced runtime code with the deployed runtime code
    ↓
verified Workflow source
```

A metadata hash found in bytecode is not sufficient by itself because arbitrary bytecode could contain a fabricated metadata trailer. Verification MUST reproduce the compilation and compare code, not merely trust the claimed metadata reference.

The verifier handles compiler-reported link and immutable references when comparing runtime code. It must fail closed if it cannot obtain an exact compiler, a required source unit, required deployment context, or a supported comparison result.

Verification is block-specific. Historical interpretation reads the Profile and Workflow bytecode at the block relevant to the run or claim. It MUST NOT silently use the current Profile, current repository head, or current contract code for an older run.

## 8. TAS delivery and verification lifecycle

TAS exposes exactly two TAS-defined, read-only Workflow-source operations:

```text
workflow.source.verify
workflow.source.get
```

`workflow.source.verify` resolves the Profile-selected Workflow and pinned source, validates compiler metadata and every source unit, reproduces the exact compilation, compares runtime code with the deployed Workflow, and records the verified fingerprint in process memory. It returns the verification context and findings but not the source as Agent guidance.

The verifier invokes the exact Solidity compiler through a constrained Standard JSON compilation in a separate Node child process. TAS bounds stdin/stdout/stderr, passes a minimal non-secret environment, and kills then reaps the child on cancellation, deadline, malformed output, overflow, or compiler failure before starting queued work. This child boundary protects the TAS process from a compiler-process crash; it is not a portable OS-level memory quota, so a production host may additionally constrain the TAS/compiler process tree. The verifier MUST NOT execute Repository scripts, package lifecycle hooks, Foundry scripts, Hardhat tasks, shell commands, or code supplied by the Workflow Repository. Imported source bytes are compiler input, not executable local setup instructions.

`workflow.source.get` resolves the current fingerprint and returns the complete `Workflow.sol` only when the same fingerprint is already verified in the current TAS process. It does not compile, compare bytecode, or silently perform verification. If no matching verification exists, it fails with `WORKFLOW_SOURCE_VERIFICATION_REQUIRED`.

The combined results identify at least:

```text
chain and block context
workflowAddress
runtime code hash
repository and full commit
source and metadata paths
source hash
metadata hash
compiler version and settings identity
verification status and findings
verified source content from `get`
```

The caller cannot use this tool to select an unrelated repository, contract address, source file, metadata file, or compiler configuration. A private repository credential may be supplied under the common operation-scoped credential rules when retrieval requires it.

TAS keeps a successful verification only in process memory against its complete immutable fingerprint. The fingerprint includes the chain, Workflow address, runtime code hash, Repository and full commit, source and metadata paths, source and metadata hashes, compiler version, and compiler settings identity. The in-memory result is not persisted and is not authority.

Verification is required:

1. on the Agent's first connection to a newly started TAS process;
2. after the Profile-selected Workflow address changes;
3. after the Workflow source locator, commit, source hash, metadata hash, compiler identity, or compiler settings change; and
4. if the runtime code hash at the same address changes, which is non-conforming in v0.1 and may ultimately fail verification.

A Profile Version change caused only by another domain does not require recompilation when the complete Workflow fingerprint is unchanged. Any Workflow operation that observes a missing or stale verification fails closed with `WORKFLOW_SOURCE_VERIFICATION_REQUIRED`; it does not automatically run an expensive compilation or continue using stale guidance.

A completed source-to-runtime comparison returns `valid` and a concise `reason`. A source, compiler-metadata, or runtime mismatch returns `valid: false` with `source_mismatch`, `metadata_mismatch`, or `runtime_mismatch`, clears any stale matching assumption, and never exposes the unverified comments as active Workflow guidance. Failure to obtain or execute a required verifier input—such as an unavailable immutable source, unsupported deployment form, missing exact compiler, malformed metadata, or failed compilation—is a typed tool error rather than a negative comparison result.

## 9. Agent loading sequence

The release-matched TAS Skill and applicable TAWG Role Skill remain guidance layers rather than authorities. For Workflow participation they guide the Agent to:

1. call `profile.get` to discover the current Workflow;
2. call `workflow.source.verify` on first connection or after a Workflow fingerprint change;
3. call `workflow.source.get` to obtain the already verified `Workflow.sol`;
4. read the executable Solidity and its marked Agent guidance comments;
5. query current on-chain run and Agent context through the Workflow's read interface;
6. determine the applicable operation from the verified code and current state;
7. execute it through the applicable generated `workflow.*` operation; and
8. query chain state again rather than assuming that a submission caused a transition.

Source explains possible behavior; current on-chain state determines actual behavior. Notification delivery, Skill text, Repository state, or an Agent's interpretation never creates a Workflow transition.

## 10. Security invariants

1. Source is never trusted only because it was read from the Profile-selected Repository.
2. The full Git commit, not a mutable branch or tag, selects Workflow artifacts.
3. Every compilation source unit is hash-checked.
4. The exact compiler version and settings are used for reproduction.
5. Runtime code comparison is mandatory; a claimed metadata hash alone is insufficient.
6. Verification executes only a constrained compiler invocation and never executes Repository build or setup code.
7. TAS returns guidance-bearing source only after successful verification in the current process.
8. A Workflow fingerprint change invalidates the in-memory verification before another Workflow operation proceeds.
9. Comments do not grant an Agent a Role, authorize an Action, satisfy a Gate, accept a Reply or Proof, change state, or trigger settlement.
10. TAS never becomes a second Workflow engine.
11. Historical verification never falls forward to current source or state.
12. Proxy and replaceable-implementation deployments are rejected in v0.1.

## 11. Reference instances

Concrete TAWG operating models live below `instances/` rather than in this protocol-level
source and verification specification. Each Instance may define its own Roles, States, Actions,
Gates, data commitments, proof policy, settlement logic, diagrams, and review package.

The first v0.1 Instance is:

1. [Daily Contribution and Settlement](instances/daily-contribution/README.md) — records Work
   and Review Contributions discovered through group coordination, applies one fixed Evaluator
   Agent's ERC-8274-attested scores, permits one Appeal, and atomically settles periodic TAWG
   Points through an ERC-8312-metered ERC-8301 Workflow.

Instance documentation is explanatory and review-oriented. The deployment-verified
`Workflow.sol` and its on-chain state remain authoritative.
