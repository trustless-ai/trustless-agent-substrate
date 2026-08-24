# Task 1 report — scaffold Demo TAWG roles

## Result

Task 1 is complete without a commit. The standalone `tawg/demo/` scaffold now has the canonical Repository roots, exactly two Role Skills, dependency-free Foundry primitives, and the two exact reviewed upstream interfaces. `Workflow.sol` and `PassThroughVerifier.sol` remain absent for Task 2's missing-contract RED.

## RED evidence

Tests were created before the scaffold:

```text
npm test -- test/conformance/demoLayout.test.ts test/conformance/demoDependencies.test.ts
Test Files  2 failed (2)
Tests       8 failed (8)
```

All failures were caused by the intentionally missing Demo roots, Skills, provenance, vendored sources, Foundry configuration, and `TestBase.sol`.

A second narrow RED was run when standalone build-artifact hygiene was added: one layout test failed specifically because `tawg/demo/.gitignore` was missing. The minimum `/out/` and `/cache/` rules then restored GREEN.

A review RED then exposed incorrect DA guidance: the Role Skill test failed because Contributor guidance did not state the exact `workflow.da.put` result or the required generated `agent-sdk` recompute step. The Contributor and Evaluator guides were corrected before GREEN.

The final security-review RED exposed flattened license provenance: the dependency test failed because `PROVENANCE.json` recorded only MIT and omitted the pinned repository's Apache-2.0 declaration and license bytes. The repository-level and per-file declarations are now preserved separately.

## GREEN evidence

After the minimum scaffold was added:

```text
npm test -- test/conformance/demoLayout.test.ts test/conformance/demoDependencies.test.ts
Test Files  2 passed (2)
Tests       8 passed (8)
```

The Role Skill conformance tests cover valid minimal YAML frontmatter, trigger-only `Use when...` descriptions, concise quick references and common mistakes, canonical decimal ERC-8004 `agentId` wording, default Contributor membership, Evaluator guidance, general TAS surfaces, restart recovery, and rejection of a `demo.*` MCP namespace or third role. They also require that `workflow.da.put` returns only `ref` plus `size_bytes`, while both roles derive `daDigest` from exact bytes through the applicable generated `agent-sdk` recompute operation. Unknown writes are reconciled through retained destination and Repository or Provider state, candidate references, `workflow.da.get`, and recomputation—not a nonexistent DA digest lookup.

## Vendored source verification

The local `agent-ercs` checkout was read only after its source bytes were checked. Its HEAD was `bfcd4e59bdbbf0c32e67024e9d8d9226548e5578`, not the pinned provenance revision, but both required files matched the reviewed digests before copying. After vendoring, `cmp` confirmed byte-for-byte equality with those checked local sources.

| Source | Pinned commit | SHA-256 |
|---|---|---|
| `contracts/execution/ERC8301/IAgentWorkflow.sol` | `00605871ff33e80ff21804e5d1cd1ba5fa1c2d68` | `e551dc81859c03828a55b116ee70720b8c60edfb261f6880c37317ca3bc7ca9e` |
| `contracts/verify/ERC8274/IAgentVerifier.sol` | `00605871ff33e80ff21804e5d1cd1ba5fa1c2d68` | `115942e5c66f76e8447f9cae51f80d6820a09c22609022bcd8443455b49baa36` |
| repository `LICENSE` | `00605871ff33e80ff21804e5d1cd1ba5fa1c2d68` | `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` |

`PROVENANCE.json` records the upstream repository, pinned commit, exact paths, immutable raw source URLs, and digests. It distinguishes the repository-level Apache-2.0 declaration from each Solidity file's SPDX MIT declaration. The exact pinned Apache-2.0 `LICENSE` bytes are vendored as evidence. The provenance note preserves both declarations for review without making a legal determination. Conformance rejects any additional vendored Solidity source.

## Verification commands

```text
npm test -- test/conformance/demoLayout.test.ts test/conformance/demoDependencies.test.ts
npm run typecheck
forge build --root tawg/demo
git diff --check
```

All commands passed. Generated Foundry `out/` and `cache/` directories were removed after verification.

The Demo template now ignores only its root Foundry `/out/` and `/cache/` paths; it does not rely on a surrounding Repository's ignore rules.

## Plan interpretation and concerns

The original Task 1 wording simultaneously required "exactly one Workflow source" and required Task 2 to begin with missing `Workflow.sol` and `PassThroughVerifier.sol`. The plan was clarified during implementation: Task 1 creates neither source, while the persistent recursive conformance rule only rejects basenames beyond the two planned files; it does not freeze `contracts/` as empty. `Workflow.sol` remains the sole TAWG-specific business source; `PassThroughVerifier.sol` is the proof-free helper.

No remaining Task 1 blocker is known. The existing root ignore rules also ignore `tawg/demo/data/.gitkeep` and this SDD directory, so those files need an explicit force-add when the parent creates the local commit. Later contract tasks may add only the additional cheatcodes or assertions they demonstrate a need for; `TestBase.sol` is intentionally narrow today.
