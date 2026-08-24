# Task 3 brief — TypeScript schemas and EVM JSON codecs

## Ownership

This task owns:

- `tools/manifest/schemaEncoder.ts`
- `src/clients/chain/jsonCodec.ts`
- `test/unit/manifest/schemaEncoder.test.ts`
- `test/unit/clients/jsonCodec.test.ts`
- Task 3 brief/report and the A2 progress entry

Do not change Tasks 1/2 implementation without first reporting a blocking interface defect. Preserve concurrent review work.

## Contract

- Use `analyzeViemActions({ project(context) })`; traverse TS7 types only inside that live synchronous callback and return detached plain JSON Schema 2020-12 projections.
- Encode primitives, canonical bigint strings, hex/address, arrays, readonly tuples, optional properties, string records, discriminated/literal unions, ABI arrays, nullable values, and Promise outputs.
- ABI arguments/default-generic outputs use a recursive JSON-value schema, never runtime `any`.
- Reject unsupported runtime/class/function/symbol/stream types, unbounded ordinary recursion, and unions whose overlapping JSON matches decode differently. Emit `oneOf` for mutually exclusive branches and `anyOf` only for source-overlapping branches with provably equivalent decoding.
- Remove runtime `chain`, `transport`, `client`, and `account` only after resolving their shared viem types. Wallet caller input removes Account and adds one optional common inline credential. Public Account unions retain only their Address branch. Optional KZG/provider callback objects are not caller input.
- Encode source-native output values recursively without creating TAS operation semantics. Bigints become canonical decimal strings; bytes become `0x` hex; hashes, addresses, receipts, signatures, and identifiers retain their source-native string/object shape.
- Decode from the generated schema, including bigint ranges, explicit analyzer-proven byte envelopes, bounded `oneOf`/`anyOf`, and recursive local `$ref`. Reject unsafe numeric bigint input, noncanonical decimals, malformed hex, ambiguous `anyOf` decoding, undefined, cycles, accessors, `toJSON`, proxies, and unsupported objects without invoking attacker-controlled code.

## Verification

Follow strict RED-GREEN cycles, then run focused tests, `npm run typecheck`, the full suite, and `git diff --check`. Commit implementation and Task 3 records separately. Do not push.
