# TAWG Collaboration Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Use superpowers:writing-skills for Tasks 2 and 6, and superpowers:verification-before-completion for Task 9.

**Goal:** Ship the release-matched TAWG Collaboration Skill through four flat MCP Skill interfaces, migrate TAS and Demo guidance to the four-layer model, and provide deterministic plus human-operated three-Agent acceptance gates.

**Architecture:** TAS loads two immutable release Skills at startup and two Profile-selected Repository Skills on demand. One phase-aware MCP registration module always lists `tas.get`, `collaboration.get`, `tawg.get`, and `role.get`; nonmember calls to the last three fail with a stable phase error. Collaboration interpretation, approval decisions, cursors, local work, and specialist execution remain in the Agent Host, while TAS only transports exact Markdown and source metadata.

**Tech Stack:** TypeScript 7, Node.js 24, MCP SDK 2, Zod 4, Vitest 4, GitHub Repository Client, Markdown Agent Skills, local fake Chat Clients, and Anvil/Demo Workflow for final acceptance.

**Spec:** `docs/superpowers/specs/2026-08-23-tawg-collaboration-skill-design.md`

## Global Constraints

- The public Skill tools are exactly `tas.get`, `collaboration.get`, `tawg.get`, and `role.get` in that load order.
- All four Skill tools are always discoverable; before member context only `tas.get` succeeds.
- `collaboration.get`, `tawg.get`, and `role.get` return `SKILL_MEMBER_CONTEXT_REQUIRED` outside member mode.
- Every successful Skill call returns complete UTF-8 Markdown plus exact source metadata and a SHA-256 digest.
- `tas.get` and `collaboration.get` read only release-bundled fixed paths and are cached after verified startup loading.
- `tawg.get` reads only `skills/SKILL.md`; `role.get` reads only `skills/roles/<role>.md`.
- Repository-backed Skill callers never supply a commit, Repository, or path. TAS resolves default HEAD internally for each call and returns the exact commit it read.
- `tawg.get` and `role.get` retain the existing optional operation-scoped inline Repository credential contract; TAS never stores or returns the credential.
- Reading a Role Skill does not validate role ownership and grants no authority.
- Agent-proposed new work always requires explicit Human Approval; no Auto grant may waive it.
- Action Approval and Message Approval occur in the Agent Host. Do not add approval state, a task queue, a message classifier, a work lifecycle engine, a cursor store, or a global `operation_id` to TAS.
- Group messages remain natural language. Do not add a production JSON/YAML message envelope or a formal-message MCP namespace.
- Preserve one Agent, one TAWG, one TAS process and the existing inline credential, redaction, and fail-closed Repository boundaries.
- Use TDD for every production change. Request code review after every code task and security review for bundle loading, Repository content, input schemas, credentials, and path validation.
- Historical plans remain historical records. Only current normative documentation and executable content migrate to the flat interface names.

---

## Planned File Structure

```text
skills/
├── tas-bootstrap/SKILL.md
├── tas/SKILL.md
└── tawg-collaboration/SKILL.md       # release-matched collaboration guide

src/core/skill/
├── bundled.ts                        # fixed-path, verified release Skill loader
├── tasSkill.ts                       # TAS release Skill descriptor
├── collaborationSkill.ts             # Collaboration release Skill descriptor
├── loader.ts                         # Profile-selected Root and Role Skill loaders
└── types.ts                          # shared release/repository Skill result types

src/mcp/
└── skillTools.ts                      # all four flat tools and phase guards

test/fixtures/skill/
├── tawg.md
├── contributor.md
└── evaluator.md

test/acceptance/collaboration/
├── README.md                          # how to run the Agent behavior gate
├── scenarios.json                    # test-only scenario/rubric inputs
├── acceptance.schema.json            # result record schema
└── THREE-AGENT-RUNBOOK.md             # Jimmy-operated final acceptance
```

`src/app/createTasApp.ts` composes the four Skill sources. `src/mcp/server.ts` registers the same four Skill tools in every phase while keeping all non-Skill capabilities phase-reduced. Existing Repository, Chat, Workflow, Chain, DA, and Proof Provider modules retain their responsibilities.

---

### Task 1: Generalize verified release Skill loading

**Files:**
- Create: `src/core/skill/bundled.ts`
- Create: `src/core/skill/collaborationSkill.ts`
- Create: `test/unit/skill/collaborationSkill.test.ts`
- Modify: `src/core/skill/tasSkill.ts`
- Modify: `test/unit/skill/tasSkill.test.ts`
- Modify: `src/core/skill/types.ts`

**Interfaces:**
- Produces: `loadBundledSkill<Name, Path>(descriptor, options): BundledSkillArtifact<Name, Path>`.
- Produces: `loadBundledTasSkill(options?): TasSkillArtifact`.
- Produces: `loadBundledCollaborationSkill(options?): CollaborationSkillArtifact`.
- Consumes: fixed package name `@trustless-ai/tas`, package-relative paths, and exact Skill frontmatter names.

- [ ] **Step 1: Write failing tests for a second verified release Skill**

Add tests that create a temporary package root with both fixed Skill files and assert:

```ts
const tas = loadBundledTasSkill({ packageRoot: root })
const collaboration = loadBundledCollaborationSkill({ packageRoot: root })

expect(tas.skill).toEqual({
  name: 'tas', package: '@trustless-ai/tas', version: '9.8.7',
})
expect(collaboration.skill).toEqual({
  name: 'tawg-collaboration', package: '@trustless-ai/tas', version: '9.8.7',
})
expect(collaboration.source).toMatchObject({
  kind: 'release',
  path: 'skills/tawg-collaboration/SKILL.md',
  contentDigest: { algorithm: 'sha256' },
})
```

Cover missing file, empty bytes, invalid UTF-8, wrong frontmatter name, wrong package metadata, a symlinked directory, a symlinked Skill, path escape, exact digest, immutable frozen output, separate cache entries per Skill, and cached bytes after later filesystem mutation.

- [ ] **Step 2: Run the focused tests and verify the new API is absent**

Run:

```bash
npm test -- test/unit/skill/tasSkill.test.ts test/unit/skill/collaborationSkill.test.ts
```

Expected: FAIL because `bundled.ts`, `collaborationSkill.ts`, and the generic artifact fields do not exist.

- [ ] **Step 3: Extract the fixed-path loader and add typed descriptors**

Define these public types in `src/core/skill/types.ts`:

```ts
export interface SkillContentDigest {
  readonly algorithm: 'sha256'
  readonly value: string
}

export interface SkillMarkdownContent {
  readonly mediaType: 'text/markdown; charset=utf-8'
  readonly encoding: 'utf8'
  readonly value: string
}

export interface BundledSkillArtifact<Name extends string, Path extends string> {
  readonly skill: {
    readonly name: Name
    readonly package: '@trustless-ai/tas'
    readonly version: string
  }
  readonly source: {
    readonly kind: 'release'
    readonly path: Path
    readonly contentDigest: SkillContentDigest
  }
  readonly content: SkillMarkdownContent
}

export type TasSkillArtifact = BundledSkillArtifact<'tas', 'skills/tas/SKILL.md'>
export type CollaborationSkillArtifact = BundledSkillArtifact<
  'tawg-collaboration',
  'skills/tawg-collaboration/SKILL.md'
>
```

`src/core/skill/bundled.ts` owns all current `O_NOFOLLOW`, realpath containment, package metadata, UTF-8, frontmatter, digest, freeze, and cache logic. Its descriptor is exact and code-owned:

```ts
export interface BundledSkillDescriptor<Name extends string, Path extends string> {
  readonly name: Name
  readonly path: Path
  readonly segments: readonly string[]
}

export function loadBundledSkill<Name extends string, Path extends string>(
  descriptor: BundledSkillDescriptor<Name, Path>,
  options: { readonly packageRoot?: string } = {},
): BundledSkillArtifact<Name, Path>
```

`tasSkill.ts` and `collaborationSkill.ts` contain only fixed descriptors and typed wrapper functions. Neither accepts a caller-supplied subpath or Skill name.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
npm test -- test/unit/skill/tasSkill.test.ts test/unit/skill/collaborationSkill.test.ts
npm run typecheck
```

Expected: both test files PASS and TypeScript reports no errors.

- [ ] **Step 5: Review and commit the release loader**

Request code review and security review for symlink, containment, UTF-8, cache-key, and package-root behavior. Apply accepted fixes, rerun Step 4, then commit:

```bash
git add src/core/skill/bundled.ts src/core/skill/tasSkill.ts src/core/skill/collaborationSkill.ts src/core/skill/types.ts test/unit/skill/tasSkill.test.ts test/unit/skill/collaborationSkill.test.ts
git commit -m "feat: load bundled collaboration skill"
```

---

### Task 2: Author and package the Collaboration Skill

**Files:**
- Create: `skills/tawg-collaboration/SKILL.md`
- Create: `test/conformance/collaborationSkillContent.test.ts`
- Modify: `package.json`
- Modify: `test/conformance/packageContents.test.ts`

**Interfaces:**
- Produces: release artifact at `skills/tawg-collaboration/SKILL.md` with frontmatter name `tawg-collaboration`.
- Consumes: the exact operating model in the approved spec and `loadBundledCollaborationSkill()` from Task 1.

- [ ] **Step 1: Invoke the Skill-writing discipline and write failing content/package tests**

Use `superpowers:writing-skills`. Add tests that require:

```ts
const artifact = loadBundledCollaborationSkill()
expect(artifact.skill.name).toBe('tawg-collaboration')
expect(artifact.source.path).toBe('skills/tawg-collaboration/SKILL.md')
expect(artifact.content.value).toContain('Group-first. Human-readable.')
expect(artifact.content.value).toContain('Agent-proposed new work always requires explicit Human Approval')
expect(artifact.content.value).toContain('Action Approval')
expect(artifact.content.value).toContain('Message Approval')
expect(artifact.content.value).toContain('tas.get')
expect(artifact.content.value).toContain('collaboration.get')
expect(artifact.content.value).toContain('tawg.get')
expect(artifact.content.value).toContain('role.get')
```

Also assert balanced frontmatter, all required headings, Observe/Suggest/Assist/Auto, optional Task/Batch mode boundaries, L0-L5, every Scope value (Group, Role, Individual, Multiple, Thread, and Private), all four named Work Origins (Collaboration-originated, Human-initiated, Agent-proposed, and Workflow-originated), the operating loop in order, incoming and outgoing Handoff rules, restart recovery, isolated branch/worktree discipline, fixed artifact references, proof-scope distinctions, cursor ownership, secret prohibition, and the completion checklist. Reject `skill.tas.get`, `skill.role.get`, mandatory YAML/JSON messages, TAS-owned approval state, TAS-owned cursors, and Agent-proposed Auto work.

Update the exact npm package inventory expectation to include `skills/tawg-collaboration/SKILL.md`.

- [ ] **Step 2: Run tests and confirm the release file is missing**

Run:

```bash
npm test -- test/conformance/collaborationSkillContent.test.ts test/conformance/packageContents.test.ts
```

Expected: FAIL because the Collaboration Skill is not present or packaged.

- [ ] **Step 3: Write the complete imperative Skill**

Use this exact frontmatter and section order:

```markdown
---
name: tawg-collaboration
description: Use when a TAS-connected TAWG member needs to understand group collaboration, obtain human approval, coordinate accepted work, send or receive a handoff, or recover after restart.
---

