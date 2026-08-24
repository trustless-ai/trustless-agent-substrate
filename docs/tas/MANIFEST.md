# TAS Manifest Contract

| Item | Value |
|---|---|
| Status | Draft for review |
| Schema | `tas-manifest/v1` |
| Scope | Build-time generation, review, publication, startup validation, and MCP registration |
| Parent design | [TAS v0.1 Design](../TAS.md) |
| MCP interface | [TAS MCP Interface Design](MCP.md) |

> **Generate at build time. Review before release. Validate at startup. Never reflect at runtime.**

## 1. Purpose

TAS exposes selected TypeScript dependency capabilities as MCP tools. The installed `agent-sdk`, viem, grammY, and discord.js packages may change over time, so TAS must not maintain a second handwritten inventory of their operations.

A **Manifest** is the reviewed, deterministic contract between an exact dependency version and the MCP tools shipped by a TAS release. It records what TAS exposes, how each tool is invoked, which values TAS injects, and which common MCP rules apply.

The Manifest system has four goals:

1. follow supported dependency capabilities without copying their operation lists by hand;
2. keep the MCP interface stable for the lifetime of a TAS release and process;
3. make dependency-driven interface changes visible in code review; and
4. fail closed when a source type, operation, or semantic mapping cannot be represented safely.

## 2. Boundaries

The Manifest system covers:

1. generated `agent-sdk` Workflow tools;
2. generated viem Public and Wallet Action tools;
3. generated Telegram and Discord tools; and
4. reviewed Proof Provider Adapter tools.

It does not cover TAS-owned fixed tools:

```text
profile.*
repo.*
tas.get
collaboration.get
tawg.get
role.get
workflow.da.*
proof_provider.attestation.list
```

Those interfaces are defined directly by TAS because they are stable TAS concepts rather than projections of an upstream TypeScript package.

A TAWG Repository cannot provide, replace, or extend a TAS Manifest. TAS does not download Manifests, generate them during startup, reflect over packages at runtime, or evaluate code named by Repository content or configuration.

Process mode may select complete reviewed namespace groups without changing any Manifest entry. Every mode registers the four fixed Skill names. In identity setup `(chainId, identityRegistryAddress)`, only `tas.get` succeeds; the other three return `SKILL_MEMBER_CONTEXT_REQUIRED`, and the complete generated viem Public and Wallet Action namespaces are available. TAWG setup `(chainId, tawgAddress)` adds the fixed public Profile onboarding tools and has the same Skill call-time boundary. Neither setup mode registers Repository activity, `agent-sdk`, DA, Chat, or Proof Provider operations. Member mode `(chainId, tawgAddress, agentId)` registers the complete groups selected by its configuration and permits all four Skill calls. TAS never maintains a second per-operation allowlist inside those groups.

## 3. Manifest Classes

### 3.1 Dependency Manifest

A Dependency Manifest is generated mechanically from the public callable interface of one exact installed TypeScript package.

TAS v0.1 defines these source profiles:

| Source profile | Package | MCP namespace |
|---|---|---|
| `agent-sdk` | `@trustless-ai/agent-sdk` | `workflow.*` |
| `viem-public` | `viem` Public Actions | `workflow.chain.public.*` |
| `viem-wallet` | `viem` Wallet Actions | `workflow.chain.wallet.*` |
| `telegram` | grammY | `chat.telegram.*` |
| `discord` | discord.js | `chat.discord.*` |

A source profile defines structural eligibility and invocation conventions for a package family. It is not a per-operation allowlist.

### 3.2 Provider Adapter Manifest

TypeScript names alone cannot determine that one Provider method means “generate a proof” and another means “validate a proof.” A Proof Provider therefore uses a reviewed Provider Adapter.

The Adapter implementation satisfies TAS's internal `generate` and `validate` interface and performs any required source-specific argument or result conversion. Its Manifest:

1. identifies the exact source package and Adapter implementation;
2. assigns the Proof Provider type and name;
3. exposes the Adapter's `generate` and `validate` schemas; and
4. records the source methods to which those semantic operations correspond.

For every v0.1 Proof Provider Adapter, the Agent-facing `validate` output schema is:

```json
{
  "type": "object",
  "properties": {
    "valid": {"type": "boolean"},
    "reason": {"type": "string", "minLength": 1}
  },
  "required": ["valid", "reason"],
  "additionalProperties": false
}
```

