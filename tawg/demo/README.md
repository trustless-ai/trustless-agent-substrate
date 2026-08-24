# Demo TAWG

This directory is a minimal, standalone TAWG Repository example. To start another Repository from it, copy the **contents** of `tawg/demo/` into the new Repository root. Do not copy the enclosing `demo/` directory: `charter/`, `contracts/`, `skills/`, `knowledge/`, and `data/` are canonical root paths.

## Roles and operating flow

The Demo has two roles. Every registered Profile member is a Contributor by default. One immutable ERC-8004 `agentId` is the Evaluator; the identity cannot be replaced by this Workflow.

The Evaluator's current ERC-8004 Authentication Wallet opens the initial round. During an open round, Contributors put content in the selected DA backend and submit the resulting immutable reference plus the digest of the exact bytes. The Workflow derives a contribution ID from its own address, the round, the Contributor Agent ID, and that digest. The Evaluator inspects the DA bytes, scores each contribution at most once, settles the round, and either opens a linked next round or permanently completes the Demo. Contract reads, rather than chat notifications or Skills, determine the current state.

```text
open round -> contribute -> score each accepted contribution -> settle
                                                        -> open next round
                                                        -> complete permanently
```

Every accepted reply is anchored through ERC-8301 storage. The local `PassThroughVerifier` marks only deliberately proof-free Demo operations as proven. It proves neither the quality of a contribution nor the correctness of a score, and it is not a Proof Provider. Settlement records exact per-round and cumulative points. It iterates the round's authoritative contribution list, which is useful for a readable example but is not a scalable production distribution design.

## Repository roots and TAS access

- `charter/` fixes the Demo goal and role model.
- `knowledge/` holds evolving shared context.
- `data/` is the Git-backed DA root when that client is selected; other DA clients may return another immutable reference encoding.
- `contracts/Workflow.sol` is the business source of truth and `contracts/Workflow.metadata.json` is its generated compiler metadata.
- `skills/` contains general and role-specific Agent guidance.
- `vendor/` contains only the two reviewed upstream interfaces needed for a clean build.

Agents use general TAS namespaces, not a Demo-specific API: `profile.*` for discovery and identity, `repo.*` for Repository queries, `workflow.source.*` for verified source, generated `workflow.<agent-sdk namespace>.*` and `workflow.chain.*` operations for contract reads and writes, `workflow.da.*` for DA, plus `chat.*` and `proof_provider.*` when a TAWG uses those capabilities.

After member setup, an Agent loads guidance in four layers: `tas.get`, `collaboration.get`, `tawg.get`, then `role.get(role)` for every applicable role. TAS handles setup and access; the Collaboration Skill handles generic human-readable coordination and approvals; the Demo Root Skill defines shared Demo policy; Contributor and Evaluator Role Skills define exact business actions. Verified Solidity and current chain state remain authoritative.

## Reproducible source and build

`contracts/Workflow.sol` is compiled with the explicitly pinned settings in `foundry.toml`: Solidity 0.8.30, optimizer 200, Cancun, no IR pipeline, normal IPFS/CBOR bytecode metadata, no FFI, and only the checked `remappings.txt`. `contracts/Workflow.metadata.json` is the compiler artifact's exact `rawMetadata` string plus one line feed. It is generated and must never be edited independently. Dependency revision and SHA-256 provenance remain authoritative in `vendor/agent-ercs/PROVENANCE.json`; compiler metadata records their exact source Keccak hashes.

Build and test without network dependency resolution:

```bash
forge build --offline --force
forge test --offline --force
```

The Workflow metadata binds `Workflow.sol` and its imported interfaces. It does not by itself bind the separately deployed `PassThroughVerifier`; deployment tests compare the verifier's deployed runtime code with the committed helper implementation and confirm the Workflow reference.

## Deterministic local deployment fixture

Deployment needs an ERC-8004 Identity Registry address and an existing Evaluator `agentId` whose current Authentication Wallet is nonzero. `script/Deploy.s.sol` deploys a one-shot `DemoDeployer`, whose child CREATE order is fixed:

1. nonce 1 deploys `PassThroughVerifier`;
2. nonce 2 deploys `Workflow` with the predicted nonce-3 Profile address; and
3. nonce 3 deploys `DemoProfileFixture`, which points back to the Workflow.

The factory rejects a registry without code, a missing Evaluator identity, an unset Authentication Wallet, an address-prediction mismatch, or a second deployment. It also checks the final cross-references and deployed code.

For a local chain, invoke the Foundry wrapper with the Registry and full ERC-8004 Evaluator Agent ID:

```bash
forge script script/Deploy.s.sol:Deploy \
  --sig "run(address,uint256)" <identity-registry> <evaluator-agent-id> \
  --rpc-url <local-rpc-url> --broadcast
```

`DemoProfileFixture` is deliberately narrow test/development infrastructure. It is not the future TAWG Profile reference implementation and does not claim its ERC-165 interface. It starts with no members and never pre-registers or impersonates an Agent. The Evaluator must call `registerSelf` from its current ERC-8004 Authentication Wallet, supply a deployed Agent verifier, and then open the initial round itself. Other Agents join through the same self-registration boundary.
