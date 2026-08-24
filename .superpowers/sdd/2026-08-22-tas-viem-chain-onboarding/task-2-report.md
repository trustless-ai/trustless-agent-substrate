# Task 2 report — Analyze viem Public and Wallet Action Interfaces

## Status

Implemented as `e02cbfe` (`feat: analyze viem action interfaces`), lifecycle-remediated as `561840f`, and fail-closed through independent review in `da19077`, `107a130`, and `8afb60c`.

## TDD evidence

1. The initial focused test failed because `tools/manifest/analyzeViem.ts` did not exist.
2. The first minimal analyzer run exposed the zero-argument `void` boundary bug; the focused fixture stayed red until zero-argument actions were treated as empty requests.
3. Recursive ABI and signed-transaction documentation regressions were added before their fixes. They failed because ABI data was treated as non-finite and `fillTransaction` was mistaken for transaction submission.
4. Installed-viem onboarding regressions were added before their fixes. They failed while `readContract`, `getTransactionReceipt`, and `writeContract` were excluded.
5. An optional KZG provider fixture was added before the generic optional callable-provider projection. It failed until the runtime provider was separated from the finite caller boundary without hiding direct callbacks such as `onReplaced`.
6. Review regressions first demonstrated that raw-transaction detection stopped after two levels, arbitrary ABI-adjacent `unknown` values were accepted, opaque unions and same-named providers were trusted too broadly, and unknown Wallet writes were classified synchronously. Each fixture failed before the fail-closed remediation.

## Implementation

- Resolves viem through the package's public `exports["."].types` entry and verifies that entry remains inside the installed package.
- Requires package-lock v3, derives the resolved package key, and binds analyzer output to the exact installed viem version and SHA-512 integrity.
- Uses `typescript/unstable/sync` with a generator-owned in-memory probe. Its `PublicActions`, `WalletActions`, and `PrivateKeyAccount` aliases have no explicit generic arguments, so installed defaults are applied.
- Every virtual filesystem callback returns `undefined` for unowned paths, allowing normal dependency resolution from the real filesystem.
- Disposes the snapshot and closes the API with nested `try/finally`, so API cleanup still runs when snapshot disposal throws.
- Runs optional type-dependent work through a synchronous projector while the checker is live. The context carries source profile/name, tool name, signature, completion, checker, and input/output types, so Task 3 never infers identity from callback order. The result is validated/cloned as plain JSON, and no compiler-session handle is returned. A projector attempting to return a `Type`, `Checker`, Promise, callback, cycle, or prototype-bearing object fails closed.
- Enumerates instantiated action properties and classifies every one exactly once. Generated names reuse the Manifest contract's shared `viemMemberToToolSegment` normalizer and duplicate names fail generation.
- Uses structural boundary walking with primitive short-circuits, Promise/array/tuple/union/intersection handling, depth and node budgets, and `type.id` recursion guards.
- Records callbacks, subscriptions, opaque runtime objects, non-finite inputs/outputs, non-injectable Wallet Accounts, and unbound authenticated writes with explicit reason codes.
- Requires every included Wallet action to accept a removable Account request property to which `PrivateKeyAccount` is assignable, then walks the remaining request.
- Preserves dynamic JSON only at exact root `abi`/`args` paths after proving their ABI type provenance, and only for output types resolved to trusted `ContractFunctionReturnType`/`ReadContractReturnType` declarations. An ABI-bearing action cannot hide unrelated `unknown`, provider, or recursive fields.
- Applies runtime omissions only at exact root paths. `Chain`, `Client`, `Transport`, KZG, ABI, and expanded Account types must resolve to declarations under the installed viem/abitype roots (or the exact focused fixture declaration). Same-named foreign types remain rejected.
- Allows root Public `account` only when every non-null union branch is either an EVM Address or a trusted viem Account projection; an Address branch no longer hides an untrusted callback/object branch.
- Classifies public raw-signed transaction submission structurally across the bounded 64-depth/10,000-node graph as well as from declaration/JSON-RPC semantics. Traversal-limit uncertainty fails closed. Transaction preparation is not mistaken for submission.
- Treats unknown Wallet semantics conservatively as `external_handle`; only clearly signing/preparing/filling operations are synchronous, and explicit submission language wins over signing language.
- Requires package integrity to be canonical base64 decoding to exactly 64 SHA-512 bytes, not merely a matching prefix and alphabet.
- Unwraps Promise only once at the top-level action output. Promise input and nested Promise values remain runtime/callback boundaries and are rejected.
- Accepts built-in `Uint8Array` only when every declaration is a compiler-recognized default-library file; a foreign same-named interface is not treated as bytes.
- Resolves abitype from viem, verifies its installed version and canonical SHA-512 against the exact lockfile-v3 entry, and exposes that trusted transitive package metadata in the analysis result.
- Detects raw transaction requests from exact semantic field/parameter names, trusted non-erased serialized-transaction aliases, and byte/Hex payloads combined with submission verbs. TypeScript erases a transparent `type Alias = Hex`, so such aliases are not claimed as independently distinguishable; action/parameter semantics plus checked-in Manifest review remain the deterministic fallback.

## Coverage result

The installed viem `2.55.19` report accounts for all currently instantiated members without hard-coded count assertions:

- Public Actions: 62 classified exactly once.
- Wallet Actions: 29 classified exactly once.
- Included actions: 34.
- Reviewed exclusions: 57.

The snapshot includes the exact package version/integrity and sorted classification report. Explicit regressions require:

- `workflow.chain.public.read_contract` included;
- `workflow.chain.public.get_transaction_receipt` included;
- `workflow.chain.wallet.write_contract` included as `external_handle`;
- `waitForTransactionReceipt` excluded as `callback_input`; and
- public raw transaction submission excluded as `authenticated_write_not_bound`.

## Verification

```text
npm test -- test/unit/manifest/analyzeViem.test.ts
  1 file passed, 11 tests passed

npm run typecheck
  production and tools TypeScript checks passed

npm test -- --exclude test/unit/manifest/schemaEncoder.test.ts --exclude test/unit/clients/jsonCodec.test.ts
  21 files passed, 499 tests passed (Task 3 suites intentionally excluded)

git diff --cached --check
  passed before implementation commit
```

## Lifecycle remediation and Task 3 handoff

The first implementation returned TS7 `Type` values after closing their remote API session. Those lazy handles could no longer traverse the type graph and would have broken Task 3. The remediation replaces them with a synchronous projector callback invoked inside the analyzer's controlled live session. Its result is cloned as plain JSON before return, and cleanup remains in `finally`.

Task 3 must supply the schema projector to `analyzeViemActions`; it must not open, retain, or close its own compiler session through this interface. The default Task 2 report path uses `projection: undefined`.

The fail-closed review remediation also makes Task 3 responsible for schema generation only after the analyzer has established exact action/type provenance. It must not reintroduce name-only runtime-field removal or broad ABI exceptions.
