# Task 1 brief — Runtime Manifest types and deterministic artifact contract

## Source

- Plan: `docs/superpowers/plans/2026-08-22-tas-viem-chain-onboarding.md`, Task 1
- Contract: `docs/tas/MANIFEST.md`

## Owned files

- `src/mcp/manifest/types.ts`
- `tools/manifest/canonicalJson.ts`
- `test/unit/manifest/types.test.ts`
- `test/unit/manifest/canonicalJson.test.ts`
- `test/unit/package.test.ts`
- `package.json`
- `package-lock.json`
- `tsconfig.tools.json`

## Required behavior

1. Define the strict `tas-manifest/v1` viem Public/Wallet runtime types and Zod parser.
2. Reject unknown fields, duplicate or unsorted tool names, malformed namespaces and source metadata, and profile-inconsistent export/binding/runtime-dependency/credential combinations.
3. Serialize only a prevalidated plain JSON tree through RFC 8785 canonicalization; reject unsupported primitives, non-finite numbers, cycles, proxies, accessors, sparse/extended arrays, symbols, and non-plain prototypes without evaluating getters.
4. Pin `canonicalize@4.0.0`, add explicit Manifest generation/check scripts, and include tool sources in the standard typecheck gate.

## Method

- Red-green-refactor.
- No runtime generation, dependency reflection, GitHub write, or executable artifact.
- Run focused tests, full tests, standard typecheck, dependency audit, and diff check before handoff.
