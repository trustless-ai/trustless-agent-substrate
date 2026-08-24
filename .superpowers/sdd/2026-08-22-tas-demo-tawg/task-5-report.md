# Task 5 report — reproducible Demo compilation and deployment

## Result

Task 5 is implemented without a commit. The Demo now pins every relevant Foundry compiler setting, commits the compiler's exact Workflow `rawMetadata`, proves a clean copied Repository can build and run all tests offline, and provides one deterministic local deployment fixture for the circular Workflow/Profile address construction.

The deployment Profile is deliberately narrow fixture infrastructure. It does not claim ERC-165 or the future TAWG Profile interface, starts with no members, and allows only live ERC-8004 Authentication Wallet self-registration with deployed Agent-verifier code.

## RED evidence

The metadata, clean-copy, and deployment tests were written before production files or configuration changes. The first run failed for exactly the intended missing behavior:

```text
demoMetadata.test.ts
- missing auto_detect_solc = false and the remaining pinned settings
- missing contracts/Workflow.metadata.json
- missing script/Deploy.s.sol

demoCleanCheckout.test.ts
- missing copied contracts/Workflow.metadata.json

forge test --match-path test/Deploy.t.sol
- Source "script/Deploy.s.sol" not found
```

After initial implementation, a test-only assumption incorrectly compared the runtime IPFS field to raw `sha256(metadata)`. Solidity stores an IPFS CID multihash commitment, whose digest includes IPFS encoding rather than that raw hash. The conformance assertion was corrected to the exact Solidity CBOR map shape, 32-byte IPFS digest, compiler build bytes, and trailer length. Exact `rawMetadata` equality and source Keccak checks remain separate and strict.

## Compiler and metadata boundary

`foundry.toml` now fixes Solidity 0.8.30 with compiler auto-detection disabled, optimizer 200, Cancun, `via_ir = false`, IPFS bytecode metadata, CBOR enabled, FFI disabled, and automatic remapping detection disabled. `remappings.txt` is the only mapping source and contains only the pinned interface mapping. No absolute or parent path enters configuration or metadata.

`contracts/Workflow.metadata.json` is byte-for-byte the fresh artifact's `rawMetadata` string followed by one LF. Tests assert:

- compiler build `0.8.30+commit.73712a01`;
- compilation target `contracts/Workflow.sol:Workflow`;
- exact emitted settings and output categories;
- normalized Repository-relative source-unit names;
- exact Keccak for Workflow and both imported interface bytes;
- exact provenance SHA-256 and corresponding metadata Keccak for each vendored source;
- exact checked/fresh metadata equality; and
- the normal Solidity IPFS/CBOR runtime trailer.

The pinned upstream Git revision remains solely authoritative in `vendor/agent-ercs/PROVENANCE.json`; no non-compiler revision field was invented in raw metadata.

## Deployment sequence and identity boundary

The one-shot `DemoDeployer` rejects reuse before any external Registry call. It requires Registry code, an existing Evaluator identity, and a nonzero current Authentication Wallet. Its child CREATE order is fixed:

```text
nonce 1: PassThroughVerifier
nonce 2: Workflow(predicted Profile, verifier, immutable evaluatorAgentId)
nonce 3: DemoProfileFixture(registry, Workflow)
```

The nonce-3 RLP address is predicted before creating the Workflow. Deployment fails on prediction mismatch or any final code/cross-reference mismatch. Tests assert the actual prediction, Workflow/Profile cross-links, Registry/verifier code, immutable Evaluator ID, and one-shot behavior. They separately bind the deployed helper with:

```text
keccak256(verifierAddress.code) == keccak256(type(PassThroughVerifier).runtimeCode)
```

The fixture pre-registers nobody. The Evaluator uses its current Authentication Wallet to register its own ERC-8004 Agent ID with deployed verifier code, then that same live identity opens the initial round. Tests also reject cross-Agent registration, a rotated-out wallet, and a verifier without code.

## Standalone clean-copy boundary

The clean-copy test recursively inspects only `tawg/demo/` with Node filesystem APIs. It rejects symlinks and non-regular files, omits generated `out/`, `cache/`, and `broadcast/`, and copies no parent TAS file, `node_modules`, or sibling Repository. Before compilation it validates the vendored SHA-256 values and all metadata source Keccaks.

The test invokes reviewed system `forge` directly with an argument array, timeout, `--offline`, and `--force`; it uses no shell, RPC, FFI, lifecycle hook, or Repository setup script. The complete copied Demo test suite passes, fresh raw metadata and runtime trailer are compared, and the temporary directory is always removed.

This is Repository conformance testing only. Generic TAS Workflow verification remains the constrained Standard JSON process defined in `docs/tawg/WORKFLOW.md` and must never execute these scripts or tests.

## GREEN evidence

```text
npm test -- --run test/conformance/demoMetadata.test.ts test/conformance/demoCleanCheckout.test.ts
2 files passed; 3 tests passed

forge test --root tawg/demo --match-path test/Deploy.t.sol -vvv
8 passed, 0 failed

forge test --root tawg/demo --offline --force -vv
61 passed, 0 failed across 5 suites

npm test -- --run test/conformance/demoCleanCheckout.test.ts \
  test/conformance/demoDependencies.test.ts \
  test/conformance/demoLayout.test.ts \
  test/conformance/demoMetadata.test.ts \
  test/conformance/demoSolidityAbi.test.ts
5 files passed; 13 tests passed

npm run typecheck
passed

forge fmt --root tawg/demo --check
passed

forge build --root tawg/demo --offline --force --sizes
Workflow runtime: 16,185 bytes; margin: 8,391 bytes
DemoDeployer runtime: 20,973 bytes; margin: 3,603 bytes
Deploy wrapper runtime: 21,697 bytes; margin: 2,879 bytes

git diff --check
passed
```

## Warnings and concerns

There is no known Task 5 blocker. The deployment factory and script wrapper remain below EIP-170 but have less margin because each embeds creation code for the full Workflow; they are local deployment infrastructure, not persistent TAWG business logic. The clean-copy conformance test intentionally depends on the reviewed system `forge` and exact installed solc being available on PATH.

Workflow metadata covers only `Workflow.sol` and its compiler imports. It does not cover the separately compiled helper or deployment fixture; the deployment suite therefore binds the actual helper runtime and cross-reference explicitly. Solc's existing advisory that `onAgentProve` could be `view` remains intentionally ignored because the pinned ERC-8301 ABI requires `nonpayable`.
