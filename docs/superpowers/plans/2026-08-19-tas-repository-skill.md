# TAS Repository Discovery and Role Skill Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Begin Slice C (Participating TAS) by extending the Slice A member process with Profile-bound GitHub activity discovery and safe, commit-pinned loading of a caller-selected Role Skill.

**Architecture:** Repo Resolver derives one canonical GitHub Repository URL exclusively from the exact Profile snapshot. A provider-neutral Repository Client implements read-only activity and internal file access, while the GitHub Client adapts those operations to GitHub REST. Role Skill Loader is the only repository-content reader exposed through MCP: `skill.role.get` maps a normalized role to `skills/roles/<role>.md`, pins the read to a full commit, and returns its content and digest. It does not validate role ownership or expose arbitrary paths.

**Tech Stack:** The Slice A Node.js 24 and TypeScript 7 stack, `@octokit/request` 10.0.14, Node.js crypto and TextDecoder APIs, MCP TypeScript SDK 2.0.0, Zod 4.4.3, and Vitest 4.1.11.

**Spec:** `docs/TAS.md` Sections 7.3–7.4 and 9, `docs/tas/MCP.md` Sections 4.7 and 4.13–4.14, `docs/TAWG.md` Sections 4.5–4.6, and `docs/tas/IMPLEMENTATION.md` Slice C.

## Global Constraints

- Begin only after both Slice A1 and Slice A2 completion criteria in `docs/superpowers/plans/2026-08-18-tas-foundation-profile.md` and `docs/superpowers/plans/2026-08-22-tas-viem-chain-onboarding.md` pass.
- Work in an isolated Git worktree and preserve the legacy Go scaffold and unrelated user changes.
- Keep the dependency direction `mcp -> core -> clients`; clients never import MCP schemas or native MCP result types.
- The Profile-selected Repository is authoritative. No Slice C tool accepts a Repository URL, owner, repository name, API base URL, branch, or default-branch override from the caller.
- TAS v0.1 accepts only `https://github.com/<owner>/<repository>` as a Repository locator. It rejects user information, ports, query strings, fragments, trailing slashes, `.git` suffixes, GitHub Enterprise hosts, SSH locators, and Git protocol locators.
- Repository tools remain read-only. Do not add clone, checkout, file read, status, diff, branch, commit, push, Issue mutation, Pull Request mutation, review, approval, merge, close, or delete tools.
- `skill.role.get` is the only MCP repository-content exception. It reads only `skills/roles/<role>.md` from the Profile-selected Repository.
- Every unpinned Role Skill load resolves the provider's current default-branch HEAD to a full immutable commit before reading bytes. An explicit full commit is used unchanged.
- TAS stores no Repository cursor, selected Role Skill commit, GitHub credential, repository working tree, or Agent session state.
- Repository credentials are optional inline MCP credentials, passed to one call, redacted everywhere, and never retained in a shared authenticated Octokit instance.
- Repository activity is live data. Every first page captures `observed_at`; later pages reuse it from the opaque cursor. Results are reverse chronological, newest first, and include their inclusive `since` boundary.
- Decoded Role Skill content is limited to 1 MiB (`1_048_576` bytes) in v0.1.
- Use GitHub API version `2026-03-10` for all GitHub REST calls in this phase.
- stdout remains reserved for MCP protocol frames.

---

## Planned File Structure

```text
src/
├── mcp/
│   ├── repositoryTools.ts
│   ├── skillTools.ts
│   └── schemas.ts                    extend Slice A schemas
├── core/
│   ├── repository/
│   │   ├── types.ts
│   │   ├── locator.ts
│   │   ├── cursor.ts
│   │   ├── client.ts
│   │   ├── resolver.ts
│   │   └── service.ts
│   └── skill/
│       ├── types.ts
│       └── loader.ts
└── clients/
    └── repository/
        ├── githubRequest.ts
        └── githubRepositoryClient.ts

test/
├── fixtures/
│   ├── repository/
│   └── skill/
├── unit/
│   ├── repository/
│   ├── skill/
│   └── mcp/
├── integration/
│   └── githubRepositoryClient.test.ts
└── conformance/
    ├── repositorySkillMcp.test.ts
    └── toolInventory.expected.ts     cumulative fixture from Slice A
```

