# Task 2 brief — Analyze viem Public and Wallet Action Interfaces

## Ownership

Work only in the `tas-demo-vertical-slice` worktree. This task owns:

- `tools/manifest/analyzeViem.ts`
- `test/fixtures/manifest/viem-mini.d.ts`
- `test/unit/manifest/analyzeViem.test.ts`
- `test/unit/manifest/__snapshots__/analyzeViem.test.ts.snap`
- this brief and the matching report

Other tasks own the Manifest artifact types, canonical JSON tooling, and package files. Preserve their changes.

## Contract

Implement a deterministic build-time analyzer for the exact installed viem `PublicActions` and `WalletActions` interfaces.

- Use `typescript/unstable/sync` and generator-owned virtual probe aliases with no explicit generic arguments.
- Virtual filesystem callbacks return `undefined` for every unowned path, allowing the real filesystem to resolve dependencies.
- Resolve viem through its public package exports and bind the result to the exact package-lock v3 version and integrity.
- Account for every source member exactly once as included or excluded; reject duplicate generated names and unclassified members.
- Classify callbacks, subscriptions, opaque runtime objects, and non-finite boundaries structurally with bounded type walking.
- Wallet actions are included only when their request contains a removable `account` property to which `PrivateKeyAccount` is assignable. Walk the remaining request after that property is removed.
- Treat non-callable namespace tokens as opaque.
- Exclude public raw-signed transaction submission from declaration documentation/JSON-RPC semantics as `authenticated_write_not_bound`; missing or contradictory signed-write semantics fail closed.
- Keep ABI/function-argument JSON placeholders for Task 3 schema projection. Include `readContract`, `writeContract`, and receipt polling. Exclude current `waitForTransactionReceipt` because its request contains a callback.
- Classify transaction-submitting Wallet actions as `external_handle`, receipt-waiting actions as `bounded_wait`, and finite reads as `synchronous`.
- Run optional type-dependent projection synchronously inside the live compiler session. Supply explicit source profile/name, tool name, signature, and completion metadata with the checker/types; clone only plain JSON projection data and never return `Type`/`Checker` handles.
- Return exact package metadata, stable tool names through the shared viem member normalizer, signatures, detached projection data, and operation completion.
- Dispose every TypeScript snapshot and API process in `finally`.

## TDD and verification

Write and observe focused failures before production code. Fixture coverage must include zero-argument and finite reads, an injectable Wallet write, callback input/output, subscription, opaque token/runtime object, raw transaction semantics, recursive ABI data, and a Wallet action without injectable Account.

The installed-viem test independently obtains the current instantiated member sets, compares them to the analyzer's included/excluded union, and snapshots the sorted report. It must not hard-code current member counts.

Run:

```bash
npm test -- test/unit/manifest/analyzeViem.test.ts
npm run typecheck
git diff --check
```

Commit only task-owned files as `feat: analyze viem action interfaces`.
