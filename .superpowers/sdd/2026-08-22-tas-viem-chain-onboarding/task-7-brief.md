### Task 7: Register Generated Chain Tools in All Three TAS Phases

**Files:**

- Create: `src/mcp/generatedChainTools.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/app/createTasApp.ts`
- Modify: `src/app/main.ts`
- Create: `test/conformance/generatedChainTools.test.ts`
- Modify: `test/conformance/fixedToolInventory.test.ts`
- Create: `test/conformance/toolInventory.expected.ts`

**Interfaces:**

- Consumes: Manifest Registry and Chain Service.
- Produces: complete `workflow.chain.public.*` and `workflow.chain.wallet.*` MCP groups.

- [ ] **Step 1: Write failing inventory conformance tests**

For identity setup, require exactly:

```text
skill.tas.get
every included viem-public Manifest name
every included viem-wallet Manifest name
```

Explicitly reject `profile.get`, `profile.get_agent`, Repository, Role Skill, generated agent-sdk Workflow, DA, Chat, and Proof Provider tools.

For TAWG setup and member mode, require:

```text
skill.tas.get
profile.get
profile.get_agent
every included viem-public Manifest name
every included viem-wallet Manifest name
```

At the Slice A gate, reject any extra Repository, Role Skill, agent-sdk Workflow, DA, Chat, or Proof Provider tool. Require `tools/list` to remain stable for the process lifetime even when no credential is available. Composition selects only whole reviewed Manifest groups; it has no phase-specific per-action allowlist.

`toolInventory.expected.ts` is the one cumulative inventory fixture for the repository. At the Slice A commit it contains only the groups above. Every later slice that adds a reviewed tool group must update this same fixture and its assertions rather than preserving a permanently exact Slice A production inventory test. Identity-setup expectations remain permanently exact because later slices add no capability to that phase.

- [ ] **Step 2: Write failing schema and annotation tests**

For every generated tool, compare MCP `inputSchema`, `outputSchema`, description, and annotations with its accepted Manifest. Wallet tools expose one optional write-only inline credential field so TAS can return `CREDENTIAL_REQUIRED`; Public tools expose none.

- [ ] **Step 3: Implement mechanical tool registration**

Iterate the accepted whole groups, register each exact schema, and dispatch by manifest name to `ChainService.invoke`. Do not add per-name switch cases. Return native TAS context and source result/error envelopes.

Production startup must establish the trust boundary before importing viem. Replace the static `main.ts → createTasApp` path with a small preflight path that imports only the bundled validator, generated artifact-digest constant, and shared package-tree scanner. After validation succeeds, dynamically import `createTasApp`; only that post-gate graph may load `loadConfig`, `ProfileReader`, viem, or Task 6 action bindings. Tests that directly import internal modules are not evidence for this production ordering, so add a conformance fixture that detects any pre-gate viem load.

- [ ] **Step 4: Verify and commit**

```bash
npm test -- test/conformance/generatedChainTools.test.ts test/conformance/fixedToolInventory.test.ts
npm run typecheck
git add src/mcp/generatedChainTools.ts src/mcp/server.ts src/app/createTasApp.ts src/app/main.ts test/conformance
git commit -m "feat: expose generated viem Chain tools"
```

---
