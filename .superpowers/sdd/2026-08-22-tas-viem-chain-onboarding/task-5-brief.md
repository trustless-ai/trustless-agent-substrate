# Task 5 brief — validate and register bundled viem Manifests

## Ownership

- `src/mcp/manifest/load.ts`
- `src/mcp/manifest/registry.ts`
- `test/unit/manifest/load.test.ts`
- `test/unit/manifest/registry.test.ts`

## Contract

- Load only the three release-bundled Manifest artifacts from the installed TAS package. Reject missing, renamed, symlinked, non-regular, oversized, non-canonical, or digest-mismatched artifacts before use.
- Validate the generated TypeScript artifact digests, package-lock identity, exact viem version/integrity, declaration closure, entrypoint digest, and every complete reviewed package-tree snapshot before exposing a tool entry.
- Recompute complete package trees with the same bounded scanner used by generation. The installation must remain non-concurrently-writable from validation through process exit.
- Return detached, deeply frozen Public and Wallet Manifests. Build one process-lifetime Registry containing the two complete reviewed groups; do not add a per-action allowlist.
- Keep the loader and Registry free of executable viem imports. Task 6 may dynamically import runtime actions only after this Registry succeeds.

## Verification

Use RED/GREEN tests for artifact bytes, canonical JSON, provenance, package-tree tampering, prototype/accessor/Proxy inputs, stable Registry identity, lookup, sorting, and deep immutability. Run focused tests, typecheck, full regression, audit, package dry-run, and diff checks before commit and review.
