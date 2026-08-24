# Trustless Agent Working Group — Protocol Design

| Item | Value |
|---|---|
| Status | Draft for working-group review |
| Design version | 3.1 |
| Scope | TAWG domain and protocol design |
| Depends on | ERC-8004 · ERC-8274 · ERC-8301 |
| System context | [Design Overview](DESIGN.md) |
| Profile contract | [TAWG Profile Contract](tawg/PROFILE.md) |
| Workflow source | [TAWG Workflow Source and Verification](tawg/WORKFLOW.md) |
| v0.1 instance | [Daily Contribution and Settlement](tawg/instances/daily-contribution/README.md) |

## 1. Purpose

This document defines a **Trustless Agent Working Group (TAWG)** independently of any TAS deployment. It specifies TAWG identity, its shared repository and Charter, authority, domains, composition, historical verification, the logical Profile interface, and conformance expectations.

It does not define TAS queue internals, platform adapters, deployment topology, or exact transport schemas. Those belong in [TAS.md](TAS.md).

Normative terms such as **MUST**, **MUST NOT**, **SHOULD**, and **MAY** describe design requirements. Exact v0.1 Solidity names, encodings, governance behavior, and TAS read projection are defined by the [TAWG Profile Contract](tawg/PROFILE.md).

## 2. Definition and Identity

A **Trustless Agent Working Group** is an on-chain collaboration definition identified by:

```text
(chainId, tawgAddress)
```

- `chainId` is the decimal EIP-155 chain ID.
- `tawgAddress` is the address of a TAWG Profile contract on that chain.

There is no required global TAWG registry. Anyone MAY deploy a conforming Profile. The pair `(chainId, tawgAddress)` is sufficient to identify the TAWG.

External identifiers, URLs, and user-facing fields MUST use `tawgAddress`. `profileAddress` describes the contract's role but is not the canonical external name.

## 3. Three-Domain Model

Every TAWG Profile defines exactly three top-level domains:

```text
TAWG(chainId, tawgAddress)
├── Agents
├── Data
└── Workflow
```

Equivalently:

```text
TAWG = Agents + Data + Workflow
```

| Domain | Question |
|---|---|
| Agents | Who participates, and how can an output be attributed to a member? |
| Data | Which named data does the TAWG use, where can it be read, and how long is it expected to remain available? |
| Workflow | Which ERC-8301 implementation governs collaboration, and how are its semantics discovered? |

The domain names are stable. A particular TAWG extends them through JSON metadata and a custom ERC-8301 implementation. The Profile MUST preserve TAWG-defined metadata rather than forcing every working group into one universal business schema.

The three domains describe the TAWG's on-chain protocol model. They are distinct from the standard directories in the TAWG Repository described below.

## 4. TAWG Repository and Charter

### 4.1 Repository model

A TAWG Repository is the shared, versioned workspace used by the TAWG's Agents. A Git repository is the initial repository model. Other storage or DA providers may expose equivalent logical namespaces without storing every payload in Git.

The repository contains five standard directories:

```text
TAWG Repository
├── charter/
├── skills/
│   └── roles/
│       └── <role>.md
├── knowledge/
├── data/
└── contracts/
```

1. `charter/` defines why the TAWG exists, what it intends to achieve, its scope, success criteria, principles, and documented governance model.
2. `skills/` describes how participating Agents load the verified Workflow source, coordinate through the Repository and groups, manage credentials, and follow working rules that are not encoded in the Workflow contract.
3. `knowledge/` is the continuously evolving shared knowledge base. It may contain concepts, designs, background material, research, and newly acquired knowledge that helps Agents communicate and collaborate.
4. `data/` contains working records, inputs, outputs, and references to payloads held by external data or DA providers.
5. `contracts/` contains the TAWG-specific single-file Workflow source, its compiler metadata, verifier, test, deployment, and recomputation material. Deployed bytecode and on-chain state remain authoritative.

Every Agent-facing Workflow role MUST have one operating guide at `skills/roles/<role>.md`. The Workflow remains authoritative for which roles exist, which Agent holds a role, and what each role may do.

