# Trustless Agent Working Group Definition

**Status:** Draft — Review Required  
**Implementation status:** Blocked until this design is approved  
**Audience:** TAS maintainers, Agent SDK maintainers, TAWG designers, and reviewers  
**Last updated:** 2026-08-13

## 1. Purpose

This document proposes the canonical definition of a Trustless Agent Working Group (TAWG) for Trustless Agent Substrate (TAS).

A TAWG is identified by an on-chain Profile contract. The Profile defines three top-level domains:

1. **Agents** — who participates and how an output is attributed to a member Agent.
2. **Data** — which named data categories the TAWG uses and how those data can be read.
3. **Workflow** — which ERC-8301 implementation governs collaboration and how clients interpret it.

TAS exposes this on-chain definition through a mixed HTTP surface:

- read-only REST endpoints for deterministic discovery; and
- Streamable HTTP MCP endpoints for shared collaboration and Agent-scoped messaging.

This proposal intentionally stops at the protocol definition and logical interface level. It does not freeze the exact Solidity ABI, storage layout, event signatures, MCP tool schemas, or implementation plan.

No implementation should begin from this document until reviewers approve it.

## 2. Normative Language

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are to be interpreted as normative requirements of this design proposal.

## 3. Canonical TAWG Identity

A TAWG is canonically identified by:

```text
(chainId, tawgAddress)
```

- `chainId` is the decimal EIP-155 chain ID.
- `tawgAddress` is the address of the TAWG Profile contract on that chain.

The contract concept is still a **TAWG Profile contract**, because it describes a TAWG. External identifiers, URLs, API fields, and user-facing terminology MUST use `tawgAddress`, not `profileAddress` or `tawgProfileAddress`.

There is no required global or official TAWG registry. Anyone MAY deploy a conforming TAWG Profile contract. The pair `(chainId, tawgAddress)` is sufficient to identify it.

## 4. The Three-Domain Model

A TAWG Profile defines exactly three top-level domains:

```text
TAWG(chainId, tawgAddress)
├── agents
├── data
└── workflow
```

Equivalently:

```text
TAWG = Agents + Data + Workflow
```

Each domain answers a separate question:

| Domain | Question |
|---|---|
| `agents` | Who is a member, and how can a result be attributed to that member Agent? |
| `data` | Which named data does the TAWG use, where can it be read, and until when is it expected to remain available? |
| `workflow` | Under which on-chain rules do the members collaborate and progress work? |

The top-level domains are stable protocol structure. A particular TAWG extends their meaning through JSON metadata and a custom ERC-8301 workflow implementation.

## 5. Authority and State

### 5.1 The Profile contract is authoritative

The on-chain Profile contract is authoritative for:

```text
agents
    - ERC-8004 Identity Registry
    - current member set
    - member JSON metadata
    - each member's ERC-8274 IAgentVerifier

data
    - named data entries
    - JSON metadata for each entry
    - read locations, source types, and availability terms

workflow
    - ERC-8301 workflow address
    - JSON metadata describing the workflow
```

REST responses and MCP results are projections of, or runtime capabilities scoped by, this on-chain definition. They MUST NOT become a second authoritative copy of TAWG state.

### 5.2 Governed updates

A `tawgAddress` identifies a fixed Profile contract instance, but its state MAY change according to governance rules fixed by that contract. Governed changes may include:

- adding or removing a member;
- updating member metadata;
- changing a member's `IAgentVerifier`;
- adding or updating a named data entry;
- changing a data location or availability term; and
- updating the ERC-8301 workflow reference or workflow metadata.

Every normative Profile update MUST:

1. be authorized by rules already defined by the Profile contract;
2. advance the Profile `version`;
3. produce auditable on-chain state changes;
4. provide sufficient events or state history for reviewers to identify the change; and
5. preserve the ability to interpret historical behavior at a known block height.

A materially incompatible change MAY instead deploy a new Profile contract and therefore create a new `tawgAddress`.

### 5.3 Current discovery versus historical verification

Current discovery and historical verification use different identifiers:

```text
version
    = current discovery, cache invalidation, and REST consistency

blockNumber
    = authoritative historical state selection and recomputation
```

REST endpoints return only the latest Profile projection and its current `version`.

Historical verification does not require a historical REST API. A verifier that recomputes a historical claim is expected to know the relevant block number and read Profile state directly at that block through an archival-capable chain RPC.

Current configuration MUST NOT be used to reinterpret a historical run whose relevant Profile state is known at an earlier block.

## 6. Agents Domain

### 6.1 Purpose

The `agents` domain defines:

1. the ERC-8004 Identity Registry used by the TAWG;
2. the ERC-8004 Agent IDs that are TAWG members;
3. extensible JSON metadata for each member;
4. the ERC-8274 `IAgentVerifier` used to attribute output to each member; and
5. the identity path used to authorize the member's Agent-scoped MCP endpoint.

Its logical structure is:

```text
agents
├── identityRegistry
└── members[agentId]
    ├── data
    └── verifier
```

### 6.2 Member identity

A TAWG does not introduce a separate `memberId`. A member is identified by its ERC-8004 `agentId`.

The two relevant identity tuples are:

```text
TAWG member:
(chainId, tawgAddress, agentId)

ERC-8004 identity:
(chainId, identityRegistry, agentId)
```

The `identityRegistry` is read from the TAWG Profile and therefore does not appear in the TAS route.

