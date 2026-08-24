# Trustless Agent Substrate (TAS)

TAS is a host-neutral connectivity layer for independently operated AI Agents. It connects Agent Hosts to Trustless Agent Working Groups (TAWGs), messaging platforms, Trustless AI contracts, declared external data, and Proof Providers through MCP and read-only discovery interfaces.

> **Agent Hosts execute. TAWGs define collaboration. TAS connects. Contracts govern. Proof Providers produce evidence.**

## Design

The design is split into three source-of-truth documents:

- [System Design Overview](docs/DESIGN.md) — background, motivation, definitions, three-layer architecture, scenarios, and end-to-end flows.
- [TAWG Protocol Design](docs/TAWG.md) — TAWG identity, Agents/Data/Workflow domains, authority, historical verification, and logical Profile interface.
- [TAS Implementation Design](docs/TAS.md) — service modules, MCP and REST seams, messaging, adapters, chain/data/Provider access, state, security, deployment, and v0.1 scope.
- [Daily Contribution and Settlement Instance](docs/tawg/instances/daily-contribution/README.md) — the first concrete TAWG v0.1 Workflow, state machines, implementation, and review package.

## Core Model

A TAWG is identified by:

```text
(chainId, tawgAddress)
```

and defined as:

```text
TAWG = Agents + Data + Workflow
```

An Agent's TAWG-scoped MCP context is:

```text
/{chainId}/{tawgAddress}/agents/{agentId}/mcp
```

TAS does not run Agents, schedule business work, hold private keys, write evidence on an Agent's behalf, or maintain a parallel workflow state machine.

## v0.1 TAWG Instance

The first concrete operating example is the
[Daily Contribution and Settlement TAWG](docs/tawg/instances/daily-contribution/README.md).
Its scenario, Roles, state machines, Workflow actions, proof policy, settlement rules, current
implementation, test results, and review package are maintained together under `docs/tawg/instances/`.

