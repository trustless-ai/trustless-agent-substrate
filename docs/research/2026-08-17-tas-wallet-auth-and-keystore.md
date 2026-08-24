# TAS Wallet Authentication and Agent-Owned Credential Research

Date: 2026-08-17

> **Status:** Research record. The Credential Broker, Host pairing, delegated Signer, and private capability channel explored below are not part of TAS v0.1. The normative v0.1 decision is defined in [TAS.md](../TAS.md): the Agent Host stores credentials locally and supplies the required secret inline for one sensitive MCP operation.

## 1. Research question

How should TAS separate stable Agent identity, wallet authorization, and persistent credential storage? What stronger industry patterns could replace a simple inline-secret v0.1 design later?

## 2. Executive conclusion

The research supports a strong long-term separation between Agent identity, authentication, credential storage, and signing. TAS v0.1 deliberately adopts a smaller model:

1. `agentId` remains the stable Agent principal and TAS instance dimension.
2. The TAWG's current ERC-8004 `agentWallet` is the v0.1 Authentication Wallet.
3. The Agent Host persistently stores the EOA private key and provider tokens, initially in a local credential file configured through the Bootstrap Skill and later maintained under the loaded TAWG Skill's guidance.
4. A sensitive MCP call includes only the secret needed for that operation. TAS uses it transiently and does not persist, cache, log, or return it.
5. For a chain write, TAS constructs an Account for that call and verifies that its derived address matches the current Authentication Wallet. TAS and `agent-sdk` retain only connection state.
6. Missing or expired provider credentials produce `CREDENTIAL_REQUIRED`; the Skill guides login or refresh, updates the local credential, and retries idempotently.

This simple path does not protect secrets from a compromised Agent Host, model context, Host tracing, or another process that can read the Host credential file. High-value signing should use one of the stronger patterns researched below when TAS adds a reference-based authorization mode.

Standards maturity matters: ERC-8004, ERC-7710, and ERC-7715 are marked Draft as of this research date, while ERC-4361, EIP-712, and ERC-1271 are Final. TAS can adopt the former group as design patterns, but should not freeze wire compatibility without pinning the exact revision. The status is shown on each linked EIP page.

## 3. Important ERC-8004 distinction

### Industry fact