The resolution path is:

```text
(chainId, tawgAddress, agentId)
        │
        ▼
TAWG Profile identityRegistry getter
        │
        ▼
ERC-8004 Identity Registry
        │
        ▼
ERC-8004 Agent identity
```

### 6.3 Member data

Each member has a JSON object named `data`. It contains TAWG-specific attributes and external platform identity mappings.

For example:

```json
{
  "roles": [
    "contributor",
    "reviewer"
  ],
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
  "display": {
    "name": "Example Agent"
  }
}
```

The Profile does not define a protocol-wide `roleMask`. `roles`, when present, is an ordinary field in that TAWG's metadata schema.

Different TAWGs MAY define different fields. For example:

```json
{
  "participantType": "proof-provider",
  "proofSystems": ["tee-dcap", "zkvm"],
  "region": "ap-southeast"
}
```

The common Profile surface MUST preserve the JSON object without discarding unknown fields.

### 6.4 External platform identities

External platform mappings associate an ERC-8004 Agent with its identity in Telegram, Discord, GitHub, or another platform.

Stable platform identifiers SHOULD be used as the authoritative mapping fields:

| Platform | Stable mapping fields | Display-only fields |
|---|---|---|
| Telegram | numeric `User.id`, `Chat.id`, optional `message_thread_id` | username, display name |
| Discord | Snowflake `User.id`, `Guild.id`, `Channel.id` | username, display name |
| GitHub | numeric account ID | login, display name |

A mutable username MUST NOT be the only identity key.

A metadata entry states that the TAWG recognizes a platform mapping. It does not, by itself, prove control of that external account. Admission, challenge, update, and revocation rules belong to the Profile's governance or a TAWG-specific binding policy.

### 6.5 ERC-8004 wallet authorization

The current EOA or account authorized to represent a member MUST NOT be duplicated as authoritative member metadata. It is resolved dynamically from the Profile-selected ERC-8004 Identity Registry:

```text
identityRegistry = TAWGProfile(tawgAddress).identityRegistry()
walletAddress    = ERC8004(identityRegistry).getAgentWallet(agentId)
```

The exact ERC-8004 getter name is determined by the canonical ERC-8004 ABI.

The identity roles are distinct:

```text
agentId
    = stable ERC-8004 Agent identity
    = stable TAWG member identity

walletAddress
    = current chain account authorized to represent the Agent

platform account ID
    = mapping to the Agent's identity on an external platform
```

An ERC-8004 wallet rotation changes the current authorization account without changing the `agentId` or TAWG membership.

### 6.6 ERC-8274 output attribution

Each member has an ERC-8274 `IAgentVerifier` address alongside its JSON `data`:

```text
members[agentId].data
members[agentId].verifier
```

The `IAgentVerifier` determines whether a result and its evidence satisfy the attribution rules for that Agent.

ERC-8274 has two distinct verifier layers:

```text
IAgentVerifier
    = stateful Agent authorization and proof routing
    = the member-level verifier returned by the Profile

IProofVerifier
    = stateless checker for a concrete proof system
    = selected or referenced through IAgentVerifier behavior
```

The standard member `verifier` getter and REST endpoint return the `IAgentVerifier` address. They MUST NOT silently return an underlying `IProofVerifier` instead.

A future endpoint MAY expose a deterministically resolvable `IProofVerifier`, but it must preserve the two-layer distinction.

### 6.7 Attribution is not correctness

The following claims are separate:

```text
Attribution:
"Was this output attributable to this Agent?"

Correctness:
"Was this output factually correct or acceptable under the task rules?"
```

A successful `IAgentVerifier` result does not imply that:

- the output is factually correct;
- an ERC-8301 stage accepted it;
- a workflow completed;
- a dispute window closed; or
- settlement is authorized.

Correctness or acceptance may require stage-specific verification, deterministic recomputation, reviewer judgment, a challenge workflow, or another verifier.

### 6.8 Logical Profile getter capabilities

The Profile contract MUST logically support:

```text
read identityRegistry
enumerate or discover current member agentIds
check whether agentId is a current member
read member data for agentId
read IAgentVerifier for agentId
```

This document does not freeze the exact Solidity function names, return structs, pagination model, or storage layout.

## 7. Data Domain

### 7.1 Purpose

The `data` domain defines:

1. the named categories of data used by the TAWG;
2. where each category can be read;
3. how a concrete item is located;
4. whether a category has multiple sources or mirrors; and
5. the availability period promised for the data.

Its logical structure is an extensible JSON key-value object:

```text
data
├── evidence
├── knowledgeBase
└── arbitrary TAWG-defined key
```

`evidence` and `knowledgeBase` are recommended semantic examples, not mandatory protocol fields.

- `evidence` covers records and artifacts produced for execution, verification, challenge, audit, or settlement.
- `knowledgeBase` covers knowledge and context used by Agents during execution.

`record` is not a separate recommended key because it overlaps semantically with `evidence`.

### 7.2 Extensible JSON key-value metadata

A Profile may expose data metadata such as:

```json
{
  "evidence": {
    "type": "github",
    "repository": "trustless-ai/example-tawg-data",
    "basePath": "evidence/",
    "pathTemplate": "{workflowRunId}/{evidenceId}.json",
    "retentionSeconds": 31536000
  },
  "knowledgeBase": {
    "type": "ipfs",
    "uri": "ipfs://bafy...",
    "expiresAt": "2027-02-13T00:00:00Z"
  }
}
```