Provider-specific intrinsic checks may be richer internally. The Adapter combines them into the boolean conclusion and human-readable reason. Invalid, malformed, wrongly issued, or signature-invalid proof content is represented by `valid = false`; it is not a tool execution error.

The Manifest does not contain executable expressions, scripts, arbitrary imports, or a data-driven transformation language. `adapter_id` can select only an Adapter implementation bundled and registered by the same TAS release.

When a reviewed Provider Adapter is added after the local vertical slice, it may map:

```text
proof_provider.attestation.invino_veritas.generate
    → bundled InvinoVeritas Adapter
    → ReviewGateClient.review

proof_provider.attestation.invino_veritas.validate
    → bundled InvinoVeritas Adapter
    → ReviewGateClient.verifyLocal
```

Provider-reserved modules such as `governance/InvinoVeritas` MUST remain absent from generic `workflow.*` until a reviewed Adapter claims and maps them.

## 4. Artifact Model

Each Manifest is a canonical JSON document serialized with the JSON Canonicalization Scheme (RFC 8785). Tool entries are sorted by full MCP tool name before serialization, so the same inputs and generator version produce byte-identical output. Embedded `input_schema` and `output_schema` values use JSON Schema Draft 2020-12.

The top-level contract is:

```json
{
  "schema_version": "tas-manifest/v1",
  "manifest_id": "agent-sdk",
  "kind": "dependency",
  "source_profile": "agent-sdk",
  "source": {
    "package": "@trustless-ai/agent-sdk",
    "version": "0.3.0",
    "entrypoint_digest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "entrypoints": [".", "./execution/ERC8301"]
  },
  "generator": {
    "name": "@trustless-ai/tas-manifest",
    "version": "0.1.0",
    "typescript_version": "7.0.2"
  },
  "tools": []
}
```

### 4.1 Top-level fields

| Field | Requirement |
|---|---|
| `schema_version` | Required. Exact supported schema identifier. v0.1 accepts only `tas-manifest/v1`. |
| `manifest_id` | Required. Stable identifier unique inside one TAS release. |
| `kind` | Required. `dependency` or `provider_adapter`. |
| `source_profile` | Required. Selects a built-in, reviewed generation and binding profile. |
| `source.package` | Required. Exact npm package name. |
| `source.version` | Required. Exact resolved version; ranges are forbidden. |
| `source.package_integrity` | Optional only when the package source has no package-manager integrity value. |
| `source.entrypoint_digest` | Required. SHA-256 digest of the source-profile-specific reviewed entrypoint material. viem and `agent-sdk` bind their declaration/runtime/package-tree closure; Chat profiles bind exact package identity, the public type-entrypoint path, and its bytes. |
| `source.entrypoints` | Required. Sorted public package export subpaths inspected or claimed by this Manifest. |
| `generator` | Required. Generator and TypeScript compiler versions used to create the artifact. |
| `tools` | Required. Stable tool entries sorted by full MCP tool name. |

A Provider Adapter Manifest also contains:

```json
{
  "provider": {
    "type": "attestation",
    "name": "invino_veritas",
    "adapter_id": "invino-veritas-v1",
    "claimed_entrypoints": ["./governance/InvinoVeritas"]
  }
}
```

Provider `type` is `attestation`, `tee`, or `zk`. Only `attestation` has a v0.1 implementation.

### 4.2 Tool entry

Every generated tool has this logical record:

```json
{
  "name": "workflow.execution.erc8301.agent_workflow.run",
  "description": "Run an ERC-8301 Agent Workflow operation.",
  "source": {
    "entrypoint": "./execution/ERC8301",
    "export": "AgentWorkflowClient",
    "member": "run"
  },
  "binding": {
    "kind": "class_method",
    "target": "AgentWorkflowClient.run",
    "arguments": [
      { "kind": "input", "name": "inputHash" },
      { "kind": "input", "name": "input" },
      { "kind": "input", "name": "expiresAt" }
    ]
  },
  "input_schema": {},
  "output_schema": {},
  "operation": {
    "effect": "side_effect",
    "completion": "external_handle"
  },
  "runtime_dependencies": ["chain_client", "contract_address", "account"],
  "credential": "evm_private_key",
  "annotations": {}
}
```

The fields mean:

| Field | Requirement |
|---|---|
| `name` | Full globally unique MCP tool name produced by the source profile's naming rules. |
| `description` | Stable concise description derived from public source documentation when available; it cannot change invocation semantics. |
| `source` | Public package location and callable identity used for review and diagnostics. |
| `binding` | One supported invocation form: `function`, `class_method`, `client_action`, `chat_operation`, or `provider_adapter`. An `agent-sdk` function or class method records its complete ordered call arguments. Each argument is either `{ kind: "input", name }` or the runtime-injected `{ kind: "runtime", source: "chain_config" }`. A `client_action` has no `arguments` field. |
| `input_schema` | Complete JSON Schema exposed to the MCP caller, including the common inline `credential` argument when applicable. Source-native replay or idempotency parameters remain ordinary source-operation fields. |
| `output_schema` | Schema for the tool-specific `data`; the MCP Adapter adds the common result context and error envelope. |
| `operation.effect` | `read` or `side_effect`. Unknown effects are classified as `side_effect`. |
| `operation.completion` | `synchronous`, `bounded_wait`, or `external_handle`. |
| `runtime_dependencies` | Values TAS resolves and injects rather than accepting as arbitrary destinations from the caller. |
| `credential` | `none` or the one expected inline credential purpose. The secret remains optional in the MCP schema so TAS can return `CREDENTIAL_REQUIRED`. |
| `annotations` | Accurate MCP tool annotations derived from the operation classification. |

`runtime_dependencies` may use only names understood by the selected source profile, including:

```text
chain_client
contract_address
account
repository
da_client
chat_source
chat_target
chat_context
proof_provider_config
```

Unknown runtime dependencies fail generation or startup. Runtime-injected destinations do not appear as caller-selectable fields in `input_schema`.

For an `agent-sdk` binding, input argument slots cover every `input_schema.properties` field other than the optional common `credential` exactly once, including optional source parameters. Their array order is the source call order. A `chain_config` slot replaces the exact SDK parameter into which TAS injects its configured RPC URL and Profile-resolved contract address; it corresponds to `chain_client` and `contract_address` runtime dependencies. Constructor dependencies remain `runtime_dependencies` rather than method-call arguments.

## 5. Generation

Generation is an explicit developer action after a pinned dependency changes:

```text
resolve exact dependency and lockfile
        ↓
read public package exports and TypeScript declarations
        ↓
apply the source profile's structural eligibility rules
        ↓
derive names, JSON Schemas, operation modes, and runtime dependencies
        ↓
validate bindings and global tool-name ownership
        ↓
write canonical Manifest and generation report
        ↓
review the generated diff
        ↓
publish the accepted Manifest with TAS
```

Generation MUST NOT modify a Manifest by comparing it with the previous artifact. The new artifact is derived only from the current exact inputs. Previous and new artifacts are compared during review.

### 5.1 Source discovery

Only public package entrypoints declared by the package's `exports` map or by a source profile's documented public Client interface are eligible. Deep imports into unexported implementation files are forbidden.

For `agent-sdk`:

1. exported functions are eligible;
2. public instance methods of exported classes are eligible;
3. constructors, types, constants, private and protected members are excluded structurally;
4. package subpaths and exported class names determine the namespace; and
5. a trailing `Client` is removed from the class-name segment; and
6. every public export subpath must declare normalized package-relative `types` and `default` paths. After the reviewed package-tree snapshot, generation re-reads `package.json`, requires both paths to equal the analyzer's reviewed metadata, hashes the exact type bytes, and requires the `default` path to be present in the reviewed runtime-file closure.

For viem, only Public Actions and Wallet Actions are eligible. Client construction, transports, types, constants, utilities, callbacks, subscriptions, and unrelated Client plumbing are outside the projection.

Eligibility does not permit an authorization bypass. A Wallet Action is included only when its authorization can be bound to the operation-scoped Account injected by TAS. A Public Action that can submit a signed transaction or otherwise create an authenticated Chain write is included only when the source profile can deterministically bind that write to the configured Agent's Authentication Wallet. An action that cannot satisfy those structural rules is excluded with an explicit machine-readable reason in the generation report. TAS does not maintain a handwritten per-action allowlist, and raw-transaction submission cannot become a backdoor around Account injection.

For grammY and discord.js, only finite request-response operations with JSON-compatible inputs and outputs are eligible. Streaming callbacks and subscription registration are outside the projection. TAS defines `chat.telegram.events.wait` and `chat.discord.events.wait` separately as bounded platform bridges.

### 5.2 Type conversion