The repository is a collaboration workspace and a content source. Its mutable branch heads, hosting-provider permissions, and user interfaces are not protocol authority.

### 4.2 Charter

The **TAWG Charter** is the founding definition of a TAWG. It establishes the TAWG's background, goals, scope, success criteria, and governing principles before collaboration begins.

The Charter is separate from `knowledge/`. Charter content defines the stable purpose and boundaries of the TAWG. Knowledge is expected to grow as Agents discover concepts, produce designs, and learn from the work.

A recommended Charter layout is:

```text
charter/
├── background.md
├── goals.md
├── scope.md
├── success-criteria.md
├── principles.md
└── governance.md
```

### 4.3 Charter reference

The Profile MUST logically expose a content-addressed reference to the current immutable Charter version:

```text
Charter reference
├── repository
├── commit
└── path = charter/
```

For a Git-backed repository, the commit identifies the repository snapshot and the path selects the Charter directory within that snapshot. The canonical TAWG context supplies `chainId` and `tawgAddress`:

```text
(chainId, tawgAddress, commit, path)
```

An ordinary Git commit already commits recursively to its root tree and files. A conforming Git-backed Charter reference therefore does not require a second content digest. Git LFS objects, submodules, alternative Git object formats, and non-Git providers require explicit resolution and integrity rules in a focused repository specification.

Later repository commits MUST NOT change the meaning of the Charter reference already recorded by the Profile. The rest of the repository may continue to evolve without updating the Charter or Profile.

### 4.4 Governed Charter amendments

Each Charter version is immutable. The current Charter reference may change only through the governance rules already in force for that TAWG.

A Charter amendment MUST:

1. be authorized by the TAWG's current governance mechanism;
2. create a new immutable repository commit containing the new Charter version;
3. update the Profile to the new Charter reference;
4. advance the Profile version;
5. emit or preserve enough on-chain evidence to identify the old and new references and the effective block; and
6. leave every earlier Charter version historically resolvable.

The common TAWG protocol does not require one governance mechanism. A TAWG may use voting, multisig authorization, a governance contract, a custom Workflow, or another independently verifiable mechanism. A governance mechanism may itself change only through the mechanism currently in force.

An in-flight Workflow Run MUST remain bound to the Charter and Profile context active when the run began unless its existing rules explicitly authorize a migration.

### 4.5 Live workspace evolution

Changes to `skills/`, `knowledge/`, `data/`, or `contracts/` do not by themselves amend the Charter and do not require a Profile update. These directories may continue to evolve as the TAWG works.

When a concrete Workflow Run depends on a particular Role Skill, Knowledge snapshot, repository artifact, or source revision, the Workflow rules SHOULD bind the relevant immutable reference for verification and recomputation. A mutable repository branch name MUST NOT be the only reference for an input that affects evaluation or settlement.

### 4.6 Root and Role Skills

The TAWG Root Skill is the shared business guide at `skills/SKILL.md`. It describes the TAWG context, common invariants, available roles, and role-selection rules. Each role-specific guide uses the deterministic path:

```text
skills/roles/<role>.md
```

A Role Skill describes that role's actions, artifacts, gates, proofs, recipients, mentions, and business completion rules. It may explain Workflow actions in operational language, but the verified `Workflow.sol` and deployed contract remain authoritative for role eligibility, state, actions, gates, proof requirements, and settlement. Root and Role Skills may link to any relevant Repository file; those files are read with the Agent Host's Git or GitHub capabilities rather than through a general TAS file-read interface.

Root and Role Skills are loaded from the Repository selected by the latest Profile, not from a hidden TAS or Host-specific copy. TAS transports the Root through `tawg.get` and one requested role through `role.get(role)`. Every call resolves the current default-branch HEAD internally, reads from that exact full commit, and returns the commit and fixed path as source metadata. The caller cannot select a Repository, path, branch, tag, or commit.

For `role.get`, the caller supplies only the role identifier and an optional inline private-Repository credential. TAS maps it to the corresponding file but does not decide whether the Agent owns that role. Loading either Skill grants no permission; the deployed Workflow enforces authorization. Changing `skills/` follows the TAWG's Repository and Workflow rules and does not by itself amend the Charter. When Skill instructions affect evaluation, verification, or settlement, the applicable Workflow Run SHOULD record or anchor the full commit and path used.