# TAWG Collaboration

## Purpose and authority
## Load the complete guidance stack
## Core principles
## Work origins
## Participation modes and Human Approval
## Synchronize and discover context
## Interpret Collaboration Messages
### Scope
### Formality
### Progressive clarification
## Run the collaboration loop
## Manage accepted work
## Send and receive Handoffs
## Use Repository and workspace discipline
## Verify every external result
## Restart and recover
## Protect secrets
## Completion checklist
```

Translate the approved spec into direct Agent instructions. Keep message classification private to the Agent, require natural language for people, require Action Approval before uncovered work, require Message Approval on the exact draft before uncovered sends, and prohibit Auto from starting Agent-proposed work. Describe specialist Skills as unrestricted after approval. Keep Task/Batch processing optional and limited to accepted formal work; keep the optional Work View out of v0.1. Do not include design-history prose, a fixed business role, a fixed Workflow action, a mandatory wire schema, or a scenario-specific MCP tool.

- [ ] **Step 4: Add the file to the release package and pass package safety gates**

Add `skills/tawg-collaboration/SKILL.md` to `package.json#files`. Run:

```bash
npm test -- test/conformance/collaborationSkillContent.test.ts test/conformance/packageContents.test.ts test/conformance/sliceAPackage.test.ts
npm pack --dry-run --json
```

Expected: tests PASS; the dry-run inventory contains both release Skills exactly once and contains no `test/`, `tawg/`, secret, credential-bearing URL, or unexpected source file.

- [ ] **Step 5: Review and commit the Collaboration Skill artifact**

Review the Skill against every spec invariant, request documentation/Skill review, rerun Step 4, then commit:

```bash
git add skills/tawg-collaboration/SKILL.md package.json test/conformance/collaborationSkillContent.test.ts test/conformance/packageContents.test.ts
git commit -m "feat: ship TAWG collaboration skill"
```

---

### Task 3: Add Profile-selected TAWG Root Skill loading and simplify Role Skill loading

**Files:**
- Modify: `src/core/skill/loader.ts`
- Modify: `src/core/skill/types.ts`
- Modify: `test/unit/skill/loader.test.ts`
- Create: `test/fixtures/skill/tawg.md`
- Modify: `test/conformance/repositorySkillFixtures.test.ts`
- Modify: `test/fixtures/repository/activity-window.json`

**Interfaces:**
- Produces: `TawgSkillLoader.get({ credential? }): Promise<TawgSkillGetResult>`.
- Produces: `RoleSkillLoader.get({ role, credential? }): Promise<RoleSkillGetResult>`.
- Removes: caller-supplied `commit` from `RoleSkillGetInput`.
- Consumes: `RepositoryResolver`, `RepositoryContentClient.resolveDefaultHead`, and `RepositoryContentClient.readFile`.

- [ ] **Step 1: Rewrite loader tests around two fixed Repository Skill paths**

Add these interfaces to the test expectations:

```ts
export interface TawgSkillGetInput {
  readonly credential?: RepositoryCredential
}

export interface RoleSkillGetInput {
  readonly role: string
  readonly credential?: RepositoryCredential
}

export interface TawgSkillLoader {
  get(input: TawgSkillGetInput): Promise<TawgSkillGetResult>
}
```

Test `tawg.get` core loading against `skills/SKILL.md` and Role loading against `skills/roles/contributor.md`. For each call assert the exact sequence `resolve Profile latest -> resolve default HEAD once -> read fixed path at returned full commit`. Assert credential forwarding only to HEAD and file reads, no credential in results, exact Profile context, exact digest, 1 MiB boundary, fatal UTF-8, empty-content rejection, mismatched provider path/commit rejection, and mapped Repository failures.

Delete explicit-commit success tests. Add a compile-time/runtime test showing an input containing `commit`, `repository`, or `path` is ignored by Core and rejected later by strict MCP schemas.

- [ ] **Step 2: Run loader tests and verify Root loading is absent**

Run:

```bash
npm test -- test/unit/skill/loader.test.ts test/conformance/repositorySkillFixtures.test.ts
```

Expected: FAIL because no TAWG Root loader/result exists and Role loading still accepts a commit.

- [ ] **Step 3: Implement one internal fixed-path read primitive**

Keep `loader.ts` as the Repository Skill boundary. Add:

```ts
export function createTawgSkillLoader(
  repositoryResolver: RepositoryResolver,
  contentClient: RepositoryContentClient,
): TawgSkillLoader

export function createRoleSkillLoader(
  repositoryResolver: RepositoryResolver,
  contentClient: RepositoryContentClient,
): RoleSkillLoader
```

Both wrappers call one private `loadRepositorySkill(path, credential)` that resolves latest Profile and default HEAD on every call, validates a full lowercase 40- or 64-character commit, reads the fixed path, validates returned path and commit, enforces the existing 1 MiB/UTF-8 boundary, and returns:

```ts
source: {
  kind: 'repository',
  repositoryUrl,
  commit,
  path,
  profile,
  contentDigest: { algorithm: 'sha256', value },
}
content: { mediaType: 'text/markdown; charset=utf-8', encoding: 'utf8', value }
```

`TawgSkillGetResult` has `skill: { name: 'tawg' }`. `RoleSkillGetResult` has `skill: { name: 'role'; role: string }`. Generalize error messages from “Role Skill” to “requested Skill”; retain `SKILL_ROLE_INVALID`, `SKILL_NOT_FOUND`, `SKILL_FETCH_FAILED`, `SKILL_INVALID`, and `SKILL_CONTENT_TOO_LARGE`. Remove `SKILL_COMMIT_INVALID` from active Core behavior.

- [ ] **Step 4: Extend public Repository fixtures with Root Skill bytes**

Add `test/fixtures/skill/tawg.md` and a `skills.root` entry containing `path = skills/SKILL.md` plus its SHA-256 to `activity-window.json`. Extend the acceptance fixture to enqueue and read Root, Contributor, and Evaluator Skills, proving every unpinned call may observe the current default HEAD while returning immutable source metadata.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
npm test -- test/unit/skill/loader.test.ts test/conformance/repositorySkillFixtures.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Review and commit Repository Skill loading**

Request code and security review for fixed paths, role normalization, provider result validation, credential lifetime, and removal of caller commits. Apply accepted fixes, rerun Step 5, then commit:

```bash
git add src/core/skill/loader.ts src/core/skill/types.ts test/unit/skill/loader.test.ts test/fixtures/skill/tawg.md test/fixtures/repository/activity-window.json test/conformance/repositorySkillFixtures.test.ts
git commit -m "feat: load TAWG root and role skills"
```

---

### Task 4: Replace legacy Skill MCP tools with the four flat phase-aware tools

**Files:**
- Modify: `src/mcp/skillTools.ts`
- Modify: `src/core/errors.ts`
- Modify: `test/unit/mcp/skillTools.test.ts`
- Modify: `test/unit/mcp/results.test.ts`
- Modify: `test/conformance/tasSkillTool.test.ts`

**Interfaces:**
- Produces: `registerSkillTools(server, options): void`.
- Produces MCP tools: `tas.get`, `collaboration.get`, `tawg.get`, `role.get`.
- Consumes both bundled artifacts, optional member-only loaders, and `TasPublicInstance`.

- [ ] **Step 1: Write failing schemas and phase-behavior tests**

Define the registration input expected by tests:

```ts
export interface SkillToolOptions {
  readonly tas: TasSkillArtifact
  readonly collaboration: CollaborationSkillArtifact
  readonly instance: TasPublicInstance
  readonly tawg?: TawgSkillLoader
  readonly role?: RoleSkillLoader
}
```

For identity setup, TAWG setup, and member servers, assert `tools/list` contains exactly these four Skill names. Assert:

- `tas.get` succeeds in every phase;
- the other three return MCP tool errors whose structured error code is `SKILL_MEMBER_CONTEXT_REQUIRED` outside member mode;
- `collaboration.get` accepts no arguments;
- `tawg.get` accepts only optional write-only inline `credential`;
- `role.get` requires `role` and accepts only optional write-only inline `credential`;
- `commit`, `repository`, `path`, unknown credential fields, and unknown top-level fields are rejected by Zod before a loader call;
- member calls return complete content and exact release/repository source fields; and
- compact MCP text never contains full Skill Markdown or credentials.

- [ ] **Step 2: Run the focused MCP tests and verify old names fail expectations**

Run:

```bash
npm test -- test/unit/mcp/skillTools.test.ts test/unit/mcp/results.test.ts test/conformance/tasSkillTool.test.ts
```

Expected: FAIL because only `skill.tas.get` and member-only `skill.role.get` exist.

- [ ] **Step 3: Add the stable phase error**

Add this error code and safe metadata to `src/core/errors.ts`:

```ts
SKILL_MEMBER_CONTEXT_REQUIRED: {
  category: 'configuration',
  message: 'A valid TAWG member context is required to load this Skill.',
  retryable: false,
  action: 'user_action',
}
```

Remove active `SKILL_COMMIT_INVALID` use and its public metadata once no code or current test references it.

- [ ] **Step 4: Implement one four-tool registration function**

Replace `registerTasSkillTools` and `registerRoleSkillTools` with `registerSkillTools`. Use strict Zod schemas and existing `createTasResultBuilder`. Register all four names unconditionally. The last three handlers begin with:

```ts
if (options.instance.phase !== 'member') {
  return createTasResultBuilder(options.instance).toolError(
    new TasError(
      'SKILL_MEMBER_CONTEXT_REQUIRED',
      'A valid TAWG member context is required to load this Skill.',
    ),
  )
}
```

In member mode, require both Repository loaders as a server composition invariant. Project all four results through one public shape so only the source variant changes:

```ts
type PublicSkillData = {
  skill: { name: 'tas' | 'tawg-collaboration' | 'tawg' | 'role'; role?: string }
  source:
    | {
        kind: 'release'
        package: '@trustless-ai/tas'
        version: string
        path: 'skills/tas/SKILL.md' | 'skills/tawg-collaboration/SKILL.md'
        content_digest: { algorithm: 'sha256'; value: string }
      }
    | {
        kind: 'repository'
        repository_url: `https://github.com/${string}/${string}`
        commit: string
        path: 'skills/SKILL.md' | `skills/roles/${string}.md`
        content_digest: { algorithm: 'sha256'; value: string }
      }
  content: {
    media_type: 'text/markdown; charset=utf-8'
    encoding: 'utf8'
    value: string
  }
}
```

The ordinary TAS result envelope still supplies phase and resolution context. Never expose a credential, local package root, provider token, or mutable branch name.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
npm test -- test/unit/mcp/skillTools.test.ts test/unit/mcp/results.test.ts test/conformance/tasSkillTool.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Review and commit the flat MCP surface**

Request code and security review for phase guards, strict schemas, write-only credential metadata, projections, compact summaries, and secret exclusion. Apply accepted fixes, rerun Step 5, then commit:

```bash
git add src/mcp/skillTools.ts src/core/errors.ts test/unit/mcp/skillTools.test.ts test/unit/mcp/results.test.ts test/conformance/tasSkillTool.test.ts
git commit -m "feat: expose flat Skill MCP tools"
```

---

### Task 5: Wire all four Skill tools through TAS phases and package acceptance

**Files:**
- Modify: `src/app/createTasApp.ts`
- Modify: `src/mcp/server.ts`
- Modify: `test/conformance/fixedToolInventory.test.ts`
- Modify: `test/conformance/toolInventory.expected.ts`
- Modify: `test/conformance/repositorySkillMcp.test.ts`
- Modify: `test/integration/chainOnboarding.test.ts`
- Modify: `test/integration/stdio.test.ts`
- Modify: `test/unit/package.test.ts`
- Modify: `test/conformance/sliceAPackage.test.ts`

**Interfaces:**
- Consumes: both bundled artifacts and both Repository Skill loaders.
- Produces: identical four-Skill discovery in identity setup, TAWG setup, and member mode.
- Preserves: all non-Skill phase reduction and member-only services.

- [ ] **Step 1: Update cumulative inventory fixtures before composition**

Set the expected Skill portion in every phase to:

```ts
export const expectedSkillTools = [
  'collaboration.get',
  'role.get',
  'tas.get',
  'tawg.get',
] as const
```

Identity setup adds generated viem Public/Wallet Actions, TAWG setup additionally adds Profile reads, and member mode adds Repository, Workflow, DA, Chat, and Proof Provider tools as before. Add calls proving nonmember phase errors without removing the tools from `tools/list`.

- [ ] **Step 2: Run composition and inventory tests and verify they fail**

Run:

```bash
npm test -- test/conformance/fixedToolInventory.test.ts test/conformance/repositorySkillMcp.test.ts test/integration/chainOnboarding.test.ts test/integration/stdio.test.ts
```

Expected: FAIL because server composition still registers legacy names conditionally.

- [ ] **Step 3: Compose both release artifacts and both member Repository loaders**

In `createTasApp.ts`, load both release artifacts before server factory creation:

```ts
const tasSkill = loadBundledTasSkill(bundleOptions)
const collaborationSkill = loadBundledCollaborationSkill(bundleOptions)
```

Inside member Repository composition, construct both `createTawgSkillLoader(repositoryResolver, githubClient)` and `createRoleSkillLoader(repositoryResolver, githubClient)`. Pass all four sources into `createTasMcpServer`; pass no Repository loaders outside member mode.

In `server.ts`, validate that both Repository loaders are present together only for member mode, call `registerSkillTools` before phase-specific registration, and keep existing Profile, Repository, Workflow, DA, Chat, and Proof Provider checks unchanged.

- [ ] **Step 4: Update integration calls and package surface assertions**

Replace active test calls from `skill.tas.get` to `tas.get` and from `skill.role.get` to `role.get`. Add member integration calls for `collaboration.get` and `tawg.get`, and assert exact content plus source metadata. Remove commit arguments from Role calls.

Update package tests for the new compiled modules and both bundled Skills. Do not add Bootstrap, Demo, test acceptance files, or TAWG Repository Skills to the npm package.

- [ ] **Step 5: Run the focused composition and package tests**

Run:

```bash
npm test -- test/conformance/fixedToolInventory.test.ts test/conformance/repositorySkillMcp.test.ts test/integration/chainOnboarding.test.ts test/integration/stdio.test.ts test/unit/package.test.ts test/conformance/packageContents.test.ts test/conformance/sliceAPackage.test.ts
npm run typecheck
npm run build
```

Expected: PASS.

- [ ] **Step 6: Prove active code and tests contain no legacy Skill tool names**

Run:

```bash
if rg -n 'skill\.tas\.get|skill\.role\.get|SKILL_COMMIT_INVALID' src test; then exit 1; fi
```

Expected: no matches in active source or tests. Skill Markdown may still contain legacy names at this point; Task 6 owns that migration and its wider gate.

- [ ] **Step 7: Review and commit application wiring**

Request code review for phase composition and regression risk. Apply accepted fixes, rerun Step 5, then commit:

```bash
git add src/app/createTasApp.ts src/mcp/server.ts test/conformance/fixedToolInventory.test.ts test/conformance/toolInventory.expected.ts test/conformance/repositorySkillMcp.test.ts test/integration/chainOnboarding.test.ts test/integration/stdio.test.ts test/unit/package.test.ts test/conformance/sliceAPackage.test.ts
git commit -m "feat: wire four Skill layers into TAS"
```

---

### Task 6: Migrate Bootstrap, TAS, and Demo TAWG Skills to the collaboration layer

**Files:**
- Modify: `skills/tas-bootstrap/SKILL.md`
- Modify: `skills/tas/SKILL.md`
- Modify: `tawg/demo/skills/SKILL.md`
- Modify: `tawg/demo/skills/roles/contributor.md`
- Modify: `tawg/demo/skills/roles/evaluator.md`
- Modify: `tawg/demo/README.md`
- Modify: `test/unit/skill/tasSkill.test.ts`
- Modify: `test/conformance/demoLayout.test.ts`
- Create: `test/conformance/skillLayering.test.ts`

**Interfaces:**
- Produces: the exact user-visible load order `tas.get -> collaboration.get -> tawg.get -> role.get`.
- Consumes: general collaboration rules from the release Skill; business behavior remains in Root and Role Skills.

- [ ] **Step 1: Invoke the Skill-writing discipline and write failing layering tests**

Use `superpowers:writing-skills`. Add tests proving:

- Bootstrap expects all four Skill tools in `tools/list`, calls only `tas.get`, and treats the last three pre-member failures as intentional;
- TAS Skill performs identity and membership onboarding, then loads `collaboration.get`, `tawg.get`, and each applicable `role.get` in order;
- TAS Skill never asks the Agent to pass a commit to a Skill call;
- Demo Root Skill identifies roles and business context but delegates generic message Scope/Formality, Human Approval, Handoff, cursor, and restart mechanics to Collaboration Skill;
- Demo Role Skills define role actions, artifacts, proofs, recipients, mentions, and business acceptance but do not reproduce the L0-L5 table or generic operating loop; and
- all current Skills use only flat names.

- [ ] **Step 2: Run Skill tests and verify legacy guidance fails**

Run:

```bash
npm test -- test/unit/skill/tasSkill.test.ts test/conformance/demoLayout.test.ts test/conformance/skillLayering.test.ts
```

Expected: FAIL on legacy names, old tool visibility, old authority order, and duplicated generic guidance.

- [ ] **Step 3: Rewrite Bootstrap and TAS Skill handoff**

Bootstrap must install/start TAS, require all four Skill tools to be discoverable, call `tas.get`, and hand control to it. It must not call member-only Skills during setup.

TAS Skill must retain identity, member registration, credential, Profile, Repository, and Workflow verification guidance. After member restart it loads:

```text
tas.get
→ collaboration.get
→ tawg.get
→ role.get(role) for each applicable role
→ workflow.source.verify and current Workflow state
```

Its authority order becomes deployed contracts/current chain, Charter, Root/Role business guidance, Collaboration mechanics, TAS operations, then messages. It must direct Human Approval behavior to Collaboration Skill rather than duplicating it.

- [ ] **Step 4: Narrow Demo Root and Role Skills**

Update Demo Root to call `role.get(role)` and explain only Demo purpose, immutable Evaluator identity, default Contributor membership, Workflow discovery, shared business invariants, and available roles.

Contributor and Evaluator Skills retain exact Workflow action construction, DA/digest behavior, role checks, proof/settlement semantics, next recipient, required mention, and business completion rules. Replace generic Handoff/restart prose with references to the loaded Collaboration Skill plus Demo-specific identifiers that must be included.

- [ ] **Step 5: Run Skill conformance and the legacy-name gate**

Run:

```bash
npm test -- test/unit/skill/tasSkill.test.ts test/conformance/demoLayout.test.ts test/conformance/skillLayering.test.ts test/conformance/collaborationSkillContent.test.ts
if rg -n 'skill\.tas\.get|skill\.role\.get' src test skills/tas skills/tas-bootstrap tawg/demo; then exit 1; fi
```

Expected: tests PASS and `rg` returns no matches.

- [ ] **Step 6: Review and commit layered Skill guidance**

Request Skill/documentation review against the approved spec and Demo Workflow. Apply accepted fixes, rerun Step 5, then commit:

```bash
git add skills/tas-bootstrap/SKILL.md skills/tas/SKILL.md tawg/demo/skills/SKILL.md tawg/demo/skills/roles/contributor.md tawg/demo/skills/roles/evaluator.md tawg/demo/README.md test/unit/skill/tasSkill.test.ts test/conformance/demoLayout.test.ts test/conformance/skillLayering.test.ts
git commit -m "docs: layer TAS and TAWG collaboration skills"
```

---

### Task 7: Migrate current normative documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/DESIGN.md`
- Modify: `docs/TAS.md`
- Modify: `docs/TAWG.md`
- Modify: `docs/PROJECT_STRUCTURE.md`
- Modify: `docs/tas/CONFIG.md`
- Modify: `docs/tas/IMPLEMENTATION.md`
- Modify: `docs/tas/MANIFEST.md`
- Modify: `docs/tas/MCP.md`
- Modify: `docs/tas/SKILLS.md`

