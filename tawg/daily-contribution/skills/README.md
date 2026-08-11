# Daily Contribution TAWG Skills

Agent skills for operating the Daily Contribution Trustless Agent Working Group.

## Overview

These skills enable an Assist Agent to:
- Process contribution messages from Telegram/Discord
- Store and anchor contributions on-chain
- Execute daily cutoff and produce verifiable summaries
- Enumerate and verify frozen contribution snapshots

## Skills

### handle-mention.md
Detects and processes mentions of the Assist Agent in Telegram/Discord groups. Extracts contribution content, deduplicates, and prepares for storage.

### process-contribution.md
Processes a validated contribution by:
- Creating a content-addressed artifact
- Storing preimage in DA
- Computing digest
- Anchoring through the workflow contract

### daily-cutoff.md
Executes the daily cutoff procedure:
- Freezes contributionCount and contributionRoot on-chain
- Creates immutable snapshot for enumeration
- Prepares for aggregation phase

### enumerate-verify.md
Enumerates all contributions from the frozen snapshot:
- Iterates through artifact references
- Fetches DA preimages
- Verifies every digest matches
- Detects gaps or inconsistencies

### aggregate-summary.md
Produces the final daily summary:
- Aggregates all verified contributions
- Generates summary report
- Produces required signature/attestation/proof
- Publishes through TAS

## Assist Agent Setup

The Assist Agent requires:

### 1. ERC-8004 Identity
Register the Assist Agent identity (see `tas-skills/setup/register-agent.md`)

### 2. TAS Connection
Connect to TAS via MCP (see `tas-skills/setup/connect-tas.md`)

### 3. Role in TAWG
The Assist Agent must be registered in the DailyContributionProfile contract with appropriate permissions.

### 4. Integration Access
- Telegram bot token and group configuration
- Discord bot token and channel configuration

### 5. Scheduler
Daily cutoff trigger (e.g., cron job at 00:00 UTC):
```bash
0 0 * * * /path/to/trigger-daily-cutoff.sh
```

## Skill Loading

Agent Hosts should load these skills and make them available to the Assist Agent:

```yaml
# Example Agent Host configuration
agent:
  identity:
    chainId: 11155111
    registry: "0x..."
    agentId: 1
  
  skills:
    - path: "tawg/daily-contribution/skills/handle-mention.md"
    - path: "tawg/daily-contribution/skills/process-contribution.md"
    - path: "tawg/daily-contribution/skills/daily-cutoff.md"
    - path: "tawg/daily-contribution/skills/enumerate-verify.md"
    - path: "tawg/daily-contribution/skills/aggregate-summary.md"
  
  triggers:
    - event: "message.received"
      skill: "handle-mention"
    - schedule: "0 0 * * *"
      skill: "daily-cutoff"
```

## Flow Diagram

```
┌─────────────────────────────────────────────────────────┐
│              Continuous: Handle Contributions            │
└─────────────────────────────────────────────────────────┘
  Mention detected (Telegram/Discord)
           ↓
  handle-mention.md
           ↓
  process-contribution.md
           ↓
  Contribution anchored on-chain


┌─────────────────────────────────────────────────────────┐
│              Daily: Cutoff and Aggregation               │
└─────────────────────────────────────────────────────────┘
  00:00 UTC trigger
           ↓
  daily-cutoff.md
           ↓
  enumerate-verify.md
           ↓
  aggregate-summary.md
           ↓
  Summary published
```

## Error Handling

Each skill should handle:
- **Transient failures** - Retry with exponential backoff
- **DA unavailability** - Queue for later retry
- **Chain reorgs** - Re-verify anchor status
- **Invalid contributions** - Log and skip gracefully

## Monitoring

Recommended monitoring:
- Contribution processing latency
- DA storage success rate
- Daily cutoff completion time
- Verification failure rate
- Summary publication status

## Testing

Test scenarios:
1. Single contribution flow
2. Multiple concurrent contributions
3. Daily cutoff with various contribution counts
4. DA failures and recovery
5. Chain reorg during cutoff
6. Gap detection in frozen snapshot
