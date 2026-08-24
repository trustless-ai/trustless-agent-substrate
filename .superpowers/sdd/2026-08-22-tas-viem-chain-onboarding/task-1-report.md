# Task 1 report — Runtime Manifest types and deterministic artifact contract

## Outcome

Implemented in `32999c0` and hardened through review remediation commits `0c8e1be`, `f32d546`, `05d5c51`, `62c41b3`, `8affcc0`, and `21ff1ea`. Commit `0d11f27` adds the exact top-level callable `toJSON` regression requested during security review.

- Added strict viem Public/Wallet Dependency Manifest types and parsing.
- Bound Manifest identity, namespaces, source exports, source members, entrypoints, client-action targets, runtime dependencies, and credentials into one fail-closed contract.
- Required deterministic ordering and uniqueness for entrypoints and tools.
- Added RFC 8785 canonical serialization after an iterative, getter-free JSON-tree validation and inert clone.
- Added exact `canonicalize@4.0.0`, Manifest generation/check scripts, and a tools TypeScript project included by `npm run typecheck`.
- Updated the existing exact package contract tests.
- Added a pre-Zod own-property guard for every structured Manifest object and array. It rejects inherited required fields, unknown prototype-named fields, accessors, Proxies, sparse arrays, and unsafe projection prototypes before Zod can read or assign through them.
- Bound each generated tool name to the canonical snake-case projection of its exact source member.
- Recursively validates and detaches both embedded JSON Schemas through the production `clonePlainJson` boundary. The clone is getter-free, Proxy/accessor/cycle/non-JSON rejecting, preserves prototype-named extension keys as inert data, and uses null-prototype containers.
- Bounds shared-DAG expansion at 10,000 expanded nodes and canonical output at 1 MiB of UTF-8. The serializer checks the remaining byte budget before every append.

## TDD evidence

- RED: focused Vitest exited 1 because both new modules were absent.
- First GREEN: 49 focused tests passed; both production and tools TypeScript checks passed after the initial implementation.
- Refactor GREEN: 59 focused/package tests passed after deterministic sorting, exact SRI validation, Proxy rejection, and prototype-named schema preservation were added.
- Review RED: 9 focused regressions reproduced unknown `__proto__` acceptance, member/name mismatch, and Array-prototype execution in the canonicalizer.
- Review GREEN: the container-free serializer and structural guard closed those findings.
- Follow-up RED/GREEN: inherited required fields, structural array Proxies, and Zod Object/Array projection setters were each reproduced before their minimal fail-closed fixes. Final focused/package gate is 81 tests passed.
- Security RED: 7 tests reproduced live nested Schema values, callable `toJSON`, shared-DAG exponential expansion, and unbounded canonical output.
- Security GREEN: 83 focused Manifest/canonical tests passed after the shared production clone and hard budgets were introduced.

## Verification

- `npm test -- test/unit/manifest/types.test.ts test/unit/manifest/canonicalJson.test.ts`: 83 passed.
- `npm run typecheck`: passed both `tsconfig.json` and `tsconfig.tools.json`.
- Independent security re-review on the clean Task 1 commits: 83/83 focused Manifest tests and 488/488 clean-commit regression tests passed.
- `npm audit --audit-level=high`: 0 vulnerabilities.
- `git diff --check`: passed.

## Independent security re-review

**APPROVED with no findings.** The reviewer independently confirmed the focused Manifest contract, clean-commit regression, TypeScript typecheck, and high-severity dependency audit gates.

## Residual boundary

Task 1 defines and validates the artifact contract only. It deliberately does not implement the TypeScript declaration analyzer, generator, artifact loader, or runtime registry; those are later A2 tasks.