---

## Task 1: Add the Repository Dependencies and Domain Contracts

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/core/repository/types.ts`
- Create: `src/core/repository/client.ts`
- Create: `src/core/skill/types.ts`
- Create: `test/unit/repository/contracts.test.ts`

**Interfaces:**

- Consumes: Slice A `ChainSelector`, Profile projection, `TasError`, public Resolution Context, and inline credential shape.
- Produces: Provider-neutral Repository and Skill types used by all later tasks in this plan.

- [ ] **Step 1: Write the failing package and contract test**

Assert that `package.json` pins this exact runtime dependency:

```text
@octokit/request = 10.0.14
```

Add compile-time type assertions for the interfaces below and run:

```bash
npm test -- test/unit/repository/contracts.test.ts
```

Expected: FAIL because the dependencies and domain files do not exist.

- [ ] **Step 2: Define immutable source and activity types**

Add these public core contracts, using readonly properties throughout:

```ts
export interface RepositorySource {
  provider: 'github';
  locator: `https://github.com/${string}/${string}`;
  owner: string;
  repository: string;
  profile: {
    blockNumber: string;
    blockHash: `0x${string}`;
    version: string;
  };
  charter: {
    commit: string;
    path: 'charter/';
  };
}

export interface RepositoryCredential {
  type: 'inline';
  secret: string;
}

export interface RepositoryIssue {
  id: string;
  number: string;
  title: string;
  state: 'open' | 'closed';
  author: string | null;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export type RepositoryPullRequest = RepositoryIssue;

export interface RepositoryCommit {
  commit: string;
  message: string;
  authorName: string | null;
  authorLogin: string | null;
  committedAt: string;
  url: string;
}

export interface ActivityWindow {
  since: string;
  observedAt: string;
  limit: number;
  providerPage: number;
  providerOffset: number;
}

export interface RepositoryPage<T> {
  items: readonly T[];
  nextPosition?: {
    providerPage: number;
    providerOffset: number;
  };
}
```

All time strings are canonical UTC RFC 3339 values with second precision. Repository IDs and numbers are strings even when GitHub returns JSON numbers.

- [ ] **Step 3: Define the provider-neutral client ports**

```ts
export interface RepositoryActivityClient {
  listIssues(
    source: RepositorySource,
    window: ActivityWindow,
    credential?: RepositoryCredential,
  ): Promise<RepositoryPage<RepositoryIssue>>;

  listPullRequests(
    source: RepositorySource,
    window: ActivityWindow,
    credential?: RepositoryCredential,
  ): Promise<RepositoryPage<RepositoryPullRequest>>;

  listCommits(
    source: RepositorySource,
    window: ActivityWindow,
    credential?: RepositoryCredential,
  ): Promise<RepositoryPage<RepositoryCommit>>;
}

export interface RepositoryFile {
  path: string;
  commit: string;
  bytes: Uint8Array;
}

export interface RepositoryContentClient {
  resolveDefaultHead(
    source: RepositorySource,
    credential?: RepositoryCredential,
  ): Promise<string>;

