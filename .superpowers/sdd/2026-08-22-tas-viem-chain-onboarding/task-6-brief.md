# Task 6 brief — safely bind viem Public and Wallet Actions

## Ownership

- `src/clients/chain/viemActions.ts`
- `src/core/workflow/chainService.ts`
- the required Chain error codes and public error behavior in `src/core/errors.ts` and `src/mcp/results.ts`
- `test/unit/clients/viemActions.test.ts`
- `test/unit/workflow/chainService.test.ts`
- the `OPERATION_OUTCOME_UNKNOWN` recovery regression in `test/unit/mcp/results.test.ts`
- bounded test scheduling in `vitest.config.ts`

## Contract

- Accept only the validated process Manifest Registry. After that boundary, dynamically import only `viem/actions` and `viem/accounts`; bind one exact own data-function member per canonical entry with no `eval`, caller-selected module, path, or property traversal.
- Decode caller data with each generated input schema. Preserve Manifest-declared fields such as Public Action address-valued `account`, while runtime `client`, `transport`, `chain`, and Wallet `account` remain absent from the generated schema.
- Extract one exact inline 32-byte EVM private key from Wallet arguments before decoding and never pass it to viem. Construct an Account per call, inject it last, and release local key/Account/argument references in `finally`. Store only configured connection clients, never a Wallet Account.
- In member phase, resolve the configured ERC-8004 `agentId` at `latest` exactly once. Require a matching member record, non-zero Authentication Wallet, and case-insensitive match with the derived Account before the source call. Setup phases perform no Profile lookup.
- Invoke the selected action once with `(configuredClient, decodedArguments)`, never retry, encode the source-native result, and validate the encoded value against the generated output schema.
- Normalize invalid input, credential, authorization, binding, Profile, source, and output failures without exposing credentials, RPC URLs, upstream messages, stacks, or responses. Read and synchronous sign failures are `EXTERNAL_UNAVAILABLE`; external-handle and bounded-wait transaction failures are `OPERATION_OUTCOME_UNKNOWN` and require reconciliation, not retry.
- Capture dependencies at service creation so later mutation of the options envelope cannot replace the trusted Registry, bindings, clients, phase, Agent ID, or resolver.

## Verification

Follow RED/GREEN. Cover all current 34 entries without hard-coding that count in production, the real viem `action(client, args)` convention, strict invocation/argument/credential shapes, three phases, member authorization, exact-once behavior, output roundtrip, redaction, error recovery, and mutable-options resistance. Run focused/full tests, typecheck, build, manifest check, audit, package dry-run, and diff checks before dual review.
