# Trustless Agent Collaboration

This context defines the shared language used by the TAWG protocol, TAS, and the contracts through which independently operated Agents collaborate.

## Language

**Trustless Agent Working Group (TAWG)**:
An on-chain collaboration definition identified by `(chainId, tawgAddress)`.
_Avoid_: Project, workspace, Agent team

**TAWG Profile**:
The on-chain discovery and governance entry point whose address is the TAWG's `tawgAddress`.
_Avoid_: TAWG Registry, Profile service

**Profile Version**:
The monotonically increasing revision of active Profile state used for discovery and cache consistency; historical state is selected by block.
_Avoid_: Protocol version, block version

**TAWG Member**:
A current Profile member identified by an ERC-8004 `agentId` from the Profile's immutable Identity Registry.
_Avoid_: Agent account, wallet member

**Open TAWG Enrollment**:
The process by which any existing ERC-8004 Agent becomes a TAWG Member by calling the Profile directly through a transaction authorized by that Agent's current Authentication Wallet. Profile membership is open discovery and attribution state, not role or participation approval. An Evaluator Agent may detect a missing membership, explain how to join, and confirm completion, but it does not enroll another Agent. Any role, eligibility, or action restriction belongs to the Workflow.
_Avoid_: Governance admission, Workflow-local member registry, Bot registration, off-chain signup, registration by chat message

**Profile Membership**:
The permanent open registration of an ERC-8004 `agentId` in a TAWG Profile. An Agent's current Authentication Wallet may register it once and later replace its complete Member data and `agentVerifier`; neither the Agent nor Governance may delete the membership. It provides the canonical Member record and metadata used for discovery and attribution, but grants no universal Workflow role or permission by itself.
_Avoid_: Removable membership, allowlist, Workflow role, governance approval, second member ID

**Authentication Wallet**:
The current ERC-8004 Agent Wallet authorized by the TAWG to represent an Agent; it may rotate without changing `agentId`.
_Avoid_: Agent identity, member ID

**Charter Reference**:
The active immutable Repository, full commit hash, and path that identify the TAWG Charter version.
_Avoid_: Latest Charter, Charter branch

**TAWG Repository**:
The versioned collaborative workspace selected by the Profile and organized into `charter/`, `skills/`, `knowledge/`, `data/`, and `contracts/`.
_Avoid_: Profile storage, DA database

**TAWG Workflow Source**:
The single TAWG-specific `Workflow.sol` file that contains the executable Workflow specification and its guidance comments.
_Avoid_: Workflow Model, Workflow Descriptor, state JSON

**Workflow Compiler Metadata**:
The compiler-produced `Workflow.metadata.json` used with all exact compilation inputs to reproduce and match the deployed Workflow runtime code.
_Avoid_: Workflow design file, manually maintained manifest

**Verified Workflow Source**:
A TAWG Workflow Source whose pinned source units, compiler metadata, reproduced runtime code, and Profile-selected deployed code have been matched at an exact chain block.
_Avoid_: Repo source, latest Workflow source

**Governance**:
The current address authorized to mutate a TAWG Profile under the mechanism defined by the TAWG.
_Avoid_: Owner, admin

**Proof Provider**:
An external system that produces a proof or attestation artifact for an Agent or Workflow to use.
_Avoid_: Verifier, evaluator

**Workflow Acceptance**:
The result of the TAWG's ERC-8301 Workflow applying its selected rules to a submitted operation or proof.
_Avoid_: Proof validity, Agent attribution

**Contribution Appeal**:
The single opportunity for the Agent attributed to a Contribution Record to submit additional explanation and supporting material and request a new evaluation from the Evaluator Agent. It is not a third-party challenge.
_Avoid_: Reasoning, clarification, dispute, challenge

**Work Contribution**:
A proposal, focused improvement, implementation, or other work product submitted by a TAWG Member for evaluation.
_Avoid_: Review, chat message, task state

**Review Contribution**:
A scoreable review by one TAWG Member of one Work Contribution. A Review Contribution cannot itself be the target of another Review, but its attributed reviewer may appeal its evaluation once.
_Avoid_: Work Contribution, recursive review, evaluator decision

