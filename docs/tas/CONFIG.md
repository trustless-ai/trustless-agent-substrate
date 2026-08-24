# TAS v0.1 Configuration Contract

| Item | Value |
|---|---|
| Status | Draft; identity setup, TAWG setup, and member modes approved |
| Scope | Public `tas.toml` schema, environment resolution, and startup validation |
| Parent design | [TAS v0.1 Design](../TAS.md) |
| MCP interface | [TAS MCP Interface Design](MCP.md) |

> **Key decisions**
>
> 1. One `tas.toml` selects exactly one identity-setup process, one TAWG-setup process, or one `(chainId, tawgAddress, ERC-8004 agentId)` member instance.
> 2. The file selects local Clients and public connection metadata; it does not duplicate TAWG Profile or Repository authority.
> 3. Private keys and provider tokens never appear in `tas.toml`.
> 4. An authenticated RPC URL is injected by an Agent Host environment variable and treated as process-scoped Chain transport configuration.
> 5. Unknown fields and conflicting values fail startup. Configuration changes require a restart in v0.1.

## 1. Glossary

1. **Configuration file.** The public TOML document used to start one TAS instance.
2. **Identity setup.** The tuple `(chainId, identityRegistryAddress)` used by one short-lived process to create or inspect an ERC-8004 identity before a TAWG is selected.
3. **TAWG setup.** The tuple `(chainId, tawgAddress)` used by one short-lived, non-member process to read one TAWG Profile and register or update that identity's membership.
4. **Member instance.** The tuple `(chainId, tawgAddress, agentId)` that binds one member-phase TAS process to one TAWG member.
5. **ERC-8004 agentId.** The `uint256` Agent identifier issued by the Identity Registry selected by the TAWG Profile. It is not an Agent Host-local ID.
6. **Client selector.** A configuration value that chooses a TAS Layer 3 implementation without changing the external resource selected by the TAWG.
7. **Connection environment variable.** An environment variable whose value is resolved once at process startup and used to configure a Client transport.
8. **Operation credential.** A private key or provider token supplied inline to one MCP operation. It is separate from process-scoped RPC connection configuration.

## 2. Background

TAS needs enough local configuration to create or inspect one identity before a TAWG exists, then to discover one TAWG and register that identity, and finally to bind one member process to one Agent and one TAWG. At the same time, the TAWG Profile, immutable Charter reference, Repository, generated Manifests, and Workflow remain authoritative and must not be shadowed by local settings.

The configuration contract is intentionally small. Optional systems are enabled by adding their configuration entries, not by maintaining separate `enabled` flags.

## 3. Problem

Without one strict configuration contract, different Host Adapters could assign different meanings to Agent identity, duplicate Profile state, store secrets in public files, select arbitrary repositories or groups at call time, or expose different tools from the same TAS release.

The v0.1 contract must therefore define:

1. the exact identity-setup, TAWG-setup, member-identity, and Client-selection fields;
2. which values come from the Profile rather than local configuration;
3. how an authenticated RPC endpoint enters TAS without being stored in TOML;
4. how named Chat sources and targets are validated; and
5. when startup fails instead of running with a partial configuration.

## 4. Solution

### 4.1 Canonical identity-setup example

```toml
config_version = 1
mode = "identity_setup"

[identity_setup]
chain_id = "11155111"
identity_registry_address = "0x2222222222222222222222222222222222222222"

[chain]
family = "evm"
rpc_url_env = "TAS_RPC_URL"
```

Identity setup is intentionally independent of a TAWG. All four Skill names are discoverable: `tas.get` succeeds and `collaboration.get`, `tawg.get`, and `role.get` return `SKILL_MEMBER_CONTEXT_REQUIRED`. The phase also exposes the complete generated viem Public and Wallet Action namespaces. It accepts no Profile, Repository, Workflow, DA, Chat, Proof Provider, or member settings or capabilities.

### 4.2 Canonical TAWG-setup example

