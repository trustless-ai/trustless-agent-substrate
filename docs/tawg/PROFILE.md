# TAWG Profile Contract

| Item | Value |
|---|---|
| Status | Draft for review |
| Scope | TAWG Profile v0.1 Solidity interface, state, governance, events, and TAS read projection |
| Parent protocol | [TAWG Protocol Design](../TAWG.md) |
| Consumer | [TAS v0.1 Design](../TAS.md) |
| MCP projection | [TAS MCP Interface Design](../tas/MCP.md) |
| Workflow source | [TAWG Workflow Source and Verification](WORKFLOW.md) |

> **One Profile address identifies one TAWG. Its ERC-8004 Identity Registry never changes. Agent registration is open and permanent. Effective changes advance the Profile Version, while historical meaning remains selected by block.**

# 1. Glossary

**TAWG Profile.** The on-chain discovery and governance entry point identified by `tawgAddress`.

**Profile Version.** A monotonically increasing `uint256` revision for the active Profile state. It is a cache and change-detection marker, not a historical state selector.

**Identity Registry.** The immutable ERC-8004 Identity Registry selected when the Profile is created.

**TAWG Member.** A permanently registered Profile member identified by an ERC-8004 `agentId` from the Profile's immutable Identity Registry.

**Authentication Wallet.** The current wallet returned by the immutable Identity Registry's `getAgentWallet(agentId)`. The Profile does not copy this address into member state.

**Charter Reference.** The current immutable Git-backed reference formed by Repository locator, full commit hash, and Charter path.

**Governance.** The address currently authorized to mutate the Charter, Data, Workflow, and Governance domains. It may be an EOA, multisig, voting contract, custom Workflow, or another contract selected by the TAWG. It does not register, update, or remove Agents.

**JSON Data.** A UTF-8 JSON object stored as a Solidity `string` for extensible Agent, Data, or Workflow metadata.

# 2. Background

The TAWG protocol identifies a working group by `(chainId, tawgAddress)`. TAS starts from that address to discover the current Charter, Repository, Agents, Data definitions, Workflow, and governance context.

The protocol design already fixes three Profile domains:

```text
TAWG Profile
├── Agents
├── Data
└── Workflow
```

It also requires a governed, immutable Charter reference and historical interpretation at an exact chain block. This document converts that logical model into one Solidity interface and one TAS read projection.

# 3. Problem

The Profile must satisfy several requirements without becoming a universal collaboration or governance contract:

1. a client must discover the whole TAWG from one address;
2. an ERC-8004 `agentId` must retain one stable identity meaning inside that TAWG;
3. critical addresses and references must be typed rather than hidden in arbitrary JSON;
4. TAWG-specific Agent, Data, and Workflow metadata must remain extensible;
5. voting, multisig, and other governance mechanisms must remain replaceable;
6. each effective update must be visible and versioned;
7. historical verification must use the state active at a known block; and
8. TAS must project the contract through only `profile.get` and `profile.get_agent`.

# 4. Solution

## 4.1 Design decisions

TAWG Profile v0.1 uses a **typed core with JSON extensions**:

1. the Charter reference, Identity Registry, Agent IDs, Agent Verifiers, Workflow address, Governance, and Profile Version are typed Solidity state;
2. Agent, Data, and Workflow extensions are JSON Data;
3. one external Governance address authorizes Charter, Data, Workflow, and Governance mutations, while an Agent's current Authentication Wallet authorizes that Agent's registration and updates;
4. the Profile does not implement voting, multisig, role masks, or Workflow business rules;
5. the Identity Registry is immutable for the lifetime of the Profile;
6. the reference implementation is not upgradeable;
7. materially incompatible changes or Identity Registry migration require a new Profile address; and
8. current state is read through getters, while historical state is selected by an exact block and audited through events.

Alternative designs are rejected for v0.1:

1. separate Agents, Data, and Workflow contracts add deployment, resolution, and cross-contract consistency complexity before independent domain replacement is needed; and
2. a generic key-value contract would hide identity, verifier, governance, and workflow invariants inside opaque bytes.

## 4.2 Authority model

The Profile separates governed TAWG definition from Agent-controlled membership:

```text
Governance mechanism                         ERC-8004 Agent
voting | multisig | custom contract | EOA    current Authentication Wallet
                   ↓                                      ↓
               TAWG Profile ←─────────────────────────────┘
                   ↓
       Charter · Data · Workflow             permanent Agent registration
```

Charter, Data, Workflow, and Governance mutations require `msg.sender == governance`. `registerAgent` and `updateAgent` instead require `msg.sender` to equal the non-zero current Authentication Wallet returned by the immutable ERC-8004 Identity Registry for that `agentId`. Governance cannot register, rewrite, suspend, or remove an Agent unless Governance is itself that Agent's current Authentication Wallet.