The generator uses the TypeScript compiler's resolved type model rather than parsing declaration text heuristically.

1. Exposed inputs and outputs MUST have finite JSON Schema representations.
2. `bigint` and integer types that may exceed JavaScript's safe range are exposed as canonical decimal strings.
3. byte arrays and binary values use the explicit `{ "encoding": "hex", "value": "0x..." }` content envelope rather than an untyped JSON array or a bare Hex string. Their generated schema carries `"x-tas-type": "bytes"`; only an analyzer-proven byte type may emit that marker. The codec reconstructs a built-in `Uint8Array` only when this marker is present, so a source object with the same two fields remains an ordinary object.
4. unions must have an exact JSON representation. Mutually exclusive branches use `oneOf`. When the source union itself has overlapping branches, the generator may use `anyOf` only when every overlapping match decodes to the same structural value; TAS rejects a value if matching branches decode differently.
5. functions, callbacks, streams, symbols, recursive types without a finite schema, and opaque runtime objects cannot appear in an exposed schema.
6. optionality, nullability, enums, tuple ordering, and documented size constraints are preserved.
7. schemas use `additionalProperties: false` unless the source type explicitly defines a string-keyed map.

If a public `agent-sdk` callable is otherwise eligible but cannot be converted, generation fails. Structurally ineligible viem or Chat callables are excluded and recorded in the generation report.

### 5.3 Naming and ownership

All generated names are lowercase `snake_case` namespace segments.

The registry enforces:

1. global uniqueness across fixed TAS tools and every loaded Manifest;
2. one owner for each source entrypoint and callable;
3. no simultaneous generic and Provider Adapter exposure of one claimed source module; and
4. no aliases or automatic renaming to resolve collisions.

Ambiguity is a generation failure. A developer must change the source profile, source package, or Adapter design and review the resulting interface.

### 5.4 Operation classification

Classification is conservative:

1. ABI `view` and `pure` operations are reads;
2. `agent-sdk` functions under an explicit `recompute` subpath are reads;
3. viem Public Actions are reads unless their resolved type and documented interface prove an external side effect; an authenticated Chain write without a supported Agent binding is structurally excluded;
4. viem Wallet Actions are side effects unless proven read-only and are structurally excluded when TAS cannot inject the operation-scoped Account;
5. message sends, edits, deletes, DA writes, chain writes, and proof generation are side effects;
6. Provider validation is a read; and
7. anything unresolved is a side effect or a generation failure, never an optimistic read.

Common MCP arguments and behavior follow the classification in [MCP.md](MCP.md): credentials are inline and redacted; TAS does not automatically replay side effects; bounded waits and external handles retain their source-native semantics.

Generated MCP annotations are conservative and mechanical. A `read` has `readOnlyHint = true` and `destructiveHint = false`. A `side_effect` has `readOnlyHint = false` and `destructiveHint = true`, including Wallet signing and write operations, so the Host never receives an optimistic approval hint. This mapping is source-profile-wide and has no per-action override list.

### 5.5 Generation report

Every generation run produces a deterministic review report beside the Manifest. Its operation classifications are review material and are not used to add tools at runtime. For dependency Manifests whose entrypoint digest binds a declaration closure, the runtime loader reads the bundled report only to recompute that closure without starting TypeScript. The report records:

1. source package, version, integrity, analyzed entrypoints with exact `exported_types_path`, `exported_runtime_path`, and type-file digest, the narrower semantic-trust dependencies, every reviewed package's exact name/version/lock integrity plus `package_tree_sha256`, `package_file_count`, and `package_total_bytes`, every actually analyzed third-party declaration, and every runtime JavaScript file used for effect classification as stable package name, version, package-relative path, and SHA-256 digest;
2. generated tools and their operation classification;
3. structurally excluded exports and machine-readable reasons;
4. source modules claimed by Provider Adapters;
5. schema or binding failures; and
6. changes from the previously committed Manifest when one exists.

No eligible callable may disappear without either appearing in the Manifest or causing generation to fail. Structural exclusions must remain visible in the report.

### 5.6 Reviewed package-tree snapshot

The declaration closure explains which types produced the interface; it is not a complete installed-code integrity boundary. Generation therefore recursively snapshots every regular file below each reviewed package root, including package metadata, JavaScript, JSON, declarations, source maps, documentation, and other ordinary files. A symlink, special filesystem entry, nested `node_modules`, unsafe real path, or exceeded budget fails generation. Empty directories are not tree entries.

