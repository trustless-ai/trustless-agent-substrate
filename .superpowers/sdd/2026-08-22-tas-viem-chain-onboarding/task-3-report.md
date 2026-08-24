# Task 3 report — Project TypeScript Schemas and Bound EVM JSON

## Status

Implemented, locally verified, and independently approved by TypeScript and security reviewers with no CRITICAL/HIGH findings.

## TDD evidence

1. The first schema tests failed because no TS7 schema projector existed.
2. Installed-viem projection remained red until root union branches were traversed independently and analyzer-proven ABI, Account, provider, and byte boundary directives were consumed without guessing by name.
3. Exact bigint literal, nested union, 79-character bound, byte-envelope, Wallet credential-collision, and 257-member union regressions failed before their respective fail-closed behavior was added.
4. `CreateAccessListParameters` exposed a real source-level overlapping union. A focused optional-discriminator fixture stayed red until the projector emitted `anyOf` only for overlap with provably equivalent decoded values; the existing bigint/string ambiguity fixture remains rejected.
5. Codec tests for ambiguous `anyOf`, byte/object collisions, forbidden siblings, branch limits, and shared non-rollback budgets failed before bounded `anyOf` validation and structural comparison were implemented.

## Implementation

- Projects detached JSON Schema Draft 2020-12 values synchronously inside the analyzer's live TS7 callback.
- Encodes primitives, exact literals/enums, canonical bigints, analyzer-proven addresses and bytes, arrays, readonly and variadic tuples, finite closed objects, string records, intersections, nullable types, and Promise outputs.
- Preserves every analyzer-included root-union field. Analyzer-declared runtime properties are omitted; ABI-dependent values use a bounded recursive JSON-value schema; Wallet actions receive one optional inline credential envelope.
- Generates `oneOf` for mutually exclusive branches. It uses `anyOf` only for source branches that overlap at the JSON boundary and whose shared values are statically proven to decode identically. Otherwise generation fails.
- Encodes `Uint8Array` as an explicit `x-tas-type: bytes` envelope and reconstructs a direct built-in `Uint8Array` only under that exact closed schema marker.
- Clones and validates untrusted schemas without getters, Proxies, cycles, arbitrary regular expressions, ignored siblings, or unsupported keywords.
- Applies shared 64-depth, 10,000-node, 1-MiB, and 256-union-member limits. Failed union attempts never roll back consumed work.
- For `anyOf`, at least one branch must match. Multiple matches are accepted only when a bounded descriptor-based comparison proves primitive, bigint, array, inert object, and `Uint8Array` results structurally identical; different results are a fatal ambiguity.

## Verification

```text
npm test -- --run test/unit/manifest/schemaEncoder.test.ts test/unit/clients/jsonCodec.test.ts
  2 files passed, 34 tests passed

npm test -- --run test/unit/manifest/analyzeViem.test.ts test/unit/manifest/schemaEncoder.test.ts test/unit/clients/jsonCodec.test.ts
  3 files passed, 45 tests passed

npm test
  23 files passed, 533 tests passed

npm run typecheck
  production and tools TypeScript checks passed

git diff --check
  passed

npm audit --omit=dev
  found 0 vulnerabilities
```

Independent TypeScript and security re-reviews approved the final frozen tree after exercising nested decode-kind ambiguity, optional-field overlap, bigint literal width, byte-envelope identity, `anyOf` budget, and structural-equivalence behavior.
