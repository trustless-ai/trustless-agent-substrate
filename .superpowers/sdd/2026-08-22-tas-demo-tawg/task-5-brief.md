# Task 5 brief — reproducible Demo compilation and deployment

## Goal

Make the committed Demo TAWG independently buildable and make its `Workflow.sol` source reproducibly match compiler-produced metadata and runtime bytecode. Provide and test one deterministic local deployment sequence without presenting a test fixture as the future production TAWG Profile.

## Scope and authority

1. `contracts/Workflow.metadata.json` is the exact Solidity compiler `rawMetadata` string for `Workflow`, followed by one LF. It is generated, never independently authored.
2. Solidity metadata records compiler inputs and source hashes. The pinned upstream Git revision remains authoritative in `vendor/agent-ercs/PROVENANCE.json`; do not invent a dependency-revision field inside compiler metadata.
3. The deployment fixture exists only to prove circular Workflow/Profile address construction and support later local acceptance. It is not the Profile reference implementation, must not claim the TAWG Profile ERC-165 interface, and must be named and documented as a fixture.
4. Generic TAS Workflow verification must never execute this Repository's scripts or tests. Task 5 clean-copy execution is Repository conformance testing only.

## Owned files

- Modify `tawg/demo/foundry.toml`
- Modify `tawg/demo/.gitignore`
- Create `tawg/demo/contracts/Workflow.metadata.json`
- Create `tawg/demo/script/Deploy.s.sol`
- Create `tawg/demo/test/Deploy.t.sol`
- Modify `tawg/demo/README.md`
- Create `test/conformance/demoMetadata.test.ts`
- Create `test/conformance/demoCleanCheckout.test.ts`
- Modify `test/conformance/demoLayout.test.ts` only where the new canonical files require it
- Modify `docs/superpowers/plans/2026-08-22-tas-demo-tawg.md` Task 5 so its files and assertions match the tested implementation
- Task 5 SDD report/progress

## Pinned compiler configuration

The Foundry configuration must explicitly fix and the conformance tests must assert:

- Solidity `0.8.30`, with auto detection disabled;
- optimizer enabled, 200 runs;
- Cancun EVM;
- `via_ir = false`;
- normal IPFS bytecode metadata and CBOR trailer enabled;
- FFI disabled;
- automatic remapping detection disabled; and
- only the checked `remappings.txt` supplies the upstream interface mapping.

No absolute path or parent-directory dependency may enter metadata or configuration.

## Compiler metadata and bytecode tests

Use strict TDD. A fresh build produces `out/Workflow.sol/Workflow.json`; copy its exact `rawMetadata` string plus LF into `contracts/Workflow.metadata.json`. Tests must establish at least:

1. exact compiler build `0.8.30+commit.73712a01`;
2. compilation target `contracts/Workflow.sol:Workflow`;
3. exact optimizer, EVM, IR, remapping, library, metadata, and output settings;
4. source-unit names are normalized Repository-relative paths with no absolute path;
5. every metadata source Keccak matches its committed bytes;
6. the two vendored source paths and hashes match `PROVENANCE.json`;
7. a fresh artifact's `rawMetadata` exactly equals the checked file; and
8. deployed/runtime bytecode retains the expected Solidity IPFS/CBOR metadata trailer.

The compiler artifact or Foundry build-info is evidence used by the test; neither replaces the committed compiler metadata.

## Deterministic deployment fixture

`script/Deploy.s.sol` may contain the deployment wrapper, a one-shot `DemoDeployer` factory, and the narrowly scoped `DemoProfileFixture`. The factory must:

1. reject a registry without code;
2. reject a missing Evaluator identity or zero Authentication Wallet before deployment;
3. deploy `PassThroughVerifier` as child CREATE nonce 1;
4. predict its Profile fixture child CREATE address at nonce 3;
5. deploy `Workflow` at child nonce 2 with that predicted Profile address and immutable Evaluator ERC-8004 Agent ID;
6. deploy the fixture at child nonce 3 and assert the actual address equals the prediction;
7. assert Workflow/Profile cross-references and verifier/registry code; and
8. reject a second deployment through the same factory.

The fixture starts with no members. It must allow the Evaluator to self-register using its current ERC-8004 Authentication Wallet and then open the initial round itself. It must not pre-register or impersonate an Agent. Keep the fixture's ABI and claims narrow; do not return true for the future full TAWG Profile interface.

Deployment tests must cover successful prediction and cross-links, missing identity, unset wallet, one-shot behavior, self-registration, and Evaluator-started first round. A deliberately perturbed prediction helper or harness may prove that a wrong expected address fails, but production deployment order must remain fixed.

## Standalone clean-copy conformance

The test copies only the candidate `tawg/demo/` tree into a fresh temporary directory using Node filesystem APIs:

- reject symlinks and non-regular special files;
- omit `out/`, `cache/`, and `broadcast/`;
- never copy parent TAS files, `node_modules`, or sibling repositories;
- validate vendored SHA-256 and metadata/source Keccak before compilation;
- invoke `forge` with `execFileSync`, argument arrays, timeout, `--offline`, and `--force`; never through a shell;
- run the complete Demo tests in the copy;
- compare fresh `rawMetadata` and runtime metadata trailer after compilation; and
- clean up its temporary directory.

The test assumes the reviewed system Forge and exact installed solc are available. It must not connect to RPC, enable FFI, run package hooks, or execute Repository setup scripts.

## Documentation

The README must explain roles, the multi-round state/evidence flow, deployment inputs, deterministic circular-address sequence, Agent self-registration boundary, DA references, proof-free verifier scope, source/metadata authority, and the general TAS namespaces. It must state that a developer copies the contents of `tawg/demo/` into the root of a new TAWG Repository so `charter/`, `contracts/`, `skills/`, and `data/` remain canonical paths.

Do not describe E2E-only injection or the fixture as product behavior. Do not imply the helper verifier is covered merely because `Workflow.sol` metadata is verified; the deployment tests separately bind the deployed verifier code used by the example.

## Verification and review

Run focused metadata/deployment/clean-copy tests, all Demo Foundry tests, all Demo conformance tests, TypeScript typecheck, Forge formatting, build/size, and `git diff --check`. Remove generated local `out/`, `cache/`, and `broadcast/`. Obtain independent code/specification and security reviews before commit.

## Collaboration

The worker owns only the files listed above, is not alone in the Repository, must preserve other edits, must not commit, and must not spawn subagents.
