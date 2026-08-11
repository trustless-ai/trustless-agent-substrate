# Aggregate and Publish Summary Skill

## Purpose
Produce the final daily summary by aggregating all verified contributions, generating a report, producing required proof, and publishing through TAS.

## Trigger
- **Invoked by**: `enumerate-verify.md` after successful verification
- **Condition**: Verification passed or acceptable failure rate

## Input
```json
{
  "snapshotDate": "2026-08-11",
  "contributions": [...],  // Array of verified contributions
  "verificationResults": {
    "total": 42,
    "verified": 42,
    "failed": 0
  }
}
```

## Process

### 1. Load contribution artifacts
Fetch full artifact data for verified contributions:
```javascript
const artifacts = []

for (const contrib of contributions) {
  const preimage = await daClient.get(contrib.daReference)
  const artifact = JSON.parse(preimage.toString('utf8'))
  artifacts.push(artifact)
}
```

### 2. Aggregate contributions
Build structured summary:
```javascript
const summary = {
  date: snapshotDate,
  period: {
    start: artifacts[0]?.timestamp,
    end: artifacts[artifacts.length - 1]?.timestamp
  },
  statistics: {
    totalContributions: artifacts.length,
    uniqueContributors: new Set(artifacts.map(a => a.author.platformId)).size,
    platforms: {
      telegram: artifacts.filter(a => a.source.platform === 'telegram').length,
      discord: artifacts.filter(a => a.source.platform === 'discord').length
    }
  },
  contributors: aggregateByContributor(artifacts),
  contributions: artifacts.map(a => ({
    contributionId: a.contributionId,
    author: a.author.username,
    timestamp: a.timestamp,
    contentPreview: truncate(a.content.text, 100),
    daReference: a.daReference
  }))
}
```

### 3. Generate summary artifact
Create the canonical summary artifact:
```json
{
  "version": "1.0",
  "type": "daily_summary",
  "date": "2026-08-11",
  "snapshot": {
    "contributionCount": 42,
    "contributionRoot": "0x1234...",
    "cutoffBlock": 12345678
  },
  "verification": {
    "total": 42,
    "verified": 42,
    "failed": 0,
    "verifiedAt": "2026-08-11T00:05:23Z"
  },
  "summary": {
    "totalContributions": 42,
    "uniqueContributors": 15,
    "topContributors": [
      { "username": "alice", "count": 8 },
      { "username": "bob", "count": 6 }
    ],
    "highlights": [
      "Implemented ERC-8301 recompute functions",
      "Fixed NATS JetStream integration",
      "Added TEE attestation support"
    ]
  },
  "contributionDetails": [...],
  "metadata": {
    "generatedBy": {
      "chainId": 11155111,
      "registry": "0x...",
      "agentId": 1
    },
    "generatedAt": "2026-08-11T00:05:23Z"
  }
}
```

### 4. Store summary in DA
```javascript
const summaryJson = JSON.stringify(summaryArtifact, null, 2)
const summaryBytes = Buffer.from(summaryJson, 'utf8')
const summaryHash = keccak256(summaryBytes)
const summaryCid = await daClient.put(summaryBytes)
```

### 5. Produce verification proof
Generate the required proof based on verification phase:

**Phase 1: Attestation (v0.1)**
```javascript
// Agent signature
const proofData = {
  summaryHash,
  snapshotDate,
  contributionCount: summary.snapshot.contributionCount,
  contributionRoot: summary.snapshot.contributionRoot
}

const signature = await agentWallet.sign(
  encodeProofData(proofData)
)

const proof = {
  type: "signature",
  version: "1.0",
  signer: {
    chainId: 11155111,
    registry: "0x...",
    agentId: 1
  },
  signature,
  signedData: proofData
}
```

**Phase 2: TEE (future)**
```javascript
const proof = await teeProvider.attest({
  summaryHash,
  inputSnapshot: {
    contributionCount,
    contributionRoot
  },
  verificationResults
})
```

**Phase 3: ZK (future)**
```javascript
const proof = await zkProver.prove({
  statement: "summary correctly derived from frozen snapshot",
  witness: { contributions, verificationResults },
  publicInputs: { summaryHash, contributionRoot }
})
```