The Solidity source remains in the separate
[`tawg-daily-contribution`](https://github.com/trustless-ai/tawg-daily-contribution) Repository.
Legacy Daily Contribution Skill and Go verification experiments in this Repository are not the
current Instance specification or implementation.

## Repository Status

The active implementation is the TypeScript `@trustless-ai/tas` v0.1 **Slice A: Bootable TAS** baseline plus the Repository, four-layer Skill, Workflow, Git DA, and offline integration-port portions of **Slice C: Participating TAS**. It includes deterministic reviewed viem Chain operations for Agent-owned identity and Profile onboarding, Profile-bound Repository discovery, release-bundled TAS and Collaboration Skills, commit-pinned TAWG Root and Role Skill reads, reproducible Workflow verification, statically reviewed `agent-sdk` operation bindings, immutable Git DA reads and writes, generated Telegram/Discord MCP contracts, and a concrete-independent Proof Provider adapter boundary.

Slice A implements:

- a strict Node.js `>=24 <25` ESM package with an exact npm lockfile;
- identity-setup, TAWG-setup, and isolated member process configuration in TOML;
- local MCP over stdio with stdout reserved for protocol frames;
- the four flat Skill tools `tas.get`, `collaboration.get`, `tawg.get`, and `role.get`, with the TAS and Collaboration Skills bundled in the release and Repository Skills callable only in member phase;
- exact-block `profile.get` and `profile.get_agent` reads for TAWG-bound phases;
- one process lock per canonical `(chainId, tawgAddress, ERC-8004 agentId)` member identity;
- complete reviewed viem Public and Wallet Action groups in every phase, shipped as deterministic Manifests;
- Agent-owned ERC-8004 registration, receipt reconciliation, Registry wallet establishment, and Profile self-registration through those groups; and
- per-call inline Wallet credentials: TAS constructs an Account only for that call and retains no private key, Account, discovered `agentId`, retry journal, or side-effect replay state.

The completed Repository and TAWG Skill portion of Slice C adds:

- `repo.get`, which returns the complete canonical `https://github.com/<owner>/<repository>` URL selected by the Profile plus the Profile-anchored Charter commit and `charter/` path without calling GitHub;
- `repo.issue.list`, `repo.pull_request.list`, and `repo.commit.list`, which poll the same Profile-selected Repository newest-first from an inclusive `since` boundary and return source-native IDs or full commit hashes for Agent-side deduplication;
- optional GitHub credentials supplied inline to one activity, Root Skill, or Role Skill call and never retained by TAS;
- `tawg.get`, which reads the fixed `skills/SKILL.md` Root Skill, and `role.get`, which maps a normalized role to `skills/roles/<role>.md`; both resolve the current default-branch HEAD internally and return the exact full commit, path, SHA-256 digest, encoding, and Markdown bytes; and
- a fixed 1 MiB Repository Skill file-byte limit.

The activity cursor is opaque and binds the Repository, exact Profile block, `since`, `observed_at`, ordering, and provider position. The Agent retains it and deduplicates repeated boundary objects; TAS keeps no cursor state. Every Root or Role call discovers the current default HEAD and reports its immutable commit; the caller cannot select a Repository, path, or commit. TAS retains no active Skill commit and does not validate role ownership—the deployed Workflow remains authoritative.

Profile reads resolve an exact block number and hash, bind every contract read with the EIP-1898 canonical block-hash selector `{ blockHash, requireCanonical: true }`, and verify the block again before returning. Resolution is bounded and caller-cancellable; TAS never silently falls back to number-only or current-state reads.

TAS does not open a Host Credential File. The Agent creates or loads its wallet outside TAS, keeps the credential outside project state, supplies it inline to each Wallet call, retains source-native transaction hashes, and reconciles outcomes through Chain reads after a restart.

Member startup provides canonical process isolation; it is not a membership-authority check. After connection, the release-bundled TAS Skill requires `profile.get_agent` for the configured Agent and stops member operation when the successful query result says `is_member = false`.

### Cumulative process inventory

| Phase | Public selector | MCP tools implemented now |
|---|---|---|
| Identity setup | `(chainId, identityRegistryAddress)` from `[identity_setup]` | all four Skill names are discoverable; only `tas.get` succeeds, plus the complete reviewed viem Public and Wallet groups |
| TAWG setup | `(chainId, tawgAddress)` from `[tawg_setup]` | the same four Skill names, with member-phase-only calls returning `SKILL_MEMBER_CONTEXT_REQUIRED`; adds `profile.get`, `profile.get_agent`, and the complete reviewed viem groups |
| Member | `(chainId, tawgAddress, ERC-8004 agentId)` from `[instance]` | all four Skill calls pass the phase gate; normal input, Profile, Repository, and credential failures still apply; adds Repository, Workflow, DA, Provider, and configured Chat tools |

The onboarding path is: start identity setup with only a Registry locator; the Agent registers and records its canonical decimal ERC-8004 `agentId`; restart in TAWG setup with a Profile locator; read the Profile-selected immutable Registry, register or reconcile membership with the current Authentication Wallet, write the public member configuration, and start member TAS. A new Agent that starts with the TAWG locator discovers that Registry with `profile.get` before registering its own identity. TAS never submits an automatic duplicate or retries a side effect.

TAS deliberately exposes no general clone, file-read, diff, branch, commit, push, Issue mutation, Pull Request mutation, review, approval, merge, or close operation. After discovery, the Agent uses the returned canonical Repository URL with Host-native Git, filesystem, or GitHub tools.

Workflow source verification, static runtime bindings, Git DA, generated Chat ports, configuration-bound Chat routing, bounded caller-owned waits, and standardized Proof Provider discovery/generate/validate ports are implemented. Offline Fake Telegram/Discord Clients and a Fake attestation adapter exercise the production MCP namespaces and contracts without network access or a test-only namespace. Production startup fails closed when Chat is configured without a matching composed factory, and its default Proof Provider registry is valid and empty, so `proof_provider.attestation.list` returns `[]`.

Chain-bound generated `agent-sdk@0.3.0` operations currently support local Anvil (`chainId = 31337`); pure recompute operations are chain-independent. Automatic contract-address resolution is intentionally limited to the Profile-authoritative ERC-8301 Workflow address. Live Telegram/Discord Client bindings, a concrete Proof Provider integration, the full deterministic three-Actor E2E, and later vertical-slice work remain deferred. No npm publication or production Profile deployment is claimed.

## Current Layout

```text
trustless-agent-substrate/
├── src/                           # Active TypeScript TAS runtime
│   ├── app/                       # CLI composition and lifecycle
│   ├── mcp/                       # MCP server, reviewed Manifests, and tool adapters
│   ├── core/                      # Profile, Repository, Skill, Workflow, DA, Chat, Provider, and Chain modules
│   ├── clients/                   # Chain, Repository, Workflow SDK, compiler, and Git DA clients; live Chat bindings deferred
│   └── local/                     # strict Config and member isolation
├── skills/
│   ├── tas-bootstrap/             # minimal Host-installed product entry
│   ├── tas/                       # release-bundled TAS Skill
│   └── tawg-collaboration/        # release-bundled collaboration mechanics
├── test/                          # unit, integration, and conformance gates
├── docs/                          # system, TAWG, TAS, and slice designs
├── cmd/, internal/, go.mod        # untouched legacy Go scaffold
├── config/, docker/, scripts/     # untouched legacy scaffolding
├── tas-skills/                    # legacy Skill drafts
└── tawg/                          # legacy Daily Contribution material
```

Go/YAML/Docker and legacy Skill content is retained for reference and non-regression only. It is not the active TAS runtime or v0.1 configuration contract.

## Development

Requirements:

- Node.js `>=24 <25`
- npm using the committed exact `package-lock.json`

Install and run the current release gates. Regenerate Manifests only after an intentional dependency review:

```bash
npm ci
npm run manifest:check
npm run typecheck
npm test
npm run test:coverage
npm run build
npm pack --dry-run
```

Use `npm run manifest:generate` only to regenerate the committed reviewed Manifest artifacts after that review; normal TAS startup never generates or reflects over dependencies.

Inspect the active CLI and start one configured stdio process with an absolute path:

```bash
npm exec -- tas --version
npm exec -- tas --config /absolute/path/to/tas.toml
```

`tas --version` prints the exact package version. `tas --config` loads exactly one of the three public TOML phases and then serves MCP on stdio until its input or process lifecycle ends. See [Configuration](docs/tas/CONFIG.md), [MCP](docs/tas/MCP.md), and [implementation status](docs/tas/IMPLEMENTATION.md).

The untouched Go scaffold still has its independent non-regression check:

```bash
go test ./...
```

## Trustless AI Dependencies

- [`agent-ercs`](https://github.com/trustless-ai/agent-ercs) — on-chain protocol interfaces.
- [`agent-sdk`](https://github.com/trustless-ai/agent-sdk) — typed clients and deterministic recomputation.
- [`recompute-kit`](https://github.com/trustless-ai/recompute-kit) — independent verification and conformance.
- [`trustless-inference-mcp`](https://github.com/trustless-ai/trustless-inference-mcp) — proof-producing inference direction.
- [`recompute-lens`](https://github.com/trustless-ai/recompute-lens) — verification visualization direction.

## License

Apache-2.0. See [LICENSE](LICENSE).