  readFile(
    source: RepositorySource,
    commit: string,
    path: string,
    credential?: RepositoryCredential,
  ): Promise<RepositoryFile>;
}

export type RepositoryClient = RepositoryActivityClient & RepositoryContentClient;
```

Add Role Skill result types matching the logical result in `docs/tas/MCP.md`, with `contentDigest.algorithm` fixed to `sha256`, `path` derived from the role, and content encoding fixed to `utf8` Markdown.

- [ ] **Step 4: Install and verify**

```bash
npm install @octokit/request@10.0.14 --save-exact
npm test -- test/unit/repository/contracts.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit the domain contracts**

```bash
git add package.json package-lock.json src/core/repository/types.ts src/core/repository/client.ts src/core/skill/types.ts test/unit/repository/contracts.test.ts
git commit -m "feat: define repository and skill contracts"
```

---

## Task 2: Resolve the Profile-Bound GitHub Repository

**Files:**

- Create: `src/core/repository/locator.ts`
- Create: `src/core/repository/resolver.ts`
- Create: `test/unit/repository/locator.test.ts`
- Create: `test/unit/repository/resolver.test.ts`

**Interfaces:**

- Consumes: Slice A `ProfileResolver.resolveProfile(selector)` and `ResolvedProfile`.
- Produces: `RepositoryResolver.resolve(selector): Promise<RepositorySource>`.

- [ ] **Step 1: Write failing canonical-locator tests**

Accept exactly examples shaped like:

```text
https://github.com/trustless-ai/trustless-agent-substrate
https://github.com/Owner-Name/repo_name
```

Reject:

```text
http://github.com/owner/repo
https://user@github.com/owner/repo
https://github.com:443/owner/repo
https://github.com/owner/repo/
https://github.com/owner/repo.git
https://github.com/owner/repo?ref=main
https://github.com/owner/repo#readme
https://api.github.com/repos/owner/repo
https://github.example.com/owner/repo
git@github.com:owner/repo.git
```

Owner and repository segments must be non-empty and percent encoding is rejected. Owner matches `[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?` with no consecutive hyphens. Repository matches `[A-Za-z0-9._-]{1,100}` and is neither `.` nor `..`.

Run the focused test and confirm `parseGitHubLocator` is missing.

- [ ] **Step 2: Implement the locator parser**

```ts
export interface GitHubLocator {
  locator: `https://github.com/${string}/${string}`;
  owner: string;
  repository: string;
}

export function parseGitHubLocator(locator: string): GitHubLocator;
```

Use the standard `URL` parser, then compare the reconstructed canonical locator byte-for-byte with the input. Throw `REPOSITORY_LOCATOR_UNSUPPORTED` for every unsupported form. Do not normalize an unsupported locator into an accepted one.

- [ ] **Step 3: Write failing resolver tests**

Cover:

- Repository source derives only from the Profile projection;
- Charter commit and path are preserved exactly;
- Profile block number, block hash, and version are preserved;
- a caller cannot override the Repository;
- invalid locator, non-full Charter commit, or non-`charter/` path fails closed; and
- a Profile read error retains its original stable error code.

- [ ] **Step 4: Implement Repo Resolver**

```ts
export interface RepositoryResolver {
  resolve(selector: ChainSelector): Promise<RepositorySource>;
}

