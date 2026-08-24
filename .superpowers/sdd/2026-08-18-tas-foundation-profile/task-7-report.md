# Task 7 report — Profile projection and MCP tools

## TDD evidence

- Initial RED: `npm test -- test/unit/profile/resolver.test.ts test/conformance/profileTools.test.ts` failed because `src/core/profile/resolver.ts` and `src/mcp/profileTools.ts` did not exist. Both suites failed at their intended imports before any production implementation was added.
- Public-result RED: the focused `prototype-named` result test failed with `TAS public result invariant violated.` because the shared result clone rejected `__proto__`, `constructor`, `prototype`, and `toJSON` even when they were inert JSON data properties.
- Cancellation/error-boundary RED: the first MCP implementation read a nonexistent top-level `context.signal`; real SDK conformance calls therefore returned `Cannot read properties of undefined (reading 'aborted')`. The implementation now passes `context.mcpReq.signal`, matching the installed SDK's request context and the cancellation notification path.
- Snapshot-accessor RED: an accessor-backed Agent ID array was accepted and its getter executed. The snapshot array boundary now inspects own data descriptors, rejects accessors and extra/symbol properties, and never invokes the element getter.
- Review binding RED: four setup/member cases proved that a Resolver bound to chain/Profile A could register tools whose public MCP instance claimed chain/Profile B. Registration now compares the immutable normalized Resolver binding before registering either tool and fails synchronously with `PROFILE_INCONSISTENT`.
- Review schema RED: the advertised output schema accepted zero Profile Versions, zero required addresses, arbitrary Repository strings, and arbitrary Data keys. A final schema-discovery RED also showed that canonical decimal inputs and outputs enforced the 78-digit limit at runtime without advertising it through JSON Schema. The conformance test failed on those exact paths before the contracts were tightened.
- Security budget RED: an 8,000-level JSON object leaked a raw `RangeError`; single and aggregate JSON above 1 MiB, 10,000-wide JSON, and an over-budget Agent/Data combination were accepted; and an oversized enumeration read every descriptor before checking its length. Separate 100,000-digit inputs exercised the missing pre-`BigInt` guard.
- GREEN/REFACTOR: 125 focused tests pass across the Resolver, MCP conformance, and shared-result suites. The final focused suite passed three consecutive independent runs (pass^3).

## Implementation

- Added a `ProfileResolver` that depends only on `ProfileReader` plus the immutable process binding. It validates the reader's chain/Profile binding, canonical full-width decimal values, required addresses, Charter reference, Data keys, duplicate enumeration, exact block context, and member/nonmember combinations.
- The Resolver exposes one frozen normalized binding through a getter backed by a private field; neither the binding object nor the binding reference can be reassigned. Profile tool registration validates both `tawg_setup` and `member` public instances against it before registering any operation, so a read from Profile A cannot be labelled as Profile B.
- `profile.get` projects only Version, Governance, immutable Charter, current Agent IDs and Identity Registry, parsed Data objects, and parsed Workflow metadata. It omits pending Governance and does not infer a Workflow role.
- `profile.get_agent` returns a full member projection or exactly `{ agent_id, is_member: false }` for a nonmember. It rejects a response for another Agent ID and impossible raw member/nonmember states.
- Every Agent, Data, and Workflow JSON string must parse to an object. Nested arrays and unknown fields are preserved. Non-finite numbers, scalars, arrays at the top level, null, malformed JSON, accessors, sparse arrays, cycles, and non-JSON values fail as `PROFILE_INCONSISTENT`.
- One resolve call has an aggregate 1 MiB JSON UTF-8 budget. JSON projection uses an explicit work stack, and both in-progress JSON plus the complete typed output enforce the shared MCP boundary's depth 64, 10,000-node, and 10,000-entry limits. Profile enumeration lengths and the combined Agent/Data structural reserve are checked before result construction. These are local transport/projection safety limits, not pagination or new on-chain count semantics.
- Decimal strings longer than uint256's maximum 78 decimal digits are rejected before regex-to-`BigInt` conversion in both the Resolver and MCP Zod refinements. Invalid `profile.get_agent` input therefore fails before the reader is called.
- Prototype-named keys are copied onto null-prototype objects as inert own data properties. The shared MCP result clone received the same narrow behavior while retaining its existing cycle, type, depth, node, entry, sparse-array, and finite-number guards.
- Added exact `profile.get` and `profile.get_agent` MCP schemas. Advertised inputs and outputs expose `maxLength: 78` as well as pattern and uint256 refinement for every relevant Agent ID, chain ID, Profile Version, and block number. Outputs also constrain nonzero 20-byte addresses, 32-byte block hashes, canonical GitHub Repository URLs, full lowercase Charter commits, `charter/`, canonical Data keys, JSON-object metadata, and the exact member/nonmember union. All five selectors and omitted-latest are tested on both tools; instance locators and unknown fields are rejected before the reader runs.
- Resolver success uses the same snapshot's block number, block hash, and Profile Version in Resolution Context. TAS errors use the fixed native result boundary, unexpected errors become the fixed internal error, and SDK caller cancellation reaches the reader without relabeling.
- Cancellation is exercised independently for `profile.get` and `profile.get_agent`. Prototype-named fields are independently verified in Profile Data, Workflow data, and member data, including through the complete MCP transport; typed Workflow/member fields remain authoritative.

## Verification

- Focused tests: 125 passed across three files.
- Focused stability: pass@1 = 1.0 and three consecutive final runs passed (pass^3).
- Full suite: 315 passed across 14 files.
- Coverage: 90.42% statements, 87.51% branches, 100% functions, and 96.86% lines. `src/core/profile/resolver.ts` has 88.55% statements, 86.22% branches, 100% functions, and 98.33% lines.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.

## Commit

The initial implementation is committed locally as `5eea1b2` (`feat: expose Profile discovery tools`), and the TypeScript review remediation as `5bd30a5` (`fix: bind Profile tools to resolver context`). The security remediation is committed separately and its final hash is reported to the controller after commit creation.

## Residual risks

- The v0.1 Profile namespace returns complete Agent and Data collections rather than pagination. The shared public-result boundary intentionally retains its existing bounded JSON projection, so a valid but exceptionally large Profile or metadata object can fail closed instead of being partially returned.
- JSON is parsed in-process with the platform parser after aggregate byte accounting. The tested 8,000-level input is handled safely by the iterative projection, but future runtime changes to the platform parser remain outside TAS control.
