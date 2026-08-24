# TAS Project Structure

| Item | Value |
|---|---|
| Status | Slice A baseline plus four-layer Skill, Repository, generated inventory, Workflow, DA, and offline integration milestones |
| Design version | 3.1 |
| Scope | Current and target TAS project structure |

This file distinguishes the active TypeScript implementation, retained legacy scaffolding, and the remaining target TypeScript v0.1 structure. Product and protocol decisions live in [DESIGN.md](DESIGN.md), [TAWG.md](TAWG.md), and [TAS.md](TAS.md).

## Current Repository

```text
trustless-agent-substrate/
├── package.json                  # @trustless-ai/tas v0.1 package contract
├── package-lock.json             # exact npm dependency lock
├── src/
│   ├── app/                      # tas CLI, composition, stdio lifecycle
│   ├── mcp/                      # result boundary, Manifest registry, and fixed phase tools
│   ├── core/
│   │   ├── profile/              # Profile projection and resolution
│   │   ├── repository/           # Profile-bound source, cursor, activity, and content ports
│   │   ├── skill/                # bundled TAS/Collaboration and Profile-bound Root/Role Skill loaders
│   │   └── workflow/             # generated operations, source resolution, verification, and process Gate
│   ├── clients/chain/            # viem exact-block Profile reader and bindings
│   ├── clients/repository/       # bounded GitHub activity and immutable content adapter
│   ├── clients/workflow/         # exact solc, canonical runtime-code, and generated SDK client boundaries
│   └── local/
│       ├── config/               # strict three-phase TOML loader
│       └── instance/             # canonical member path and process lock
├── skills/
│   ├── tas-bootstrap/SKILL.md    # minimal Host-installed product entry
│   ├── tas/SKILL.md              # release-matched TAS operating guidance
│   └── tawg-collaboration/SKILL.md # release-matched collaboration mechanics
├── test/
│   ├── fixtures/                 # deterministic Config/Profile/Repository/Skill/Anvil fixtures
│   ├── conformance/              # MCP, Repository/Skill flow, package, and public-fixture gates
│   ├── integration/              # CLI, stdio, GitHub, lock, and viem integration
│   └── unit/                     # core, client, MCP, and local unit coverage
├── cmd/tas/
│   └── main.go                   # retained legacy process scaffold
├── internal/verification/
│   ├── verify.go                 # retained snapshot digest experiment
│   ├── verify_test.go
│   └── README.md
├── config/
│   ├── local.yaml                # legacy draft configuration
│   └── tas.example.yaml          # legacy draft configuration
├── docs/
│   ├── DESIGN.md                 # Concise system overview
│   ├── TAWG.md                   # TAWG protocol design
│   ├── tawg/
│   │   ├── PROFILE.md            # TAWG Profile Solidity contract design
│   │   └── WORKFLOW.md           # Workflow source authority and verification
│   ├── TAS.md                    # TAS implementation design
│   ├── tas/
│   │   ├── MCP.md                # TAS MCP interface design
│   │   ├── CONFIG.md             # TAS TOML configuration contract
│   │   ├── CREDENTIALS.md        # Host-owned credential file contract
│   │   ├── MANIFEST.md           # generated tool Manifest contract
│   │   ├── SKILLS.md             # Skill layers and onboarding contract
│   │   └── IMPLEMENTATION.md      # phased TAS v0.1 implementation roadmap
│   ├── superpowers/plans/
│   │   ├── 2026-08-16-tas-documentation-restructure.md
│   │   ├── 2026-08-18-tas-foundation-profile.md
│   │   ├── 2026-08-19-tas-repository-skill.md
│   │   ├── 2026-08-22-tas-viem-chain-onboarding.md
│   │   ├── 2026-08-22-tas-demo-vertical-slice.md
│   │   ├── 2026-08-22-tas-demo-tawg.md
│   │   ├── 2026-08-22-tas-workflow-da.md
│   │   ├── 2026-08-22-tas-offline-integrations.md
│   │   └── 2026-08-22-tas-demo-e2e.md
│   ├── superpowers/specs/
│   │   └── 2026-08-22-tas-demo-vertical-slice-design.md
│   ├── PROJECT_STRUCTURE.md
│   └── research/                 # Design research notes
├── tas-skills/setup/             # Setup skill drafts
├── tawg/daily-contribution/      # Scenario and Agent skill drafts
├── docker/                       # Local Docker scaffolding
└── scripts/                      # Local setup scaffolding
```

`src/` is the active runtime and requires Node.js `>=24 <25`. The npm package ships only compiled `dist/**`, reviewed `manifests/**`, `skills/tas/SKILL.md`, `skills/tawg-collaboration/SKILL.md`, `docs/tas/CREDENTIALS.md`, and npm-required metadata. Tests, fixtures, source TypeScript, local configuration, state, Bootstrap installation material, and all legacy material are excluded from the package.

TAS has three public selectors and cumulative fixed tool inventories. All inventories include the complete, reviewed generated viem Public and Wallet Action groups from the shipped Manifests:

| Process | Selector | Implemented tools |
|---|---|---|
| Identity setup | `[identity_setup]`: `(chainId, identityRegistryAddress)` | `tas.get`, `collaboration.get`, `tawg.get`, `role.get`; only `tas.get` succeeds, plus reviewed viem groups |
| TAWG setup | `[tawg_setup]`: `(chainId, tawgAddress)` | the same four names; member-phase-only Skill calls return `SKILL_MEMBER_CONTEXT_REQUIRED`; adds `profile.get` and `profile.get_agent` |
| Member | `[instance]`: `(chainId, tawgAddress, ERC-8004 agentId)` | all four Skill calls pass the phase gate; normal operation failures still apply; adds Repository, Workflow, DA, configured Chat, and Proof Provider tools |

