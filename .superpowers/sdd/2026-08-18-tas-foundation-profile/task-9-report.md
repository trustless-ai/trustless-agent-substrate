# Task 9 report — Slice A1 package and security gates

## TDD and gate evidence

- Baseline: no package-content conformance test or immutable public Profile fixture set existed. The first focused run after adding both test contracts failed 11 Profile-fixture cases with the expected `ENOENT` for the deliberately absent `test/fixtures/profile/public/*.json`; all three package inventory/security assertions were already GREEN because the implemented package contract satisfied the new independent gate.
- Fixture GREEN: added deterministic `profile.json`, `member.json`, and `nonmember.json` fixtures. The gate deep-freezes the complete loaded tree and validates full 20-byte addresses, decimal-string block/version/Agent identifiers, a block number and ERC-8004 Agent ID above JavaScript's safe-integer range, a 32-byte block hash, both 40- and 64-character lowercase Git commits, canonical GitHub Repository plus `charter/`, inert prototype-named and future nested extensions, one non-zero verifier/Authentication Wallet member, and one successful nonmember result.
- Contamination GREEN: independently mutated fixtures are rejected for numeric Agent ID, numeric block, numeric version, short address, short block hash, short commit, non-Repository endpoint, private-key material, access-token material, and local absolute path. A synthetic GitHub-token shape under the innocuous `public_note` key proves value-shape detection independently of forbidden key names. The checks run on parsed values rather than source grep.
- Package gate GREEN: `npm pack --dry-run --json` is executed from the Repository root in the current Node/npm environment. It compares the returned inventory exactly against an expected manifest derived independently from `src/**/*.ts` plus the supported `tsconfig.json` emission settings, validates the declared `tas` bin target, bounded-decodes every packed artifact as strict UTF-8, rejects secret/token/credential-bearing endpoint and live-RPC shapes, and requires no pre-existing or generated root tarball.
- Review RED/GREEN: the first TypeScript review found that deriving expected outputs by walking live `dist/` would bless a stale compiled file. A focused test wrote `dist/stale-review-artifact.js`, ran the real prepack/dry-run path, and failed because the old expected manifest included the stale file. The corrected manifest maps each current `src/**/*.ts` input to its independently expected `.js` and `.d.ts` output, plus maps only when enabled by the compiler configuration; the same stale package is now rejected and cleaned only after the assertion.
- Review test-hardening: the stale-artifact regression now creates a UUID-named file with exclusive `wx`, records whether creation succeeded, and removes only the file it created. It runs `dryRunPackage` outside the rejection assertion, first proves that the exact stale path entered the successful pack inventory, and then requires only the inventory comparison to fail with explicit `unexpected=[path]; missing=[]` semantics. An unrelated pack failure can no longer satisfy the regression.
- Coverage gate GREEN: Vitest 4's supported glob thresholds independently enforce 80% statements, branches, functions, and lines for all four required source scopes while retaining the global 80% floor. No production line was excluded to improve coverage.
- All-source coverage GREEN: security review found that thresholds alone did not force unimported production files into collection. A config-conformance test first failed because the coverage provider published no `include`; Vitest now publishes and applies `include: ['src/**/*.ts']`. The final report contains production sources only and no longer inflates the global result with imported test fixtures.
- Context-sensitive secret scan RED/GREEN: 17 focused cases exposed missing `npm_` and URL-parameter detections, false positives on public block/transaction/content hashes, broad nested `block_hash` exemption, and incomplete absolute-path handling. The package gate now rejects a 64-hex EVM key only in private-key/secret credential context, detects `npm_` plus every declared URL credential parameter, and allows public 32-byte hashes. The fixture gate validates the root block hash structurally before granting the exact `$.block_hash` exception; nested same-named values remain scanned. It rejects every POSIX absolute path, both Windows drive separators, both UNC forms, and file URLs.
- Multiline credential RED/GREEN: final TypeScript review showed that the first context matcher stopped at newlines. LF JavaScript, CRLF JavaScript with a bare key, and multiline JSON private-key assignments all failed to be detected. The bounded matcher now requires one explicit private-key/secret field or variable name, an optional closing quote, at most 32 whitespace characters, `:` or `=`, at most 32 more whitespace characters, an optional opening quote, and bare or `0x` 64-hex material. Four negative cases prove that separate secret/public-hash fields and nearby guidance remain allowed rather than being joined across unrelated content.
- Linear URL scan RED/GREEN: security re-review identified quadratic backtracking in the credential-bearing endpoint regex. A 64 KiB repeated-`https://` baseline took about 294 ms and exceeded its 100 ms RED ceiling; percent-encoded sensitive parameters, username-only userinfo, and malformed candidates also escaped the regex. The replacement advances one monotonic cursor, terminates non-overlapping candidates at a conservative delimiter set, parses each once with the standard `URL` implementation, and checks decoded lowercase parameter names plus username/password. A near-1 MiB repeated-prefix case now passes a generous 2-second ceiling, while malformed candidates fail safely and public URLs remain accepted.
- URL delimiter RED/GREEN: final review found that treating URL-valid punctuation as surrounding-text boundaries let sensitive parameters escape after `path;segment` and `path(section)`, while `[` incorrectly rejected a safe public IPv6 literal. All three focused regressions failed before the change. Candidates now terminate only at whitespace, quotes, backticks, or angle brackets, so the standard `URL` parser receives semicolons, parentheses, brackets, and other URL punctuation intact. Both bypasses are rejected, the IPv6 URL is accepted, malformed input still fails safely, and the near-1 MiB linear-time regression remains green.
- Adjacent URL RED/GREEN: the next review showed that parsing one complete non-whitespace region and then jumping to its end skipped later HTTP(S) schemes embedded after URL-valid punctuation. Exact regressions first failed for a queried public URL followed by a comma and a token-bearing URL, and for a queried public URL followed by a semicolon and a userinfo-bearing URL. The monotonic scanner now closes the current candidate at every subsequent case-insensitive HTTP(S) scheme and restarts there, parsing every segment once while preserving punctuation and IPv6 within each segment. Safe adjacent public URLs remain accepted. A near-1 MiB sequence of adjacent valid URL candidates traverses the complete input below the 2-second ceiling.
- Documentation follows the executable gates and the implemented CLI. It records the three actual Slice A1 phase inventories, exact-block EIP-1898 behavior, member isolation, the Host credential boundary, and all Slice A2/later deferrals without claiming Slice A completion.