export function createRepositoryResolver(
  profileResolver: Pick<ProfileResolver, 'resolveProfile'>,
): RepositoryResolver;
```

The resolver validates a 40- or 64-character lowercase hexadecimal Charter commit. It performs no GitHub request and does not inspect Charter content. `repo.get` later returns this Profile-derived source directly.

- [ ] **Step 5: Verify and commit**

```bash
npm test -- test/unit/repository/locator.test.ts test/unit/repository/resolver.test.ts
npm run typecheck
git add src/core/repository/locator.ts src/core/repository/resolver.ts test/unit/repository/locator.test.ts test/unit/repository/resolver.test.ts
git commit -m "feat: resolve Profile-bound repositories"
```

---

## Task 3: Implement Opaque, Stateless Repository Cursors

**Files:**

- Create: `src/core/repository/cursor.ts`
- Create: `test/unit/repository/cursor.test.ts`

**Interfaces:**

- Consumes: `RepositorySource` and the Slice A canonical public context conventions.
- Produces: `encodeRepositoryCursor`, `decodeRepositoryCursor`, and `assertRepositoryCursorContext`.

- [ ] **Step 1: Write failing cursor tests**

Use this internal payload:

```ts
export interface RepositoryCursorPayload {
  version: 1;
  tool: 'repo.issue.list' | 'repo.pull_request.list' | 'repo.commit.list';
  repository: string;
  profileBlockHash: `0x${string}`;
  since: string;
  observedAt: string;
  order: 'newest_first';
  providerPage: number;
  providerOffset: number;
}
```

Test deterministic base64url encoding, round trip, malformed base64, malformed JSON, unknown fields, unsupported version, wrong tool, wrong Repository, wrong Profile block hash, changed `since`, invalid page/offset, future `observedAt`, and oversized cursor input.

Expected errors:

```text
REPOSITORY_CURSOR_INVALID
REPOSITORY_CURSOR_CONTEXT_MISMATCH
```

- [ ] **Step 2: Implement strict cursor encoding**

Serialize properties in the interface order above, UTF-8 encode, and base64url encode without padding. Limit the encoded input to 2 KiB. Decode with a strict Zod schema. The cursor contains no credential, local path, RPC URL, Host ID, or mutable lookup key.

The cursor is opaque protocol state, not an authorization token. Context validation still re-resolves the Profile by the cursor's exact block hash and compares the Repository locator before a provider call.

- [ ] **Step 3: Verify and commit**

```bash
npm test -- test/unit/repository/cursor.test.ts
npm run typecheck
git add src/core/repository/cursor.ts test/unit/repository/cursor.test.ts
git commit -m "feat: encode repository activity cursors"
```

---

## Task 4: Implement the GitHub Read Client

**Files:**

- Create: `src/clients/repository/githubRequest.ts`
- Create: `src/clients/repository/githubRepositoryClient.ts`
- Create: `test/fixtures/repository/github.ts`
- Create: `test/integration/githubRepositoryClient.test.ts`

**Interfaces:**

- Consumes: `RepositoryClient`, `RepositorySource`, `ActivityWindow`, and transient `RepositoryCredential`.
- Produces: `createGitHubRepositoryClient(request, clock): RepositoryClient`.

- [ ] **Step 1: Build a recording GitHub transport fixture**

Create an injected request port rather than mocking global fetch:

```ts
export interface GitHubRequest {
  request<T>(
    route: string,
    parameters: Readonly<Record<string, unknown>>,
    credential?: RepositoryCredential,
  ): Promise<{ data: T; headers: Readonly<Record<string, string | undefined>> }>;
}
```

The recording fixture must assert the route, owner, repository, page, filters, GitHub API version header, and whether an Authorization header was present without recording its value.

- [ ] **Step 2: Write failing Issue and Pull Request tests**

Both methods call `GET /repos/{owner}/{repo}/issues` with:

```text
state = all
sort = created
direction = desc
since = one second before the requested inclusive lower bound
per_page = 100
page = providerPage
X-GitHub-Api-Version = 2026-03-10
```

The Client locally retains only records whose `created_at` is within inclusive `[since, observedAt]`. `listIssues` excludes objects containing `pull_request`; `listPullRequests` includes only those objects. Scan provider pages until the requested result limit is filled, the source is exhausted, a record falls below `since`, or 20 provider pages have been read in one MCP operation.

Return newest-first items. If scanning stops because of the 20-page call bound while more source data may exist, return a next position even when the result page is empty. Preserve `providerOffset` when a result limit ends inside a provider page.

Map `id` from GitHub's opaque `node_id`, not its JSON numeric `id`. Convert `number` to a decimal string only after requiring a non-negative safe integer. Cover boundary equality, mixed Issue/PR pages, empty filtered pages, null user, source exhaustion, Link-header continuation, unsafe numeric issue numbers, and malformed provider responses.

- [ ] **Step 3: Write failing commit tests**

Call `GET /repos/{owner}/{repo}/commits` without `sha`, so GitHub selects the provider's current default branch. Send `since`, `until = observedAt`, `per_page = 100`, and `page`. Locally require `commit.committer.date` within inclusive `[since, observedAt]`, require a full lowercase commit hash, and return newest first.

Map each result to:

```ts
{
  commit: response.sha,
  message: response.commit.message,
  authorName: response.commit.author?.name ?? null,
  authorLogin: response.author?.login ?? null,
  committedAt: response.commit.committer.date,
  url: response.html_url,
}
```

Cover merge commits, null GitHub users, missing author metadata, pagination, boundary equality, malformed dates, and a force-push causing a live page to contain a previously observed commit.

- [ ] **Step 4: Write failing default-HEAD and file tests**

`resolveDefaultHead` performs:

1. `GET /repos/{owner}/{repo}` to obtain `default_branch`;
2. `GET /repos/{owner}/{repo}/commits/{ref}` to resolve it; and
3. validation of the returned full lowercase commit hash.

`readFile` performs `GET /repos/{owner}/{repo}/contents/{path}` with `ref` equal to the full commit. Accept only `type = file`, `encoding = base64`, and a decoded body no larger than 1 MiB. Reject directories, symlinks, submodules, missing content, invalid base64, declared/decoded size mismatch, and oversized content.

- [ ] **Step 5: Implement transient authentication and error mapping**

Create the shared unauthenticated request function with:

```ts
request.defaults({
  headers: {
    accept: 'application/vnd.github+json',
    'user-agent': '@trustless-ai/tas/0.1',
    'x-github-api-version': '2026-03-10',
  },
});
```

For one call, pass `authorization: Bearer <secret>` in that request's headers only. Never call `.defaults({auth})`, never retain a credential in a Client field, and never attach it to an error. Map:

```text
401                         CREDENTIAL_REQUIRED
403 or 429 with rate limit REPOSITORY_RATE_LIMITED
404                         REPOSITORY_NOT_FOUND or SKILL_NOT_FOUND at the caller boundary
other transport/status      REPOSITORY_FETCH_FAILED
invalid source data         REPOSITORY_FETCH_FAILED
```

Rate-limit details may include a reset timestamp but not response headers that can contain sensitive values.

- [ ] **Step 6: Verify and commit**

```bash
npm test -- test/integration/githubRepositoryClient.test.ts
npm run typecheck
git add src/clients/repository test/fixtures/repository test/integration/githubRepositoryClient.test.ts
git commit -m "feat: add GitHub repository reader"
```

---

## Task 5: Implement Repository Discovery Services

**Files:**

- Create: `src/core/repository/service.ts`
- Create: `test/unit/repository/activity.test.ts`

**Interfaces:**

- Consumes: `RepositoryResolver`, `RepositoryActivityClient`, cursor codec, injected UTC clock.
- Produces: `getRepository` and `listRepositoryActivity` service methods used by MCP.

- [ ] **Step 1: Write failing service tests**

Define:

```ts
export type RepositoryActivityTool =
  | 'repo.issue.list'
  | 'repo.pull_request.list'
  | 'repo.commit.list';