```toml
config_version = 1
mode = "tawg_setup"

[tawg_setup]
chain_id = "11155111"
tawg_address = "0x1111111111111111111111111111111111111111"

[chain]
family = "evm"
rpc_url_env = "TAS_RPC_URL"
```

TAWG setup contains no `agent_id`, Repository, DA, Chat, or Proof Provider configuration. It exposes the same four Skill names with the same member-phase-only call failures and exists only long enough to load `tas.get`, read the target Profile, and perform the reviewed membership operations described by the TAS Skill.

### 4.3 Canonical member example

```toml
config_version = 1
mode = "member"

[instance]
chain_id = "11155111"
tawg_address = "0x1111111111111111111111111111111111111111"
# ERC-8004 Identity Registry agentId (uint256), not an Agent Host-local ID.
agent_id = "340282366920938463463374607431768211457"

[chain]
family = "evm"
rpc_url_env = "TAS_RPC_URL"

[repository]
client = "github"

[da]
client = "git"

```

The long `agent_id` value is deliberate: implementations MUST treat it as an ERC-8004 `uint256` decimal string and MUST NOT parse it as a JavaScript `number` or confuse it with an Agent Host-local identifier.

### 4.4 Root, setup, and instance fields

| Field | Required | Rule |
|---|---:|---|
| `config_version` | Yes | Integer `1` for TAS v0.1. |
| `mode` | Yes | Exactly `identity_setup`, `tawg_setup`, or `member`. |
| `identity_setup.chain_id` | Identity setup only | Canonical positive decimal string representing an EIP-155 chain ID. |
| `identity_setup.identity_registry_address` | Identity setup only | Valid 20-byte EVM address of the ERC-8004 Identity Registry on `chain_id`. |
| `tawg_setup.chain_id` | TAWG setup only | Canonical positive decimal string representing an EIP-155 chain ID. |
| `tawg_setup.tawg_address` | TAWG setup only | Valid 20-byte EVM address of the TAWG Profile on `chain_id`. |
| `instance.chain_id` | Member only | Canonical positive decimal string representing an EIP-155 chain ID. |
| `instance.tawg_address` | Member only | Valid 20-byte EVM address of the TAWG Profile on `chain_id`. |
| `instance.agent_id` | Member only | Canonical decimal string in the ERC-8004 `uint256` range. |

Identity setup requires `[identity_setup]`, forbids every TAWG and member section, and creates no member instance directory or lock. TAWG setup requires `[tawg_setup]`, forbids `[identity_setup]` and `[instance]`, and creates no member directory or lock. Member mode requires `[instance]`, forbids both setup sections, and uses `(instance.chain_id, instance.tawg_address, instance.agent_id)` for the instance directory and process lock. `agent_id` is always the ERC-8004 Agent identity. The Authentication Wallet, membership, and member verifier are resolved from the Profile and chain; they are not configuration fields.

Decimal strings use canonical unsigned notation: ASCII digits only, with no leading zero unless the value is exactly `0`. `chain_id` MUST be greater than zero. `agent_id` MAY be zero when the selected ERC-8004 registry permits it. TAS normalizes EVM addresses for internal comparison but does not infer a different chain or address from local aliases.

### 4.5 Chain Client

| Field | Required | Rule |
|---|---:|---|
| `chain.family` | Yes | `evm` in v0.1. |
| `chain.rpc_url` | Conditional | Credential-free HTTP or HTTPS RPC URL. |
| `chain.rpc_url_env` | Conditional | Name of an environment variable containing the complete RPC URL. |

Exactly one of `rpc_url` and `rpc_url_env` MUST be present. `rpc_url_env` is recommended whenever the endpoint contains an API key, authorization component, or other non-public value.

`rpc_url_env` MUST match `[A-Za-z_][A-Za-z0-9_]*`. TAS resolves it once during startup. A missing or empty variable fails startup. The resolved value may remain in Chain Client transport state for the process lifetime, but MUST NOT appear in MCP results, public Resolution Context, errors, logs, or diagnostics. This connection-scoped value is an explicit exception to operation-scoped inline credentials; EOA private keys and all operation-authorizing credentials remain inline per MCP call.