**Interfaces:**
- Consumes: implemented schemas and behavior from Tasks 1-6.
- Produces: one normative documentation surface with no legacy Skill API presented as current.

- [ ] **Step 1: Capture the documentation migration failures**

Run:

```bash
rg -n 'skill\.tas\.get|skill\.role\.get|caller.*commit|commit.*caller|member-only tools are absent|must not expose.*Role Skill' README.md docs/DESIGN.md docs/TAS.md docs/TAWG.md docs/PROJECT_STRUCTURE.md docs/tas
```

Expected: matches identifying every stale active description.

- [ ] **Step 2: Update architecture and Skill documentation**

Document:

- four layers and flat names;
- complete Markdown plus release/repository source metadata;
- all-tool discoverability with call-time phase errors;
- internal default-HEAD resolution and no public commit selector;
- optional inline private Repository credential;
- Collaboration Skill as release content and Root/Role Skills as Repository content;
- Agent-owned approvals, automation scopes, cursors, work state, and specialist Skills;
- Human-readable messages and no production message wire schema; and
- migration from the two legacy Skill tools.

`docs/tas/MCP.md` carries exact inputs, outputs, error code, annotations, and examples. `docs/tas/SKILLS.md` carries loading/authority/layering behavior. Higher-level documents link to those details instead of duplicating schemas.

