# TAWG Workflow Design Pattern Research

Date: 2026-08-19

> **Status:** Research record. This note evaluates external patterns and proposes a design direction. It does not define the normative TAWG Workflow format or TAS MCP interface.

> **Decision after research:** The project selected a simpler contract-first design rather than this note's intermediate Workflow Model recommendation. One guidance-commented `Workflow.sol` is the sole manually maintained Workflow specification; compiler-produced metadata and reproducible runtime-code comparison bind it to the deployed contract. No persistent Workflow Descriptor is used. See the normative [TAWG Workflow Source and Verification](../tawg/WORKFLOW.md).

## 1. Research question

TAWG needs a repeatable way to design custom ERC-8301 Workflows so that:

1. roles, states, actions, transitions, gates, verification, and terminal conditions are explicit;
2. an Agent can discover the current on-chain state and determine what it may or should do;
3. a human-readable, machine-readable Workflow Descriptor accompanies the deployed contract;
4. Solidity, the Descriptor, tests, and Agent instructions do not silently diverge; and
5. TAS can project the result without becoming a second workflow engine or authority.

This research compares the current ERC-8301 sources with SCXML, XState, BPMN, DMN, OpenZeppelin access control, MCP, and A2A.

## 2. Executive conclusion

No reviewed framework should be adopted as the TAWG on-chain runtime.

The useful design is a small TAWG-specific declarative model inspired by statecharts, compiled into multiple artifacts:

```text
Charter
    human intent, invariants, governance, settlement meaning
        ↓
Workflow Model
    machine-checkable roles, states, actions, transitions, gates,
    verification policies, data schemas, and Skill references
        ↓ one reviewed generation pipeline
    ├── Solidity Workflow skeleton and generated topology
    ├── Workflow Descriptor JSON for Agent discovery
    ├── ABI/client metadata
    ├── diagrams and documentation
    └── transition, authorization, and conformance tests
```

The Charter should not be the only code-generation input. Natural language is necessary for intent but cannot prove that two separately AI-generated artifacts have identical behavior. The intermediate Workflow Model should be the structural single source of truth. AI may draft or revise that model and implement explicitly named custom gate hooks, but deterministic tooling must validate and generate the shared structure.

The deployed ERC-8301 contract remains authoritative. The Descriptor is a pinned projection of the intended behavior, not an off-chain override. The contract should expose or immutably bind the canonical Workflow Model digest and schema version so TAS can detect a mismatched Descriptor.

SCXML and XState contribute useful vocabulary and development-time tooling. BPMN and DMN contribute useful review notations. OpenZeppelin contributes implementation components for coarse authorization and administration. None provides the required combination of ERC-8004 Agent identity, ERC-8301 evidence chains, on-chain deterministic gates, proof policy, recomputation, settlement, and Agent-facing action guidance.

## 3. ERC-8301 baseline and source drift

### 3.1 Current interface shape

At the current ERC-8301 PR head, `IAgentWorkflow` is a contract-driven finite state machine with:

- `run(inputHash, input, expiresAt)`;
- `result(workflowRunId)`;
- `getAgentTask(taskHash)` and `getAgentReply(replyHash)`;
- `onAgentReply(AgentReply)` and `onAgentProve(replyHashes, proof)`;
- `NewAgentTask`, `AgentReplyAnchored`, and `WorkflowCompleted` events; and
- implementation-defined stage enums, gates, proof policies, and static or dynamic topology.

