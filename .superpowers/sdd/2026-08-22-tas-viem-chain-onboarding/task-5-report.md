# Task 5 report — validate and register bundled viem Manifests

## Status

Completed in `233dbad` after independent TypeScript review approval.

## TDD and implementation

- RED began with absent runtime loader and Registry modules.
- The loader now opens only fixed package-relative artifacts, requires ordinary regular files under non-symlinked package boundaries, checks exact compiled SHA-256 constants before parsing, and accepts only canonical bytes that pass the strict Manifest schema.
- Runtime provenance checks bind the artifact to the installed lockfile, exact viem release, declaration closure, entrypoint digest, and all reviewed complete package trees. File additions, edits, removals, symlinks, special files, ownership escapes, and budget violations fail closed.
- The Registry validates both profiles once, exposes each whole reviewed group in canonical order, supports exact globally unique lookup, and returns the same deeply frozen entry objects for the process lifetime.
- The pre-binding graph performs no executable viem import.

## Verification

```text
npm test -- test/unit/manifest/load.test.ts test/unit/manifest/registry.test.ts
  2 files passed, 25 tests passed

npm run typecheck
npm run build
git diff --check
  passed before commit
```
