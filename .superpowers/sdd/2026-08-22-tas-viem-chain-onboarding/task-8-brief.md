### Task 8: Prove Identity-to-TAWG-to-Member Onboarding

**Files:**

- Create: `test/fixtures/contracts/identityRegistry.ts`
- Create: `test/fixtures/contracts/tawgProfile.ts`
- Create: `test/integration/chainOnboarding.test.ts`
- Create: `test/conformance/sliceAPackage.test.ts`
- Modify: `README.md`
- Modify: `docs/PROJECT_STRUCTURE.md`
- Modify: `docs/tas/IMPLEMENTATION.md`

**Interfaces:**

- Consumes: complete Slice A1 and A2 tool surfaces.
- Produces: Slice A onboarding evidence for identity setup, TAWG setup, and member TAS plus package gates.

- [ ] **Step 1: Add deterministic contract fixtures**

The harness deploys the fixture chain and contracts and provisions test funds, but it does not create an Agent wallet, register an ERC-8004 identity, register Profile membership, or submit a business transaction for the Agent. The Agent-side test driver creates or loads an ephemeral fixture-only wallet after startup and keeps its key outside TAS. The fixture must implement ERC-8004 `register`, `ownerOf`, `getAgentWallet`, wallet establishment, Profile `registerAgent`, and the Profile reads used by TAS. Use an Agent ID larger than JavaScript's safe integer.

- [ ] **Step 2: Exercise pre-TAWG identity setup**

Through MCP only:

```text
receive only the chain ID and Identity Registry address
start identity-setup TAS
skill.tas.get
tools/list -> TAS Skill plus complete generated viem groups, with no Profile or later-phase tools
Agent-side driver creates or loads its own wallet
workflow.chain.wallet.write_contract -> ERC-8004 register
workflow.chain.public.get_transaction_receipt -> Agent-owned polling until the registration receipt exposes the Registered agentId
workflow.chain.public.read_contract -> ownerOf and getAgentWallet
workflow.chain.wallet.write_contract -> establish Registry wallet when fixture requires it
Agent-side driver records the canonical-decimal agentId
stop identity-setup TAS
```

Pass the credential inline on each Wallet call. Assert TAS retains no key or Account and no Profile service is constructed. Restart identity setup and have the Agent reconcile the existing registration through Public Actions rather than submitting an automatic duplicate.

- [ ] **Step 3: Exercise TAWG setup and member startup**

After the harness uses only the public Evaluator `agentId` to deploy the Profile/TAWG fixture, continue through MCP:

```text
receive the TAWG locator
start TAWG-setup TAS
skill.tas.get
profile.get -> immutable Identity Registry and current Profile state
workflow.chain.wallet.write_contract -> Profile registerAgent
profile.get_agent -> permanent member and exact verifier/Data/wallet
Agent-side driver writes the member configuration containing the returned agentId
stop TAWG-setup TAS
start member TAS with returned decimal agentId
tools/list -> fixed tools plus complete viem groups
```

The Agent-side test driver supplies its own ephemeral key inline per Wallet call. TAS never opens a credential file. Retain and use transaction hashes in the Agent-side path; do not assert a TAS retry registry. Also exercise a second Agent that receives the TAWG locator first, discovers the immutable Identity Registry through `profile.get`, registers its own ERC-8004 identity from TAWG setup, then registers itself into the Profile.

- [ ] **Step 4: Exercise existing identity and failure paths**

Cover existing nonmember registration, already-registered member, zero Registry wallet, wallet mismatch, invalid verifier contract, reverted Profile registration, unknown transaction outcome, TAS restart followed by Agent-side chain reconciliation, and no automatic duplicate submission.

- [ ] **Step 5: Run package and security gates**

Require packaged Manifests to match `manifest:check`. Scan stdout, stderr, errors, snapshots, built files, and package contents for fixture secrets and RPC URLs. Require all generated Wallet tools to construct and release one Account per call.

- [ ] **Step 6: Update documentation and run acceptance**

Document the actual Slice A tool inventories, Manifest regeneration command, identity-setup/TAWG-setup/member path, and Agent-owned wallet, `agentId`, and replay responsibilities. Mark Slice A complete only after:

```bash
npm ci
npm run manifest:check
npm run typecheck
npm test
npm run test:coverage
npm run build
npm pack --dry-run
git diff --check
```

- [ ] **Step 7: Commit Slice A completion**

```bash
git add test/fixtures/contracts test/integration/chainOnboarding.test.ts test/conformance/sliceAPackage.test.ts README.md docs/PROJECT_STRUCTURE.md docs/tas/IMPLEMENTATION.md
git commit -m "feat: complete TAS Slice A onboarding"
```

---

## Slice A2 Completion Criteria

1. Identical dependency inputs generate byte-identical Manifests and report.
2. Every viem Public/Wallet Action is included or has one reviewed structural exclusion.
3. Startup rejects artifact, package version, package integrity, binding, and schema mismatch.
4. Identity setup contains only `skill.tas.get` plus the complete reviewed viem groups; it exposes and constructs no Profile, Repository, Role Skill, Workflow SDK, DA, Chat, or Proof Provider capability.
5. At the Slice A gate, TAWG setup and member inventories contain their Slice A1 fixed tools plus the complete reviewed viem groups. Later slices update the shared cumulative member inventory fixture while TAWG setup remains restricted to onboarding capabilities.
6. The configured chain, transport, and operation-scoped Account cannot be overridden by a caller.
7. An Agent creates or loads its own wallet, registers its own ERC-8004 identity in identity setup, records its own canonical-decimal `agentId`, and passes its credential inline for each Wallet call.
8. TAWG setup can also register an identity after resolving the immutable Registry, can self-register or update Profile membership, and member Wallet calls require the current Authentication Wallet.
9. The complete identity-to-TAWG-to-member path succeeds using decimal-string Agent IDs and source-native transaction hashes without harness-owned Agent transactions.
10. TAS performs no hidden side-effect replay and stores no key, Account, Agent ID discovery state, business-operation ID, or retry journal.
11. stdout remains MCP-only and no secret or authenticated RPC URL appears in results, errors, logs, fixtures shipped to npm, or package contents.
12. `npm ci`, Manifest check, type checking, all tests, coverage, build, and package dry-run pass.
