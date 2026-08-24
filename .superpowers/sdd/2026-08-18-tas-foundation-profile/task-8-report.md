# Task 8 report — three-phase MCP stdio composition

## TDD evidence

- Inventory RED: `npm test -- test/conformance/fixedToolInventory.test.ts` failed because `src/mcp/server.ts` did not exist. This proved the conformance suite depended on the new phase composition boundary rather than existing standalone tool registration.
- Application RED: `npm test -- test/integration/stdio.test.ts` failed because `src/app/createTasApp.ts` did not exist. After the application seam became GREEN, the two source-entrypoint cases still timed out because the CLI continued to return `TAS_STARTUP_NOT_IMPLEMENTED`; replacing only that composition root made real stdio traffic pass.
- SDK characterization: the identity source process passed both the installed SDK's legacy `initialize` path and modern `2026-07-28` per-request envelope path. Both use the same fresh server factory and list exactly one tool.
- Cleanup-race RED: the first post-commit stability run exposed an actual competing stdin/SIGTERM race. Cleanup removed signal listeners before the stdio handle and lock finished closing, so a closely following SIGTERM could take its default action and produce a signal exit. Signal handlers now remain installed until resource cleanup settles; the same race scenario then passed three consecutive focused runs.
- Review lifecycle RED: the first TypeScript review identified that guards were still installed only after asynchronous startup, and that `once` removed each signal guard on its first delivery. New regression tests failed in seven places: a signal after simulated member-lock acquisition was not latched, repeated SIGINT/SIGTERM and mixed signal/stdin events did not reach cleanup, and the stronger stdio Skill projection caught its independently authored media-type typo before GREEN.
- Review lifecycle GREEN: startup now installs every guard before invoking `createTasApp`, latches shutdown while startup is pending, closes the returned app immediately, and removes guards safely on startup failure. Separate tests keep cleanup pending while delivering repeated SIGINT, repeated SIGTERM, mixed signals, and mixed signal/stdin events; all observe one app close and persistent guards until completion. The real TAWG and member child-process tests now use SIGINT-only and SIGTERM-only shutdown rather than pairing signals with stdin end.
- Skill conformance GREEN: both the linked in-memory MCP suite and spawned stdio process read the running release's `skills/tas/SKILL.md` bytes independently, calculate SHA-256 independently, and compare the exact digest, complete Markdown, path, media type, encoding, package name, and version returned by `skill.tas.get`.
- Security terminal RED: the first security review found that fatal stdio `onerror` only logged and left the CLI awaiting shutdown forever. Three regression cases failed as intended: `TasApp` had no terminal notification, a terminal error competing with signals/stdin returned status `0`, and a real source member process receiving a frame above 10 MiB did not exit within five seconds.
- Security terminal GREEN: `TasApp` now exposes a one-shot fixed `{ reason: 'stdio_error' }` terminal promise. Repeated or synchronous-before-handle-assignment `onerror` resolves it once and triggers the same idempotent close once the handle is available. The CLI folds the terminal into its preinstalled lifecycle, emits exactly `TAS_STDIO_FAILED`, returns `1`, and suppresses duplicate diagnostics under competing terminal, repeated signal, and stdin events. The raw SDK Error is never logged or surfaced.
- Real oversized-frame GREEN: after a valid legacy opening, a member source process receives one MCP input above the SDK's 10 MiB buffer, exits promptly with status `1`, writes only the fixed stderr line, keeps stdout frame-pure, and exposes neither the local path nor RPC/secret marker. A second identical member process starts immediately, proving release of the first process's lock.
- GREEN/REFACTOR: the final focused inventory, stdio, and CLI suite passes 38 tests. Three consecutive final runs passed (pass@1 = 1.0, pass^3 stable).

## Implementation and lifecycle

- Added `createTasMcpServer`, which creates one fresh `McpServer` per SDK connection using the bundled package name/version. It always registers `skill.tas.get`, registers Profile tools only for TAWG-bound phases, and synchronously rejects identity-with-Resolver or TAWG/member-without-Resolver combinations.
- Added `createTasApp(configPath)`. It validates configuration before phase construction, maps it to one frozen public instance, loads the release-bundled TAS Skill once, creates a viem public client without a JavaScript-number chain definition, and shares only immutable phase services with the connection-local server factory.
- Identity setup constructs no Chain Client, Profile Reader/Resolver, member path, directory, or lock. TAWG setup constructs public Profile services but no member path/directory/lock. Member mode computes the canonical TAWG/Agent path and acquires exactly one member lock without reading membership during startup.
- The production Chain transport receives only the validated process-scoped RPC URL. Neither the public instance, result context, diagnostics, nor MCP output receives that URL.
- `createTasApp.close()` is idempotent. It closes stdio before releasing the member lock and still attempts lock release when transport close fails. Startup failure after lock acquisition invokes the same cleanup boundary before returning a fixed safe failure.
- Fatal stdio errors are projected into a one-shot fixed terminal reason rather than logged with the SDK Error. The application triggers controlled close itself, including when `onerror` fires synchronously before `serveStdio` returns its handle. The CLI observes that same terminal, releases the member lock through normal cleanup, and owns the single fixed user-facing diagnostic.
- The CLI remains exact for `--version` and invalid syntax. For `--config`, it reserves stdout for MCP frames and installs stdin-end/close plus persistent SIGINT/SIGTERM guards before asynchronous application construction. A startup-window event is latched; once construction returns, the app is closed immediately. Repeated and mixed shutdown events share one close, guards remain active until cleanup settles, startup failure removes them, and only fixed startup/shutdown diagnostics are printed.
- The stdio integration suite spawns the TypeScript source entrypoint and uses local HTTP JSON-RPC fixtures. It covers modern and legacy openings, exact inventories, Skill package version/content, valid Profile calls, successful nonmember data, identity zero-RPC behavior, setup state exclusion, member lock contention/release/restart, stdin and both signals, competing cleanup, stdout frame purity, and RPC URL/secret-marker redaction.

## Verification

- Focused final suite: 38 passed across `fixedToolInventory`, `stdio`, and `cli`.
- Focused stability: three consecutive final runs passed; pass@1 = 1.0 and pass^3 = 1.0.
- Full suite: 338 passed across 16 files.
- Coverage: 90.31% statements, 87.20% branches, 98.09% functions, and 96.58% lines.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.

## Commits

- `3c615d7` — `feat: serve TAS foundation over MCP stdio`
- `f590e79` — `fix: keep TAS cleanup signals guarded`
- `618947c` — `fix: guard TAS startup and shutdown lifecycle`
- `307e972` — `fix: terminate TAS on fatal stdio errors`

## Residual risks

- Modern stdio conformance is intentionally pinned to the installed MCP SDK's `2026-07-28` envelope. A future SDK protocol revision requires updating the fixture and re-running inventory conformance rather than silently accepting a new opening contract.
- Signal behavior is exercised on the current POSIX host. Windows launcher behavior remains covered for `--version`, but Windows console-signal delivery is platform-owned and is not reproduced by this Linux/macOS-style child-process fixture.
- The oversized-frame conformance case deliberately tracks the installed SDK's current 10 MiB stdio buffer. A future SDK limit change requires updating the independently sized fixture while preserving the terminal-failure contract.
- Profile integration uses a deterministic local JSON-RPC bridge with no external network. It exercises the complete viem/Profile reader boundary for successful reads and nonmember data; provider-specific socket failures remain covered by the existing Profile Reader and safe-result suites rather than the stdio process suite.