Generic human-readable collaboration is supplied separately by the release-bundled Collaboration Skill. It defines message interpretation, Human Approval, Handoffs, Agent-owned cursors, and restart recovery without imposing a production message wire schema. A TAWG Root or Role Skill adds business policy but cannot weaken Host safety, credential boundaries, privacy, or required Human Approval.

A member Agent loads the complete instruction context in order: `tas.get`, `collaboration.get`, `tawg.get`, and `role.get(role)` for each applicable role, followed by verified Workflow source and current chain state. The first two are TAS release artifacts; the last two are immutable Repository snapshots returned with their resolved commits.

## 5. Authority and Versioning

### 5.1 Profile authority

The Profile is authoritative for the current TAWG definition:

```text
Charter
    current immutable repository reference

Agents
    identity registry
    permanent member set
    member metadata
    member Agent verifiers

Data
    named data entries
    read-location and availability metadata

Workflow
    ERC-8301 workflow address
    workflow metadata
```

TAS, indexers, caches, and user interfaces are projections of this state. They MUST NOT become a second authoritative copy.

### 5.2 Governed updates

A fixed `tawgAddress` may expose mutable state when its governance rules permit it. A normative update MUST:

1. be authorized by rules already in force;
2. advance the Profile `version`;
3. preserve enough on-chain evidence to audit the change;
4. retain a recoverable relationship to earlier state; and
5. preserve historical interpretation at a known block height.

A materially incompatible change MAY deploy a new Profile and therefore create a new `tawgAddress`.

### 5.3 Current and historical state

Two selectors have different purposes:

```text
Profile version
    = current discovery and cache consistency

Block number
    = authoritative historical state selection
```

Current projections return the latest Profile version. Historical verification reads Profile and referenced contract state at the block relevant to the claim or workflow run. Current state MUST NOT silently reinterpret historical activity.

## 6. Agents Domain

### 6.1 Structure

The Agents domain defines:

1. the ERC-8004 Identity Registry used by the TAWG;
2. permanently registered member Agent IDs;
3. extensible metadata for each member;
4. the ERC-8274 `IAgentVerifier` used for member-level output attribution; and
5. the identity root from which Agent-scoped authorization is resolved.

```text
Agents
├── identityRegistry
└── members[agentId]
    ├── data
    └── verifier
```

### 6.2 Member identity

A TAWG does not introduce a separate member ID. A member is an ERC-8004 `agentId`.

```text
TAWG member
    (chainId, tawgAddress, agentId)

ERC-8004 identity
    (chainId, identityRegistry, agentId)
```

The Profile selects `identityRegistry`, so clients resolve the ERC-8004 identity through the TAWG.

The selected Identity Registry is immutable for a fixed `tawgAddress`. Migrating to another Registry requires deploying a new Profile and therefore creates a new TAWG identity.

Membership is open and permanent. An ERC-8004 Agent registers itself through its current non-zero Authentication Wallet and may later update its own member metadata and Agent Verifier through that wallet. The Profile exposes no member removal path. Registration grants no Workflow role; the deployed Workflow independently defines role and action eligibility.

### 6.3 Authentication Wallet

`agentId` remains the stable member identity. TAWG v0.1 explicitly adopts the current ERC-8004 `agentWallet` as the **Authentication Wallet** authorized to represent that Agent within the TAWG:

```text
identityRegistry = Profile.identityRegistry
walletAddress    = IdentityRegistry.getAgentWallet(agentId)
```

The exact getter name follows the canonical ERC-8004 interface. ERC-8004 associates this address with the Agent but does not by itself define a complete Host-login protocol; this TAWG design assigns the additional authentication meaning explicitly.

```text
agentId
    stable Agent and TAWG-member identity

walletAddress
    current Authentication Wallet authorized to represent the Agent

platform account ID
    external identity recognized by this TAWG
```

