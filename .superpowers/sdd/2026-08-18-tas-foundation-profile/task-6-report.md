# Task 6 report — exact-block TAWG Profile reader

## TDD evidence

- Initial RED: after creating the ABI and integration contract tests, `npm test -- test/unit/clients/profileAbi.test.ts test/integration/viemProfileReader.test.ts` failed because `src/clients/chain/profileAbi.ts` and `src/clients/chain/viemProfileReader.ts` did not exist.
- Boundary RED: the first implementation continued calling Profile getters after a failed ERC-165 probe (11 calls instead of one), and classified an explicit block selector's generic `-32603` transport error as `HISTORICAL_STATE_UNAVAILABLE`. Focused tests failed on both behaviors.
- Resolution RED: a node returning the wrong block number for `block_number` was detected only after 11 contract reads. The regression required `RESOLUTION_CONFLICT` before any `eth_call` and failed until resolution validated the returned number immediately.
- Review RED: the first implementation imposed an undocumented 10,000-entry cap and converted Profile counts to JavaScript `number`. The cap regression was removed; both enumerations now retain `bigint` indices for the complete contract-defined count.
- Security RED: 12 focused assertions failed before remediation. Contract calls were number-bound, an A/B load-balanced fixture returned H2 state labeled with H1, a provider rejecting EIP-1898 silently succeeded through number-based calls, duplicate IDs/keys were detected only after unnecessary reads, and an in-flight operation ignored cancellation until the test timeout.
- Follow-up security REDs proved six cancellation/canonicality failures and four concurrency/deadline failures: transport requests did not observe abort, no-signal reads lacked a deadline, noncanonical hash reads were misclassified, early `Promise.all` failure left a sibling RPC hanging, deadline looked like caller cancellation, and viem request deduplication coupled two independently cancellable readers.
- GREEN/REFACTOR: all focused tests pass, and the exact focused suite passed three consecutive independent runs (pass^3).

## Implementation

- Added viem-independent `ChainSelector`, raw Profile snapshot types, and `ProfileReader` port. EVM `uint256` fields cross the boundary as canonical decimal strings.
- Added the fixed `ITAWGProfile`, ERC-165, ERC-721 `ownerOf`, and ERC-8004 `getAgentWallet` ABIs, including the documented Profile events and custom errors. Tests derive selectors from the actual ABI and independently documented signatures, then XOR them to verify the exported interface ID.
- Added a custom-transport viem fixture and exact-block reader. Every operation resolves `{number, hash}`, performs all Profile and Registry calls with EIP-1898 `{blockHash, requireCanonical: true}`, and re-fetches the number to reject a changed number/hash. Providers that cannot perform hash-bound calls fail safely without a number-based fallback.
- `readProfile` returns Profile Version, Governance, immutable Registry, Charter, permanent Agent IDs, current Data entries, and Workflow. Duplicate enumeration, missing enumerated Data, and unsupported ERC-165 fail as `PROFILE_INCONSISTENT`.
- `readAgent` reads Version, Registry, and member state at the pinned block. Only members cause same-block `ownerOf` and `getAgentWallet` calls; nonmembers return successful negative raw data without an Authentication Wallet.
- Both public reads accept an optional `AbortSignal` and enforce a 30-second default local deadline. Signals reach viem's raw request/call transport boundary, per-operation requests disable cross-signal deduplication, and finalization aborts pending sibling calls. Caller cancellation remains `AbortError`; deadline exhaustion is the fixed retryable `EXTERNAL_UNAVAILABLE`. Duplicate Agent IDs and Data keys are rejected incrementally without changing complete `bigint` enumeration semantics.
- Added the five fixed safe error codes and their MCP public-boundary mappings. Upstream endpoints, transport text, payloads, and credentials are never copied into TAS errors or public results.

## Verification

- Focused tests: 61 passed across two files.
- Focused stability: pass@1 = 1.0 and three consecutive runs passed (pass^3).
- Full suite: 223 passed across 12 files.
- Coverage: 90.66% statements, 87.58% branches, 100% functions, and 96.46% lines. `src/clients/chain` has 89.26% statements and 83.51% branches.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.

## Commit

The initial implementation was committed as `e5ebce2` (`feat: read TAWG Profile at an exact block`), the first review remediation as `bac06f1` (`fix: classify Profile read failures precisely`), the historical-`eth_call` re-review as `ea7342e` (`fix: detect pruned Profile state safely`), and the security remediation as `cf5db9d` (`fix: bind Profile reads to canonical blocks`).

## TypeScript review remediation