**Contribution Record**:
The append-only TAWG record submitted only by its Attributed Contributor or the Evaluator Agent. It attributes one Work Contribution or Review Contribution to the ERC-8004 `agentId` resolved from its Contribution Source and references its supporting data. Evaluation, an optional Contribution Appeal, and final evaluation are appended later.
_Avoid_: Chat message, mutable score, settlement payment

**Attributed Contributor**:
The ERC-8004 Agent to whom a Contribution Record belongs: the author of a Work Contribution or the reviewer who authored a Review Contribution. Only this Agent or the Evaluator Agent may create the corresponding Contribution Record.
_Avoid_: Recorder, transaction sender, unrelated Member

**Contribution Supporting Material**:
Content or immutable references appended to a Contribution Record by its Attributed Contributor or the Evaluator Agent. An unrelated TAWG Member cannot add material to another Agent's record; material submitted with a Contribution Appeal remains authored by the Attributed Contributor even when the Evaluator Agent helps transport it.
_Avoid_: Third-party comment, unrestricted attachment, mutable chat context

**Contribution Source**:
The one final group message that uses `contribute` or `review`, mentions the Evaluator Agent, and uniquely identifies one Contribution Record by platform, conversation, message, and contribution type. When the Contribution Record is created, the source message, author, timestamp, and attachment references are captured as an immutable DA snapshot whose locator and digest are recorded on-chain. Later edits or deletion of the platform message do not change the Contribution Record; corrections are appended as Contribution Supporting Material or a Contribution Appeal. Earlier discussion and linked artifacts are supporting context rather than additional Contribution Sources.
_Avoid_: Live mutable message, every discussion message, mutable username, duplicate record

**Anchored Data Reference**:
The on-chain pair of a non-empty DA locator and a non-zero content digest used by a Contribution Source, Supporting Material, evaluation, Appeal, or Round Summary. The locator tells an Agent where to retrieve the immutable object; the digest lets it verify the retrieved bytes. Expiry metadata may describe availability but cannot replace either locator or digest.
_Avoid_: Mutable URL without digest, digest without discovery location, inline chat history

**Canonical Agent Action Reply**:
An ERC-8301 `AgentReply` submitted through `Workflow.onAgentReply` whose encoded `ActionKind` identifies a Contribution, Supporting Material append, initial evaluation, Appeal, Appeal reevaluation, or Round Summary. The Workflow exposes no parallel action-specific write entrypoints. Wallet-authorized deterministic actions become proven when accepted; Evaluator-authored AI outputs remain unproven until their snapshotted ERC-8274 verifier accepts a proof.
_Avoid_: Action-specific transaction API, unsigned payload, automatically trusted Evaluator output

**Final Contribution Score**:
The integer score from `0` through `100` used for settlement: the initial evaluation when no Contribution Appeal exists, or the replacement evaluation produced from the Agent's single Appeal. An Appeal score may increase, decrease, or preserve the initial score; earlier evaluations remain historically visible. Zero is a completed evaluation, not an unevaluated record.
_Avoid_: Mutable score, Round total, token balance

**Evaluator Attestation**:
The ERC-8274 proof required for an Evaluator Agent's initial evaluation, Appeal reevaluation, or Round Summary Reply to become proven and usable by a dependent Workflow gate. The Workflow snapshots the Profile Member's `IAgentVerifier` when the Reply is anchored and delegates attestation verification through that standard interface. The Fede attestation integration remains an explicit v0.1 integration TODO; until a real verifier is connected, production settlement must fail closed rather than accept a permissive placeholder.
_Avoid_: Proof Provider acceptance, wallet authentication, always-true verifier, mutable historical verifier

**Agent Round Score**:
The deterministic sum of one Agent's Final Contribution Scores for all Work Contributions and Review Contributions in one Settlement Round.
_Avoid_: Evaluator override, discretionary Round bonus, lifetime score

**TAWG Points**:
The TAWG's fixed-supply ERC-20 reward units minted when the TAWG is established. The Workflow holds the Reward Reserve, cannot mint during settlement, and may transfer Points from the Reserve only through a fully valid Settlement Round settlement.
_Avoid_: Contribution score, invested asset, redemption right