- [ ] **Step 3: Update configuration, package, manifest, and implementation status**

Clarify that no new TOML field stores role, Skill commit, cursor, approval, automation grant, or work state. Add the bundled Collaboration Skill to package/project layout. Mark implementation status only for behavior that already passes Tasks 1-6; leave the final human gate open until Task 9.

- [ ] **Step 4: Verify normative docs contain only the new surface**

Run:

```bash
if rg -n 'skill\.tas\.get|skill\.role\.get|SKILL_COMMIT_INVALID' README.md docs/DESIGN.md docs/TAS.md docs/TAWG.md docs/PROJECT_STRUCTURE.md docs/tas; then exit 1; fi
rg -n 'tas\.get|collaboration\.get|tawg\.get|role\.get' README.md docs/DESIGN.md docs/TAS.md docs/TAWG.md docs/PROJECT_STRUCTURE.md docs/tas
```

Expected: the first command has no matches; the second shows the new surface in all relevant normative documents. Historical files under `docs/superpowers/plans` and earlier specs are not rewritten.

- [ ] **Step 5: Commit normative documentation**

```bash
git add README.md docs/DESIGN.md docs/TAS.md docs/TAWG.md docs/PROJECT_STRUCTURE.md docs/tas
git commit -m "docs: document TAWG collaboration skill"
```

---

### Task 8: Add deterministic scenario coverage and the three-Agent acceptance pack

**Files:**
- Create: `test/acceptance/collaboration/README.md`
- Create: `test/acceptance/collaboration/scenarios.json`
- Create: `test/acceptance/collaboration/acceptance.schema.json`
- Create: `test/acceptance/collaboration/THREE-AGENT-RUNBOOK.md`
- Create: `test/conformance/collaborationAcceptancePack.test.ts`
- Modify: `test/integration/offlineChat.test.ts`

**Interfaces:**
- Produces: test-only scenario IDs and a public-evidence acceptance record.
- Consumes: existing Fake Chat Broker, production Chat MCP schemas, Demo TAWG, and the four loaded Skills.
- Does not produce: a TAS classifier, scheduler, approval service, or message protocol.

- [ ] **Step 1: Write the failing acceptance-pack conformance test**

Require `scenarios.json` to use this test-only shape:

```ts
interface CollaborationScenario {
  readonly id: string
  readonly work_origin: 'collaboration' | 'human' | 'agent' | 'workflow'
  readonly messages: readonly string[]
  readonly automation_grants: readonly string[]
  readonly expected: {
    readonly action_approval: 'required' | 'covered' | 'not_applicable'
    readonly message_approval: 'required' | 'covered' | 'not_applicable'
    readonly required_behaviors: readonly string[]
    readonly forbidden_behaviors: readonly string[]
  }
}
```

Require coverage of all four Work Origins and unique scenarios for L0, L2, L3, human-originated idea, Agent-proposed idea with an unrelated Auto grant, incoming Handoff, uncovered action, uncovered outgoing message, bounded automatic message, L5 recheck, restart recovery, duplicate notification, superseded work, and multiple roles. Assert fixture text contains no private key, token, authenticated URL, real wallet, live RPC endpoint, or mandatory user-facing JSON/YAML message instruction.

- [ ] **Step 2: Run the conformance test and confirm the pack is absent**

Run:

```bash
npm test -- test/conformance/collaborationAcceptancePack.test.ts
```

Expected: FAIL because the acceptance files do not exist.

- [ ] **Step 3: Write the scenario pack and result schema**

Create all required scenarios with natural human-readable messages and explicit behavioral rubrics. `acceptance.schema.json` permits only public evidence:

```text
run_id
started_at
completed_at
tawg_address
agents[{label, erc8004_agent_id, role_skill_sources[]}]
rounds[{round, scenario_ids[], approvals[], message_ids[], commits[], transaction_hashes[], restart_boundaries[]}]
checks[{id, passed, note}]
accepted_by_human
```

