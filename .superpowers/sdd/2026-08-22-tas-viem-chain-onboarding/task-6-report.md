# Task 6 report — safely bind viem Public and Wallet Actions

## Status

Completed and ready for controller commit. Independent TypeScript review and the dedicated security axis both APPROVED with no findings.

## RED/GREEN

- RED: the two new suites failed because `viemActions.ts` and `chainService.ts` did not exist.
- GREEN: runtime bindings now accept only the validated Registry singleton, dynamically import the two reviewed viem entrypoints, and verify every currently accepted Manifest member is an exact function before returning bindings.
- Chain Service tests prove strict external envelopes, schema decoding, valid Public `account` preservation, operation-scoped Wallet credential stripping, per-call Account construction, exact member/Profile authorization, configured-client injection, one source invocation, result encoding/output validation, no retry, and redacted stable errors.
- A real `getBlockNumber` binding test proves the installed viem action convention is `action(client, parameters)` and reaches one configured client request.
- Full-regression cold-cache contention between complete package-tree validation suites exposed the default unbounded worker scheduling. Vitest now uses two workers so the bounded full-installation scans remain stable without weakening test timeouts.

## Verification so far

```text
npm test -- test/unit/clients/viemActions.test.ts test/unit/workflow/chainService.test.ts test/unit/mcp/results.test.ts
  3 files passed, 71 tests passed

npm run typecheck
npm run build
git diff --check
  passed

npm test
  29 files passed, 641 tests passed

npm run manifest:check
  all three Manifest artifacts and the generated digest source are current

npm audit --omit=dev --audit-level=high
  found 0 vulnerabilities

npm pack --dry-run --json
  62 package files; compiled viemActions and ChainService JS/declarations included
```

Independent TypeScript review re-ran focused tests, the default full suite, typecheck, build, Manifest check, and diff check, then APPROVED with no findings. The dedicated security axis covered dynamic binding, hostile object shapes, key lifecycle and leakage, Account override, member authorization, exact-once/no-retry behavior, source-error redaction, unknown transaction outcomes, supply-chain status, and malicious-code patterns; it APPROVED with no findings.