export interface RepositoryActivityInput {
  tool: RepositoryActivityTool;
  since: string;
  limit?: number;
  cursor?: string;
  selector?: ChainSelector;
  credential?: RepositoryCredential;
}

export interface RepositoryActivityResult<T> {
  source: RepositorySource;
  observedAt: string;
  items: readonly T[];
  page: {
    consistency: 'live';
    nextCursor?: string;
  };
}
```

Cover:

- first page defaults to `limit = 50` and `latest` Profile selector;
- valid limits are 1 through 100;
- first page captures the injected clock as `observedAt`;
- `since` is inclusive and cannot be after `observedAt`;
- cursor pages reuse the cursor's `observedAt`, Profile block hash, order, and provider position;
- cursor pages re-resolve the Profile by exact block hash;
- cursor calls reject an explicit selector;
- repeated `since` must equal the cursor's `since`;
- changed repository or tool returns context mismatch;
- empty result is successful; and
- credential objects are absent from result and cursor.

- [ ] **Step 2: Implement repository services**

Expose:

```ts
export interface RepositoryService {
  getRepository(selector: ChainSelector): Promise<RepositorySource>;
  listActivity<T>(input: RepositoryActivityInput): Promise<RepositoryActivityResult<T>>;
}
```

Normalize timestamps to UTC seconds. For initial calls, resolve the requested Profile selector and capture the clock once. For cursor calls, decode first, require `selector` absent, resolve `{kind: 'block_hash', blockHash: cursor.profileBlockHash}`, validate the Repository context, then dispatch to the correct Client method.

Encode a next cursor only when the Client returns a next position. Repository live cursors do not expire locally; provider rejection or source disappearance maps to the applicable Repository error.

- [ ] **Step 3: Verify and commit**

```bash
npm test -- test/unit/repository/activity.test.ts
npm run typecheck
git add src/core/repository/service.ts test/unit/repository/activity.test.ts
git commit -m "feat: resolve repository activity"
```

---

## Task 6: Implement Safe, Commit-Pinned Role Skill Loading

**Files:**

- Create: `src/core/skill/loader.ts`
- Create: `test/fixtures/skill/contributor.md`
- Create: `test/unit/skill/loader.test.ts`

**Interfaces:**

- Consumes: `RepositoryResolver`, `RepositoryContentClient`, and Node.js `createHash` and fatal UTF-8 `TextDecoder`.
- Produces: `RoleSkillLoader.get(input): Promise<RoleSkillGetResult>`.

- [ ] **Step 1: Write failing role and commit tests**

Define:

```ts
export interface RoleSkillGetInput {
  role: string;
  commit?: string;
  credential?: RepositoryCredential;
}
```

Accept `role` only when it matches `[a-z][a-z0-9_-]{0,63}`. Map it without caller-controlled path handling to `skills/roles/${role}.md`. Accept only full 40- or 64-character lowercase hexadecimal commits. Reject uppercase or malformed roles, empty roles, path syntax in a role, abbreviated commits, branches, tags, uppercase commits, and empty commits.

- [ ] **Step 2: Write failing loader tests**

Cover:

- an unpinned call resolves default HEAD once, then reads the derived role path by that full commit;
- an explicit commit never calls `resolveDefaultHead`;
- Repository always comes from the exact Profile resolution;
- the caller cannot supply a Repository or path;
- every returned source contains `repository_url`, full commit, derived path, and SHA-256 digest of the exact decoded bytes;
- content must be non-empty UTF-8 Markdown and returns `media_type = text/markdown; charset=utf-8` and `encoding = utf8`;
- decoded size exactly 1 MiB succeeds and one byte more fails;
- provider file path and commit must equal the requested values;
- requesting a Role Skill does not call Profile Agent membership or role-authorization logic; and
- no content is executed, written to disk, imported, or installed.

- [ ] **Step 3: Implement the Role Skill Loader**

```ts
export interface RoleSkillLoader {
  get(input: RoleSkillGetInput): Promise<RoleSkillGetResult>;
}