### 6. Complete workflow on-chain
Submit the summary and proof to the workflow contract:
```javascript
const tx = await workflow.completeDailySummary(
  snapshotDate,
  summaryHash,
  summaryCid,
  proof
)

const receipt = await workflow.waitForTx(tx)
```

### 7. Publish via TAS
Notify all TAWG members:
```javascript
await mcp.call('messages.send', {
  recipients: await tawg.getMembers(),
  content: {
    type: "daily_summary_published",
    date: snapshotDate,
    summaryHash,
    summaryCid,
    proofType: proof.type,
    workflowTx: receipt.transactionHash
  }
})
```

### 8. Post to coordination channels
Send human-readable summary to Telegram/Discord:
```
📊 Daily Summary: 2026-08-11

✅ 42 contributions from 15 contributors
🔗 Summary: bafybeig... (TX: 0xabcd...)
✍️ Verified with: Agent Signature

Top contributors:
1. alice (8)
2. bob (6)
3. carol (5)

Highlights:
• Implemented ERC-8301 recompute functions
• Fixed NATS JetStream integration
• Added TEE attestation support

Full details: https://tas.example.com/summaries/2026-08-11
```

## Output
```json
{
  "status": "published",
  "date": "2026-08-11",
  "summary": {
    "hash": "0x5678...",
    "daReference": "bafybeig...",
    "contributionCount": 42,
    "uniqueContributors": 15
  },
  "proof": {
    "type": "signature",
    "signature": "0x9abc..."
  },
  "publication": {
    "workflowTx": "0xabcd...",
    "publishedAt": "2026-08-11T00:05:30Z"
  }
}
```

## Error Handling

### Aggregation failures
```javascript
if (aggregationError) {
  // Log detailed error with contribution data
  console.error('Aggregation failed:', aggregationError)
  console.error('Contributions:', contributions.length)
  
  // Attempt recovery with reduced data
  const minimalSummary = createMinimalSummary(contributions)
  
  // Proceed with minimal summary if acceptable
  if (isAcceptable(minimalSummary)) {
    return proceedWithSummary(minimalSummary)
  }
}
```

### DA storage failure
```javascript
if (daError) {
  // Retry with different provider
  await retryWithFallbackProvider(daClient.put, summaryBytes)
  
  // If all providers fail, alert and queue
  await sendAlert('CRITICAL: Unable to store daily summary in DA')
  await retryQueue.add({ operation: 'publish_summary', data: summaryArtifact })
}
```

### Proof generation failure
```javascript
if (proofError) {
  // Log error
  console.error('Proof generation failed:', proofError)
  
  // Fallback to simpler proof method if available
  if (proof.type === 'zk' && zkProver.error) {
    console.log('Falling back to attestation proof')
    proof = await generateAttestationProof(proofData)
  }
}
```

### Workflow submission failure
```javascript
if (txError) {
  // Check if already submitted
  const existing = await workflow.getDailySummary(snapshotDate)
  if (existing && existing.summaryHash === summaryHash) {
    console.log('Summary already submitted')
    return { status: 'already_published', summary: existing }
  }
  
  // Retry with higher gas
  await retryWithHigherGas(workflow.completeDailySummary)
}
```

## Configuration
```yaml
aggregation:
  summary:
    include_full_text: false  # Privacy consideration
    max_preview_length: 100
    highlight_extraction: "llm"  # or "keyword", "manual"
  
  proof:
    type: "signature"  # or "attestation", "tee", "zk"
    fallback_enabled: true
    fallback_chain: ["zk", "tee", "attestation", "signature"]
  
  publication:
    channels:
      - telegram
      - discord
    webhook: "https://..."
    retry_attempts: 5
```

## Testing
1. Normal aggregation with all contributions verified
2. Aggregation with some verification failures
3. Very large number of contributions (performance)
4. DA storage failure and retry
5. Proof generation failure and fallback
6. Workflow submission failure
7. Publication to multiple channels
8. Duplicate summary submission (idempotency)

## Monitoring
Track:
- Aggregation duration
- Summary size (bytes)
- Proof generation time by type
- DA storage latency
- Workflow submission success rate
- Time from cutoff to publication
- Channel delivery success rate