**Points Recipient**:
The current ERC-8004 Authentication Wallet resolved for the rewarded `agentId` at Settlement Round settlement. A valid Wallet rotation changes the receiving address without changing contribution ownership; a zero Wallet prevents settlement rather than redirecting Points.
_Avoid_: Contribution recorder, platform account, historical wallet

**Round Point Budget**:
The fixed maximum amount of TAWG Points that one Settlement Round may distribute. `Workflow.sol` implements a restricted ERC-8312 Budget Substrate and creates one Budget Envelope bound to the Run, Points asset, and cap. Only the Workflow's settlement path may advance or complete it; projected scores cannot exceed the cap, and settlement atomically advances the budget cursor with the Points transfers.
_Avoid_: Token balance, per-Contribution score cap, advisory budget

**Workflow Round Configuration**:
The immutable `roundDuration`, `appealDuration`, `roundPointCap`, and `maxContributionsPerRound` selected when the Workflow is deployed. A Round becomes eligible for rollover after `roundDuration`, and its successor starts at the rollover transaction's block time rather than at a precomputed calendar boundary. The Appeal deadline is derived from the on-chain opening time of the Appeal phase. `maxContributionsPerRound` must not exceed an implementation hard limit established by gas testing.
_Avoid_: Editable schedule, calendar-day guarantee, off-chain timer

**Atomic Round Settlement**:
The single transaction that deterministically finalizes one eligible Settlement Round, advances its ERC-8312 budget cursor, and transfers every Agent's TAWG Points. The Workflow bounds recipient iteration through the immutable `maxContributionsPerRound`; insufficient reserve, a zero recipient Wallet, failed transfer, or any unmet gate reverts the complete settlement.
_Avoid_: Partial payout, unbounded recipient loop, per-Agent claim

**Evaluator Agent**:
The fixed ERC-8004 TAWG Member whose identity is authorized for the lifetime of one Workflow to evaluate Contribution Records, evaluate Contribution Appeals, and publish Round summaries. Its software, Host, and Authentication Wallet may change without changing its `agentId`; selecting another Evaluator Agent requires a new Workflow. If it stops acting, affected Rounds remain incomplete until the same Agent identity resumes: v0.1 provides no timeout score, substitute evaluator, or governance-forced result. A permanently lost identity requires a new Workflow, while the old incomplete Round remains historical. It does not own permissionless deterministic Round transitions.
_Avoid_: Contribution recorder, Proof Provider, settlement caller

**Workflow Participant**:
Any permanent Profile Member acting under the current Workflow rules. The task-publication-and-settlement Workflow keeps no separate participant or role registry: all Members have the same contribution, supporting-material, and Appeal capabilities, except for the fixed Evaluator Agent's exclusive evaluation and summary capabilities. Deterministic Round transitions remain callable even by non-members.
_Avoid_: Profile role, participant allowlist, duplicated membership table

**Deterministic Round Transition**:
A Round lifecycle change that any caller may trigger once its on-chain time and completeness conditions hold. The caller does not choose scores or override an Evaluator Agent decision.
_Avoid_: Evaluator judgment, privileged Bot action, off-chain scheduler decision

**Round Summary**:
The Evaluator Agent's required final account of one Settlement Round. Its full content is stored through the configured DA mechanism, while the Workflow records an immutable locator and digest before settlement. It summarizes progress and references the Round's contributions and per-Agent results, but it cannot override Final Contribution Scores or deterministically recomputed Point allocations. A Telegram or Discord post is notification only, not the authoritative record.
_Avoid_: Editable group announcement, score override, settlement calculation

**Settlement Round**:
A time-bounded collection and settlement cycle identified by one ERC-8301 `workflowRunId`, with `Open`, `Evaluating`, `Appealing`, and `Settled` phases. Its Contribution, evaluation, Appeal, reevaluation, Summary, and terminal tasks and replies form one ERC-8301 evidence chain, and `result(workflowRunId)` becomes `Success` only after atomic settlement. Once its immutable minimum duration has elapsed, rollover closes Contribution intake for the current Round and opens a concurrent successor Run at the rollover transaction's block time without creating a precomputed empty Round. The closed Round completes all initial evaluations before its Appeal window, then settles only after the Appeal deadline, every submitted Appeal evaluation is complete, and its Round Summary has been anchored.
_Avoid_: Chat day, billing period, Workflow run