Registration grants discoverability and permanent membership only. It grants no Workflow role or action authority. The deployed Workflow defines roles, action eligibility, gates, proof requirements, and settlement.

Governance migration is two-step:

1. current Governance nominates `pendingGovernance`;
2. the nominated address calls `acceptGovernance`; and
3. the accepted change advances the Profile Version.

A pending nomination is not yet part of the active TAWG definition and does not advance the Profile Version. Current Governance may replace or cancel the nomination. Governance cannot be renounced or set to the zero address.

## 4.3 Logical state

The Profile stores this logical state:

```text
Profile
├── version: uint256
├── governance: address
├── pendingGovernance: address
├── identityRegistry: IIdentityRegistry immutable
├── charter: CharterReference
├── agents
│   ├── permanent agentId enumeration
│   └── agentId → {isMember, data, agentVerifier}
├── data
│   ├── current key enumeration
│   └── key → {exists, data}
└── workflow
    ├── workflowAddress: IAgentWorkflow
    └── data
```

The storage layout and slot order are implementation details. A reference implementation may use arrays plus index mappings for current Agent and Data enumeration, but callers depend only on the interface and invariants in this document.

## 4.4 Solidity data types

The Profile defines:

```solidity
struct CharterReference {
    string repository;
    string commitHash;
    string path;
}
```

`repository` is the non-empty canonical locator for the current TAWG Repository. `commitHash` is a complete Git object ID represented as 40 or 64 lowercase hexadecimal characters without abbreviation. In v0.1, `path` MUST equal `charter/`.

The contract uses `string` for the commit hash rather than `bytes20` so Git SHA-1 and SHA-256 object formats can both be represented. Exact Git locator, object-format, path, LFS, and submodule rules belong to the TAWG Repository specification.

Agent, Data, and Workflow `data` values MUST encode one UTF-8 JSON object. Empty metadata is represented as `{}`, not an empty string, `null`, array, or scalar. Unknown properties are allowed and must survive client projection.

The Profile contract stores JSON bytes but does not implement a JSON parser. Governance tooling is responsible for submitting conforming JSON. TAS parses the value and returns `PROFILE_INCONSISTENT` if a selected Profile block contains invalid JSON.

Data keys use ASCII names matching:

```text
[a-z][a-z0-9._-]{0,63}
```

Keys are case-sensitive and canonical lowercase. This keeps key identity stable across Solidity, JSON, Git paths, and Agent tools.

## 4.5 Solidity interface

The v0.1 interface is `ITAWGProfile` and extends ERC-165:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IIdentityRegistry} from "agent-ercs/contracts/identity/ERC8004/IIdentityRegistry.sol";
import {IAgentVerifier} from "agent-ercs/contracts/verify/ERC8274/IAgentVerifier.sol";
import {IAgentWorkflow} from "agent-ercs/contracts/execution/ERC8301/IAgentWorkflow.sol";

interface ITAWGProfile is IERC165 {
    struct CharterReference {
        string repository;
        string commitHash;
        string path;
    }

    // Profile
    function version() external view returns (uint256);
    function governance() external view returns (address);
    function pendingGovernance() external view returns (address);
    function identityRegistry() external view returns (IIdentityRegistry);

    // Charter
    function getCharter() external view returns (CharterReference memory);

    // Agents
    function agentCount() external view returns (uint256);
    function agentIdAt(uint256 index) external view returns (uint256 agentId);
    function getAgent(uint256 agentId)
        external
        view
        returns (bool isMember, string memory data, IAgentVerifier agentVerifier);

    // Data
    function dataCount() external view returns (uint256);
    function dataKeyAt(uint256 index) external view returns (string memory key);
    function getData(string calldata key)
        external
        view
        returns (bool exists, string memory data);

    // Workflow
    function getWorkflow()
        external
        view
        returns (IAgentWorkflow workflowAddress, string memory data);

    // Agent-authorized updates
    function registerAgent(uint256 agentId, string calldata data, IAgentVerifier agentVerifier) external;
    function updateAgent(uint256 agentId, string calldata data, IAgentVerifier agentVerifier) external;

    // Governed updates
    function updateCharter(CharterReference calldata newCharter) external;
    function setData(string calldata key, string calldata data) external;
    function removeData(string calldata key) external;
    function updateWorkflow(IAgentWorkflow workflowAddress, string calldata data) external;