export function createRoleSkillLoader(
  repositoryResolver: RepositoryResolver,
  contentClient: RepositoryContentClient,
): RoleSkillLoader;
```

Resolve the Profile-selected Repository first. Derive the path from the validated role, resolve or validate the commit, fetch exact bytes, enforce size and UTF-8 Markdown, and calculate lowercase hexadecimal SHA-256. Do not parse Skill frontmatter and do not inspect linked Repository files.

Map failures to:

```text
SKILL_NOT_FOUND
SKILL_INVALID
SKILL_ROLE_INVALID
SKILL_COMMIT_INVALID
SKILL_FETCH_FAILED
SKILL_CONTENT_TOO_LARGE
```

Preserve `CREDENTIAL_REQUIRED` and `REPOSITORY_RATE_LIMITED` instead of hiding them behind `SKILL_FETCH_FAILED`.

- [ ] **Step 4: Verify and commit**

```bash
npm test -- test/unit/skill
npm run typecheck
git add src/core/skill test/fixtures/skill test/unit/skill
git commit -m "feat: load commit-pinned role skills"
```

---

## Task 7: Register Repository and Role Skill MCP Tools

**Files:**

- Modify: `src/mcp/schemas.ts`
- Create: `src/mcp/repositoryTools.ts`
- Create: `src/mcp/skillTools.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/app/createTasApp.ts`
- Create: `test/unit/mcp/repositoryTools.test.ts`
- Create: `test/unit/mcp/skillTools.test.ts`
- Create: `test/conformance/repositorySkillMcp.test.ts`

**Interfaces:**

- Consumes: Slice A MCP server/result factories, `RepositoryService`, and `RoleSkillLoader`.
- Produces: five new member tools added to the cumulative Slice A inventory. TAWG setup and identity setup inventories do not change.

- [ ] **Step 1: Write strict schema tests**

Register these five new member tools:

```text
repo.get
repo.issue.list
repo.pull_request.list
repo.commit.list
skill.role.get
```

Inputs:

```ts
repo.get = {
  selector?: ChainSelector;
}