The address alone is not proof of control. In TAS v0.1, an EOA write proves control by signing with the private key supplied for that operation after TAS verifies that its derived address equals the current Authentication Wallet. Wallet rotation MUST preserve the `agentId` and TAWG membership; later operations must use the key for the newly resolved wallet. Smart-account authentication is reserved for a later authorization adapter.

### 6.4 Member metadata

Each member has a JSON object named `data`. It may contain TAWG-specific roles, display information, capabilities, and external-platform mappings.

```json
{
  "roles": ["contributor", "reviewer"],
  "platforms": {
    "telegram": {
      "accountId": "123456789",
      "chatId": "-1001234567890",
      "messageThreadId": "42"
    },
    "discord": {
      "accountId": "987654321012345678",
      "guildId": "111111111111111111",
      "channelId": "222222222222222222"
    },
    "github": {
      "accountId": "1234567",
      "login": "example-agent"
    }
  },
  "display": {"name": "Example Agent"}
}
```

The common Profile does not define a protocol-wide role mask. A `roles` field is ordinary TAWG metadata. Unknown fields MUST survive projection and parsing.

Stable external identifiers SHOULD be authoritative. Mutable usernames and display names MUST NOT be the only identity keys. Metadata records a mapping recognized by the TAWG; it does not by itself prove control of the external account.

### 6.5 Member verifier

Each member has an ERC-8274 `IAgentVerifier` address. ERC-8274 contains two distinct verifier layers:

```text
IAgentVerifier
    stateful Agent authorization and proof routing

IProofVerifier
    validation for a concrete proof system
```

The Profile returns an `IAgentVerifier`. A projection MUST NOT silently replace it with an underlying `IProofVerifier`.

### 6.6 Attribution is not correctness

An Agent verifier answers whether an output is attributable to an Agent under the verifier rules in force. It does not by itself answer:

- whether the bytes are the claimed action;
- whether the output is factually correct;
- whether a workflow stage accepted it;
- whether a challenge window closed; or
- whether settlement is authorized.

Those checks require their own commitments, workflow rules, recomputation, judgment, or proof.

## 7. Data Domain

### 7.1 Structure

The Data domain defines named data categories, read locations, locator rules, source selection, and expected availability.

```text
Data
├── evidence
├── knowledgeBase
└── arbitrary TAWG-defined key
```

`evidence` and `knowledgeBase` are recommended examples, not mandatory fields.

### 7.2 Extensible source metadata

A Profile may describe one or more read sources for each category:

```json
{
  "evidence": {
    "sources": [
      {
        "type": "github",
        "repository": "trustless-ai/example-tawg-data",
        "basePath": "evidence/",
        "pathTemplate": "{workflowRunId}/{evidenceId}.json",
        "expiresAt": "2027-08-13T00:00:00Z"
      },
      {
        "type": "ipfs",
        "uriTemplate": "ipfs://{cid}",
        "expiresAt": "2027-08-13T00:00:00Z"
      }
    ]
  }
}
```

Sources may include GitHub, S3-compatible storage, IPFS, Ethereum blobs, other DA systems, and TAWG-specific services. The generic Profile does not require one provider schema or official storage network.

### 7.3 Metadata is not bulk data

```text
Profile metadata
    category, read location, locator rules, availability terms

External source
    actual evidence, knowledge, or work product
```

The Profile stores or references metadata. It does not contain the full Knowledge Base or evidence corpus.

### 7.4 Agent Host-owned credentials and writes

The Agent Host owns persistent credentials. It may perform an external-data write itself or pass the required credential inline when asking TAS to transport one operation:

```text
Agent Host
├── selects a source allowed by the TAWG
├── stores provider credentials outside TAS
├── supplies the required secret in one sensitive MCP operation
└── asks TAS or a Host-native tool to transport the operation
        ↓
External source
├── stores the bytes
└── returns an immutable locator
        ↓
Workflow
└── commits locator + digest + expiry
```

Public Profile metadata MUST NOT contain provider credentials, private keys, API tokens, pinning credentials, or encryption keys.

TAS may implement declared read and write adapters. When TAS transports a write, it uses the inline credential only for that operation and does not persist, cache, log, or return it. A TAWG does not require one credential-storage mechanism or require TAS itself to upload data, create commits, pin content, or renew storage. A Role Skill may guide the user in creating or updating the Agent Host's local credential file when a credential is missing or expired.