    // Governance migration
    function transferGovernance(address newGovernance) external;
    function cancelGovernanceTransfer() external;
    function acceptGovernance() external;
}
```

The complete Solidity interface also declares the events and custom errors in Sections 4.10 and 4.11. `supportsInterface(type(ITAWGProfile).interfaceId)` MUST return `true`. No separate string-valued ABI version is defined. The ERC-165 interface ID identifies ABI support; `version()` identifies mutable Profile state.

## 4.6 Creation

A Profile is created with:

1. non-zero Governance;
2. a non-zero deployed immutable Identity Registry contract;
3. a valid initial Charter Reference;
4. a non-zero deployed ERC-8301 Workflow contract; and
5. valid initial Workflow JSON Data.

The initial Profile Version is `1`. The Agent set starts empty so every member enters through the same self-registration rule. The initial Data set may be empty. Later Agent registrations and governed Data additions advance the version independently.

The v0.1 reference implementation is a non-upgradeable contract. A factory or immutable clone deployment MAY be used, but no governance action may replace the code that defines a fixed `tawgAddress`.

## 4.7 Read behavior

### 4.7.1 Version and core addresses

`version()` returns the active state revision. It never decreases and is never zero after successful creation.

`identityRegistry()` always returns the same non-zero ERC-8004 Registry. There is no setter. A new Registry requires a new Profile and therefore a new TAWG identity.

`governance()` returns the only address authorized to perform governed updates. `pendingGovernance()` returns zero when no transfer is pending.

### 4.7.2 Charter

`getCharter()` returns the complete active Charter Reference. Later Repository commits do not change that reference. A Charter amendment creates a new immutable commit and calls `updateCharter` through the Governance mechanism.

### 4.7.3 Agents

`agentCount()` and `agentIdAt(index)` enumerate every permanently registered member. Registration appends exactly once; enumeration order has no role, governance, evaluation, or settlement meaning.

`getAgent(agentId)` never reverts merely because the Agent is not a member:

```text
member
    isMember = true
    data = JSON object
    agentVerifier = non-zero IAgentVerifier

non-member
    isMember = false
    data = ""
    agentVerifier = address(0)
```

The Profile does not return the Authentication Wallet. A client resolves it at the same block from:

```text
identityRegistry().getAgentWallet(agentId)
```

### 4.7.4 Data

`dataCount()` and `dataKeyAt(index)` enumerate current Data definitions. Enumeration order is not stable across changes.

`getData(key)` returns `exists = false` and an empty data string for an absent key. The stored JSON describes categories, read locations, locator rules, and availability expectations. It does not contain or commit every concrete payload.

### 4.7.5 Workflow

`getWorkflow()` returns one non-zero ERC-8301 Workflow address and its current JSON Data. For a TAWG Workflow v0.1 deployment, the JSON Data contains a `source` object with the Repository locator, full immutable commit, `contracts/Workflow.sol` path, and compiler-produced `contracts/Workflow.metadata.json` path defined by [TAWG Workflow Source and Verification](WORKFLOW.md).

The Profile contract does not parse or verify those fields. TAS validates their shape, retrieves the pinned artifacts, reproduces the compilation, and compares runtime code before returning the source as verified. JSON metadata aids discovery but cannot override deployed Workflow behavior.

## 4.8 Update behavior

Every effective versioned update except a pending Governance nomination or cancellation:

1. applies the domain-specific authorization rule;
2. validates its typed inputs;
3. rejects a no-op;
4. changes one logical Profile domain atomically;
5. increments `version` exactly once; and
6. emits its domain event with the new version.

Different mutation calls in one transaction remain different Profile revisions. Historical interpretation is still selected by block; events provide the ordered revisions inside that block. Charter, Data, Workflow, and Governance changes use Governance authorization. Agent registration and updates use the Agent's current Authentication Wallet.

### 4.8.1 Charter update

`updateCharter` requires a complete, different Charter Reference. It may also move the TAWG Repository when the current Governance mechanism authorizes that change.

The Profile does not modify Git content. It only selects the new immutable reference.

### 4.8.2 Agent updates

`registerAgent` requires:

1. the `agentId` has never been registered in this Profile;
2. the immutable Identity Registry recognizes the ERC-721 token through `ownerOf(agentId)`;
3. the Registry returns a non-zero current Authentication Wallet for the `agentId`;
4. `msg.sender` equals that current Authentication Wallet;
5. `agentVerifier` is a non-zero deployed contract; and
6. `data` is a conforming JSON object.

Anyone may submit the transaction, but the EVM caller must be the current Authentication Wallet. TAS therefore constructs the transaction only from the inline private key whose derived address matches that wallet.

`updateAgent` requires an existing member and the same current-Authentication-Wallet check. It updates the member's complete JSON Data and Agent Verifier atomically. Partial JSON merge is not performed on-chain. ERC-8004 wallet rotation does not change membership; the newly resolved wallet authorizes later updates.

The Profile exposes no removal, suspension, or re-registration operation. Once registered, `isMember` remains true for the lifetime of the Profile. A Workflow may independently decide that a member has no active role or may not perform an action.

### 4.8.3 Data updates

`setData` is an upsert. A new key joins the current enumeration; an existing key keeps one enumeration entry and replaces its complete JSON Data. `removeData` requires the key to exist and removes it from current enumeration.

Concrete Workflow locators and commitments already recorded elsewhere are not changed by later Profile Data updates.

### 4.8.4 Workflow update

`updateWorkflow` atomically sets the Workflow address and complete Workflow JSON Data. Either value may change, but a call that changes neither is rejected.

The new Workflow address must contain deployed contract code. The Profile does not attempt to infer the custom Workflow's stage semantics or business correctness.

An in-flight run remains interpreted against the Profile and Workflow context active when it began unless the old Workflow rules explicitly authorize migration.

## 4.9 Version rules

Profile Version follows these exact rules:

| Action | Version effect |
|---|---|
| Successful creation | Set to `1` |
| Charter update | `+1` |
| Agent registration or update | `+1` |
| Data set or removal | `+1` |
| Workflow update | `+1` |
| Governance nomination or cancellation | No change |
| Governance acceptance | `+1` |
| Reverted or no-op call | No change |

Profile Version is not a semantic-version string, block number, event sequence shared with another contract, or substitute for historical state selection.

## 4.10 Events

The Profile emits:

```solidity
event ProfileCreated(
    uint256 indexed version,
    address indexed governance,
    address indexed identityRegistry
);