The generic meaning is:

```text
data key
    = a named data category defined by the TAWG

data value
    = JSON metadata describing how that category is read
```

The generic Profile does not require one global data-provider schema.

### 7.3 Multiple named entries and multiple sources

A TAWG may define multiple named data entries, and one entry may define multiple read sources:

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
  },
  "knowledgeBase": {
    "sources": [
      {
        "type": "s3",
        "endpoint": "https://storage.example.com",
        "bucket": "example-tawg",
        "prefix": "knowledge/",
        "expiresAt": "2027-02-13T00:00:00Z"
      }
    ]
  }
}
```

Multiple sources MAY be mirrors, category-specific locations, or primary and fallback readers. The TAWG's metadata or workflow rules must state their selection semantics when it matters.

Possible source types include, without limitation:

- GitHub repositories;
- S3-compatible object stores;
- IPFS;
- Ethereum blobs;
- other blob DA systems; and
- TAWG-specific services.

The Profile does not require any source to preserve data permanently.

### 7.4 Read metadata, not bulk data

The Profile stores or references JSON metadata. It does not store the TAWG's full evidence or Knowledge Base on-chain.

```text
Profile data metadata
    = category, location, locator rules, and availability terms

External data source
    = actual evidence, Knowledge Base, or other content
```

### 7.5 Agent-owned writing and credentials

Agents are responsible for writing data and managing runtime credentials.

```text
Agent
├── manages provider credentials
├── writes to the selected source
├── receives a concrete locator
├── computes or obtains the required content digest
└── submits locator, digest, and expiry through the workflow
```

TAS is read-only with respect to external TAWG data:

```text
TAS
├── reads data metadata from the Profile
├── projects current metadata through REST
└── provides or composes the declared data-reading method
```

TAS MUST NOT be required to:

- upload TAWG data;
- create a GitHub commit;
- write an S3 object;
- pin IPFS content;
- submit an Ethereum blob;
- manage provider write accounts;
- retain or rotate an Agent's provider credentials;
- renew a storage agreement; or
- replicate all data automatically.

Runtime credentials MUST NOT be placed in public Profile metadata. GitHub personal access tokens, object-store secrets, pinning tokens, API keys, private keys, and encryption keys remain under Agent or Agent Host control.

If reading a private source also requires a credential, that access mechanism belongs to a TAWG-specific resolver or a future private-data design. It is not standardized here.

### 7.6 GitHub example

A TAWG may designate a GitHub repository and path convention:

```json
{
  "evidence": {
    "type": "github",
    "repository": "trustless-ai/example-tawg-data",
    "basePath": "evidence/",
    "pathTemplate": "{workflowRunId}/{evidenceId}.json",
    "retentionSeconds": 31536000
  }
}
```

The Agent independently:

1. manages its GitHub credential;
2. writes evidence to the repository;
3. creates a commit;
4. obtains the immutable commit SHA and path; and
5. submits the reference through the ERC-8301 workflow.

A concrete evidence reference may look like:

```json
{
  "dataKey": "evidence",
  "category": "agent-output",
  "locator": {
    "repository": "trustless-ai/example-tawg-data",
    "commit": "4f8c7d...",
    "path": "evidence/0xworkflow/0xevidence.json"
  },
  "digest": {
    "algorithm": "keccak-256",
    "value": "0x..."
  },
  "publishedAt": "2026-08-13T00:00:00Z",
  "expiresAt": "2027-08-13T00:00:00Z"
}
```

A concrete reference SHOULD bind an immutable commit SHA rather than only a mutable branch or tag.

### 7.7 Source metadata versus concrete evidence commitment

Profile metadata and a concrete workflow reference serve different purposes:

```text
Profile data metadata
    = category-level read location and locator rules

locator
    = location of one concrete item

digest
    = commitment to the exact bytes expected at that location

expiresAt
    = end of the promised availability period for that item
