# Task 4 report — Generate and package reviewed viem Manifests

## Status

Package-tree and compiled artifact-integrity hardening implemented after the previous dual approval. Fresh independent TypeScript and security review is pending.

## TDD evidence

1. The first conformance test failed because `tools/manifest/generate.ts` and all checked-in artifacts were absent.
2. Complete Public Manifest generation stayed red at the canonical serializer's default expansion boundary. An approved focused RED proved the default remains fail-closed, invalid explicit limits fail, and a fixed reviewed build budget can serialize a larger valid plain-JSON artifact before the minimal option was added.
3. Check-mode, byte-identity, and coordinated-publication tests failed before the in-memory comparison and staged backup/rollback publication paths existed.
4. The first full regression run exposed the cumulative exact npm inventory gate. It failed with only the three new artifacts reported as unexpected, then passed after the package contract explicitly included and scanned them.
5. Review REDs proved every side effect still advertised `destructiveHint = false`, `null` bypassed the explicit canonical node-budget validator, the entrypoint digest covered only a root re-export, symlink/special destinations were moved or read, check mode created a missing directory, and a failed rollback deleted its recovery backup. Each regression passed only after the corresponding conservative rule was implemented.
6. Final security REDs proved an unlocked inner npm package could inherit a locked ancestor and that package identity relied on optional lock-entry `name`. The remediation derives scoped/nested names from exact lock keys, treats the nearest complete npm manifest as a hard boundary, verifies primary viem/abitype names, and rejects package-root symlinks and realpath escapes. Real viem/ox identity-free module markers remain positive regressions.
7. Post-approval REDs proved the report bound only compiler-read declarations and had no compiled trust anchor for the JSON bytes. New tests modify, add, and delete runtime package files; inject symlinks, a FIFO, nested `node_modules`, and reduced budgets; tamper artifact bytes and generated constants; and force failure after the three JSON files publish but before the TypeScript constant publishes.

## Implementation

- Generates canonical Public, Wallet, and review-report artifacts from one `analyzeViemActions({ project: projectViemActionSchemas })` call.
- Binds all 517 non-default third-party declaration SourceFiles actually read by the live TypeScript Program to eight exact locked npm packages: viem, abitype, ox, eventemitter3, `@noble/curves`, `@noble/hashes`, `@scure/bip32`, and `@scure/bip39`. Each package records canonical SHA-512 lock integrity; each declaration records only package name/version, a stable package-relative path, and a SHA-256 digest. Fixed file-count and 64-MiB aggregate text budgets fail closed, and the narrower trusted-dependency list still expresses only semantic trust.
- Determines ownership at the nearest npm manifest. Identity-free module/exports markers inside real viem and ox are skipped, but partial or unlocked inner package identities cannot fall back to an ancestor. Scoped and nested package-lock keys determine the expected npm name, which must match package.json and the primary viem/abitype expectation. Package-root symlinks and realpath escapes outside lock ownership fail closed.
- Uses one shared production scanner to bind the complete regular-file trees of all eight packages: 12,133 files and 39,315,521 bytes in the reviewed installation. The report adds only a deterministic tree digest, file count, and byte total for each package. The digest algorithm incrementally hashes domain-separated 8-byte length frames over UTF-8 path-sorted per-file hashes; fixed limits are 4 MiB/file, 20,000 files and 128 MiB/package, and 50,000 files and 256 MiB globally. Directory and streamed-entry traversal have separate 50,000/package and 100,000/global limits.
- Generates `src/mcp/manifest/generatedViemArtifactDigests.ts`, whose compiled constant fixes the exact raw-byte SHA-256 of the three JSON artifacts. The constant is excluded from its own inputs. Normal generation coordinates all four destinations through staging, preflight, rollback, and retained recovery backups. The cross-directory publication is deliberately described as recoverable, not atomic: a crash or concurrent reader can observe a mixed generation, so an exclusive workspace and fresh successful `npm run manifest:check` are required immediately before consumption.
- Produces globally unique, sorted tools and a sorted complete report covering all 91 installed action members exactly once: 34 included and 57 excluded.
- Derives source bindings, schemas, credentials, runtime dependencies, effects, completion modes, descriptions, and MCP annotations from general Public/Wallet rules. Reads set `destructiveHint = false`; every side effect sets it to `true`. There is no per-action inclusion or classification allowlist.
- Keeps ordinary deploy/send/write transaction submission as `external_handle` for Agent-owned polling. The two installed native `*Sync` receipt-returning operations retain analyzer-reviewed `bounded_wait` semantics.
- Keeps `--check` strictly read-only and byte-exact: missing directories are not created, symlink/special artifacts are rejected, size is checked before opening, and file descriptors use bounded non-blocking no-follow reads. Normal publication rejects symlink/non-directory outputs and non-regular destinations before mutation, stages every file, restores the complete prior set after an ordinary in-process publish failure, and retains the recovery backup with an error if restoration fails.
- Defines the package-tree threat boundary explicitly: validation detects static pre-start tampering, and the reviewed TAS installation tree must remain non-concurrently-writable from validation start through process exit. A read-only installation, different owner/service UID, or immutable image/mount satisfies the assumption. A same-UID adversarial writer can replace TAS itself, so pure Node.js path checks and dynamic imports cannot defend it in v0.1.
- Fixes the generator's canonical expansion budget at 100,000 while preserving the shared serializer's 10,000 default and 1-MiB output limit. Explicit null, non-finite, fractional, non-positive, or otherwise invalid budgets fail closed. No CLI/runtime input controls this value or output directory.
- Includes only the three reviewed artifacts in npm package contents and applies the existing bounded secret/endpoint scan to them.

## Installed exclusion review

```text
callback_input                 12
callback_output                 3
non_finite_request             10
non_finite_response             6
opaque_runtime_object           4
authenticated_write_not_bound   2
subscription                    6
account_not_injectable         14
total                          57
```

Both raw Public signed-transaction submissions are excluded as unbound authenticated writes. Callback/subscription/runtime-client boundaries and Wallet actions without operation-scoped Account injection remain excluded rather than approximated.

## Verification

The earlier implementation received independent TypeScript and security APPROVE. This subsequent hardening awaits a fresh dual review.

```text
npm test -- --run test/unit/manifest/canonicalJson.test.ts
  1 file passed, 41 tests passed

npm test -- --run test/unit/manifest/analyzeViem.test.ts
  1 file passed, 24 tests passed

npm test -- --run test/conformance/viemManifest.test.ts
  1 file passed, 13 tests passed

npm test -- --run test/unit/manifest/packageTree.test.ts
  1 file passed, 13 tests passed

npm test -- --run test/conformance/packageContents.test.ts
  1 file passed, 45 tests passed

combined focused gate
  5 files passed, 136 tests passed

npm run manifest:generate
npm run manifest:check
  three canonical JSON artifacts plus compiled digest source generated and checked
  measured wall time: 3.63 seconds generate; 3.45 seconds check

npm run typecheck
  production and tools TypeScript checks passed

npm test
  all 25 non-Task-5 files passed; 599/605 total tests passed
  shared untracked Task 5 loader/registry: 6 contract-migration failures, 20 passes

npm audit --omit=dev --audit-level=high
  found 0 vulnerabilities

npm pack --dry-run --json
  58 files in the shared worktree; all three JSON artifacts and the four compiled files
  for packageTree/generatedViemArtifactDigests are present

git diff --check
  passed
```