repo.*.list = {
  since: string;
  limit?: number;
  cursor?: string;
  selector?: ChainSelector;
  credential?: { type: 'inline'; secret: string };
}

skill.role.get = {
  role: string;
  commit?: string;
  credential?: { type: 'inline'; secret: string };
}
```

The list schema rejects `selector` when `cursor` is present. The credential secret is marked `writeOnly` in generated JSON Schema. All objects reject unknown fields.

- [ ] **Step 2: Write exact output tests**

`repo.get` data:

```text
repository_url
charter
    commit
    path
```

Issue and Pull Request list data:

```text
observed_at
items[]
    id
    number
    title
    state
    author
    created_at
    updated_at
    url
page
    consistency = live
    next_cursor       optional
```

Commit list data:

```text
observed_at
items[]
    commit
    message
    author_name
    author_login
    committed_at
    url
page
    consistency = live
    next_cursor       optional
```

`skill.role.get` data exactly follows `docs/tas/MCP.md`. Repository results include the exact Profile block/version in Resolution Context. Role Skill results include the requested role, Profile context, canonical Repository URL, and immutable commit/path/digest source context.

- [ ] **Step 3: Write behavior and error tests**

Assert:

- all five new tools are read-only, idempotent, and non-destructive;
- `repo.get` never calls GitHub and accepts no credential;
- list and Role Skill tools pass one inline credential then release their reference;
- empty activity is successful, while empty or non-UTF-8 Role Skill content fails with `SKILL_INVALID`;
- schema errors use MCP input errors;
- Repository and Skill execution errors use native tool errors;
- compact text never contains full Role Skill content, cursor, credential, or provider response body; and
- no success/error duplicate status field is introduced.

- [ ] **Step 4: Compose the clients and register tools**

Extend `createTasApp` after the Slice A Profile Resolver is created:

```text
Profile Resolver
    -> Repository Resolver
        -> Repository Service -> GitHub Activity Client
        -> Role Skill Loader  -> GitHub Content Client