ERC-8004 identifies an Agent using an Identity Registry and `agentId`; the identity is an ERC-721 token whose owner can transfer ownership or delegate supported management operations. The reserved `agentWallet` metadata is described as the address where the Agent receives payments. Setting a new `agentWallet` requires proof of control through EIP-712 for an EOA or ERC-1271 for a contract wallet, and transferring the Agent clears that wallet. See the [ERC-8004 Identity Registry specification](https://eips.ethereum.org/EIPS/eip-8004#identity-registry).

### TAS inference

The address returned by `getAgentWallet(agentId)` is a cryptographically verified address associated with the Agent, but ERC-8004 does not define it as a universal authentication or management key. TAS must not silently infer “Agent authentication authority” from the field's name.

TAWG should explicitly select its authentication rule, for example:

```text
agent principal       = (identityRegistry, agentId)
authentication source = ERC-8004 agentWallet | ERC-721 owner | TAWG membership binding
resolved address       = current address at a specified chain context
```

If TAS v0.1 intentionally chooses ERC-8004 `agentWallet`, the specification should say that a TAWG treats the currently verified `agentWallet` as its Agent authentication wallet. It should also define what happens when the address is unset, rotated, or cleared by an Agent transfer.

## 4. Wallet-based authentication standards

### 4.1 SIWE / ERC-4361

#### Industry fact

Sign-In with Ethereum defines a human-readable authentication message containing a requesting domain, wallet address, URI, chain ID, nonce, issue time, optional validity times, request ID, and resources. A relying party must check the parsed fields and expected values as well as the signature. Sessions must be bound to the address. Contract-account verification is resolved on the stated chain through ERC-1271. See [ERC-4361](https://eips.ethereum.org/EIPS/eip-4361).

SIWE explicitly treats authorization to server resources as outside its scope. A valid SIWE signature therefore authenticates a session but does not grant arbitrary capabilities to that session. See [ERC-4361, Out of Scope](https://eips.ethereum.org/EIPS/eip-4361#out-of-scope).

#### TAS inference

SIWE is a good model for nonce, expiry, chain binding, resource binding, and contract-wallet support. Its exact message format is less natural for a local stdio process because SIWE's `domain` represents the origin requesting sign-in, while TAS does not have a normal web origin.

TAS should either:

1. define a real, stable relying-party URI and use SIWE exactly; or
2. define a TAS-specific EIP-712 authentication challenge rather than calling a non-conformant local message “SIWE”.

The second option is cleaner for v0.1.

### 4.2 EIP-712 structured signing

#### Industry fact

EIP-712 defines deterministic hashing and signing for typed structured data. Its domain separator can bind data to fields such as the protocol name, version, chain ID, and verifying contract. EIP-712 itself does not provide replay protection; the application must include and enforce replay-resistant fields. See [EIP-712](https://eips.ethereum.org/EIPS/eip-712).

#### TAS inference

A TAS authentication challenge should be typed data with all relevant context visible and signed:

```text
TASAuthentication
├── identityRegistry
├── agentId
├── authenticationWallet
├── tawgAddress
├── chainId
├── tasInstanceId
├── hostPublicKeyHash
├── sessionId
├── nonce
├── issuedAt
└── expiresAt
```

`nonce` must be single-use, and `expiresAt` must be short. The authenticated session should be bound to the current TAS process and stdio connection. Including the Host public-key hash would allow the wallet to approve a specific Host installation rather than an unqualified local process.

The challenge proves wallet control. TAS must separately verify that the resolved wallet is currently authorized for `(identityRegistry, agentId)` under the TAWG-selected rule.

### 4.3 ERC-1271 contract-wallet support

#### Industry fact

ERC-1271 defines `isValidSignature(hash, signature)` so a contract account can validate a signature according to its own logic. That logic may depend on time, contract state, signer authorization levels, multisig rules, or a different signature scheme. Applications should use this path when the signer is a contract. See [ERC-1271](https://eips.ethereum.org/EIPS/eip-1271).

#### TAS inference

The TAS data model should say “authentication wallet”, not “EOA”, even if local EOA support ships first. Verification should dispatch as follows:

```text
address has no code   -> recover and compare ECDSA signer
address has code      -> call ERC-1271 on the configured chain context
```

This keeps Safe accounts, delegated accounts, and other smart accounts compatible without changing the Agent identity model.

## 5. Scoped and delegated operational signers

### 5.1 ERC-7715 wallet permissions

#### Industry fact

ERC-7715 defines a wallet RPC for requesting execution permissions for a session account. A request binds a chain, source account, session account, permission type, and optional rules. The specification includes an expiry rule, permits a wallet to attenuate a requested permission when allowed, advises dapps to request only necessary permission with a reasonable expiration, and requires wallets to enforce and clearly display permissions. Its reference implementation notes encrypted storage to support revocation. See [ERC-7715](https://eips.ethereum.org/EIPS/eip-7715).

#### TAS inference

An operational TAS signer should be modeled as a session account with least authority, not as a copy of the authentication wallet. The minimum useful policy dimensions are:

```text
TAWG and chain
allowed target contracts
allowed function selectors
maximum native value
token and spending limits where relevant
start and expiry times
call or rate limits
revocation identifier
```

### 5.2 ERC-7710 and MetaMask Delegation Framework

#### Industry fact

ERC-7710 specifies smart-contract delegation and cites EIP-712 validation, EOA and ERC-1271 signatures, caveat enforcement, batching, and revocation in its reference implementation. See [ERC-7710](https://eips.ethereum.org/EIPS/eip-7710).

MetaMask's official Delegation Framework describes off-chain delegations whose caveats restrict permitted on-chain actions. It warns that a delegation allows any on-chain action by default and therefore strongly recommends caveats. See the [MetaMask Delegation Framework](https://github.com/MetaMask/delegation-framework#delegations) and its [caveat warning](https://github.com/MetaMask/delegation-framework#caveat-enforcers).

#### TAS inference

Delegation gives TAS a way to remain unattended without storing the Agent's controlling private key. The controlling wallet authorizes a fresh operational key; the Agent Host stores it or references an external Signer, and TAS can request only operations allowed by on-chain-enforced caveats.

An unrestricted delegation is equivalent to handing TAS broad wallet control. TAS must reject or prominently warn about delegations without enforceable restrictions.

### 5.3 Coinbase AgentKit and CDP

#### Industry fact

Coinbase AgentKit separates the Agent framework from a wallet-provider abstraction and supports CDP, Privy, and custom providers. Wallet providers handle address management and signing rather than requiring every action to read a raw private key. See [AgentKit architecture](https://docs.cdp.coinbase.com/agent-kit/core-concepts/architecture-explained) and [wallet management](https://docs.cdp.coinbase.com/agent-kit/core-concepts/wallet-management).

CDP's Policy Engine evaluates ordered rules over operation attributes such as destination, value, and network, and rejects a request when no rule matches. See the [CDP Policy Engine](https://docs.cdp.coinbase.com/wallets/security-and-policies/policy-engine/overview). CDP Spend Permissions allow a smart account to authorize a spender subject to token, amount, and time-period limits, including agentic-payment use cases. See [CDP Spend Permissions](https://docs.cdp.coinbase.com/wallets/using-wallets/spend-permissions).

#### TAS inference

TAS should depend on a `Signer` capability, not on a raw private key. Possible implementations can include an external wallet, a delegated local key, a CDP/Privy/Turnkey-style provider, or a smart-account permission. Core Workflow Operations should not care which backend performs the signature.

The safest default authorization behavior is fail-closed: if no policy explicitly permits an operation, TAS refuses it.

### 5.4 Privy

#### Industry fact

Privy separates wallet ownership from authorization keys. Its enclave verifies a signature over the request body and critical parameters before executing wallet actions. It supports owner quorums and policies covering networks, contracts, recipients, transfer limits, calldata, typed-data signatures, and key export. See [Privy wallet policies and controls](https://docs.privy.io/security/wallet-infrastructure/policy-and-controls) and [policy concepts](https://docs.privy.io/controls/policies/overview).

Privy's security checklist recommends separating a rarely used wallet-and-policy management key from a frequently used transaction key. The transaction key is attached as an additional signer constrained by a policy, so compromise of the transaction key cannot modify the policy that limits it. See the [Privy security checklist](https://docs.privy.io/security/implementation-guide/security-checklist).

#### TAS inference

TAS should copy this separation at the conceptual level:

```text
authentication / management wallet
    └── authorizes identity binding, operational signer, and policy

operational signer
    └── performs routine TAWG operations within that policy
```

The operational signer must not be able to broaden its own policy, replace the authentication binding, or authorize a successor signer.

### 5.5 Turnkey

#### Industry fact

Turnkey stores encrypted private-key ciphertext and decrypts it only inside a secure enclave. Signing is performed inside the enclave after customer-defined policy checks, so the raw key is not exposed to the application or operator. See [Turnkey non-custodial key management](https://docs.turnkey.com/security/non-custodial-key-mgmt).

#### TAS inference

Encrypting a private key in a local file and decrypting it inside the ordinary TAS Node.js process does not provide the same property. Once decrypted, a process compromise can capture it. The closest TAS abstraction is a signer that accepts a structured intent and returns a signature without exporting the key.

## 6. Operating-system secret stores

### Industry fact

macOS Keychain stores small secrets and cryptographic keys in an encrypted database and supports access controls on keychain items. See [Apple Keychain Services](https://developer.apple.com/documentation/security/keychain-services) and [restricting keychain item accessibility](https://developer.apple.com/documentation/security/restricting-keychain-item-accessibility).

Windows Credential Locker provides a platform API for securely storing and retrieving user credentials. See [Microsoft Credential Locker](https://learn.microsoft.com/en-us/windows/apps/develop/security/credential-locker).

On Linux desktops, the Secret Service specification defines collections, items, lock/unlock behavior, prompts, and session-based secret transfer over D-Bus. Locked items cannot be read or modified. See the [Secret Service API](https://specifications.freedesktop.org/secret-service/latest/) and [collection/item behavior](https://specifications.freedesktop.org/secret-service/latest/ch03.html).

### TAS inference

An OS KeyStore backend is appropriate for Agent Host storage of GitHub tokens, chat credentials, Proof Provider API keys, DA credentials, and low-value delegated operational keys. It is a substantial improvement over TOML, environment variables, or an unencrypted file.

It is not a universal same-user process sandbox. Exact application isolation differs across platforms, desktop environments, package formats, and executable identity. Therefore, the Agent Host should treat an OS KeyStore as **encrypted local secret storage**, not as proof that no other process under the same operating-system account can use the stored secret.

High-value wallet keys should remain external or non-exportable. TAS v0.1 nevertheless accepts an inline EOA private key for one operation as a pragmatic development path. This is suitable only for limited-value operational wallets; a future hardened mode should keep controlling keys behind a non-exportable or policy-enforcing signer.

## 7. Adopted TAS v0.1 credential model

### 7.1 Components

```text
Agent Principal
    (identityRegistry, agentId)

Authentication Wallet
    current ERC-8004 agentWallet selected by the TAWG rule

Agent Host Credential File
    stores the EOA private key and provider tokens outside TAS
    configured initially through the Bootstrap Skill and refreshed under the loaded TAWG Skill

Sensitive MCP Operation
    carries one inline secret for one requested operation

TAS
    validates operation scope
    constructs an EOA Account only for a chain write
    persists neither secret nor Account state
```

### 7.2 Operation flow

```text
1. Host starts one TAS process for `(chainId, tawgAddress, agentId)` over stdio.
2. TAS resolves the current Authentication Wallet.
3. The Agent requests an operation and the Host supplies the required inline secret.
4. TAS restricts the secret to the configured Client and current operation.
5. For an EOA write, TAS constructs an Account and matches its address to the Authentication Wallet.
6. TAS performs the operation, redacts the secret from results and logs, and retains no secret or Account state.
7. If a provider token is expired, TAS returns `CREDENTIAL_REQUIRED`; the Skill guides refresh and retry.
```

The Host Credential File is separate from public `tas.toml`, the TAS instance directory, and the TAWG Repository. The current implementation may use a normal local file with restrictive permissions. Future Hosts may replace it with OS or remote secret storage.

## 8. Threat-model results

### What v0.1 improves

1. `agentId` remains stable across wallet rotation.
2. One process and one instance directory are isolated by `(chainId, tawgAddress, agentId)`.
3. TAS does not persist or cache secrets or constructed Accounts.
4. A chain key must derive to the current Authentication Wallet.
5. TAS exposes stdio only and constrains each inline credential to the configured destination and requested operation.

### What v0.1 does not solve

1. The inline secret may be visible to the Agent Host, model context, MCP tracing, or process-memory inspection.
2. A local credential file does not isolate secrets from every process running as the same operating-system user.
3. A compromised Agent Host can request an operation using credentials it controls.
4. Node.js cannot guarantee memory erasure after a secret is used.
5. EOA private-key input does not support smart accounts, hardware wallets, multisig approval, or delegated policies.

The TAWG's on-chain rules, contract authorization, immutable records, and settlement verification still provide the protocol-level trustless properties. They do not make local secret handling trustless.

## 9. Deferred hardened model

Credential references, a private Credential Broker, Host pairing, external Signers, hardware wallets, smart-account permissions, and delegated session keys remain useful future options. They should be added only when a concrete security or Host requirement justifies their additional protocol and adapter complexity.

A future MCP design can preserve the v0.1 operation boundary while adding a reference-based authorization mechanism. The exact authorization schema is intentionally deferred to the MCP interface design.

## 10. Decisions still required before implementation

1. What exact credential fields and redaction rules does each sensitive MCP tool use?
2. Which side effects rely on source-native idempotency and which require TAS-maintained operation records?
3. What exact local Host Credential File path, format, and filesystem-permission behavior will the setup Skill use?

## 11. Primary sources

- [ERC-8004: Trustless Agents](https://eips.ethereum.org/EIPS/eip-8004)
- [ERC-4361: Sign-In with Ethereum](https://eips.ethereum.org/EIPS/eip-4361)
- [EIP-712: Typed structured data hashing and signing](https://eips.ethereum.org/EIPS/eip-712)
- [ERC-1271: Standard Signature Validation Method for Contracts](https://eips.ethereum.org/EIPS/eip-1271)
- [ERC-7715: Request Permissions from Wallets](https://eips.ethereum.org/EIPS/eip-7715)
- [ERC-7710: Smart Contract Delegation](https://eips.ethereum.org/EIPS/eip-7710)
- [MetaMask Delegation Framework](https://github.com/MetaMask/delegation-framework)
- [Coinbase AgentKit architecture](https://docs.cdp.coinbase.com/agent-kit/core-concepts/architecture-explained)
- [Coinbase AgentKit wallet management](https://docs.cdp.coinbase.com/agent-kit/core-concepts/wallet-management)
- [Coinbase CDP Policy Engine](https://docs.cdp.coinbase.com/wallets/security-and-policies/policy-engine/overview)
- [Coinbase CDP Spend Permissions](https://docs.cdp.coinbase.com/wallets/using-wallets/spend-permissions)
- [Privy wallet policies and controls](https://docs.privy.io/security/wallet-infrastructure/policy-and-controls)
- [Privy policy overview](https://docs.privy.io/controls/policies/overview)
- [Privy security checklist](https://docs.privy.io/security/implementation-guide/security-checklist)
- [Turnkey non-custodial key management](https://docs.turnkey.com/security/non-custodial-key-mgmt)
- [Apple Keychain Services](https://developer.apple.com/documentation/security/keychain-services)
- [Microsoft Credential Locker](https://learn.microsoft.com/en-us/windows/apps/develop/security/credential-locker)
- [Freedesktop Secret Service API](https://specifications.freedesktop.org/secret-service/latest/)