event CharterUpdated(
    uint256 indexed version,
    string oldRepository,
    string oldCommitHash,
    string oldPath,
    string newRepository,
    string newCommitHash,
    string newPath
);

event AgentRegistered(
    uint256 indexed version,
    uint256 indexed agentId,
    address indexed authenticationWallet,
    address agentVerifier,
    bytes32 dataHash
);

event AgentUpdated(
    uint256 indexed version,
    uint256 indexed agentId,
    address indexed authenticationWallet,
    address oldAgentVerifier,
    address newAgentVerifier,
    bytes32 oldDataHash,
    bytes32 newDataHash
);

event DataSet(
    uint256 indexed version,
    bytes32 indexed keyHash,
    string key,
    bytes32 oldDataHash,
    bytes32 newDataHash,
    bool created
);

event DataRemoved(
    uint256 indexed version,
    bytes32 indexed keyHash,
    string key,
    bytes32 oldDataHash
);

event WorkflowUpdated(
    uint256 indexed version,
    address indexed oldWorkflow,
    address indexed newWorkflow,
    bytes32 oldDataHash,
    bytes32 newDataHash
);

event GovernanceTransferStarted(
    address indexed governance,
    address indexed pendingGovernance
);

event GovernanceTransferCancelled(
    address indexed governance,
    address indexed cancelledGovernance
);

event GovernanceTransferred(
    uint256 indexed version,
    address indexed oldGovernance,
    address indexed newGovernance
);
```

Every hash for an existing JSON value is `keccak256(bytes(data))`. `bytes32(0)` denotes an absent old value during creation. `keyHash` is `keccak256(bytes(key))`. These event hashes identify the exact old and new stored bytes; they are not replacements for parsing the JSON or reading historical state.

Creation also emits the initial `CharterUpdated` and `WorkflowUpdated` values at version `1`, using empty or zero old values. This makes initial discovery fields visible to event indexers without treating creation as multiple revisions.

## 4.11 Errors

The reference interface uses stable custom errors shaped as:

```solidity
error UnauthorizedGovernance(address caller);
error ZeroAddress();
error AddressHasNoCode(address value);
error NoChange();
error InvalidCharterReference();
error InvalidDataKey(string key);
error AgentIdentityNotFound(uint256 agentId);
error AgentAlreadyMember(uint256 agentId);
error AgentNotMember(uint256 agentId);
error AgentWalletUnset(uint256 agentId);
error UnauthorizedAgent(uint256 agentId, address caller, address authenticationWallet);
error DataNotFound(bytes32 keyHash);
error IndexOutOfBounds(uint256 index, uint256 count);
error NotPendingGovernance(address caller);
```

An invalid JSON value is a conformance error detectable by clients. It is not a Solidity custom error in v0.1 because the Profile contract does not parse JSON.

## 4.12 Historical state

Historical Profile state is selected by block, not by Profile Version:

```text
(chainId, tawgAddress, blockNumber or blockHash)
```

At that block, a client reads the Profile getters and the immutable Identity Registry. Domain events link each Profile Version to its transaction and log order. An archive-capable RPC or another independently verifiable historical state source is required for old `eth_call` results.

If historical state cannot be retrieved, TAS returns `HISTORICAL_STATE_UNAVAILABLE`. It must not substitute current Profile state or reinterpret an old Workflow run using the latest Charter, membership, Data, Workflow, Governance, Verifier, or Authentication Wallet.

## 4.13 TAS read projection

TAS resolves every call in one exact chain block.

For `profile.get`, Profile Resolver:

1. validates ERC-165 support for `ITAWGProfile`;
2. reads `version`, current Governance, immutable Identity Registry, Charter, and Workflow at block `B`;
3. reads `agentCount` and every current `agentIdAt` at block `B`;
4. reads `dataCount`, every current `dataKeyAt`, and corresponding `getData` at block `B`;
5. parses all JSON Data as objects while preserving unknown fields; and
6. returns the resolved block number and hash with the Profile Version.

The logical result is:

```text
version
governance
charter
    repository
    commit
    path