### 4.6 Repository and DA Clients

These sections are required in member mode and forbidden in identity setup and TAWG setup.

| Field | Required | Rule |
|---|---:|---|
| `repository.client` | Yes | `github` in v0.1. |
| `da.client` | Yes | `git` in v0.1. |

These fields choose local Client implementations only. The Repository locator, default branch, Charter commit, and Charter path come from the TAWG Profile and Repository provider. They cannot be supplied or overridden in `tas.toml`.

Git DA always operates below `data/` in the Profile-selected Repository. The configuration does not accept a Repository locator or arbitrary DA path. IPFS remains a reserved Client boundary and becomes a valid selector only when its configuration contract and implementation are added.

### 4.7 Chat sources

Chat configuration is member-phase-only and forbidden in identity setup and TAWG setup. grammY and discord.js Manifests remain product-design contracts; live Telegram and Discord bindings are deferred beyond the local vertical slice.

Each `chat.sources` entry defines one Telegram Bot, Discord App, or future platform delivery stream:

| Field | Required | Rule |
|---|---:|---|
| `name` | Yes | Unique stable local name. |
| `platform` | Yes | `telegram` or `discord` in v0.1. |
| `poll_interval` | No | Positive duration; defaults to `6s`. |

Source names MUST be unique across platforms. Names use `[a-z][a-z0-9_-]{0,63}`. `poll_interval` uses an unsigned integer followed by `ms`, `s`, or `m`, with a v0.1 range from `1s` through `60s`. A source contains no bot token, session token, cursor, or group identifier. The applicable credential is supplied inline to the Chat MCP operation, and the Agent retains its Delivery Cursor.

### 4.8 Chat targets

Each `chat.targets` entry binds a stable name to one group or channel belonging to a configured source:

| Field | Required | Rule |
|---|---:|---|
| `name` | Yes | Unique stable local target name. |
| `source` | Yes | Name of an existing `chat.sources` entry. |
| `conversation_id` | Yes | Non-empty platform-native group or channel identifier encoded as a string. |

Target names use `[a-z][a-z0-9_-]{0,63}` and MUST be globally unique within the TAS instance. The pair `(source, conversation_id)` MUST also be unique. Every configured source MUST have at least one target. MCP callers select a configured target name; they cannot supply an arbitrary group or channel destination.

The Chat arrays are optional as a pair. When neither is present, TAS registers no `chat.*` tools. When they are present, TAS registers only the generated platform namespaces and `events.wait` bridges required by the configured sources. A source without targets, a target without a source, or one of the arrays without its matching entries fails startup.

### 4.9 Proof Providers

Proof Provider configuration is member-phase-only and forbidden in identity setup and TAWG setup. The standardized adapter contract remains product design, but the first concrete adapter is deferred beyond the local vertical slice.

Each `proof_providers` entry declares one configured integration returned through Proof Provider discovery:

| Field | Required | Rule |
|---|---:|---|
| `name` | Yes | Unique stable Provider name. |
| `type` | Yes | `attestation` in v0.1. `tee` and `zk` remain reserved. |
| `integration` | Yes | Integration identifier recognized by a shipped Proof Provider adapter Manifest. |
| `base_url` | Yes | Public HTTP or HTTPS endpoint without embedded credentials. |

Provider names use `[a-z][a-z0-9_-]{0,63}`. The entry contains no API key. A Provider operation receives its credential through the common inline MCP credential boundary. An unknown integration, unsupported Provider type, or integration not present in the shipped Manifest fails startup.

The `proof_providers` array is optional. `proof_provider.attestation.list` remains available and returns an empty list when no attestation Provider is configured; `[]` is a valid local vertical-slice result. Provider-specific `generate` and `validate` operations are registered only when a reviewed adapter Manifest and runtime dependencies are configured.

### 4.10 Values that are not configuration

`tas.toml` MUST NOT contain:

1. EOA private keys, GitHub tokens, Telegram or Discord tokens, Proof Provider API keys, OAuth tokens, or refresh tokens;
2. the Authentication Wallet or, in TAWG setup and member mode, the Identity Registry address; identity setup alone requires `identity_setup.identity_registry_address`;
3. a Repository locator, default branch, Charter commit, or Charter path;
4. Workflow addresses, governance rules, evaluation rules, or settlement rules;
5. Agent memory, Delivery Cursors, page cursors, business deduplication state, accepted-work state, Human Approvals, or automation grants;
6. Root or Role Skill content, a preselected role, a Skill commit, a caller-selected Repository, or a caller-selected Skill path;
7. generated Manifest contents or individual generated-tool allowlists; or
8. configurable stdout logging, because stdout is reserved for MCP stdio.

The Profile, release-bundled TAS and Collaboration Skills, Profile-selected Repository, loaded Root and Role Skills, generated Manifests, Agent Host/workspace, and external authoritative systems supply those values under their own rules.

### 4.11 Startup validation

TAS validates configuration before it registers MCP tools or initializes external Clients:

1. parse TOML without applying implicit type coercion;
2. require supported `config_version` and reject unknown fields;
3. validate `mode` and exactly one matching identity-setup, TAWG-setup, or member identity context;
4. resolve exactly one Chain RPC endpoint and redact an environment-derived value;
5. validate supported Client selectors;
6. enforce unique Chat source, Chat target, and Proof Provider names;
7. resolve every Chat target's source;
8. validate Proof Provider integrations against shipped adapter Manifests; and
9. in member mode, acquire the instance lock for the canonical identity tuple; both setup modes create no member lock; and
10. register only the MCP tools allowed in the selected mode.

Any failure stops startup. TAS MUST NOT expose a partial tool inventory or silently ignore an invalid entry. Configuration is immutable for the process lifetime; identity setup must stop before TAWG setup, and TAWG setup must stop before a member process starts with the completed configuration.

Stable configuration error codes are:

```text
CONFIG_FILE_NOT_FOUND
CONFIG_PARSE_FAILED
CONFIG_VERSION_UNSUPPORTED
CONFIG_FIELD_INVALID
CONFIG_CONFLICT
CONFIG_ENV_REQUIRED
CONFIG_REFERENCE_INVALID
CONFIG_CLIENT_UNSUPPORTED
```

Errors identify the invalid field or reference but redact environment values, URLs that may contain credentials, and all secret-bearing input.

### 4.12 Host Adapter boundary

The Bootstrap Skill guides installation, creation of an identity-setup or TAWG-setup `tas.toml`, MCP startup, and loading of `tas.get`. The returned TAS Skill guides identity and membership onboarding, conversion to the member-mode `tas.toml`, Host-owned credential configuration, and member loading of `collaboration.get`, `tawg.get`, and applicable `role.get(role)` calls. A Host Adapter locates the TAS package and configuration file, supplies declared connection environment variables, starts the stdio process, and installs the Bootstrap Skill through Host-native mechanisms.

The Adapter does not maintain an alternative schema, add TAWG business settings, resolve the Profile, fork any loaded Skill, own approval/cursor/work state, or turn Host-specific IDs into `agent_id`. The same `tas.toml` has the same meaning across every supported Agent Host.

### 4.13 Package and process entrypoint

The `@trustless-ai/tas` package declares one executable named `tas`. A Host starts MCP with:

```text
tas --config <absolute-path-to-tas.toml>
```

The selected TOML `mode` determines identity setup, TAWG setup, or member phase. The executable accepts no private key, provider token, RPC URL, Agent identity override, TAWG override, or Repository override on the command line. Connection environment variables declared by the TOML are injected by the Host process environment.

After MCP initialization begins, standard output is reserved exclusively for MCP stdio frames. Diagnostics and redacted logs use standard error. `tas --version` is a separate non-MCP invocation that prints the exact package version and exits successfully without loading configuration.

The Bootstrap Skill may install an exact package version below the Host user's TAS runtime directory and register the platform-specific `node_modules/.bin/tas` launcher. A Host Adapter may locate the same declared executable differently, but it cannot change its arguments or configuration meaning.
