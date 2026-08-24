# TAS Host Credential File Contract

| Item | Value |
|---|---|
| Status | Draft for working-group review |
| Scope | File-backed Agent Host credential storage for TAS v0.1 |
| Parent design | [TAS v0.1 Design](../TAS.md) |
| Skill flow | [TAS Skill Architecture and Onboarding](SKILLS.md) |

## 1. Boundary

The Agent Host, not TAS, owns persistent credentials. The v0.1 file-backed profile gives every Host the same minimal format while allowing a later Host Adapter to replace the file with an OS keychain, hardware wallet, remote signer, or another secret store.

TAS never opens this file. The Host reads exactly one required value and supplies it inline to exactly one MCP operation. TAS must not persist, cache, log, return, or place that value in an error.

## 2. Paths

The default credential root is separate from TAS instance state:

```text
~/.tas/credentials/
```

During creation of a new ERC-8004 identity, the Host may use one identity-scoped pending file:

```text
~/.tas/credentials/
└── eip155-<chainId>-<lowercase-identityRegistryAddress>/
    └── pending/
        └── <lowercase-walletAddress>/
            └── credentials.toml
```

After registration and confirmation of the intended non-zero Authentication Wallet, the Host uses a platform-native atomic no-replace rename to move pending to this identity-scoped final path on the same filesystem. If unavailable, leave the pending file unchanged and fail closed for explicit migration:

```text
~/.tas/credentials/
└── eip155-<chainId>-<lowercase-identityRegistryAddress>/
    └── agents/
        └── <canonical-decimal-agentId>/
            └── credentials.toml
```

After successful Profile membership in a known TAWG, the Host copies identity-final, without moving or overwriting either file, to the member-specific TAWG path:

```text
~/.tas/credentials/
└── eip155-<chainId>-<lowercase-tawgAddress>/
    └── agents/
        └── <canonical-decimal-agentId>/
            └── credentials.toml
```

An existing Agent uses its identity path for TAWG setup and its TAWG/member path for member operation. A Host-native secure store may replace these paths, but it must preserve the same identity `(chainId, identityRegistryAddress, agentId)` and member `(chainId, tawgAddress, agentId)` isolation. Credentials may be duplicated across TAWGs or Agents; one shared TAS process or shared mutable credential context is forbidden.

## 3. TOML schema

```toml
credential_version = 1

[wallet]
private_key = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

[repository]
credential = "github-token"

[da]
credential = "da-token"

[chat]
telegram-main = "telegram-bot-token"
discord-main = "discord-bot-token"

[proof_provider]
invino-veritas = "provider-api-key"
```

Only `credential_version` is always required. Every credential entry is optional until an operation needs it. Empty strings are invalid and absent credentials are omitted.

Rules:

1. `credential_version` is integer `1`.
2. `wallet.private_key`, when present, is `0x` followed by exactly 64 hexadecimal characters.
3. `repository.credential` and `da.credential` are independent; TAS assumes no implicit fallback between them.
4. Keys below `[chat]` exactly match configured `chat.sources[].name` values.
5. Keys below `[proof_provider]` exactly match configured `proof_providers[].name` values.
6. All stored values are TOML strings. Provider-specific interpretation belongs to the configured Client and the release-matched TAS Skill.
7. Unknown top-level tables and unknown fields below `[wallet]`, `[repository]`, or `[da]` are rejected. Dynamic keys are allowed only below `[chat]` and `[proof_provider]`.
8. The file contains no RPC URL. An authenticated RPC URL remains a process-scoped environment value selected by public `tas.toml`.

## 4. Creation and permissions

The Host creates credential directories with owner-only access. On POSIX systems, directories use mode `0700` and `credentials.toml` uses mode `0600`. A Host must reject a file that is a symlink, is not a regular file, or is readable or writable by group or others. On Windows, the Host applies and verifies an equivalent current-user-only ACL when its integration supports ACL management; otherwise it warns the user before using the file.

The Host writes updates through a same-directory temporary regular file with restrictive permissions, flushes it, and atomically replaces the destination. It never prints the TOML content or embeds credentials in command arguments, process titles, MCP configuration, public `tas.toml`, the TAS instance directory, the TAWG Repository, or logs.

For a pending wallet file, the Host derives the wallet address from `wallet.private_key` and requires it to match the pending directory name. The Host never replaces an existing pending file silently; it stops for explicit wallet reconciliation. After registration and confirmation of the intended non-zero Authentication Wallet, it uses a platform-native atomic no-replace rename to move pending to identity-final on the same filesystem. If unavailable, leave the pending file unchanged and fail closed for explicit migration. During TAWG setup, after the Profile's Identity Registry is confirmed to match the identity and Profile membership succeeds, it uses an exclusive create-new destination primitive (`O_CREAT|O_EXCL` equivalent) with owner-only permissions; the Host must write and flush the TAWG/member copy. `EEXIST` means stop for reconciliation; it never overwrites. This never removes identity-final. The identity-final file remains intact only as the source of this later TAWG/member copy.

## 5. Operation use

Before a sensitive MCP call, the Agent follows this sequence:

1. determine the one credential purpose required by the selected tool;
2. read only the matching field from the Host Credential File;
3. for an EVM write on behalf of an existing or configured Agent, derive the Account and confirm its address matches that Agent's current ERC-8004 Authentication Wallet; identity setup uses only the configured Identity Registry and does not call Profile;
4. pass the value through that tool's inline credential field;
5. retain any source-native handle returned for the Agent's own operation path; and
6. discard the operation-scoped credential value after the call.

The complete file is never passed to TAS. A Role Skill may name the applicable Chat source or Proof Provider, but it cannot select another Agent's credential path or override Host permissions.

Initial ERC-8004 `register` is the deliberate exception to the existing-Agent wallet comparison because no `agentId` or Authentication Wallet exists before registration. The Host uses the pending wallet credential, obtains the new `agentId`, and then requires the Registry's non-zero Authentication Wallet to match the intended signer before Profile registration. Registry-specific wallet establishment or rotation follows that Registry's contract rules and must not be mistaken for an ordinary action by an already bound Agent.

## 6. Missing and expired credentials

When TAS returns `CREDENTIAL_REQUIRED`, the TAS Skill or applicable Role Skill identifies the required credential purpose and guides the user through the provider's normal login, token creation, or refresh flow. The Host atomically updates only the matching field. The Agent decides from its own operation path and authoritative external state whether to call the failed operation again.

`AUTHORIZATION_DENIED` is not treated as expiration. `WALLET_MISMATCH` requires selecting the private key for the current Authentication Wallet or completing the Registry's wallet-rotation process; the Host must not overwrite identity configuration to make a mismatched key appear valid.

## 7. Security limits

This file-backed profile protects against accidental Repository commits, cross-TAWG confusion, permissive file modes, and TAS persistence. It does not protect against a compromised Agent Host, malware running as the same operating-system user, process-memory inspection, or a user who reveals a secret in chat. High-value deployments should use a stronger Host-native signer or secret store when those integrations become available.