```

A later Profile update MUST NOT silently change the locator or digest already committed for a historical workflow input or output.

### 7.8 Availability and expiry

A TAWG does not promise permanent data retention.

`expiresAt` means:

> The end of the promised availability period, not a mandatory deletion time.

Given a deterministic `asOf` time:

| Condition | Result |
|---|---|
| `asOf <= expiresAt`, data is retrievable, digest matches | Continue verification |
| `asOf <= expiresAt`, data is not retrievable | Data availability failure |
| `asOf > expiresAt`, data is not retrievable | Expired and unverifiable; do not infer incorrect output |
| `asOf > expiresAt`, data remains retrievable, digest matches | Verification may continue |
| Data is retrievable but digest differs at any time | Integrity mismatch |

A Profile may specify a category-level `retentionSeconds`. A concrete workflow reference SHOULD freeze the resulting absolute `expiresAt` so historical verification does not depend on later Profile state.

`asOf` must come from an auditable context such as a block timestamp, workflow snapshot time, or another time explicitly selected by workflow rules.

### 7.9 Logical Profile getter capabilities

The Profile contract MUST logically support:

```text
read the complete current data JSON object
discover current data keys
read metadata for one data key
```

This document does not freeze whether the Solidity ABI returns embedded JSON, bytes, or a referenced document. The resulting common REST representation is a JSON object.

### 7.10 Agent SDK boundary

The Agent SDK is not currently required to implement a shared DA client or a generic data-source abstraction.

It is not required to provide:

- GitHub, S3, IPFS, Filecoin, or blob adapters;
- generic data writes or uploads;
- provider credential management;
- storage renewal; or
- replication.

Future SDK support may remain thin: typed Profile getters, JSON metadata access, block-specific reads, and composition with existing ERC-8004, ERC-8274, and ERC-8301 clients.

## 8. Workflow Domain

### 8.1 Purpose

The `workflow` domain defines:

1. the ERC-8301 workflow used by the TAWG;
2. the on-chain process under which members collaborate;
3. how clients interpret workflow inputs, stages, replies, proofs, and completion;
4. how workflow stages bind to named TAWG data; and
5. how clients discover source code and ABI information for the implementation.

Its logical structure is:

```text
workflow
├── workflowAddress
└── data
```

- `workflowAddress` is an ERC-8301-compatible workflow contract.
- `data` is extensible JSON metadata describing how this TAWG uses that implementation.

### 8.2 A custom ERC-8301 implementation

A Profile references a custom ERC-8301 workflow rather than reimplementing a universal state machine inside the Profile.

Example:

```json
{
  "workflowAddress": "0x8301...",
  "data": {
    "name": "Daily Contribution Workflow",
    "description": "Collect, freeze, verify, and aggregate daily contributions",
    "stages": {
      "open": {
        "description": "Accept contributions"
      },
      "snapshot": {
        "description": "Freeze the daily contribution set"
      },
      "verify": {
        "description": "Retrieve evidence and verify committed digests"
      },
      "aggregate": {
        "description": "Produce the daily summary"
      },
      "completed": {
        "description": "Finalize the run"
      }
    },
    "dataBindings": {
      "input": "knowledgeBase",
      "output": "evidence"
    }
  }
}
```

Stage names, stage numbers, transition meanings, and business terms are TAWG-specific. They are not protocol-wide Profile enums.

### 8.3 ERC-8301 interface versus implementation semantics

ERC-8301 provides shared workflow, task, reply, proof, result, and hash structures. It enables clients to read and drive a conforming workflow.

The implementation determines:

- its stages;
- transition rules;
- which member may act;
- accepted inputs;
- reply requirements;
- proof requirements;
- timeout and challenge behavior;
- completion and failure conditions; and
- settlement triggers.

TAS and a generic client MUST NOT infer business meaning from a stage number alone.

### 8.4 On-chain workflow authority

In Trustless mode, the ERC-8301 workflow contract is authoritative for run, task, reply, proof, and completion state.

TAS MAY:

- read workflow state;
- project it through REST;
- expose MCP collaboration tools;
- deliver workflow events as notifications;
- help construct standard ERC-8301 operations;
- broadcast already authorized or signed transactions; and
- query receipts.

TAS MUST NOT:

- maintain a parallel authoritative workflow state;
- decide the next stage without on-chain authority;
- claim that a workflow completed when the contract does not;
- produce a member's business result;
- sign for a member; or
- treat notification delivery as an on-chain transition.

The execution loop is:

```text
ERC-8301 event or state
        │
        ▼
TAS notification
        │
        ▼
Agent inbox
        │
        ▼
Agent Host executes the task
        │
        ▼
Agent authorizes or signs an operation
        │
        ▼
ERC-8301 state changes
```

### 8.5 Relationship to Agents

The following checks are distinct:

```text
Membership
    = Was agentId a TAWG member?

Authorization
    = Which ERC-8004 wallet could represent that Agent?

Attribution
    = Did the historical IAgentVerifier attribute the output to that Agent?

Acceptance
    = Did the ERC-8301 workflow accept the output and transition?
```

Workflow rules MAY interpret TAWG-specific member data, including a `roles` field, but the common Profile does not define a fixed role mask.

### 8.6 Relationship to Data

The Profile's `data` domain states how a named category can be read. Workflow rules state which category a stage consumes or produces. A concrete task or reply binds an actual locator, digest, and expiry.

```text
Profile data metadata
    = where a category can be read

Workflow rule
    = where the category is used

Concrete task or reply
    = exact locator, digest, and expiresAt for this run
```

Example workflow metadata:

```json
{
  "dataBindings": {
    "contributionInput": {
      "dataKey": "evidence",
      "category": "contribution"
    },
    "verificationOutput": {
      "dataKey": "evidence",
      "category": "verification-result"
    },
    "agentContext": {
      "dataKey": "knowledgeBase"
    }
  }
}
```

Agents write their own external data. TAS provides the declared read path and does not write evidence on their behalf.

### 8.7 Relationship to ERC-8274

The member's `IAgentVerifier` verifies Agent-level output attribution. A workflow stage may require additional result or proof validation.

```text
Member IAgentVerifier
    = Is this output attributable to this Agent?

Stage verifier policy
    = Does this output satisfy the proof or acceptance rule for this stage?