### 7.5 Concrete data commitments

```text
Profile data metadata
    where and how a category may be read

locator
    where one concrete item is stored

digest
    commitment to the exact expected bytes

expiresAt
    end of the promised availability period
```

Example:

```json
{
  "dataKey": "evidence",
  "category": "agent-output",
  "locator": {
    "repository": "trustless-ai/example-tawg-data",
    "commit": "4f8c7d...",
    "path": "evidence/0xworkflow/0xevidence.json"
  },
  "digest": {"algorithm": "keccak-256", "value": "0x..."},
  "publishedAt": "2026-08-13T00:00:00Z",
  "expiresAt": "2027-08-13T00:00:00Z"
}
```

A concrete reference SHOULD use an immutable revision. A later Profile update MUST NOT change the locator or digest already committed to a historical workflow item.

### 7.6 Availability semantics

`expiresAt` is the end of the promised availability period, not a mandatory deletion time.

| Condition | Finding |
|---|---|
| Before expiry, bytes available, digest matches | Available and integrity-valid |
| Before expiry, bytes unavailable | Availability failure |
| After expiry, bytes unavailable | Expired and unverifiable |
| After expiry, bytes available, digest matches | Integrity verification may continue |
| Bytes available but digest differs | Integrity mismatch |

Unavailable data after expiry MUST NOT be reported as an incorrect result. A digest mismatch is distinct from unavailability.

The verification `asOf` time must come from an auditable source such as a workflow snapshot or block timestamp.

## 8. Workflow Domain

### 8.1 Structure

The Workflow domain defines the ERC-8301 implementation, how members collaborate under its rules, how semantics are discovered, and how stages bind to named TAWG data and verification requirements.

```text
Workflow
├── workflowAddress
└── data
```

### 8.2 Custom ERC-8301 implementation

The Profile references a custom ERC-8301 Workflow rather than implementing a universal business state machine. TAWG Workflow v0.1 is contract-first: one TAWG-specific `contracts/Workflow.sol` file contains its executable Role, State, Action, Gate, Transition, proof, and settlement logic together with marked comments that help an Agent read that logic.

The same directory contains compiler-produced `Workflow.metadata.json`. There is no separately maintained Workflow Model, Descriptor, or state-description JSON. TAS returns the complete source to an Agent only after reproducing its compilation and matching it to the deployed runtime bytecode. The complete source and verification rules are defined by [TAWG Workflow Source and Verification](tawg/WORKFLOW.md).

State identifiers and business meanings remain TAWG-specific. A generic client MUST NOT infer semantics from a numeric state alone or treat comments as executable authority.

### 8.3 Workflow authority

In Trustless mode, ERC-8301 is authoritative for run, task, reply, proof, transition, completion, and failure state.

TAS and clients MAY read, project, and help construct operations. They MUST NOT maintain a parallel authoritative workflow or claim a transition the contract did not accept.

```text
ERC-8301 event or state
        ↓
TAS notification
        ↓
Agent Host executes local logic
        ↓
Agent authorizes an operation and the Host supplies the required inline
credential for that operation
        ↓
ERC-8301 state changes
```

Notification delivery is never itself a workflow transition.

### 8.4 Domain composition

The Workflow domain composes the other domains without merging their meanings:

```text
Membership
    was agentId a member?

Authorization
    which ERC-8004 wallet represented it?

Attribution
    did the historical Agent verifier attribute the output?

Data integrity
    did the retrieved bytes match the committed digest?

Acceptance
    did ERC-8301 accept the result?
```

Workflow rules may interpret TAWG-defined member roles and data categories. The common Profile does not define universal roles or stages.

### 8.5 Stage verification

A member `IAgentVerifier` verifies Agent-level attribution. A workflow stage may additionally require an Agent signature, deterministic recomputation, attested judgment, TEE attestation, ZK proof, or composite verification.

The workflow selects the verifier policy. Successful Agent attribution does not make every output acceptable to every stage.

### 8.6 Workflow source verification

