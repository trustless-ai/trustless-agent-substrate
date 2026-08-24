# Daily Contribution TAWG

## Overview

The Daily Contribution Trustless Agent Working Group (TAWG) is the first vertical slice implementation for TAS v0.1. It demonstrates how independently operated Agents can:

- Receive human coordination messages from Telegram/Discord
- Process and persist contribution artifacts
- Anchor contributions on-chain
- Execute daily cutoff and produce verifiable aggregated results

## Architecture

This TAWG is operated by an **Assist Agent** that:
1. Monitors Telegram/Discord for mentions
2. Interprets and deduplicates contributions
3. Writes complete contribution artifacts to a TAWG-declared source
4. Commits immutable locators and digests through the ERC workflow
5. Performs daily cutoff, enumeration, and aggregation
6. Produces verifiable daily summaries

## Components

### contracts/
Solidity contracts extending agent-ercs base implementations:
- **DailyContributionProfile.sol** - Profile contract defining Agents, Data, and Workflow
- **DailyContributionWorkflow.sol** - Workflow contract managing contribution flow and daily cutoff

### skills/
Agent skills for operating this TAWG:
- Handling mentions and contribution submission
- Processing and storing contributions
- Executing daily cutoff
- Enumerating and verifying frozen snapshots
- Aggregating and producing daily summaries

### deployments/
Deployment records and addresses for different networks.

## Workflow

### Contribution Flow

```
Human mentions Assist Agent in group
        ↓
TAS delivers notification via MCP
        ↓
Assist Agent interprets contribution
        ↓
Artifact written to a TAWG-declared source
        ↓
Digest anchored on-chain
        ↓
Assist Agent acknowledges
```

### Daily Cutoff Flow

```
Daily cutoff triggered (by Agent Host scheduler)
        ↓
Freeze contributionCount + contributionRoot on-chain
        ↓
Enumerate all artifact references from frozen snapshot
        ↓
Fetch and verify every committed artifact
        ↓
Aggregate contributions
        ↓
Produce signed/attested summary
        ↓
Complete workflow and publish
```

## Key Design Decisions

### Frozen Enumerable Input
The daily cutoff freezes an on-chain state (contributionCount, contributionRoot) that makes the input set:
- **Enumerable** - Can iterate through all contributions
- **Verifiable** - Every digest can be checked against the retrieved artifact bytes
- **Immutable** - Snapshot cannot be altered after freeze

### Contributor Identity
- Ordinary human contributors **do not need ERC-8004 identities**
- Artifacts retain stable platform/group/account identity
- Profile-bound Agent contributors may include their ERC-8004 identity

### Verification Roadmap
Initial assurance: **Assist Agent signature or attestation**

Future progression:
- Phase 1: Attestation (signed judgment)
- Phase 2: TEE (attested inference)
- Phase 3: ZK (cryptographic proof)

Different stages may use different verification mechanisms based on requirements.

## Getting Started

### Prerequisites
- TAS server running and connected
- Registered ERC-8004 Assist Agent identity
- Deployed DailyContributionProfile and DailyContributionWorkflow contracts
- Telegram/Discord bot configured
- Agent Host with daily scheduler capability

### Deployment
```bash
# Deploy contracts
cd tawg/daily-contribution
./deploy.sh --network sepolia

# Configure Assist Agent
# See skills/README.md for setup instructions
```

### Running
The Assist Agent needs:
1. MCP connection to TAS
2. Access to Telegram/Discord integrations
3. Daily scheduler trigger (e.g., cron job at 00:00 UTC)
4. Skills loaded from `skills/` directory

## References

- [System Design](../../docs/DESIGN.md)
- [TAWG Design](../../docs/TAWG.md)
- [TAS Design](../../docs/TAS.md)
- [ERC-8004: Agent Identity](https://github.com/trustless-ai/agent-ercs)
- [ERC-8301: Workflow Protocol](https://github.com/trustless-ai/agent-ercs)