Files are ordered by the UTF-8 bytes of their `/`-normalized package-relative paths. Hashing is incremental and uses an unambiguous frame `uint64be(byte_length) || bytes`. A file digest is:

```text
SHA256(frame("trustless-ai/tas/reviewed-package-file/v1") || frame(file_bytes))
```

The package tree digest is:

```text
SHA256(
  frame("trustless-ai/tas/reviewed-package-tree/v1") ||
  for each sorted file:
    frame("file") || frame(relative_path_utf8) ||
    frame(uint64be(file_size)) || frame(raw_file_digest) ||
  frame("summary") || frame(uint64be(file_count)) || frame(uint64be(total_bytes))
)
```

Production limits are 4 MiB per file, 20,000 files and 128 MiB per package, and 50,000 files and 256 MiB globally. Directory traversal is separately bounded to 50,000 directories per package and 100,000 globally. Directory entries are streamed and charged before filesystem inspection, with limits of 50,000 entries per package and 100,000 globally. The report stores only the aggregate digest, count, and byte total; it does not embed the full file list.

Generation also emits `generatedViemArtifactDigests.ts`, `generatedAgentSdkArtifactDigests.ts`, and `generatedChatArtifactDigests.ts` under `src/mcp/manifest/`. These compiled trusted constants fix the SHA-256 of the exact raw bytes of every bundled dependency Manifest and review report, including Telegram and Discord. The constant files are not among their own hash inputs. Normal generation fully computes and validates all dependency JSON artifacts before moving any destination, then publishes the nine JSON files and three digest sources as one staged, rollback-capable and recoverable transaction. A handled generation or publication failure restores the complete previous set, so it cannot leave mixed dependency generations. This publication is not crash-atomic across the two destination directories: a process crash or concurrent reader can still observe a mixed set. Generation and consumption therefore require an exclusive workspace, and `npm run manifest:check` MUST pass immediately before any build, package, or release step consumes these files. A mismatch fails closed.

## 6. Runtime Loading and Binding

TAS performs no TypeScript analysis at runtime. On startup, the Manifest Registry:

1. loads only bundled JSON artifacts whose source profiles and exact raw-byte digests are compiled into the installed TAS release; generating an additional artifact does not by itself admit that profile at runtime;
2. validates the Manifest JSON against the supported `tas-manifest/v1` schema;
3. loads the matching bundled generation report, resolves each reviewed package at its nearest npm package manifest to one exact installed package-lock entry, derives and verifies its npm name from the final `node_modules/` portion of that lock key, and verifies package.json version and canonical lock integrity; identity-free nested module/exports markers do not create package boundaries, while an unlocked or malformed inner npm manifest fails without falling back to an ancestor;
4. for viem and `agent-sdk`, uses the same published scanner and framed-hash algorithm as generation to recompute every complete reviewed package tree, re-resolves every public export's exact `types` and `default` paths, then bounded-reads every listed regular non-symlink type, declaration, and reviewed runtime file; for Chat, resolves the fixed grammY or discord.js package from the hidden npm lock, verifies exact version and integrity, and bounded-reads its regular non-symlink public type entrypoint; each profile then recomputes and verifies its source digest;
5. checks source-profile support, Adapter registration, tool-name uniqueness, source ownership, and runtime dependency names;
6. binds each entry to a built-in invocation form or bundled Provider Adapter;
7. composes the common MCP result envelope and error behavior; and
8. registers the resulting stable tool inventory with the MCP Adapter.

The runtime seam is intentionally small:

```text
load bundled Manifests
validate against installed sources
bind reviewed targets
return immutable Tool Definitions
```

Callers and MCP registration code do not need to know how TypeScript declarations were analyzed.

The production trust boundary begins before viem is loaded. `src/app/main.ts` must first invoke a bundled validator whose module graph does not import viem. Only after raw-artifact, package identity, complete package-tree, declaration, and entrypoint validation succeeds may it dynamically import `createTasApp`; that delayed graph may then load `loadConfig`, `ProfileReader`, viem, and Task 6 action bindings. A test that directly imports an internal module does not establish this production startup boundary.