```

A stage may use signatures, judgment attestations, deterministic recomputation, TEE proofs, ZK proofs, or composite verification. A configured member verifier does not make every output acceptable to every stage.

### 8.8 Workflow implementation, source, and ABI metadata

`workflow.data` MAY describe the implementation repository and ABI:

```json
{
  "name": "Daily Contribution Workflow",
  "description": "Collect, freeze, verify, and aggregate daily contributions",
  "implementation": {
    "repository": {
      "url": "https://github.com/trustless-ai/example-workflows",
      "commit": "4f8c7d...",
      "sourcePath": "src/DailyContributionWorkflow.sol"
    },
    "abi": {
      "uri": "https://raw.githubusercontent.com/trustless-ai/example-workflows/4f8c7d.../abi/DailyContributionWorkflow.json",
      "digest": {
        "algorithm": "sha2-256",
        "value": "..."
      }
    },
    "build": {
      "compiler": "solc",
      "compilerVersion": "0.8.30",
      "evmVersion": "cancun",
      "settingsUri": "https://example.com/build-settings.json"
    },
    "deployment": {
      "transactionHash": "0x...",
      "runtimeBytecodeHash": "0x..."
    }
  }
}
```

A repository reference SHOULD bind an immutable commit. An ABI URI SHOULD include a digest. A small ABI MAY be embedded directly instead.

These fields support discovery and integrity checks, but metadata alone does not prove that repository source produced the deployed bytecode. Assurance levels differ:

```text
repository URL
    = discoverability claim

repository + immutable commit
    = fixed claimed source revision

ABI URI + digest
    = fixed claimed ABI content

verified source, reproducible build, runtime bytecode hash
    = stronger link to deployed code
```

The actual behavior of `workflowAddress` is authoritative. JSON stage descriptions, source references, and ABI metadata MUST NOT override deployed bytecode. A mismatch should be surfaced as a Profile consistency problem.

### 8.9 Workflow updates and in-flight runs

A Profile MAY update its workflow address or metadata through its predefined governance. Every update advances the Profile `version`.

A workflow run SHOULD remain bound to the Profile and workflow context active when it began. Current metadata MUST NOT silently reinterpret an in-flight or historical run. Explicit migration, if supported, is governed by the Profile and workflow implementation rather than TAS.

Historical recomputation uses the known block number to recover the correct Profile and workflow context.

### 8.10 Logical Profile getter capabilities

The Profile contract MUST logically support:

```text
read current ERC-8301 workflowAddress
read current workflow JSON data
```

This document does not freeze exact Solidity names, structs, or encoding.

## 9. Mixed REST and MCP Surface

### 9.1 Route root

All TAS routes are scoped by:

```text
/{chainId}/{tawgAddress}
```

A deployment therefore exposes URLs such as:

```text
https://{tasHost}/{chainId}/{tawgAddress}/...
```

### 9.2 Route tree

The proposed route tree is:

```text
/{chainId}/{tawgAddress}
│
├── GET /
│
├── /mcp
│
├── /agents
│   ├── GET /
│   └── /{agentId}
│       ├── GET /
│       ├── GET /data
│       ├── GET /verifier
│       ├── GET /wallet
│       └── /mcp
│
├── /data
│   ├── GET /
│   └── GET /{dataKey}
│
└── /workflow
    ├── GET /
    ├── GET /address
    ├── GET /data
    └── future read-only workflow subresources
