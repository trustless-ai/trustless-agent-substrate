# Enumerate and Verify Skill

## Purpose
Enumerate all contributions from the frozen daily snapshot and verify that every digest matches its DA preimage.

## Trigger
- **Invoked by**: `daily-cutoff.md` after snapshot is frozen
- **Input**: Frozen snapshot reference

## Input
```json
{
  "snapshotDate": "2026-08-11",
  "contributionCount": 42,
  "contributionRoot": "0x1234..."
}
```

## Process

### 1. Load frozen snapshot
```javascript
const snapshot = await workflow.getSnapshot(snapshotDate)

assert(snapshot.isFrozen === true)
assert(snapshot.contributionCount === contributionCount)

console.log(`Enumerating ${snapshot.contributionCount} contributions`)
```

### 2. Enumerate contribution references
Iterate through all contributions in the frozen snapshot:
```javascript
const contributions = []

for (let i = 0; i < snapshot.contributionCount; i++) {
  const contrib = await workflow.getContributionByIndex(snapshotDate, i)
  contributions.push(contrib)
}
```

Each contribution reference includes:
```json
{
  "index": 0,
  "contributionId": "contrib_abc123",
  "contentHash": "0x1234...",
  "daReference": "bafybeigdyrzt...",
  "timestamp": 1723374600
}
```

### 3. Verify each contribution
For every contribution, fetch DA preimage and verify digest:
```javascript
const verificationResults = []

for (const contrib of contributions) {
  try {
    // Fetch DA preimage
    const preimage = await daClient.get(contrib.daReference)
    
    // Compute hash
    const computedHash = keccak256(preimage)
    
    // Verify matches on-chain hash
    const matches = computedHash === contrib.contentHash
    
    verificationResults.push({
      index: contrib.index,
      contributionId: contrib.contributionId,
      verified: matches,
      contentHash: contrib.contentHash,
      computedHash,
      daReference: contrib.daReference
    })
    
    if (!matches) {
      console.error(`MISMATCH at index ${contrib.index}`)
      console.error(`  Expected: ${contrib.contentHash}`)
      console.error(`  Computed: ${computedHash}`)
    }
    
  } catch (error) {
    console.error(`Error verifying ${contrib.contributionId}:`, error)
    verificationResults.push({
      index: contrib.index,
      contributionId: contrib.contributionId,
      verified: false,
      error: error.message
    })
  }
}
```

### 4. Detect gaps and inconsistencies
Check for:
- Missing indices
- Duplicate contribution IDs
- Hash mismatches
- DA fetch failures

```javascript
const failures = verificationResults.filter(r => !r.verified)
const mismatches = failures.filter(r => r.computedHash && r.computedHash !== r.contentHash)
const daErrors = failures.filter(r => r.error && r.error.includes('DA'))

if (failures.length > 0) {
  console.error(`Verification failures: ${failures.length}/${contributions.length}`)
  
  if (mismatches.length > 0) {
    // Hash mismatch is CRITICAL - data integrity compromised
    await sendAlert(`CRITICAL: ${mismatches.length} hash mismatches detected`)
  }
  
  if (daErrors.length > 0) {
    // DA unavailable - may be transient
    await sendAlert(`WARNING: ${daErrors.length} DA fetch failures`)
  }
}
```

### 5. Record verification results
```javascript
await localDb.verifications.insert({
  snapshotDate,
  timestamp: Date.now(),
  totalContributions: contributions.length,
  verified: verificationResults.filter(r => r.verified).length,
  failed: failures.length,
  mismatches: mismatches.length,
  daErrors: daErrors.length,
  results: verificationResults
})
```

### 6. Trigger aggregation
If verification is successful (or acceptable failure rate), proceed:
```javascript
if (failures.length === 0 || failures.length <= acceptableFailureThreshold) {
  await invokeSkill('aggregate-summary.md', {
    snapshotDate,
    contributions: contributions.filter((_, i) => 
      verificationResults[i].verified
    ),
    verificationResults
  })
} else {
  console.error('Too many verification failures, blocking aggregation')
  await sendAlert('Daily aggregation blocked due to verification failures')
}
```

## Output
```json
{
  "status": "verified",
  "snapshotDate": "2026-08-11",
  "summary": {
    "total": 42,
    "verified": 41,
    "failed": 1,
    "mismatches": 0,
    "daErrors": 1
  },
  "failures": [
    {
      "index": 15,
      "contributionId": "contrib_xyz",
      "error": "DA timeout"
    }
  ]
}
```

## Error Handling

### DA unavailable
```javascript
if (daError && daError.code === 'TIMEOUT') {
  // Retry with backoff
  await retryWithBackoff(daClient.get, {
    maxAttempts: 3,
    initialDelay: 1000,
    backoffMultiplier: 2
  })
  
  // If still failing, mark as DA error (not mismatch)
  if (stillFailing) {
    return { verified: false, error: 'DA unavailable after retries' }
  }
}
```

### Hash mismatch (CRITICAL)
```javascript
if (mismatch) {
  // Log full details
  console.error('HASH MISMATCH DETECTED')
  console.error('Index:', contrib.index)
  console.error('Contribution ID:', contrib.contributionId)
  console.error('On-chain hash:', contrib.contentHash)
  console.error('Computed hash:', computedHash)
  console.error('DA reference:', contrib.daReference)
  console.error('Preimage length:', preimage.length)
  
  // Store evidence
  await localDb.mismatches.insert({
    snapshotDate,
    index: contrib.index,
    contributionId: contrib.contributionId,
    expectedHash: contrib.contentHash,
    computedHash,
    daReference: contrib.daReference,
    preimage: preimage.toString('base64'),
    timestamp: Date.now()
  })
  
  // Critical alert
  await sendAlert('CRITICAL: Hash mismatch - possible data corruption or attack')
}
```

### Enumeration gaps
```javascript
// Check for missing indices
const indices = contributions.map(c => c.index).sort((a, b) => a - b)
for (let i = 0; i < indices.length; i++) {
  if (indices[i] !== i) {
    console.error(`Gap detected: missing index ${i}`)
    await sendAlert(`WARNING: Gap in contribution enumeration at index ${i}`)
  }
}
```

## Recovery Strategies

### DA failures
- Retry with different DA provider/gateway
- Query other Agents for the same preimage
- Mark contribution as "unverifiable" and proceed if acceptable

### Hash mismatches
- NO automatic recovery - human investigation required
- Halt aggregation until resolved
- Check for chain reorg, DA corruption, or malicious anchor

## Configuration
```yaml
enumeration:
  verification:
    parallel_fetches: 10  # Concurrent DA fetches
    da_timeout: 10s
    da_retries: 3
    acceptable_failure_rate: 0.02  # 2%
  
  mismatch_policy: "halt"  # or "warn_and_continue"
  
  da_providers:
    - url: "https://da-primary.example.com"
      priority: 1
    - url: "https://da-fallback.example.com"
      priority: 2
```

## Testing
1. All contributions verify successfully
2. Single DA fetch failure (transient)
3. Multiple DA fetch failures (persistent)
4. Hash mismatch (simulated corruption)
5. Gap in enumeration (missing index)
6. Duplicate contribution IDs
7. Very large snapshot (performance)
8. DA provider failover

## Monitoring
Track:
- Enumeration duration
- DA fetch latency (p50, p95, p99)
- Verification failure rate
- Time to detect first mismatch
- Recovery success rate