Workflow Data MUST locate the full immutable Repository commit, `contracts/Workflow.sol`, and its compiler-produced `contracts/Workflow.metadata.json`. Repository location is discovery rather than proof.

A conforming verifier validates every compiler source hash, reproduces the compilation with the exact compiler and settings, and compares the resulting runtime code with the code at `workflowAddress`. The ordinary Solidity metadata commitment MUST remain in the deployed runtime bytecode. A claimed metadata reference without code reproduction is insufficient.

TAWG Workflow v0.1 uses a directly deployed, non-upgradeable implementation. TAS MUST NOT return guidance-bearing source as verified when compilation cannot be reproduced or runtime code does not match. Deployed bytecode and on-chain state remain authoritative.

### 8.7 Workflow updates

A Profile update may select a new workflow address or metadata and MUST advance the Profile version. An in-flight run SHOULD remain pinned to the context active when it began. Migration must be explicit and governed.

## 9. Lifecycle and Governance

```text
Charter definition and immutable repository commit
        ↓
Profile deployment with Charter reference
        ↓
Initial Agents, Data, and Workflow configuration
        ↓
Open member self-registration and Agent Host connection
        ↓
Workflow runs and evidence production
        ↓
Governed version updates
        ↓
Completion, migration, or retirement
```

The Profile defines who may update each domain and under which policy. This document fixes the historical invariant but not one universal governance mechanism:

> A governed update creates a new version and must never retroactively change the meaning of an earlier action, proof, vote, or workflow result.

Role Skills tell an Agent how to use the deployment-verified Workflow source and surrounding collaboration systems for an applicable role. Workflow-specific Role, State, Action, Gate, verification, and settlement behavior remains in `Workflow.sol`; Role Skill text and mutable chat cannot override it.

## 10. Historical Verification

### 10.1 Required context

A historical verification must contain or determine:

```text
chainId
tawgAddress
profileBlockNumber
workflowAddress
workflowRunId
```

and, when relevant:

```text
agentId
locator
digest
publishedAt
expiresAt
```

### 10.2 Verification sequence

1. Resolve Profile state at `(chainId, tawgAddress, profileBlockNumber)`.
2. Resolve the historical Charter reference and retrieve the referenced Charter when its meaning is relevant to the claim.
3. Confirm historical membership.
4. Resolve the historical ERC-8004 authorization context.
5. Resolve the historical member `IAgentVerifier`.
6. Verify Agent-level output attribution.
7. Resolve historical data-reading rules.
8. Retrieve the committed evidence.
9. Recompute and compare its digest.
10. Read the relevant historical ERC-8301 state.
11. Report whether the workflow accepted the output and transition.

### 10.3 Never a bare green

A verification result MUST preserve separate findings for:

```text
membership
authorization
attribution
availability
integrity
workflow acceptance
```

```text
valid member
+ attributable output
+ matching evidence digest
≠ factually correct output
≠ workflow acceptance
≠ completed TAWG
```

The final result envelope is a separate specification, but implementations may not erase these distinctions.

## 11. Logical Profile Interface

A conforming Profile MUST logically expose:

```text
Profile
├── version
│
├── Charter
│   ├── repository
│   ├── commit
│   └── path
│
├── Agents
│   ├── identityRegistry
│   ├── current member discovery
│   ├── membership check
│   ├── member JSON data
│   └── member IAgentVerifier
│
├── Data
│   ├── complete JSON data object
│   ├── data-key discovery
│   └── metadata for one data key
│
└── Workflow
    ├── ERC-8301 workflowAddress
    └── workflow JSON data
```

The exact getters, mutation methods, enumeration strategy, metadata encoding, events, governance behavior, and TAS projection are defined by the [TAWG Profile Contract](tawg/PROFILE.md).

JSON projections MUST return objects rather than escaped strings, preserve unknown fields, reject invalid metadata explicitly, and never override deployed behavior.

## 12. Reference Instances

Concrete operating models live under [`tawg/instances/`](tawg/instances/README.md) rather than in this
protocol document. An Instance applies the common TAWG identity, Repository, Data, and Workflow
rules to one specific collaboration model without making that model universal.

1. [Daily Contribution and Settlement](tawg/instances/daily-contribution/README.md) — the first
   v0.1 implementation and review package.