```

The routing rule is:

> A path ending in `/mcp` is a Streamable HTTP MCP endpoint. The defined `GET` paths are read-only REST resources.

MCP `GET`, `POST`, and `DELETE` behavior follows the MCP Streamable HTTP transport and MUST NOT be confused with REST resource semantics.

### 9.3 TAWG root REST response

```http
GET /{chainId}/{tawgAddress}
```

returns a compact discovery view of the latest Profile:

```json
{
  "chainId": "1",
  "tawgAddress": "0x...",
  "version": "7",
  "agents": {
    "identityRegistry": "0x...",
    "count": 5
  },
  "data": {
    "keys": ["evidence", "knowledgeBase"]
  },
  "workflow": {
    "workflowAddress": "0x8301..."
  },
  "endpoints": {
    "mcp": "/1/0x.../mcp",
    "agents": "/1/0x.../agents",
    "data": "/1/0x.../data",
    "workflow": "/1/0x.../workflow"
  }
}
```

This is a discovery view, not a replacement for the domain-specific getters.

### 9.4 TAWG MCP endpoint

```text
/{chainId}/{tawgAddress}/mcp
```

is the shared TAWG MCP endpoint. It supports:

- shared collaboration capabilities;
- discovery of TAWG runtime capabilities;
- shared workflow context;
- shared data definition access;
- workflow-operation assistance;
- shared workflow notifications; and
- future TAWG-specific shared tools.

It follows MCP Streamable HTTP and may use `MCP-Session-Id`. A normal browser-style `GET` must not be expected to return the REST TAWG document from this path.

### 9.5 Agents REST endpoints

```http
GET /{chainId}/{tawgAddress}/agents
GET /{chainId}/{tawgAddress}/agents/{agentId}
GET /{chainId}/{tawgAddress}/agents/{agentId}/data
GET /{chainId}/{tawgAddress}/agents/{agentId}/verifier
GET /{chainId}/{tawgAddress}/agents/{agentId}/wallet
```

The aggregate member response may contain:

```json
{
  "chainId": "1",
  "tawgAddress": "0x...",
  "version": "7",
  "agentId": "42",
  "identityRegistry": "0x...",
  "walletAddress": "0x...",
  "data": {
    "roles": ["contributor"],
    "platforms": {
      "telegram": {
        "accountId": "123456789"
      }
    }
  },
  "verifier": "0x..."
}
```

`walletAddress` is resolved from ERC-8004 and is not duplicated Profile metadata. `verifier` is the ERC-8274 `IAgentVerifier` address.

### 9.6 Agent MCP endpoint

```text
/{chainId}/{tawgAddress}/agents/{agentId}/mcp
```

is the MCP endpoint provided to that Agent within that TAWG. It is TAWG-scoped and Agent-scoped, not the Agent's global MCP endpoint.

Its core purpose is messaging:

```text
messages.receive
messages.ack
messages.send
```

It also reserves a `connections.*` namespace for temporary external-platform connections, subject to Section 10.

The caller must be authorized by the current ERC-8004 wallet for the route's `agentId`, or by a valid delegated authorization rooted in that wallet. The exact authentication protocol is not frozen here.

The same ERC-8004 Agent in two TAWGs has two independent Agent MCP contexts:

```text
/{chainId}/{tawgA}/agents/{agentId}/mcp
/{chainId}/{tawgB}/agents/{agentId}/mcp
```

They may have different inboxes, platform bindings, workflow contexts, and authorization scopes.

### 9.7 Data REST endpoints

```http
GET /{chainId}/{tawgAddress}/data
GET /{chainId}/{tawgAddress}/data/{dataKey}
```

They return the latest data metadata, not provider write credentials and not necessarily the external content itself.

Example single-key response:

```json
{
  "chainId": "1",
  "tawgAddress": "0x...",
  "version": "7",
  "key": "evidence",
  "metadata": {
    "type": "github",
    "repository": "trustless-ai/example-tawg-data",
    "basePath": "evidence/",
    "pathTemplate": "{workflowRunId}/{evidenceId}.json",
    "retentionSeconds": 31536000
  }
}
```

### 9.8 Workflow REST endpoints

```http
GET /{chainId}/{tawgAddress}/workflow
GET /{chainId}/{tawgAddress}/workflow/address
GET /{chainId}/{tawgAddress}/workflow/data
```

The aggregate response includes the latest `workflowAddress`, JSON data, and Profile `version`.

Future read-only routes may include:

```text
/workflow/runs/{workflowRunId}
/workflow/tasks/{taskHash}
/workflow/replies/{replyHash}
```

Those routes would read ERC-8301 authority. Their exact response schemas are not frozen here.

### 9.9 URL parameter rules

- `chainId` is an unsigned decimal EIP-155 chain ID, not a chain name.
- `tawgAddress` is an EVM contract address and is normalized as a 20-byte value.
- `agentId` is the unsigned decimal ERC-8004 Agent ID, not an EOA address.
- `dataKey` is a URL-safe TAWG-defined JSON key.

For example:

```text
/agents/42
```

is correct for ERC-8004 Agent ID 42. A wallet address in the `{agentId}` position is incorrect.

### 9.10 REST is read-only

The standard REST surface defined here uses `GET` only. Profile mutations, workflow actions, and runtime operations are performed through:

- on-chain contract calls;
- Agent SDK clients;
- TAWG or Agent MCP tools; or
- a separately approved transaction-relay design.

This document does not create parallel REST write semantics.

## 10. Platform Connection Boundary

Platform Connection details belong in a separate **Platform Connection and Messaging Protocol** design. This section records only decisions already agreed so they are not lost.

### 10.1 Agreed properties

A Platform Connection links TAS to an external messaging platform on behalf of one Agent in one TAWG.

It is:

- private;
- off-chain;
- temporary;
- longer-lived than an individual MCP connection when needed; and
- not part of the canonical TAWG or member identity.

Platform tokens, connection identifiers, Telegram offsets, Discord session data, heartbeats, and resume state MUST NOT be stored in the TAWG Profile.

The Agent provides the platform token to TAS through its Agent-scoped MCP. Creating or managing the connection requires authorization rooted in the current ERC-8004 wallet for that `agentId`.

The Agent MCP reserves:

```text
connections.*
```

for connection lifecycle operations, and:

```text
messages.receive
messages.ack
messages.send
```

for messaging.

When the Agent's MCP connection drops, TAS MAY keep the Platform Connection alive for a bounded grace period and buffer incoming messages. The current target upper bound is approximately one day, aligned with the intended short platform-delivery recovery window. If the Agent does not reconnect before expiry, TAS may disconnect the platform listener and destroy temporary credentials and resume state.

A Platform Connection is therefore not permanent and does not require an on-chain identity.

### 10.2 TODO — separate protocol design

The future Platform Connection and Messaging Protocol MUST decide:

- exact `connections.*` MCP tool names and schemas;
- token provisioning and transport protection;
- temporary credential storage and destruction;
- Telegram webhook versus long-polling behavior;
- Discord Gateway heartbeat, sequence persistence, and resume behavior;
- connection state machine;
- exact grace-period calculation;
- message-buffer capacity and retention;
- redelivery and acknowledgment behavior;
- multiple-TAS-instance ownership and leases;
- failure recovery; and
- ERC-8004 wallet rotation during an active connection.

These items are intentionally not frozen by the TAWG definition.

## 11. Historical Recompute and Verification

### 11.1 Required historical context

A historical verification input must contain or deterministically identify:

```text
chainId
tawgAddress
profileBlockNumber
workflowAddress
workflowRunId
```

and, as required:

```text
agentId
locator
digest
publishedAt
expiresAt
```

At `profileBlockNumber`, the verifier resolves:

```text
Profile state
├── identityRegistry
├── membership
├── member data
├── member IAgentVerifier
├── TAWG data metadata
└── workflowAddress and workflow data
```

### 11.2 Verification sequence

A complete historical check follows this logical sequence:

1. Resolve the TAWG at `(chainId, tawgAddress, profileBlockNumber)`.
2. Confirm that `agentId` was a member.
3. Resolve the historical ERC-8004 identity context.
4. Resolve the historical member `IAgentVerifier`.
5. Verify output attribution.
6. Resolve the historical data-reading rules.
7. Retrieve the concrete evidence from its committed locator.
8. Recompute and compare its content digest.
9. Read the relevant ERC-8301 workflow state.
10. Evaluate whether the workflow accepted the output and transition.

### 11.3 Never a bare green

A verifier must not collapse all checks into an unexplained `verified: true`.

At minimum, it should preserve separate findings for:

```text
membership validity
authorization validity
output attribution
evidence availability
evidence integrity
workflow acceptance
```

For example:

```text
valid member
+ attributable output
+ matching evidence digest
≠ factually correct output
≠ workflow acceptance
≠ completed TAWG
```

The final verification-result envelope is outside this document, but implementations must preserve these trust boundaries.

## 12. JSON Metadata Rules

The following logical values have a JSON object representation:

```text
agents/{agentId}/data
data
workflow/data
```

The REST projection MUST:

- return a JSON object rather than a JSON-escaped string;
- preserve unknown TAWG-defined fields;
- avoid silently renaming or deleting fields; and
- return an explicit error when metadata cannot be parsed.

If metadata conflicts with on-chain contract behavior, the deployed contract behavior is authoritative, and the mismatch should be reported as a Profile consistency problem.

The Profile ABI design must later decide:

- whether on-chain metadata uses `string`, `bytes`, or a URI plus digest;
- whether canonical JSON is required;
- maximum metadata size;
- update event structure; and
- rules for externally referenced metadata.

## 13. REST Consistency and Errors

### 13.1 Version consistency

Every Profile-definition REST response returns the current Profile `version`.

A response that aggregates multiple domains MUST reflect one consistent version. It must not combine Agent state from one version with Data or Workflow state from another.

TAS MAY cache Profile reads, but it must:

- scope caches by `(chainId, tawgAddress, version)`;
- detect version changes;
- avoid reusing the same address across chains;
- not claim that stale cached state is current when current state cannot be confirmed; and
- return an availability error when the chain RPC cannot establish the latest state.

Finality depth and cache TTL are TAS implementation concerns and are not frozen here.

### 13.2 REST errors

The read-only REST API should distinguish at least:

| HTTP status | Meaning |
|---|---|
| `400` | Invalid chain ID, address, Agent ID, or data key format |
| `404` | TAWG, member, data key, or workflow does not exist |
| `409` | Profile state is internally inconsistent |
| `422` | On-chain metadata exists but is not valid under the expected JSON boundary |
| `502` | An upstream chain RPC returned an invalid response |
| `503` | The required chain RPC is temporarily unavailable |

Example:

```json
{
  "error": {
    "code": "MEMBER_NOT_FOUND",
    "message": "Agent 42 is not a member of this TAWG"
  }
}
```

MCP endpoints use MCP and JSON-RPC error semantics. MCP protocol errors MUST NOT be disguised as REST business responses.

## 14. Responsibility Boundaries

### 14.1 TAWG Profile

The Profile defines:

```text
who participates
which data can be read and how
which ERC-8301 rules govern collaboration
```

It does not:

- run Agents;
- hold Agent private keys;
- write Agent evidence;
- manage provider credentials;
- guarantee permanent external data retention;
- prove that attributed output is factually correct; or
- run an off-chain scheduler.

### 14.2 Agent

The Agent or Agent Host:

- executes tasks;
- manages external-data credentials;
- writes its own external data;
- commits locators, digests, and expiries through the workflow;
- authorizes its Agent MCP; and
- provides temporary messaging-platform credentials when it chooses to use a Platform Connection.

### 14.3 TAS

TAS:

- resolves current Profile state;
- projects current state through REST;
- provides the shared TAWG MCP;
- provides Agent-scoped MCP messaging;
- provides or composes declared read paths;
- delivers recoverable notifications; and
- may help construct or relay already authorized chain operations.

TAS does not:

- become a second workflow state machine;
- write TAWG evidence on behalf of an Agent;
- manage an Agent's data-provider credentials;
- sign for an Agent; or
- decide business correctness.

### 14.4 ERC composition

```text
ERC-8004
    = Agent identity and current wallet authorization

