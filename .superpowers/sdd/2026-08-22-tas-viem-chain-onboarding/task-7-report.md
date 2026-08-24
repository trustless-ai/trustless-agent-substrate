# Task 7 report — generated Chain MCP tools

## Outcome

Task 7 is implemented and ready for controller commit. TAS now advertises and dispatches the two complete reviewed viem Manifest groups in identity setup, TAWG setup, and member mode. Independent TypeScript and security reviews both APPROVED with no findings.

## RED / GREEN

- RED established that public result envelopes rejected scalar/array dependency results, the generated registration module did not exist, and all three phase inventories lacked the 34 reviewed Chain tools.
- GREEN adds mechanical generated registration, native TAS output envelopes, exact cumulative inventory fixtures, Public and Wallet dispatch coverage, stable repeated discovery, validation-before-dispatch, redacted failures, and production preflight ordering.

## Production changes

- `src/mcp/generatedChainTools.ts` registers both whole Registry groups with no per-action switch. Its Standard Schema adapter uses `decodeBySchema` and `encodeEvmJson`; handlers invoke `ChainService` by exact Manifest name.
- `src/mcp/results.ts` accepts bounded scalar, array, or object success data.
- `src/mcp/server.ts` composes Chain tools in all three phases and Profile tools only in TAWG-bound phases.
- `src/app/createTasApp.ts` validates the singleton Registry, loads reviewed bindings, constructs Chain Service, and supplies chain-bound Public and connection-only Wallet clients in every phase.
- `src/app/main.ts` performs bundled Manifest preflight before dynamically importing `createTasApp`.

## Design rulings recorded

1. Manifest `output_schema` describes only the success `data` value. MCP `outputSchema` describes the common success/error `structuredContent` envelope and embeds the exact Manifest schema beneath `data`.
2. MCP SDK 2.0 adds one required root field, `type: "object"`, to 14 object-only union input schemas (12 `oneOf`, two `anyOf`). Tests strip only that field and require every remaining field to equal the accepted Manifest exactly.
3. The production validation boundary is `main.ts`: Registry preflight completes before the dynamic import of the viem-bearing application graph. Direct internal imports are not treated as evidence for this ordering.
4. Manifest inputs omit caller-supplied viem Chain objects, so both clients bind the configured chain ID. Values outside the positive safe-integer range fail before client creation.

## Verification

- Focused generated/inventory/result tests: 48/48 passed.
- Stdio integration suite: 18/18 passed.
- Full regression: 30 files, 649/649 tests passed.
- `npm run typecheck`: passed.
- `git diff --check`: passed.
- Independent TypeScript review: APPROVED with no CRITICAL, HIGH, MEDIUM, or LOW findings; independently re-ran 66 focused and 649 full tests.
- Independent security review: APPROVED with no CRITICAL, HIGH, MEDIUM, or LOW findings; independently re-ran 79 focused, 18 stdio, and 649 full tests, Manifest check, and zero-vulnerability audits.

No implementation commit was created by the worker; the controller owns the Task 7 commit.