Each Instance owns its scenario, Roles, state machines, action gates, proof policy, settlement
rules, implementation status, and review material. The deployment-verified `Workflow.sol` and
on-chain state remain authoritative.

## 13. Conformance Expectations

### 13.1 Charter and repository

- A Profile exposes a content-addressed reference to the current immutable Charter version.
- Later repository commits do not reinterpret the referenced Charter version.
- A Charter amendment is authorized only by governance already in force and advances the Profile version.
- Earlier Charter versions remain historically resolvable.
- Mutable repository branch names are not sufficient references for inputs that affect evaluation or settlement.

### 13.2 Identity and metadata

- A Profile selects one ERC-8004 Identity Registry.
- The selected Identity Registry is immutable for a fixed `tawgAddress`.
- A member is identified by `agentId`, not an EOA.
- The current ERC-8004 `agentWallet` is the TAWG v0.1 Authentication Wallet.
- Wallet rotation preserves membership; subsequent EOA writes must match the newly resolved Authentication Wallet.
- Unknown metadata fields survive projection.
- Invalid JSON produces an explicit consistency error.

### 13.3 Data

- A TAWG may declare multiple keys and multiple sources per key.
- Agent credentials remain owned and persistently stored by the Agent Host, outside Profile and TAS persistent state. TAS may receive one inline credential for one sensitive MCP operation.
- A concrete item binds locator, digest, and expiry.
- Unavailability and integrity mismatch remain different findings.

### 13.4 Workflow and verification

- The Profile returns an ERC-8301 workflow address.
- Workflow Data locates one full Repository commit, `Workflow.sol`, and compiler-produced metadata.
- TAS returns guidance-bearing Workflow source only after reproducible compilation matches deployed runtime code.
- TAWG Workflow v0.1 does not use an upgradeable proxy or replaceable implementation.
- Historical runs resolve the workflow context active at their block.
- TAS does not maintain parallel authoritative workflow state.
- Attribution and stage acceptance remain separate.
- Verification results expose their basis and individual findings.

## 14. Non-Goals

This design does not define:

- a global TAWG registry;
- Profile implementation-specific storage slot layout;
- exact Git object encoding, alternative repository providers, or repository synchronization;
- one governance mechanism for every TAWG;
- protocol-wide member roles or stage names;
- one metadata schema for every TAWG;
- a mandatory data provider or permanent retention promise;
- generic payroll, settlement, or dispute rules;
- exact TAS MCP tool schemas and Host integration mechanics;
- Agent MCP authentication; or
- platform connection and delivery behavior.

## 15. Follow-up Specifications

1. **TAWG Repository protocol** — directory requirements, Git resolution, object formats, LFS and submodule policy, non-Git providers, and mirrors.
2. **Historical verification envelope** — structured Charter, identity, attribution, availability, integrity, correctness-evidence, and acceptance findings.
3. **Role Skill governance profile** — content addressing, activation, voting, emergency actions, and migration outside executable Workflow behavior.
4. **Private data access** — authorization for non-public sources.
5. **Workflow Solidity convention** — Role, State, Action, Gate, Transition, query, settlement, and marked-comment conventions inside `Workflow.sol`.
6. **Scenario workflows** — Daily Contribution first, then settlement and other TAWG types.

Transport and implementation follow-up designs are listed in [TAS.md](TAS.md).

## 16. Summary

```text
TAWG
├── Charter: why the TAWG exists and what it intends to achieve
├── On-chain domains
│   ├── Agents: who participates and how output is attributed
│   ├── Data: which named data can be read and verified
│   └── Workflow: which ERC-8301 rules govern the work
└── Repository
    ├── charter/
    ├── skills/
    ├── knowledge/
    ├── data/
    └── contracts/
```

The Profile anchors the current Charter, makes the current definition discoverable, and keeps historical state recoverable. Each Charter version is immutable and may be superseded only through the TAWG's governance rules. The rest of the repository may evolve as Agents collaborate. Agents execute work and write their own data. Workflow contracts accept or reject transitions. TAS makes these capabilities usable without becoming a parallel authority.
