# Task 1 brief — scaffold Demo TAWG roles

## Goal

Implement Task 1 of `docs/superpowers/plans/2026-08-22-tas-demo-tawg.md` with strict TDD. The result is the minimum standalone `tawg/demo/` repository-shaped scaffold, exactly two Role Skills, exact pinned ERC-8301/ERC-8274 interfaces, and conformance tests.

## Owned files

- `tawg/demo/**` except future Workflow implementation files
- `test/conformance/demoLayout.test.ts`
- `test/conformance/demoDependencies.test.ts`
- this SDD task report and progress

## Required behavior

1. Write and run failing conformance tests before creating the scaffold.
2. Require canonical roots `charter/`, `knowledge/`, `data/`, `contracts/`, and `skills/`.
3. Require exactly Contributor and Evaluator Role Skills; default membership is Contributor. Reject a third role and all `demo.*` MCP namespaces.
4. Skills must describe ERC-8004 `agentId` unambiguously and use only the general TAS surfaces planned for the Demo.
5. Pin `trustless-ai/agent-ercs` commit `00605871ff33e80ff21804e5d1cd1ba5fa1c2d68` in `PROVENANCE.json` and vendor exactly:
   - `contracts/execution/ERC8301/IAgentWorkflow.sol`, SHA-256 `e551dc81859c03828a55b116ee70720b8c60edfb261f6880c37317ca3bc7ca9e`
   - `contracts/verify/ERC8274/IAgentVerifier.sol`, SHA-256 `115942e5c66f76e8447f9cae51f80d6820a09c22609022bcd8443455b49baa36`
6. The local `/Users/jimmyshi/ta/agent-ercs` checkout currently contains matching bytes, but its HEAD differs; copy only after digest verification and record the pinned source URL/commit/path/license.
7. `TestBase.sol` must be dependency-free and contain only minimal Foundry test primitives needed by later Demo tests.
8. Keep Workflow/Verifier implementation absent in this task. Do not add TAS Core code or a Demo MCP namespace.
9. Run focused tests, typecheck, and `git diff --check`. Do not commit.

## Collaboration

You are not alone in the codebase. Do not revert or rewrite other agents' work; own only the files listed above and accommodate existing changes.

## Report

Write `.superpowers/sdd/2026-08-22-tas-demo-tawg/task-1-report.md` with RED/GREEN evidence, exact vendored digests, verification commands, and concerns.