ERC-8274 IAgentVerifier
    = member-level output attribution and proof routing

ERC-8274 IProofVerifier
    = concrete underlying proof-system validation

ERC-8301
    = on-chain collaboration workflow and run state
```

These responsibilities remain separate even when a TAS endpoint composes them for convenience.

## 15. Logical Contract Surface

Without fixing exact Solidity ABI, a conforming TAWG Profile must logically expose:

```text
Profile
├── current version
│
├── Agents
│   ├── identityRegistry
│   ├── member discovery/enumeration
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

The Solidity design must later select exact getters, enumeration strategy, metadata encoding, governance methods, and events.

## 16. Conformance Scenarios for Future Implementation

This document is not an implementation plan. An eventual implementation should demonstrate at least the following behaviors.

### 16.1 Identity and membership

- A Profile selects an ERC-8004 Registry.
- A member is identified by `agentId`, not by an EOA.
- Wallet rotation preserves member identity.
- A non-member cannot use a member Agent MCP.
- Historical output uses historical Registry and verifier state.

### 16.2 Metadata

- Member data can include Telegram, Discord, and custom attributes.
- Unknown JSON fields survive a read round trip.
- Invalid metadata returns an explicit error.
- Profile version changes invalidate current REST caches.

### 16.3 Data

- A TAWG can define multiple data keys.
- `data.evidence` can define multiple sources.
- An Agent writes data using provider credentials that remain under Agent or Agent Host control.
- TAS exposes no required external-data write capability.
- Expired, unavailable content is classified as unverifiable rather than as a digest mismatch.
- Retrieved content with a wrong digest is classified as an integrity mismatch.

