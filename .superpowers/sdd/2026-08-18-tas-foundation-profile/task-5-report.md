# Task 5 report — release-bundled TAS Skill

## Code RED/GREEN

- RED: added `test/unit/skill/tasSkill.test.ts` and `test/conformance/tasSkillTool.test.ts`, then ran `npm test -- test/unit/skill/tasSkill.test.ts test/conformance/tasSkillTool.test.ts`.
- Observed expected RED: both suites failed because `src/core/skill/tasSkill.ts` and `src/mcp/skillTools.ts` did not exist.
- GREEN: added a package-root-bound, cached TAS Skill loader and registered `skill.tas.get` through the real MCP SDK with `InMemoryTransport` in identity setup, TAWG setup, and member contexts.
- The loader fixes the only accepted source to `skills/tas/SKILL.md`, validates the package name/version, non-symlink directory and file boundaries, containment, strict UTF-8, SHA-256 bytes, and minimal required frontmatter. Invalid bundles produce only `TAS_SKILL_BUNDLE_INVALID`.

## Skill RED/GREEN

- RED source: `task-5-skill-baseline.md` records the fresh-Agent failure for the previous two-mode Skill: no `identity_setup`, inappropriate Profile calls, no identity-only flow, and an impossible pre-TAWG credential path.
- GREEN edit: `skills/tas/SKILL.md` now has explicit identity setup, TAWG setup, and member sections. Identity setup uses only the configured Identity Registry and generated Chain actions; TAWG setup verifies the Profile Registry, performs membership with the retained identity key inline, then copies the credential without overwrite into the TAWG/member path.
- `docs/tas/CREDENTIALS.md` now defines identity-scoped pending/final credential paths keyed by `(chainId, identityRegistryAddress)` and the non-destructive post-membership copy to the TAWG/member path. TAS reads neither file.

The controller must independently run the Skill GREEN fresh-Agent scenario after review; this report does not claim that scenario has run.

## Release artifact

- `skills/tas/SKILL.md` SHA-256: `1a3fce3ca780c903b9abd75a749fff884fa8151b69a2bc57d9b8b85343a1a0c6`

## Verification

- Focused loader and MCP SDK transport tests: 14 passed.
- `npm test`: 156 passed across 10 files.
- `npm run test:coverage`: 90.07% statements, 87.34% branches, 100% functions, 96.19% lines.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.

## Concern

Node provides no portable descriptor-relative directory traversal. The loader therefore rejects symlinked boundaries with `lstat`, verifies resolved containment before reading, and opens the final file with `O_NOFOLLOW` followed by `fstat`; this is the strongest safe open/stat sequence available through Node's portable APIs, but cannot make every multi-directory path walk fully TOCTOU-proof against a hostile concurrent local filesystem actor.

## Follow-up: self-contained identity credential handoff

- The controller's first fresh-Agent GREEN scenario passed the three phase selection, Registry match, inline membership key, non-destructive TAWG copy, and member configuration checks, but found that the returned Skill did not itself state the identity pending/final path templates or their move transition.
- RED: added a loaded-artifact contract test for the three distinct path templates, the same-filesystem atomic pending-to-identity-final move after Registry confirmation, and the later never-move identity-final-to-TAWG/member copy. The test failed against the prior bundled Skill because the pending template was absent.
- GREEN: the Skill now includes all templates and states the two transitions exactly: atomically move pending to identity-final on the same filesystem without overwrite after registration plus non-zero Authentication Wallet confirmation; later copy — never move — identity-final to TAWG/member after successful Profile membership, also without overwrite.
- Updated Skill SHA-256: `67752d0b2a0c48b21ea865e8954a20f82133f79e520b54400a7091749146e33b`.
- Verification: focused tests 15 passed; full suite 157 passed; typecheck, build, and `git diff --check` passed.

## Review follow-up: contract and type-safety fixes

- RED: the new loaded-Skill/credential-contract consistency test failed because `CREDENTIALS.md` still described creating identity-final while retaining pending. It also added symlink tests for the package root, `package.json`, `skills`, `skills/tas`, and `SKILL.md` boundaries.
- GREEN: `CREDENTIALS.md` now requires the same platform-native atomic no-replace rename as the returned Skill, with pending unchanged and explicit migration required when unavailable. Its later TAWG/member operation now requires exclusive create-new (`O_CREAT|O_EXCL` equivalent), owner-only permissions, write+flush, `EEXIST` reconciliation, and preservation of identity-final.
- Removed the `unknown as PublicJsonObject` bypass from `skill.tas.get`; an explicit, typed JSON-compatible projection now supplies the result builder. Focused transport coverage continues to verify the registered output.
- The Skill is unchanged by this review remediation; SHA-256 remains `37cd7685a6ead1a5c436478c49df3d36797c0e80cb6d449d2b6ba8e70f662954`.
- Verification: focused tests 20 passed; full suite 162 passed; typecheck, build, and `git diff --check` passed.

The controller should re-run its fresh-Agent scenario against this amended Skill before treating the scenario as fully GREEN.

## Follow-up: race-safe credential transitions

- The controller's second fresh-Agent scenario confirmed that the phases, tools, locators, exact path templates, and process handoffs were actionable, then identified missing no-replace and exclusive-create safety primitives.
- RED: extended the loaded-artifact contract with required platform-native atomic no-replace rename/fail-closed migration behavior, exclusive create-new (`O_CREAT|O_EXCL` equivalent), owner-only write-and-flush, `EEXIST` reconciliation, preservation of identity-final, and the deployed Profile meaning of `tawgAddress`. The prior Skill failed the no-replace matcher.
- GREEN: pending-to-identity-final now requires an atomic platform-native no-replace rename; where unavailable, pending remains unchanged and the Host fails closed for explicit migration. The TAWG/member copy now requires exclusive create-new, owner-only permissions, write+flush, `EEXIST` reconciliation, and never removes identity-final. The Skill explicitly defines `tawgAddress` as the deployed TAWG Profile address.
- Updated Skill SHA-256: `37cd7685a6ead1a5c436478c49df3d36797c0e80cb6d449d2b6ba8e70f662954`.
- Verification: focused tests 15 passed; full suite 157 passed; typecheck, build, and `git diff --check` passed.
