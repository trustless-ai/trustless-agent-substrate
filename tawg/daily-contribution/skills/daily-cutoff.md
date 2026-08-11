# Daily Cutoff Skill

## Purpose
Execute the daily cutoff procedure to freeze the contribution snapshot on-chain, creating an immutable, enumerable input set for aggregation.

## Trigger
- **Schedule**: Daily at 00:00 UTC (or configured cutoff time)
- **Source**: Agent Host scheduler (cron, timer, etc.)

## Input
```json
{
  "cutoffDate": "2026-08-11",
  "cutoffTimestamp": 1723334400
}
```

## Process

### 1. Pre-cutoff checks
Verify system is ready for cutoff:
```javascript
// Check pending contributions
const pending = await localDb.contributions.count({ status: "pending" })
if (pending > threshold) {
  await waitForPendingWithTimeout(maxWait)
}

// Check chain connectivity
const blockNumber = await chain.getBlockNumber()
const latency = await chain.ping()
assert(latency < maxLatency)
```

### 2. Query current state
Get the current contribution count before freeze:
```javascript
const currentCount = await workflow.getContributionCount()
const lastContributionHash = await workflow.getLastContributionHash()

console.log(`Pre-cutoff: ${currentCount} contributions`)
```

### 3. Freeze on-chain state
Call the workflow contract to freeze the snapshot:
```javascript
// DailyContributionWorkflow.freezeDailySnapshot()
const tx = await workflow.freezeDailySnapshot(
  cutoffDate,
  cutoffTimestamp
)

const receipt = await workflow.waitForTx(tx)
```

This records on-chain:
- `contributionCount` - Total contributions in this period
- `contributionRoot` - Merkle root or hash-chain head
- `cutoffTimestamp` - When the freeze occurred
- `cutoffBlock` - Block number of the freeze

### 4. Verify freeze succeeded
```javascript
const snapshot = await workflow.getSnapshot(cutoffDate)

assert(snapshot.isFrozen === true)
assert(snapshot.contributionCount === currentCount)
assert(snapshot.cutoffTimestamp === cutoffTimestamp)

console.log(`Frozen snapshot: ${snapshot.contributionCount} contributions`)
console.log(`Root: ${snapshot.contributionRoot}`)
console.log(`Block: ${snapshot.cutoffBlock}`)
```

### 5. Record freeze locally
Store the freeze event for tracking:
```javascript
await localDb.snapshots.insert({
  date: cutoffDate,
  contributionCount: snapshot.contributionCount,
  contributionRoot: snapshot.contributionRoot,
  cutoffTimestamp,
  cutoffBlock: snapshot.cutoffBlock,
  freezeTx: receipt.transactionHash,
  status: "frozen"
})
```

### 6. Trigger enumeration
Invoke the next skill in the chain:
```javascript
await invokeSkill('enumerate-verify.md', {
  snapshotDate: cutoffDate,
  contributionCount: snapshot.contributionCount,
  contributionRoot: snapshot.contributionRoot
})
```

## Output
```json
{
  "status": "frozen",
  "date": "2026-08-11",
  "snapshot": {
    "contributionCount": 42,
    "contributionRoot": "0x1234...",
    "cutoffTimestamp": 1723334400,
    "cutoffBlock": 12345678,
    "freezeTx": "0xabcd..."
  }
}
```

## Error Handling

### Pending contributions timeout
```javascript
if (pendingCount > 0 && timeoutReached) {
  // Log warning but proceed
  console.warn(`Proceeding with ${pendingCount} contributions still pending`)
  
  // Optionally notify in group
  await sendNotification(`⚠️ Daily cutoff proceeding with ${pendingCount} pending contributions`)
}
```

### Chain connectivity issues
```javascript
if (chainError) {
  // Retry with exponential backoff
  await retryWithBackoff(freezeSnapshot, {
    maxAttempts: 5,
    initialDelay: 5000,
    backoffMultiplier: 2
  })
  
  // If all retries fail, alert and skip this cutoff
  await sendAlert('CRITICAL: Daily cutoff failed - chain unreachable')
  return { status: "failed", reason: "chain_unavailable" }
}
```

### Transaction failure
```javascript
if (txError) {
  // Check if already frozen (idempotent)
  const existing = await workflow.getSnapshot(cutoffDate)
  if (existing.isFrozen) {
    console.log('Snapshot already frozen')
    return { status: "already_frozen", snapshot: existing }
  }
  
  // Retry with higher gas
  await retryWithHigherGas(freezeSnapshot)
}
```

### Chain reorg
```javascript
// Monitor freeze transaction for reorgs
await monitorTxConfirmation(receipt.transactionHash, {
  requiredConfirmations: 12,
  onReorg: async () => {
    console.warn('Reorg detected, re-verifying freeze status')
    await verifyFreezeStatus(cutoffDate)
  }
})
```

## Notification
Send status updates to configured channels:

**On freeze:**
```
🔒 Daily cutoff executed
   Date: 2026-08-11
   Contributions: 42
   Block: 12345678
   TX: 0xabcd...
   
Next: Enumeration and aggregation
```

**On failure:**
```
❌ Daily cutoff failed
   Date: 2026-08-11
   Reason: [error]
   Status: Will retry
```

## Configuration
```yaml
daily_cutoff:
  schedule:
    time: "00:00"
    timezone: "UTC"
  
  pre_checks:
    wait_for_pending: true
    pending_timeout: 300s  # 5 minutes
    pending_threshold: 10
    max_chain_latency: 2s
  
  freeze:
    gas_multiplier: 1.5
    confirmation_blocks: 12
    retry_attempts: 5
    retry_backoff: "exponential"
  
  notifications:
    telegram: true
    discord: true
    webhook: "https://..."
```

## Testing
1. Normal cutoff with no pending contributions
2. Cutoff with pending contributions (timeout)
3. Chain connectivity issues during freeze
4. Transaction failure and retry
5. Already frozen (idempotency)
6. Chain reorg after freeze
7. Multiple cutoffs in quick succession
8. Cutoff at exactly midnight (timing edge case)

## Monitoring
Track these metrics:
- Cutoff execution time
- Pending contribution count at cutoff
- Freeze transaction gas used
- Time from freeze to enumeration start
- Failed cutoffs (alerts)
