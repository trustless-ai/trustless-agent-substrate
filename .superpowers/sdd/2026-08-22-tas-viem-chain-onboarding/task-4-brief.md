# Task 4 brief — Deterministic reviewed viem Manifests

## Ownership

This task owns:

- `tools/manifest/generate.ts`
- `manifests/viem-public.v1.json`
- `manifests/viem-wallet.v1.json`
- `manifests/viem-report.v1.json`
- `src/mcp/manifest/packageTree.ts`
- `src/mcp/manifest/generatedViemArtifactDigests.ts`
- `test/conformance/viemManifest.test.ts`
- `test/unit/manifest/packageTree.test.ts`
- the Task 4 package inventory changes and Task 4 brief/report

Task 4 also makes one approved minimal Task 1 extension: `canonicalJson(value, options?)` accepts a validated explicit expansion budget while retaining the 10,000-node default and fixed 1-MiB output cap.

## Contract

- Generate all three artifacts from one exact installed-viem analyzer/projector result. Every Public and Wallet member must be included or structurally excluded exactly once.
- Keep semantic-trust dependencies separate from content integrity. Bind every non-default third-party SourceFile actually read by the live Program to one unambiguous npm package name/version/canonical lock integrity and safe package-relative path. Stop at the nearest npm manifest: skip identity-free module/exports markers, reject partial identities, and require every complete inner identity to own an exact lock entry. Derive scoped/nested package names from the final `node_modules/` lock-key segment and require exact manifest/primary-package agreement. Hash the complete bounded package and declaration lists into the Manifest entrypoint digest; skipping transitive packages or hashing only the root re-export is insufficient.
- Recursively snapshot every regular file in all reviewed package roots with the shared runtime scanner. Stream directory entries, charge each before filesystem inspection, and enforce fixed per-package and global entry budgets in addition to file, byte, and directory budgets. Use domain-separated, 8-byte big-endian length frames and incremental SHA-256; reject symlinks, special entries, ASCII-case-insensitive nested `node_modules`, and realpath escapes. Store only tree digest, file count, and byte total in the report and bind them into `entrypoint_digest` without removing the declaration closure.
- Derive effects, completion semantics, annotations, credentials, dependencies, bindings, descriptions, and report entries mechanically from general source-profile rules. Reads are non-destructive; every side effect conservatively has `destructiveHint = true`. Do not introduce a per-action exposure or classification allowlist.
- Public external submissions and Wallet writes are side effects. Ordinary transaction submission returns source-native external handles for Agent-owned receipt polling. Preserve explicitly reviewed source-native synchronous/bounded actions.
- Fail generation if any eligible action fails schema projection, any classification is missing or duplicated, any Manifest fails validation, or canonical serialization exceeds its fixed reviewed limits.
- Generate a stable TypeScript constant compiled into TAS that fixes the exact raw-byte SHA-256 of the three JSON artifacts without self-reference. Normal mode coordinates the three JSON artifacts plus this generated source through preflight, staging, rollback, and retained recovery backups if restoration fails. It is not atomic across the two destination directories: a process crash or concurrent reader can observe a mixed generation. Require an exclusive workspace and a fresh successful `npm run manifest:check` immediately before build, package, or release consumption. Check mode generates only in memory, rejects symlink/special destinations, size-checks before bounded non-blocking no-follow reads, and byte-compares all four files without writing or creating directories.
- The CLI uses only the repository's fixed `manifests` directory. Test-only output/fault seams must not become CLI, environment, configuration, MCP, or runtime write controls.
- Package and bounded-scan exactly the three accepted artifacts.

## Verification

Follow strict RED-GREEN cycles. Run focused Manifest/canonical/package tests, `npm run manifest:generate`, `npm run manifest:check`, `npm run typecheck`, the full suite, production audit, package dry-run, and `git diff --check`. Commit only after independent TypeScript and security reviews both approve; do not push as part of this task.