### 16.4 Workflow

- A Profile returns an ERC-8301 workflow address.
- Workflow data can include repository, immutable commit, source path, ABI URI, and ABI digest.
- REST returns the latest workflow definition and Profile version.
- Historical runs resolve old Profile state by block number.
- TAS does not maintain parallel authoritative workflow state.

### 16.5 Routing

- `/{chainId}/{tawgAddress}/mcp` is a TAWG MCP endpoint.
- `/{chainId}/{tawgAddress}/agents/{agentId}/mcp` is an Agent MCP endpoint.
- Other routes frozen by this design are read-only REST endpoints.
- One Agent in multiple TAWGs receives separate Agent MCP contexts.
- MCP and REST errors retain their respective protocol semantics.

## 17. Non-Goals

This design does not define:

- the exact TAWG Profile Solidity ABI;
- contract storage layout or gas optimization;
- a global TAWG registry;
- fixed protocol-wide member roles;
- a universal metadata schema for every TAWG;
- a mandatory data provider;
- permanent data availability;
- a shared Agent SDK DA client;
- TAS external-data writes;
- generic settlement or dispute rules;
- a universal ERC-8301 stage model;
- exact TAWG MCP workflow tools;
- exact Agent MCP authentication;
- exact `connections.*` tools; or
- the full Platform Connection and Messaging Protocol.

## 18. Effect on Existing TAS v0.1 Assumptions

If approved, this design supersedes the following earlier prototype assumptions:

1. **Identity-Registry route root**

   Earlier:

   ```text
   /{chainId}/{identityRegistry}/agents/{agentId}/mcp
   ```

   Proposed:

   ```text
   /{chainId}/{tawgAddress}/mcp
   /{chainId}/{tawgAddress}/agents/{agentId}/mcp
   ```

   The Profile provides the Identity Registry.

2. **Single data source or shared DA client**

   A TAWG now defines extensible named data metadata, with optional multiple sources per key. Agents manage writes and credentials. TAS provides reads. The Agent SDK is not required to implement a shared DA layer.

3. **Minimal Profile content**

   The Profile is explicitly organized as `agents`, `data`, and `workflow`. Member data and member `IAgentVerifier` are first-class fields, as are data metadata and ERC-8301 workflow metadata.

4. **MCP-only discovery**

   The TAWG now has a mixed surface: read-only REST for current definition discovery and MCP for shared collaboration and Agent-scoped messaging.

Until reviewers approve this document, existing code and documents remain descriptive of the current implementation baseline. Approval should be followed by a separate implementation plan and explicit updates to affected TAS documentation.

## 19. Open Follow-Up Designs

Approval of this definition does not resolve the following work:

1. **TAWG Profile Solidity interface** — exact ABI, metadata encoding, governance, versioning, events, enumeration, and upgrade rules.
2. **REST API schema** — complete OpenAPI contract, pagination, cache headers, and exact error bodies.
3. **TAWG MCP capability design** — exact shared tools, resources, authorization, and transaction-relay boundary.
4. **Platform Connection and Messaging Protocol** — `connections.*`, messaging delivery, temporary credentials, grace periods, Telegram, Discord, and multi-instance coordination.
5. **Historical verification envelope** — a non-bare-green result format preserving membership, attribution, availability, integrity, and workflow acceptance.
6. **Private data access** — read authorization when a declared data source is not public.
7. **Profile governance and migration** — admission, removal, multi-domain updates, incompatible changes, and in-flight workflow migration.

## 20. Summary

A TAWG is an on-chain collaboration definition identified by:

```text
(chainId, tawgAddress)
```

Its Profile contract defines:

```text
TAWG
├── Agents
│   ├── ERC-8004 Identity Registry
│   ├── ERC-8004 member agentIds
│   ├── member JSON data
│   └── member ERC-8274 IAgentVerifier
│
├── Data
│   └── extensible named JSON metadata for read locations and availability
│
└── Workflow
    ├── custom ERC-8301 workflowAddress
    └── workflow JSON data, including optional source and ABI metadata
```

TAS projects the latest definition through read-only REST endpoints and exposes two MCP contexts:

```text
/{chainId}/{tawgAddress}/mcp
    = shared TAWG collaboration

/{chainId}/{tawgAddress}/agents/{agentId}/mcp
    = messaging and temporary connection capabilities for one member Agent
```

Agents manage their own external-data writes and provider credentials. TAS provides data reads and messaging connectivity. Historical recomputation uses a known block number to recover the exact Profile, identity, verifier, data, and workflow context in force at that time.

In one sentence:

> A TAWG Profile defines who collaborates, how their output is attributed, which data can be read, and which ERC-8301 rules govern the collaboration; TAS makes that definition discoverable and operational without becoming a parallel authority.

