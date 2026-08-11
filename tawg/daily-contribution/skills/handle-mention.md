# Handle Mention Skill

## Purpose
Detect and process mentions of the Assist Agent in Telegram or Discord groups, extracting contribution content and preparing it for storage.

## Trigger
- **Event**: `message.received` from TAS with source=telegram or source=discord
- **Condition**: Message contains mention of this Agent

## Input
```json
{
  "messageId": "msg_abc123",
  "source": "telegram",
  "group": {
    "id": "group_xyz",
    "name": "TrustlessAI Contributors"
  },
  "author": {
    "id": "user_456",
    "username": "contributor_alice",
    "displayName": "Alice"
  },
  "content": "@AssistAgent I implemented the ERC-8301 recompute function",
  "timestamp": "2026-08-11T10:30:00Z",
  "replyTo": null
}
```

## Process

### 1. Verify mention
Check that this Agent is actually mentioned in the content.

### 2. Extract contribution
Parse the message to extract the actual contribution:
- Remove the mention prefix
- Clean formatting
- Preserve context (reply-to relationships, thread context)

### 3. Deduplicate
Check if this is a duplicate of a recent contribution:
- Same author + similar content within time window
- Exact message ID already processed

Deduplication strategy:
```
key = hash(author.id + normalized_content)
if exists_in_cache(key, max_age=1h):
    return duplicate
```

### 4. Enrich metadata
Build complete contribution record:
```json
{
  "contributionId": "contrib_uuid",
  "source": {
    "platform": "telegram",
    "groupId": "group_xyz",
    "groupName": "TrustlessAI Contributors",
    "messageId": "msg_abc123",
    "messageUrl": "https://t.me/...",
    "timestamp": "2026-08-11T10:30:00Z"
  },
  "author": {
    "platformId": "user_456",
    "username": "contributor_alice",
    "displayName": "Alice",
    "agentIdentity": null  // or ERC-8004 identity if Profile-bound
  },
  "content": {
    "text": "I implemented the ERC-8301 recompute function",
    "context": {
      "replyTo": null,
      "thread": null
    }
  },
  "status": "pending_review"
}
```

### 5. Validate contribution
Basic validation:
- Content not empty
- Author is recognized contributor (or open to all)
- No spam patterns detected
- Within acceptable size limits

### 6. Invoke process-contribution
If valid, pass to `process-contribution.md` skill for storage and anchoring.

If invalid, log and optionally reply with guidance.

## Output
```json
{
  "status": "processed",
  "contributionId": "contrib_uuid",
  "action": "forwarded_to_process"
}
```

Or:
```json
{
  "status": "rejected",
  "reason": "duplicate",
  "originalContributionId": "contrib_xyz"
}
```

## Error Handling

### Transient failures
- Message parsing failed: Log and retry with raw content
- Cache unavailable: Skip deduplication (err on side of processing)
- Network issues: Retry with exponential backoff

### Permanent failures
- Invalid message format: Log and acknowledge (don't retry)
- Spam detected: Log, block author temporarily, acknowledge
- Too large: Reject with helpful error message

## Reply Behavior
The Assist Agent should reply in the group:

**On success:**
```
✅ Contribution recorded. ID: contrib_abc123
```

**On duplicate:**
```
ℹ️ Already recorded (original: contrib_xyz)
```

**On rejection:**
```
❌ Unable to record: [reason]
```

## Acknowledgement
After processing (success or rejection), acknowledge the TAS message:
```javascript
await mcp.call('messages.ack', {
  messageId: "msg_abc123"
})
```

## Configuration
```yaml
mention_handling:
  deduplication:
    enabled: true
    window: 3600  # 1 hour
  validation:
    min_content_length: 10
    max_content_length: 5000
    spam_detection: true
  replies:
    enabled: true
    on_success: true
    on_duplicate: false
    on_rejection: true
```

## Testing Scenarios
1. Valid mention with new contribution
2. Duplicate mention within window
3. Mention with empty content
4. Very long contribution text
5. Rapid-fire mentions from same user
6. Mention in thread/reply context
7. Multiple agents mentioned
8. Mention with special characters/formatting