```

Use one unauthenticated shared request transport. Pass authorization per call only. Register fixed tools through the same fresh-server factory used for MCP modern/legacy stdio support.

- [ ] **Step 5: Run MCP conformance**

```bash
npm test -- test/unit/mcp/repositoryTools.test.ts test/unit/mcp/skillTools.test.ts test/conformance/repositorySkillMcp.test.ts
npm run typecheck
npm run build
```

Expected: PASS. The member `tools/list` contains the complete Slice A inventory plus these five tools. Identity setup and TAWG setup remain unchanged.

- [ ] **Step 6: Commit MCP integration**

```bash
git add src/mcp src/app/createTasApp.ts test/unit/mcp test/conformance/repositorySkillMcp.test.ts
git commit -m "feat: expose repository discovery and skill loading"
```

---

## Task 8: Add Repository and Role Skill Acceptance Tests and Documentation

**Files:**

- Create: `test/fixtures/repository/activity-window.json`
- Create: `test/fixtures/skill/contributor.md`
- Create: `test/conformance/repositorySkillFixtures.test.ts`
- Modify: `README.md`
- Modify: `docs/PROJECT_STRUCTURE.md`
- Modify: `docs/tas/IMPLEMENTATION.md`

**Interfaces:**

- Consumes: the complete Repository and Role Skill service/MCP surface.
- Produces: release evidence and documentation for the next phase.

- [ ] **Step 1: Add immutable end-to-end fixtures**

Include:

- a full Profile source and canonical GitHub Repository;
- an inclusive `since`/`observed_at` activity window;
- mixed Issues and Pull Requests using opaque GitHub `node_id` values and decimal-string issue numbers;
- full 40-character commit hashes;
- a valid UTF-8 `skills/roles/contributor.md` Role Skill; and
- expected SHA-256 digests.

Fixtures must contain no real token, private repository locator, RPC endpoint, local path, shortened hash, or executable script.

- [ ] **Step 2: Test the full flows**

Exercise:

```text
Profile -> repo.get
Profile -> GitHub -> repo.issue.list -> next cursor -> next page
Profile -> GitHub -> repo.pull_request.list
Profile -> GitHub default branch -> repo.commit.list
Profile -> GitHub default HEAD -> skills/roles/contributor.md -> skill.role.get
Profile -> returned commit -> skills/roles/evaluator.md -> skill.role.get
```

Confirm cursor calls stay on the first Profile block and observation window even when the mocked latest Profile and clock advance. Confirm a later unpinned Role Skill call may resolve a newer HEAD while a pinned Role Skill call keeps its explicit commit.

- [ ] **Step 3: Update user-facing documentation**

Document:

- the complete canonical GitHub URL returned by `repo.get`;
- optional per-call GitHub credential behavior;
- the four Repository discovery tools and their deliberate exclusions;
- newest-first inclusive polling and Agent-side deduplication;
- the unpinned-versus-pinned `skill.role.get` sequence and deterministic role path;
- the fixed 1 MiB decoded content limit;
- the cumulative member inventory (Slice A groups plus five new tools); and
- the fact that TAS does not validate role ownership or retain the cursor or active Role Skill commit.

Update `docs/PROJECT_STRUCTURE.md` with the implemented Repository and Role Skill modules. Mark the Repository/Role Skill part of Slice C complete in `docs/tas/IMPLEMENTATION.md` only after the full acceptance suite passes.

- [ ] **Step 4: Run the clean acceptance suite**

```bash
npm ci
npm run typecheck
npm test
npm run test:coverage
npm run build
npm pack --dry-run
```

Require at least 80% statement, branch, function, and line coverage for:

```text
src/core/repository
src/core/skill
src/clients/repository
```

The dry-run package must exclude tests, fixtures, credentials, local configuration, Go sources, and coverage output.

- [ ] **Step 5: Run security and repository checks**

```bash
git diff --check
rg -n "Bearer |gh[pousr]_|github_pat_|private.?key|rpc.?url" test dist README.md
git status --short
```

Review every match. Public field names, deliberately fake redaction fixtures, and explanatory security text are acceptable; usable credential values are not.

- [ ] **Step 6: Commit the completed phase**

```bash
git add README.md docs/PROJECT_STRUCTURE.md docs/tas/IMPLEMENTATION.md test/fixtures/repository test/fixtures/skill test/conformance/repositorySkillFixtures.test.ts
git commit -m "docs: complete TAS repository and role skill phase"
```

---

## Repository and Role Skill Completion Criteria

This part of Slice C is complete only when all statements below are true:

1. All Slice A acceptance tests still pass and the MCP stdio behavior is unchanged except for the five added tools.
2. Member `tools/list` contains the complete Slice A inventory plus four Repository and one Role Skill tool; the shared cumulative inventory fixture accounts for every tool exactly once.
3. No caller can select a Repository other than the one resolved from the Profile.
4. `repo.get` performs no provider request and returns the complete canonical GitHub URL plus the Profile-anchored Charter commit/path.
5. Issue and Pull Request discovery is based on `created_at`; commit discovery is based on `committed_at` on the provider's default branch.
6. Activity boundaries are inclusive, results are newest first, and cursors retain Repository, exact Profile block, `since`, `observed_at`, order, and provider position without server-side state.
7. An unpinned Role Skill load resolves a full default-branch HEAD before reading, while an explicit full commit is used unchanged.
8. `skill.role.get` derives `skills/roles/<role>.md`, cannot accept an arbitrary path or Repository, cannot return more than 1 MiB decoded content, and cannot execute/install returned content.
9. Role Skill content is non-empty UTF-8 Markdown with an exact SHA-256 digest; TAS does not parse frontmatter or validate role ownership.
10. GitHub credentials are attached to one request only and never appear in logs, errors, cursors, results, fixtures, snapshots, or retained Client state.
11. TAS exposes no general Git, filesystem, Issue mutation, Pull Request mutation, review, approval, or merge operation.
12. The existing Go scaffold and unrelated user changes remain intact.