The latest specification also states that agents react to tasks and do not control sequencing. It distinguishes async gates evaluated after `onAgentReply` from sync gates evaluated only after a successful `onAgentProve`. See the fixed [ERC-8301 PR-head specification](https://github.com/JimmyShi22/ERCs/blob/9fcb78c0c8f39412f87e54f82d8646654c250913/ERCS/erc-8301.md).

The generic interface intentionally does not define business roles, universal state names, gate meaning, or a workflow-document format. It provides the execution and evidence-chain substrate on which a TAWG-specific Workflow must define those semantics.

### 3.2 `onAgentStep` is from an earlier design

The original PR description and early discussion still describe `onAgentStep(stage, isFinal)`. The current PR-head specification instead defines `onAgentReply(AgentReply)` and hash-linked `AgentTask`/`AgentReply` records. The public [PR page](https://github.com/ethereum/ERCs/pull/1815) displays both the older summary and later commits, so its opening description alone is not a safe interface source.

The local `agent-ercs` checkout used during this research was commit `bfcd4e59...`; remote `agent-ercs/main` was `7de7507...`; the ERC PR head was `9fcb78c...`. The [remote `agent-ercs` interface at `7de7507`](https://github.com/trustless-ai/agent-ercs/blob/7de75072514a88d9d877796e0fa93ee3a6dd4c96/contracts/execution/ERC8301/IAgentWorkflow.sol) does not yet include the `AgentReplyAnchored` event added at the PR head. The [TypeScript SDK README at `a0399c6`](https://github.com/trustless-ai/agent-sdk/blob/a0399c6e5b7e86aa17fe53af20fed8c058a47350/typescript/src/execution/ERC8301/README.md) correctly warns that generic hash recomputation does not verify implementation-defined FSM correctness.

Before freezing a TAWG Workflow pattern, the project should pin all of the following together:

```text
ERC-8301 specification commit
IAgentWorkflow ABI digest
agent-ercs commit
agent-sdk version and commit
TAWG Workflow Model schema version
```

Normative design should use `onAgentReply` unless the project deliberately selects an older revision.

### 3.3 What ERC-8301 does and does not prove

ERC-8301 standardizes task/reply hash construction and a traversable evidence chain. The Workflow contract's custom code determines whether authorization, gate, stage transition, proof, and completion rules are correct.

This yields three distinct verification claims:

1. **Envelope integrity:** task and reply hashes recompute from their fields.
2. **Contract acceptance:** the deployed contract accepted a reply or transition.
3. **Workflow-model conformance:** the deployed code behaves like the reviewed Workflow Model and Descriptor.

The first is generic ERC-8301 recomputation. The second follows chain state and events. The third cannot be obtained from the base interface; it requires generated topology, source/build binding, conformance tests, and possibly formal analysis of important invariants.

## 4. Recommended TAWG Workflow semantics

### 4.1 Separate five concepts currently hidden inside “gate”

A TAWG design should not use one undifferentiated gate for every decision. Each submitted action should pass through separately described checks:

```text
Authorization
    may this Agent identity and role attempt this action now?

Input validation
    is the submitted payload structurally valid and bound to the right task/run?

Verification
    is attribution or proof required, and has it succeeded?

Transition gate
    have the threshold, deadline, quorum, evaluation, or other conditions passed?

Settlement acceptance
    is this result eligible to affect payment or final ownership?
```

Keeping these meanings separate makes the Descriptor useful to Agents and prevents an authorization check from being mistaken for proof of output quality.

### 4.2 Every reply needs validation, but not every reply needs the same proof

Every `onAgentReply` path should perform base validation:

- the run and referenced tasks exist;
- all referenced tasks belong to the same run;
- the task is currently actionable and unexpired;
- the reply is not a duplicate or replay;
- `replier` matches the authenticated transaction sender under the selected ERC-8301 revision;
- the declared Agent is a TAWG member at the run's pinned Profile context;
- the Agent has a role allowed for the action; and
- the payload matches the action's declared input or output schema and digest rules.

Additional verification is action-specific:

| Policy | Meaning | Suitable use |
|---|---|---|
| `none` | No external proof beyond authorization and structural validation | Non-critical coordination or openly attributable input |
| `sync` | Proof must succeed before the transition is evaluated | Evaluation, acceptance, irreversible effects, and final settlement |
| `async` | Transition may advance before proof; final success still depends on the required proven chain | Low-risk pipelining where later reconciliation is explicitly safe |
| `aggregate` | Multiple valid replies or proofs feed a quorum, threshold, ranking, or selection gate | Voting, review panels, competitive selection, and cross-checking |

The final gate should remain synchronous, matching the current ERC-8301 requirement. A descriptor must never imply that `async` means “verification is optional.”

### 4.3 Roles must bind to ERC-8004 Agent identity, not only an EOA

OpenZeppelin `AccessControl` checks roles assigned to addresses, while TAWG membership and role metadata are keyed by ERC-8004 `agentId`. The current ERC-8301 `AgentReply` contains `replier: address` but no `agentId`. Permissioned ERC-8301 implementations may check `msg.sender`, but the base interface does not specify how one address maps to a TAWG Agent role.

The TAWG pattern therefore needs an explicit identity bridge. The design must answer:

1. how the operation identifies the claimed ERC-8004 `agentId`;
2. how the Workflow resolves the run-pinned Profile and Identity Registry context;
3. how it verifies the historical membership and role active for that run;
4. how the claimed Agent's Authentication Wallet is matched to the sender; and
5. how wallet rotation affects an in-flight run.

Encoding the role only in the Descriptor or Skill is insufficient. Authorization that affects transitions or settlement must be enforced by contract code.

### 4.4 Static candidates versus currently permitted actions

The Workflow Descriptor can enumerate **candidate actions** for each state and role. It cannot safely determine every currently permitted action because dynamic facts such as membership, deadlines, quorum counts, previous replies, proofs, and balances live on-chain.

Agent-facing discovery should therefore combine:

```text
pinned Workflow Descriptor
    candidate actions, meanings, schemas, Skill references

authoritative Workflow query
    current state, active tasks, deadlines, gate facts,
    and per-Agent action availability

TAS projection
    one structured Agent context response
```

The result should distinguish:

- `available_actions`: contract-authorized operations that can currently be attempted;
- `blocked_actions`: candidate actions plus stable machine-readable reason codes; and
- `instructions`: non-authoritative Skill references explaining how to perform an available action well.

“Should do” is instructional and may depend on task goals. “May do” is authorization and must come from the authoritative state and gate checks.

### 4.5 Required Workflow query extension

The current ERC-8301 base reads individual tasks/replies and the terminal result, but it does not provide a single generic query for current stage, all active tasks, or actions available to a specific TAWG Agent. Reconstructing current state only from logs is possible for an indexer but is a poor Agent-facing contract.

A TAWG Workflow pattern should define a small read-only extension with semantics equivalent to:

```text
workflowDefinition()
    model schema version, model digest, descriptor locator and digest

getRunState(workflowRunId)
    status, current state ID, active task hashes, deadlines, context version

getAvailableActions(workflowRunId, agentId)
    action IDs, availability, and machine-readable block reasons

canPerform(workflowRunId, agentId, actionId, optional input commitment)
    exact preflight result for one candidate operation
```

Exact Solidity signatures remain a normative design decision. The important property is that these reads share the same identifiers and rules as the state-changing code. TAS may project them, but must not reimplement gate logic in TypeScript.

## 5. Workflow Descriptor direction

### 5.1 Use a Workflow Descriptor, not a “current state JSON file”

A repository file cannot be the current state because the chain changes independently. The repository should contain a versioned **Workflow Descriptor** describing the state space and action semantics. TAS combines it with a live or historical on-chain run-state query.

The Descriptor should include at least:

```text
schema version and workflow identifier
Workflow Model digest and descriptor digest
ERC-8301 revision and ABI digest
deployed-chain bindings or deployment-independent source binding
roles and role descriptions
states, initial state, and terminal states
actions per state and role
action input/output JSON Schemas
transitions and target states
authorization policy identifiers
verification policy and verifier binding per action/stage
gate identifiers, types, public parameters, and reason-code vocabulary
timeouts, retry, abort, and silent-rejection semantics
data bindings and immutable-reference requirements
side-effect and settlement implications
Skill references by role, state, and action
read and write contract bindings
```

The Descriptor should contain identifiers and declarative parameters, never JavaScript, Solidity snippets, `eval` expressions, arbitrary imports, or executable prompts.

### 5.2 Stable IDs matter more than display names

State, action, gate, role, and reason-code IDs should be stable machine identifiers. Human labels and descriptions may evolve without changing the IDs. Numeric ERC-8301 stages should be mapped explicitly:

```text
stage uint8 3
    ↔ state ID "reviewing"
    ↔ action ID "evaluation.submit"
    ↔ Skill reference "skills/workflow/evaluator/submit-evaluation.md"
```

An Agent must not infer semantics from `stage = 3` or from a Solidity enum ordinal alone.

### 5.3 Skills explain execution; they do not grant permission

A Skill is appropriate for:

- how to gather and format an artifact;
- how to use Git, DA, recomputation, and Proof Provider tools;
- quality criteria and review practices;
- how to interpret machine-readable block reasons; and
- how to recover from an expired credential or failed operation.

A Skill is not appropriate as the sole source for:

- role authorization;
- accepted transition targets;
- proof requirements;
- settlement eligibility; or
- the current run state.

Descriptor entries should refer to pinned Skill paths and immutable commits when the instructions affect evaluation, verification, or settlement. TAS can load those resources through `skill.get` and return them beside the state/action projection.

## 6. One-source generation pattern

### 6.1 Why “generate Solidity and JSON independently from the Charter” is unsafe

Two artifacts generated independently from natural language can agree syntactically while differing in edge cases. Neither a matching name nor a shared Git commit proves behavioral equivalence. AI generation should accelerate drafting, not replace a deterministic consistency boundary.

The recommended pipeline is:

```text
1. Author Charter intent and invariants.
2. Author or AI-draft a constrained Workflow Model.
3. Validate its schema and graph invariants.
4. Generate all structural Solidity and Descriptor content from that model.
5. Implement only explicitly named custom gate hooks by hand or with AI assistance.
6. Generate state/transition/path tests from the model.
7. Run Solidity tests against generated traces and negative authorization cases.
8. Canonicalize and hash the model and Descriptor.
9. Compile the model digest into the Workflow contract.
10. Publish source, build metadata, ABI, model, Descriptor, and test vectors together.
```

### 6.2 Generated core plus custom hooks

Not every useful gate can be represented as a small data expression. Evaluation contracts, proof verifiers, quorum logic, and settlement may require custom Solidity. The generator should therefore own the structural shell:

- stage enum and stable ID mapping;
- valid source/action/target tuples;
- dispatch and terminal topology;
- common reply validation;
- role/action dispatch tables;
- proof-mode dispatch;
- query projection; and
- model/descriptor digest constants.

Custom code should implement named hooks with narrow inputs and outputs, for example a gate returning `pass`, `retry`, `abort`, or `silent` plus a reason code. A custom hook must not be able to invent an undeclared target state unless the Workflow Model explicitly marks the transition as dynamic and enumerates its allowed target set.

### 6.3 Conformance checks

Generation should fail when:

- a state is unreachable or has no legal completion/abort path;
- a non-terminal state has no action and no timeout path;
- an action references an unknown role, schema, Skill, verifier, gate, or data binding;
- a state/action pair has ambiguous transitions without an explicit priority rule;
- a settlement-affecting or terminal action lacks synchronous verification;
- a static Workflow contains an undeclared dynamic target;
- a numeric stage is reused or reordered incompatibly;
- Descriptor and compiled model digests differ; or
- a generated query omits an action accepted by the generated state-changing dispatcher.

Model-based path generation is useful here, but contract-level negative tests remain essential for unauthorized roles, replay, expiry, duplicate replies, failed proof, racing replies, and invalid transition targets.

## 7. Framework comparison

### 7.1 W3C SCXML

SCXML is a W3C Recommendation defining states, parallel states, final states, transitions, conditions, entry/exit behavior, events, and a deterministic transition-selection algorithm. Its condition language must be side-effect free. These are useful semantics for a TAWG model. See the [W3C SCXML 1.0 Recommendation](https://www.w3.org/TR/scxml/).

SCXML is not a suitable on-chain execution format:

- it includes hierarchical and parallel configurations, internal event queues, microsteps and macrosteps;
- it permits different data models such as ECMAScript and XPath;
- executable content can send events, invoke external services, assign data, run scripts, and use platform extensions; and
- those execution semantics do not map directly to EVM transactions, block time, proofs, reverts, or gas.

Recommendation: borrow the explicit state/transition/final/guard vocabulary and deterministic conflict-resolution discipline. Do not claim SCXML conformance and do not execute arbitrary SCXML on-chain.

### 7.2 XState and statecharts

XState provides named actions and guards, JSON-serializable references, state metadata, `state.can(event)`, next-transition inspection, graph traversal, and model-based path testing. See the official documentation for [machines](https://stately.ai/docs/machines), [states and `state.can`](https://stately.ai/docs/states), [guards](https://stately.ai/docs/guards), and [graph/path generation](https://stately.ai/docs/graph).

These features are valuable during TAWG development:

- visualize a Workflow Model;
- find unreachable states;
- enumerate potential transitions;
- generate shortest/simple path tests;
- attach typed metadata used to draft a Descriptor; and
- simulate a pure structural projection before deployment.

XState must not become a parallel authority. TypeScript guard implementations, invoked actors, delayed transitions, JavaScript context, and actor scheduling are not equivalent to Solidity and chain state. `state.can(event)` is safe only as a development-time check against a generated model or as non-authoritative UI guidance; TAS must use the contract's query for authoritative availability.

Stately's newer “machines as data” and Agent machine packages demonstrate JSON/YAML workflow authoring and typed state metadata, but the Agent package is explicitly alpha. See [Machines as data](https://stately.ai/docs/packages/agent/machines-as-data) and [Agent machines](https://stately.ai/docs/packages/agent/machines). They are useful references, not a v0.1 dependency or protocol foundation.

### 7.3 BPMN

BPMN defines participants, lanes, tasks, message flows, events, multiple gateway types, choreography, execution semantics, and machine-consumable XML schemas. See the official [BPMN 2.0.2 specification](https://www.omg.org/spec/BPMN/2.0.2/PDF).

Its participant/lane and gateway notation can help humans review who acts and where branches or joins occur. Full BPMN adoption would introduce a much larger token-flow, event, correlation, compensation, choreography, and XML model than ERC-8301 requires. BPMN engines are also off-chain runtime authorities unless every relevant semantic is reimplemented in Solidity.

Recommendation: allow generated BPMN-like diagrams for review if useful. Do not use BPMN XML as the normative TAWG runtime model in v0.1.

### 7.4 DMN

DMN is designed for precise business decisions and decision tables and is intended to complement BPMN/CMMN. See the official [OMG DMN overview and specification links](https://www.omg.org/dmn/).

Decision tables are a good review form for finite gate policies:

```text
state × action × role × proof status × deadline condition → outcome
```

Full DMN/FEEL execution would add another expression language whose number, date, collection, and evaluation semantics must match Solidity exactly. That increases recomputation risk.

Recommendation: optionally generate decision-table documentation and test vectors from the TAWG model. Do not run a separate DMN engine as the authority.

### 7.5 OpenZeppelin access control

OpenZeppelin `AccessControl` provides address-based roles, admin roles, grant/revoke operations, and `hasRole`. `AccessManager` scopes roles to contract targets and function selectors and supports delays and guardians. See [OpenZeppelin Access Control](https://docs.openzeppelin.com/contracts/5.x/access-control) and its [API reference](https://docs.openzeppelin.com/contracts/5.x/api/access).

Reusable parts include:

- hardened authorization primitives;
- admin-role separation;
- delayed governance operations;
- pausing or closing sensitive targets; and
- discoverable role labels for tooling.

Mismatches with TAWG include:

- permissions are assigned to addresses, while TAWG roles are associated with ERC-8004 Agent identities;
- a Workflow action is constrained by role **and current state**, not only a function selector;
- one Agent may have multiple roles and one action may allow a role set or threshold;
- historical run context and wallet rotation must be handled; and
- `AccessManager.execute` changes the `msg.sender` observed by the target contract.

Recommendation: use OpenZeppelin components for contract administration and implementation hardening where they fit. Define TAWG's Agent-role and per-state authorization layer explicitly rather than treating `AccessControl` as the Workflow model.

### 7.6 MCP action discovery

MCP tools have stable names, descriptions, input/output schemas, and annotations. Servers can support `tools/list` and notify clients when the tool inventory changes. Tool results may return structured JSON. The current specification also says that the set of tools must not vary per connection or as a side effect of other requests on the connection. See the [MCP 2026-07-28 tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).

The installed TAS tool inventory should not change for every Workflow state. State-dependent availability is runtime data, not a new protocol capability. Dynamically removing a write tool also does not create authorization because a caller could still attempt an older cached tool name.

Recommendation:

- keep generic generated ERC-8301 write tools stable;
- add one stable TAWG Workflow context/read interface;
- return current state, available/blocked actions, schemas, and Skill references in `structuredContent`; and
- let the contract reject stale or unauthorized actions even when an Agent acts on an old context response.

### 7.7 A2A

A2A separates messages from output artifacts, defines coarse task lifecycle states, advertises Agent capabilities through Agent Cards, and includes interrupted `INPUT_REQUIRED` and `AUTH_REQUIRED` states. It also warns that messages and streams are not a reliable channel for critical state. See the official [A2A specification](https://a2a-protocol.org/latest/specification/).

Useful ideas are:

- separate communication messages from durable artifacts;
- make “needs input” and “needs authorization” explicit states or block reasons; and
- publish structured capability metadata.

A2A TaskState is too coarse for TAWG business FSMs, and an Agent Card describes a service rather than the role-specific legal actions of one on-chain run. It should remain an interoperability reference, not the TAWG Workflow authority.

## 8. Recommended TAS integration boundary

TAS should remain a resolver and adapter:

```text
Profile
    resolves Workflow address, repository, pinned context, and metadata
        ↓
Workflow Resolver
    loads and digest-validates the pinned Descriptor
        ↓
Chain Client
    queries current/historical Workflow run state and available actions
        ↓
Skill Resolver
    loads only the role/state/action instructions referenced by the Descriptor
        ↓
MCP Adapter
    returns one structured projection to the Agent Host
```

The projection should contain provenance for every layer:

```text
chain ID and resolved block
TAWG/Profile address and Profile version
ERC-8004 agentId and resolved role set
Workflow address and run ID
ERC-8301 revision and ABI digest
Workflow Model/Descriptor digest and repository commit/path
current state and active task hashes
available and blocked actions
verification/gate status and reason codes
pinned Skill references
```

TAS must not:

- calculate a transition locally and present it as authoritative;
- treat a Descriptor or Skill as overriding deployed bytecode;
- persist a parallel current state;
- infer role authorization only from prose; or
- hide an on-chain inconsistency by falling back to the newest repository version.

If the Descriptor digest does not match the Workflow's bound digest, TAS should fail with an explicit consistency error rather than supply Agent instructions for a different machine.

## 9. Decisions required before normative design

The following questions must be resolved in the TAWG Workflow design:

1. Which exact ERC-8301 revision and ABI are normative for TAWG v0.1?
2. How does a reply identify the ERC-8004 `agentId` when the base `AgentReply` contains only `replier`?
3. Is membership and role context pinned at run creation, read live for every action, or split by rule?
4. What is the minimal read-only Workflow extension for state and available-action discovery?
5. Is the v0.1 topology limited to a static FSM, or is a constrained dynamic target set supported?
6. Which gate kinds are declarative, and which require named Solidity hooks?
7. How are Workflow Model and Descriptor digests exposed and bound by the deployed contract?
8. Which fields are generated into Solidity, and which are descriptive only?
9. What reason-code vocabulary lets an Agent distinguish role, state, deadline, proof, quorum, and data blockers?
10. How are Skill commit/path references pinned for each run or action?
11. What is the migration rule for in-flight runs when the Profile selects a new Workflow or Descriptor?
12. What conformance suite proves the generated contract, Descriptor, and Agent projection remain aligned?

## 10. Suggested next design artifacts

The research supports separating the normative design into three documents:

```text
docs/tawg/WORKFLOW.md
    protocol pattern: roles, states, actions, gates, proof, queries,
    identity binding, authority, versioning, migration, and TAS projection

docs/tawg/WORKFLOW_MODEL.md
    canonical declarative schema and generation/conformance contract

docs/tawg/WORKFLOW_DESCRIPTOR.md
    Agent-facing JSON projection, Skill references, digest rules,
    current-state composition, and examples
```

The first document should decide semantics. The second should make development repeatable. The third should make the deployed Workflow understandable and actionable to an Agent without weakening on-chain authority.