Reject secret, credential, private key, RPC URL, raw private message content, and arbitrary extra fields. Explain in `README.md` that this schema is a test record, not a Collaboration Message protocol.

- [ ] **Step 4: Extend deterministic offline Chat transport coverage to three isolated consumers**

Add one integration test with three independently composed MCP servers sharing only the fake broker. Deliver duplicate and cross-platform messages, maintain three different cursors, replace one server, resume from its Agent-owned cursor, and assert no server advances another Agent's cursor. Assert sends are captured once per explicit MCP call. Do not encode approval or message classification into the fake Client.

- [ ] **Step 5: Write the Jimmy-operated runbook**

The runbook uses three independent Agent sessions/directories and at least two or three rounds. It instructs Jimmy to perform the exact twelve-step journey in spec Section 17: discussion, open opportunity, human idea with Agent A, Agent-proposed idea from Agent B, approved Handoff, receiving approval, Agent C L5 review/action, bounded automatic messages, restart, duplicate/concurrent work, and later-round isolation.

Each Agent starts from Bootstrap/TAS guidance, creates or loads its own ERC-8004 identity, joins the same TAWG itself, loads all four Skill layers, and uses its own credential/cursor/workspace. The operator relays local simulated group messages; no real Telegram or Discord connection is required. The runbook pauses for Jimmy at every Action Approval and Message Approval and records only schema-approved public evidence.

- [ ] **Step 6: Run deterministic acceptance-pack tests**

Run:

```bash
npm test -- test/conformance/collaborationAcceptancePack.test.ts test/integration/offlineChat.test.ts
```

Expected: PASS.

- [ ] **Step 7: Review and commit the acceptance pack**

Request test and security review for rubric completeness, isolation, secret exclusion, and the distinction between a test schema and product protocol. Apply accepted fixes, rerun Step 6, then commit:

```bash
git add test/acceptance/collaboration test/conformance/collaborationAcceptancePack.test.ts test/integration/offlineChat.test.ts
git commit -m "test: add collaboration skill acceptance pack"
```

---

### Task 9: Run full verification and complete human acceptance

**Files:**
- Modify after successful human acceptance: `docs/tas/IMPLEMENTATION.md`
- Runtime-only, ignored: `.tas-e2e/<run-id>/`

**Interfaces:**
- Consumes: all implementation tasks, the Demo TAWG, local Anvil, and the three-Agent runbook.
- Produces: verified release/package state and explicit human acceptance.

- [ ] **Step 1: Run the complete automated gate**

Run source directly through Node/npm tooling:

```bash
npm run typecheck
npm run build
npm run manifest:check
npm test
npm audit --audit-level=moderate
npm pack --dry-run --json
forge test --root tawg/demo --offline --force -vvv
git diff --check
```

Expected: every command exits zero, all Vitest/Foundry tests pass, audit reports zero applicable vulnerabilities, package inventory contains exactly the approved release files, and no whitespace errors are present.

- [ ] **Step 2: Run the final legacy and secret scans**

Run:

```bash
if rg -n 'skill\.tas\.get|skill\.role\.get|SKILL_COMMIT_INVALID' src test skills/tas skills/tas-bootstrap tawg/demo README.md docs/DESIGN.md docs/TAS.md docs/TAWG.md docs/PROJECT_STRUCTURE.md docs/tas; then exit 1; fi
if rg -n -- '-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_|npm_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16}' skills test/acceptance docs/tas; then exit 1; fi
```

Expected: no matches. Historical plans/specs remain outside the legacy-name scan.

- [ ] **Step 3: Prepare the isolated human acceptance run**

Follow `test/acceptance/collaboration/THREE-AGENT-RUNBOOK.md`. Create a fresh ignored `.tas-e2e/<run-id>/` root, start Anvil, deploy the Demo dependencies, and start three independent Agent/TAS directories. Infrastructure may provide public chain addresses and test funds only; each Agent performs its own identity, Profile membership, Skill loading, credential use, and role operation.

- [ ] **Step 4: Pause for Jimmy to operate and approve all three Agents**

Jimmy conducts at least two or three rounds and personally evaluates message readability, idea discussion, Agent-proposed approval, Action Approval, Message Approval, bounded automation, Handoff send/receive, L5 verification, restart recovery, duplicate avoidance, and cross-Agent isolation. Do not mark this step complete from automated tests or an Agent's self-report.

- [ ] **Step 5: Validate the public acceptance record**

Validate the run record against `test/acceptance/collaboration/acceptance.schema.json`. Require every scenario ID to appear, every check to pass, `accepted_by_human = true`, three distinct canonical decimal ERC-8004 IDs, at least two rounds, at least one restart boundary, and no forbidden secret-bearing field.

- [ ] **Step 6: Mark implementation accepted and commit**

Only after Jimmy accepts the run, update `docs/tas/IMPLEMENTATION.md` with the completed automated gate, run identifier, public evidence location, and human acceptance date. Do not commit `.tas-e2e/`.

```bash
git add docs/tas/IMPLEMENTATION.md
git commit -m "docs: record collaboration skill acceptance"
```

- [ ] **Step 7: Re-run the final clean-tree check**

Run:

```bash
git status --short
git log -10 --oneline
```

Expected: no tracked or untracked project changes except explicitly ignored `.tas-e2e/` runtime data, and the focused task commits appear in order.