agents
    identity_registry
    agent_ids
data
    <key> → JSON object
workflow
    address
    data → JSON object
```

For `profile.get_agent(agent_id)`, Profile Resolver at the same block `B`:

1. calls `getAgent(agent_id)`;
2. if the Agent is a member, parses member JSON and calls the immutable Identity Registry's `getAgentWallet(agent_id)` at `B`; and
3. returns the member's ERC-8274 `IAgentVerifier` without replacing it with an `IProofVerifier`.

A non-member is a successful result with `is_member = false`. Invalid JSON, zero required addresses, enumeration inconsistency, unsupported interface, or other impossible combinations return `PROFILE_INCONSISTENT`.

## 4.14 Security invariants

1. Identity Registry cannot change at a fixed `tawgAddress`.
2. Charter, Data, Workflow, and Governance writes require current Governance; Agent registration and updates require that Agent's current non-zero Authentication Wallet.
3. Governance transfer is two-step and cannot result in zero Governance.
4. A pending Governance nomination is operational state, not part of the active versioned definition returned by `profile.get`.
5. The Profile stores no private keys, provider tokens, private Repository credentials, or encrypted-data keys.
6. JSON cannot override typed addresses, membership, Charter reference, Governance, or Profile Version.
7. Agent membership is permanent, while authority to update that member follows the current ERC-8004 Authentication Wallet.
8. Agent Verifier attribution is distinct from Workflow acceptance.
9. The Profile does not execute arbitrary calls, delegatecalls, Repository code, Skill code, or JSON instructions.
10. The reference implementation is not upgradeable and exposes no code-replacement path.
11. Historical reads never fall forward to current state.

## 4.15 Conformance

A conforming implementation and test suite cover at least:

1. ERC-165 support for `ITAWGProfile`;
2. creation with version `1` and valid initial references;
3. rejection of zero Governance and of zero or code-less Identity Registry, Agent Verifier, and Workflow addresses;
4. immutable Identity Registry behavior;
5. Governance-only Charter, Data, Workflow, and Governance mutations plus two-step Governance transfer;
6. exact version advancement for every effective mutation;
7. no version change for nominations, cancellations, reverts, or no-ops;
8. append-only Agent enumeration across registration and update, with no removal or re-registration path;
9. ERC-8004 identity existence, non-zero Authentication Wallet, and caller-control checks on registration and update;
10. successful negative `getAgent` result for non-members;
11. Data key validation, upsert, enumeration, and removal;
12. Charter and Workflow update events;
13. exact JSON byte hashes in Agent, Data, and Workflow events;
14. current and historical TAS projections at pinned blocks;
15. Authentication Wallet resolution from ERC-8004 at the same block;
16. explicit rejection of invalid JSON projections; and
17. absence of upgrade, arbitrary-call, credential-storage, and Registry-migration paths.

## 4.16 Non-goals

TAWG Profile v0.1 does not define:

1. a global TAWG Registry or factory;
2. a universal voting, multisig, timelock, Workflow role, or action-eligibility policy;
3. business schemas for Agent, Data, or Workflow JSON Data beyond the minimum Workflow source locator defined by the TAWG Workflow specification;
4. actual DA payload storage or concrete Workflow commitments;
5. Repository provider authentication or Git synchronization;
6. Workflow execution, proof generation, verification, evaluation, or settlement;
7. Profile proxy upgrades or in-place Identity Registry migration; or
8. historical state snapshots duplicated inside Profile storage.