Both TAWG-bound phases use bounded/cancellable EIP-1898 canonical block-hash reads and return an exact block number/hash. Only the member phase owns a canonical instance directory and lock. Startup isolates the process; after connection, the TAS Skill requires `profile.get_agent` for the configured Agent and stops member operations on a nonmember result. Member composition derives one Repository Resolver from the Profile Resolver, then shares one stateless GitHub Client between Repository activity and Root/Role Skill content services. TAS itself does not retain Host credentials: the Agent owns wallet generation, its decimal `agentId`, source-native transaction handles, Repository cursor, retained Skill source metadata, approvals, automation grants, work state, and replay/reconciliation, supplying credentials inline only to calls that need them.

`internal/verification` contains Daily Contribution snapshot verification written in Go. It composes DA reads, digest recomputation, and scenario-specific enumeration checks; it is not a generic TAS DA or Proof Provider module. It remains only as a legacy scenario reference and MUST NOT be ported into TAS Core. Its eventual implementation belongs in the separate Daily Contribution TAWG project.

The Go/YAML/Docker/legacy Skill files predate the active TypeScript implementation. TAS v0.1 configuration is TOML; their presence does not make them active runtime or packaged content.

## Target v0.1 Structure

```text
src/
├── app/                       process composition and lifecycle
├── mcp/                       Layer 1 — MCP Adapter and Manifest registry
├── core/                      Layer 2 — Core modules
│   ├── profile/
│   ├── repository/
│   ├── skill/
│   ├── workflow/
│   └── chat/
├── clients/                   Layer 3 — configurable Clients
│   ├── chain/
│   ├── repository/
│   ├── da/
│   ├── chat/
│   └── proof-provider/
└── local/
│   ├── config/
│   └── instance/

skills/
├── tas-bootstrap/                # stable Host-installed product entry
├── tas/                          # TAS Skill bundled with each release
└── tawg-collaboration/           # Collaboration Skill bundled with each release

adapters/
├── template/
├── codex/
├── claude-code/
├── openclaw/
└── hermes/

test/
├── fixtures/
├── conformance/
└── integration/

.tas-e2e/                     deterministic local vertical-slice state (ignored)

tools/
└── manifest/                  build-time Manifest generation

tawg/
└── demo/                      standalone TAWG Repository template embedded for discovery
```

`src/mcp`, `src/core`, and `src/clients` map directly to the three TAS layers. The runtime Manifest registry belongs to Layer 1 because it produces the MCP tool inventory; the build-time generator remains outside the runtime layers under `tools/manifest`. Generated Manifest artifacts ship with TAS. `src/local` contains Config and setup/member instance concerns; it does not contain persistent operation credentials. `skills/tas-bootstrap` is the stable Host-installed product entry and only installs, connects, and loads `tas.get`. `skills/tas` and `skills/tawg-collaboration` are bundled release guidance. Each TAWG Repository owns `skills/SKILL.md` and `skills/roles/<role>.md`. `adapters` contains thin Agent Host packaging, MCP registration, Bootstrap Skill setup, lifecycle, and optional notification integration. Operation credentials remain in Agent Host-owned storage and are passed inline only to the MCP operation that needs them. Approval, automation, cursor, and work state stays in the Agent Host or workspace, never TOML. An authenticated RPC endpoint may be injected separately as process-scoped Chain transport configuration.

## Scenario and Host Logic

Daily Contribution business behavior remains outside TAS:

```text
Agent Host / Assist Agent
├── contribution interpretation
├── business deduplication
├── external-data writes
├── daily schedule
├── aggregation
└── signing policy
```

The markdown files under `tawg/daily-contribution/skills/` are scenario design inputs for that Agent. They are not TAS modules.

## Implementation Order

The authoritative slice boundaries are maintained in [TAS v0.1 Implementation Roadmap](tas/IMPLEMENTATION.md) and orchestrated by the [Demo Vertical Slice Master Plan](superpowers/plans/2026-08-22-tas-demo-vertical-slice.md).

1. Align the accepted interface documents with identity setup, TAWG setup, member TAS, and deferred external adapters.
2. Complete Slice A foundation/Profile discovery and generated viem onboarding.
3. Add `tawg/demo/` as a standalone TAWG Repository template embedded under TAS for discoverability.
4. Complete the remaining Slice C acceptance scenario using the implemented Repository/Root/Role Skill, generated inventory, Workflow-source verification, production `agent-sdk` binding, and Git DA surfaces.
5. Complete production Chat/Proof Provider ports with offline Chat Clients, empty Provider discovery, and Fake conformance adapters.
6. Run deterministic local E2E for three rounds and required process replacements.
7. Run the three-Agent acceptance gate from Bootstrap plus TAS/Collaboration/Root/Role Skills, with explicit human Action and Message Approval.
8. Write and execute a separate Daily Contribution integration plan only after the general path passes.
9. Add live Chat, Fede's concrete Proof Provider adapter, public-testnet validation, distribution, and additional thin Host Adapters as deferred work.

Implementation work should start only from reviewed interface specifications, not from directory names alone.