- Removed the invented 10,000-entry enumeration policy and all `Number` conversion. `agentCount` and `dataCount` are consumed with `bigint` loop indices without changing the Profile contract's complete-read semantics.
- Replaced raw JSON-RPC code/name walking with explicit viem error classes. Only a `BlockNotFoundError` during an explicit block-number/hash read proves `HISTORICAL_STATE_UNAVAILABLE`; ambiguous `-32000`/`-32001` service failures and missing tagged blocks are `EXTERNAL_UNAVAILABLE`. Unsupported safe/finalized tags require viem's `InvalidParamsRpcError` and never fall back.
- Added a separate enumerated-getter boundary. A decoded `IndexOutOfBounds` or viem `ExecutionRevertedError` from `agentIdAt`/`dataKeyAt` after the positive count is `PROFILE_INCONSISTENT`; an internal/transport outage on the same getter remains `EXTERNAL_UNAVAILABLE`.
- A selected block that disappears during the final exact-number re-fetch is a `RESOLUTION_CONFLICT`, matching the existing changed-hash rule.
- Review RED evidence: ambiguous `-32000` and `-32001` tests initially received `HISTORICAL_STATE_UNAVAILABLE`; both structural index tests initially received `EXTERNAL_UNAVAILABLE`; and the disappearing-final-block test initially received `EXTERNAL_UNAVAILABLE`. Each focused failure was observed before its production fix.

## Historical `eth_call` re-review remediation

- Replaced the synthetic action-level `BlockNotFoundError` fixture with raw custom-transport JSON-RPC failures. The tests exercise viem's real call and contract-error wrapping for `InvalidInputRpcError` (`-32000`), `ResourceNotFoundRpcError` (`-32001`), and `ResourceUnavailableRpcError` (`-32002`).
- RED: production-shaped `missing trie node`, `historical state unavailable`, and `state at block ... pruned` failures all initially returned `EXTERNAL_UNAVAILABLE`, proving that the historical contract-state branch was unreachable for real RPC responses.
- GREEN: only explicit block-number/hash contract reads may recognize historical state pruning. The reader requires one of those three explicit viem RPC wrapper classes, no revert data or viem revert semantics, and a deliberately small marker allowlist. It inspects the wrapper details for classification but never copies them into a TAS error or MCP result.
- Negative regressions cover generic `-32000`, `-32001`, and `-32002` service failures, marker-like messages accompanied by revert data, `execution reverted: missing trie node`, the same marker under `latest`, and marker text during block resolution. All remain `EXTERNAL_UNAVAILABLE`.
- A follow-up RED showed that applying the marker classifier in block resolution produced a false `HISTORICAL_STATE_UNAVAILABLE`; it is now reachable only from contract-read boundaries. Separate REDs showed that pruned state during `agentIdAt`/`dataKeyAt` still returned `EXTERNAL_UNAVAILABLE`; the enumerated-read boundary now recognizes the same narrow archive-state evidence after first excluding structural reverts.
- The focused suite again passed three consecutive independent runs after this remediation.

## Canonical-block and cancellation security remediation

- Every Profile, ERC-165, ERC-721, and ERC-8004 contract call is now bound to the initially resolved block hash with EIP-1898 and `requireCanonical: true`. The final block-number header re-fetch remains as defense in depth.
- The A/B transport regression proves that H1 is returned even where a number-based call at the same height would serve H2. A provider rejecting the EIP-1898 selector returns the fixed `EXTERNAL_UNAVAILABLE` boundary error after one hash-bound attempt and is never retried by number.
- `ProfileReadOptions.signal` is combined with a 30-second default deadline and propagated through block resolution, chain ID lookup, all contract reads, enumeration, and the final canonicality check. Header and chain reads use abort-aware raw requests; contract reads use viem `call` with ABI encode/decode and contract-error wrapping. Every request sets `dedupe: false`, so cancellation remains isolated per Profile operation.
- Cleanup aborts the internal controller before removing the caller listener and deadline. A failing member of an initial parallel getter batch therefore cancels any hanging siblings. Transport-observation tests cover caller abort, deadline abort, block reads, chain ID, contract calls, early sibling failure, and concurrent identical readers.
- Narrow production-shaped `not canonical` and `non-canonical` RPC failures during a hash-bound call map to `RESOLUTION_CONFLICT`. Generic `-32000` failures and EIP-1898 unsupported errors remain `EXTERNAL_UNAVAILABLE`.
- Agent ID and Data key duplicates are detected as soon as the second occurrence is returned. The reader stops before unrelated enumeration or duplicate payload retrieval, while count and index values remain full-width `bigint` with no local cap.
- RED evidence was captured before each production change; after remediation, 61 focused tests passed three consecutive independent runs and the 223-test full suite passed.

## Residual risks

- A provider with a nonstandard historical-state error taxonomy or wording outside the narrow allowlist fails closed as `EXTERNAL_UNAVAILABLE`. This trades false negatives for avoiding dangerous false historical-state classifications.
- The v0.1 Profile read surface has no pagination or protocol count limit. Complete enumeration cost therefore scales with on-chain Agent and Data counts; this implementation neither truncates nor invents a public limit.
- A nonstandard custom EIP-1193 provider may ignore the request `AbortSignal`; TAS cannot forcibly terminate such provider code. Viem's HTTP transport and the tested custom transport honor the propagated signal, and TAS still bounds and settles its own operation.