This validation detects static tampering present before startup; it is not a defense against a concurrent writer. From the beginning of validation through the entire TAS process lifetime, the reviewed installation tree—including TAS code, bundled artifacts, and reviewed dependency packages—MUST not be concurrently writable. Deployments satisfy this assumption with a read-only installation, a different owner or service UID, or an immutable image or mount. A same-UID adversarial process can replace TAS itself or mutate files after validation; pure Node.js path checks and dynamic-import ordering cannot defend that threat, which is outside the v0.1 boundary.

Configuration may select which bundled Provider integrations and Chat sources are active. It cannot introduce a new Manifest, source package, binding kind, Adapter, or tool name. `tools/list` remains stable until the TAS process restarts.

## 7. Validation and Failure Behavior

Generation, build, and startup fail closed for:

```text
MANIFEST_SCHEMA_UNSUPPORTED
MANIFEST_INVALID
MANIFEST_SOURCE_MISSING
MANIFEST_SOURCE_VERSION_MISMATCH
MANIFEST_SOURCE_INTEGRITY_MISMATCH
MANIFEST_ARTIFACT_INTEGRITY_MISMATCH
MANIFEST_PACKAGE_TREE_MISMATCH
MANIFEST_ENTRYPOINT_MISMATCH
MANIFEST_TOOL_COLLISION
MANIFEST_SOURCE_OWNERSHIP_CONFLICT
MANIFEST_BINDING_UNSUPPORTED
MANIFEST_ADAPTER_NOT_REGISTERED
MANIFEST_RUNTIME_DEPENDENCY_UNKNOWN
MANIFEST_SCHEMA_CONVERSION_FAILED
MANIFEST_OPERATION_AMBIGUOUS
```

These are startup or build failures, not ordinary Agent tool errors. TAS MUST NOT start with a partial generated interface, silently remove a tool, downgrade a mismatch to a warning, or regenerate an artifact automatically.

Sensitive source values, local paths, environment variables, and credentials never appear in a Manifest or generation report.

## 8. Versioning and Upgrades

Manifest schema versioning is independent of TAS and source-package versions.

1. Compatible clarifications may retain `tas-manifest/v1`.
2. Removing or changing the meaning of a required field requires a new schema version.
3. A source dependency upgrade requires regeneration even if its public types appear unchanged.
4. Any generated tool addition, removal, rename, schema change, effect change, or credential change is reviewed as an MCP interface change.
5. Accepted Manifests ship only through a new TAS release; they are never hot-swapped into a running process.
6. TAS v0.1 does not provide compatibility aliases for removed generated tools. The release-bundled TAS and Collaboration Skills, accompanying TAWG Root and Role Skills, and TAS release notes must refer to the tool inventory shipped by that release.

## 9. Conformance

Manifest conformance tests use committed fixture packages and artifacts. They cover at least:

1. deterministic generation from identical inputs;
2. public function and class-method projection;
3. `agent-sdk` recompute naming and read classification;
4. viem Public and Wallet Action separation;
5. Chat structural exclusions and generation reports;
6. TypeScript-to-JSON-Schema edge cases;
7. common credential schema composition and preservation of source-native replay fields;
8. Provider Adapter source claiming and generic-projection exclusion;
9. tool-name and source-ownership collision rejection;
10. source version, integrity, and entrypoint mismatch rejection;
11. missing Adapter and unknown runtime dependency rejection; and
12. stable MCP `tools/list` registration from an accepted Manifest set;
13. modified, added, or removed package files, unsafe tree entries, and fixed tree budgets;
14. exact raw-byte artifact digest constants and tampered constant/artifact rejection; and
15. production validation completing before dynamic import of any viem-dependent module graph.

When a concrete Adapter is added, one integration fixture maps its Client to the two standardized Proof Provider tools, proves that validation findings are reduced to `{ valid, reason }`, and proves that the same source module is absent from `workflow.*`.

## 10. v0.1 Decisions

TAS v0.1 therefore fixes these decisions:

1. Manifests are build-time JSON artifacts bundled with TAS.
2. Dependency Manifests are generated from exact public TypeScript interfaces.
3. Provider Adapter Manifests bind only reviewed, bundled Adapter implementations.
4. Runtime loading validates and registers Manifests but never generates or downloads them.
5. A TAWG cannot extend the TAS executable interface through its Repository or Profile.
6. Source and tool ambiguity fails closed.
7. Generated interface changes require regeneration, review, and a TAS release.
8. `tools/list` is the final authoritative inventory for one running TAS instance.
9. Runtime rediscovers neither TypeScript types nor tools, but it does recompute every reviewed package's complete bounded file tree before loading viem.