## Exact package inventory policy

The dry-run package contains exactly 41 files:

- the 36 expected `dist/**` outputs independently projected from the 18 current `src/**/*.ts` modules and the current `rootDir`, `outDir`, declaration, source-map, and declaration-map compiler semantics;
- `skills/tas/SKILL.md`;
- `docs/tas/CREDENTIALS.md`;
- `package.json`;
- `README.md`; and
- `LICENSE`.

Equality is exact rather than a required-subset assertion: an extra packed file fails even when it already exists under live `dist/`. The gate explicitly excludes tests/fixtures, coverage, `.superpowers`, runtime/worktree state, `src/**`, Go sources/modules/binaries, configuration and instance files, TOML/YAML, logs/locks/credential files, legacy `tas-skills/**` and `tawg/**`, Docker, and scripts. The configured `bin.tas = dist/app/main.js` target is present. Text scanning distinguishes public 32-byte hashes from private-key/secret assignment context, covers GitHub/npm/AWS/JWT/PEM token shapes, and parses HTTP(S) candidates linearly for credential userinfo or decoded sensitive query parameters. True surrounding-text boundaries or the next embedded HTTP(S) scheme end a candidate; URL punctuation and IPv6 syntax otherwise remain with the standard parser. It preserves the one explicit Credential Contract key example only in its exact documented path/context.

## Coverage

| Required scope | Statements | Branches | Functions | Lines |
|---|---:|---:|---:|---:|
| `src/core/profile/**` | 88.55% | 86.22% | 100% | 98.33% |
| `src/core/skill/**` | 86.95% | 83.05% | 100% | 98.50% |
| `src/local/config/**` | 95.02% | 92.00% | 100% | 98.65% |
| `src/local/instance/**` | 96.15% | 92.85% | 100% | 100% |
| Global, all `src/**/*.ts` | 89.85% | 86.38% | 97.97% | 96.50% |

## Clean-install verification

- `npm ci`: passed; 176 packages installed, 177 audited, zero vulnerabilities.
- `npm run typecheck`: passed.
- `npm test`: 405 tests passed across 18 files.
- `npm run test:coverage`: 405 tests passed; all `src/**/*.ts` were collected and every global/scoped gate passed.
- `npm run build`: passed.
- `npm exec --offline -- tas --version`: printed exactly `0.1.0`.
- `TAS_RPC_URL=https://rpc.example.test npm exec --offline -- tas --config <absolute-identity-setup-fixture> </dev/null`: exited `0`, produced no stdout/stderr, and exercised the real absolute-config CLI path.
- `npm pack --dry-run`: passed with exactly 41 files; no `.tgz` was created.
- `npm audit --audit-level=high`: passed with zero vulnerabilities.
- `go test ./...`: passed for the untouched legacy Go scaffold.
- `git diff --check`: passed.
- Final pre-commit status contained only Task 9-owned tracked modifications and new conformance/fixture files; ignored `dist`, `coverage`, and dependencies did not contaminate the package or commit.

## Operational boundary

Member startup owns only canonical process isolation; it does not turn startup into a membership-authority check. After connection, the release-bundled TAS Skill directs the Agent to call `profile.get_agent` for the configured ERC-8004 `agentId` and stop member operation when the successful result says `is_member = false`. Generic nonmembership remains successful negative Profile data.

## Commit

- `2e53242` — `docs: complete TAS Slice A1 foundation`
- `d360165` — `test: reject stale TAS package artifacts`
- `f9cbb47` — `test: harden stale package fixture`
- `04a2fbd` — `test: harden TAS release security gates`
- `69d7a79` — `test: detect multiline packaged private keys`
- `7dc21b1` — `test: linearize packaged URL scanning`
- `31fce37` — `test: preserve URL punctuation in package scan`
- `09bcd87` — `test: scan adjacent packaged URLs`

## Deferred work

- Slice A2 must add reviewed generated viem Public and Wallet namespaces before identity setup can register ERC-8004 identities or TAWG setup can write Profile membership.
- Repository and Role Skill discovery, Workflow source verification/operations, Chain write tools, DA, Chat, Proof Provider adapters, Demo TAWG, and deterministic E2E remain later slices.
- npm publication, production Profile deployment, live Telegram/Discord validation, concrete Proof Provider integration, and Host distribution remain unclaimed.
- Go/YAML/Docker and legacy Skill content remains untouched legacy scaffolding and is not the active package runtime.
