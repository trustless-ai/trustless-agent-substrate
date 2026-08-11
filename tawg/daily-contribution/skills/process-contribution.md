# Process Contribution Skill

## Purpose
Process a validated contribution by creating a content-addressed artifact, storing it in DA, and anchoring the digest on-chain.

## Trigger
- Invoked by `handle-mention.md` after validation
- Or directly by other contribution sources

## Input
```json
{
  "contributionId": "contrib_uuid",
  "source": {
    "platform": "telegram",
    "groupId": "group_xyz",
    "messageId": "msg_abc123",
    "timestamp": "2026-08-11T10:30:00Z"
  },
  "author": {
    "platformId": "user_456",
    "username": "contributor_alice",
    "agentIdentity": null
  },
  "content": {
    "text": "I implemented the ERC-8301 recompute function"
  }
}
```

## Process

### 1. Build canonical artifact
Create a deterministic, content-addressed artifact:

```json
{
  "version": "1.0",
  "contributionId": "contrib_uuid",
  "timestamp": "2026-08-11T10:30:00Z",
  "source": {
    "platform": "telegram",
    "groupId": "group_xyz",
    "groupName": "TrustlessAI Contributors",
    "messageId": "msg_abc123",
    "messageUrl": "https://t.me/..."
  },
  "author": {
    "platformId": "user_456",
    "username": "contributor_alice",
    "displayName": "Alice",
    "agentIdentity": null
  },
  "content": {
    "text": "I implemented the ERC-8301 recompute function",
    "contentType": "text/plain"
  },
  "metadata": {
    "processedBy": {
      "chainId": 11155111,
      "registry": "0x...",
      "agentId": 1
    },
    "processedAt": "2026-08-11T10:30:05Z"
  }
}
```

### 2. Compute content hash
```javascript
const artifactJson = JSON.stringify(artifact, null, 0)  // Canonical JSON
const artifactBytes = Buffer.from(artifactJson, 'utf8')
const contentHash = keccak256(artifactBytes)  // 0x1234...
```

### 3. Store in DA
```javascript
const daClient = await mcp.call('da.getClient')
const cid = await daClient.put(artifactBytes)
// Returns: bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi
```

### 4. Prepare on-chain record
```javascript
const contributionRecord = {
  contributionId: "contrib_uuid",
  contentHash: "0x1234...",
  daReference: "bafybeigdyrzt...",
  author: {
    platformId: "user_456",
    username: "contributor_alice"
  },
  timestamp: 1723374600
}
```

### 5. Anchor via workflow
Use ERC-8301 workflow to record the contribution:

```javascript
// Submit to DailyContributionWorkflow
const tx = await workflow.submitContribution(
  contributionRecord.contributionId,
  contributionRecord.contentHash,
  contributionRecord.daReference,
  contributionRecord.author,
  contributionRecord.timestamp
)

// Wait for confirmation
const receipt = await workflow.waitForTx(tx)
```

### 6. Verify on-chain
Confirm the contribution was recorded:
```javascript
const onChainHash = await workflow.getContributionHash(contributionId)
assert(onChainHash === contentHash)
```

### 7. Update local index
Track for daily cutoff enumeration:
```javascript
await localDb.contributions.insert({
  contributionId,
  contentHash,
  daReference,
  anchorTx: receipt.transactionHash,
  anchorBlock: receipt.blockNumber,
  status: "anchored"
})
```

## Output
```json
{
  "status": "anchored",
  "contributionId": "contrib_uuid",
  "contentHash": "0x1234...",
  "daReference": "bafybeigdyrzt...",
  "anchorTx": "0xabcd...",
  "anchorBlock": 12345678
}
```

## Error Handling

### DA storage failure
```javascript
if (daError) {
  // Queue for retry
  await retryQueue.add({
    operation: "store_artifact",
    artifact: artifactBytes,
    contributionId,
    retryCount: 0,
    maxRetries: 5
  })
  
  return { status: "queued", contributionId }
}
```

### Chain transaction failure
```javascript
if (txError) {
  // Check if already anchored (idempotent)
  const existing = await workflow.getContributionHash(contributionId)
  if (existing && existing === contentHash) {
    return { status: "already_anchored", contributionId }
  }
  
  // Otherwise retry with higher gas
  retryWithHigherGas()
}
```

### Chain reorg
Monitor for reorgs:
```javascript
if (anchorBlock < currentBlock - 64) {
  // Confirmed
} else {
  // Monitor and re-verify if reorg detected
}
```

## Integration with handle-mention

After anchoring succeeds, reply in group:
```
✅ Contribution anchored on-chain
   ID: contrib_abc123
   TX: 0xabcd...
   Block: 12345678
```

## Artifact Continuity (Optional)

For continuity tracking, artifacts may include:
```json
{
  "sequence": 42,
  "previousHash": "0xprev...",
  ...
}
```

This enables gap detection and hash-linked history traversal.

## Configuration
```yaml
contribution_processing:
  da:
    provider: "local-fs"  # or "ipfs", "arweave", "celestia"
    timeout: 30s
    retries: 5
  
  chain:
    confirmation_blocks: 3
    gas_multiplier: 1.2
    max_gas_price: "50gwei"
  
  retry:
    max_attempts: 5
    backoff: "exponential"
    initial_delay: 1s
```

## Testing
1. Single contribution flow end-to-end
2. DA storage failure and retry
3. Transaction failure and retry
4. Concurrent contributions
5. Very large artifacts (near limits)
6. Duplicate submission (idempotency)
7. Chain reorg during confirmation
