# Channel Conversation Awareness

This feature enables the bot to maintain passive awareness of conversations in opt-in Discord channels, providing contextual responses based on recent discussions without requiring explicit mentions.

## Architecture

The feature uses a three-tier hybrid RAG (Retrieval Augmented Generation) architecture:

### Tier 1: In-Memory Buffer (Hot)
- **Cost:** Zero API cost
- **Latency:** Instant access
- **Description:** Maintains a circular buffer of the last 20 messages per tracked channel
- **Usage:** Always injected into prompts for immediate context

### Tier 2: Qdrant Semantic Index (Warm)
- **Cost:** ~$0.36/month for 5 active channels (embedding costs)
- **Latency:** Sub-second semantic search
- **Description:** Hourly batch indexing of messages to Qdrant vector store
- **Usage:** Semantic search for relevant historical context
- **Retention:** 30 days with automatic cleanup

### Tier 3: Mem0 Channel Memories (Cold)
- **Cost:** ~$3/month for 5 active channels (LLM extraction)
- **Latency:** Retrieval from existing Mem0 infrastructure
- **Description:** Extracted channel-level facts and patterns
- **Usage:** Long-term channel topic awareness using `userId: 'channel:{channelId}'`

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CHANNEL_CONTEXT_ENABLED` | `false` | Enable/disable the feature |
| `CHANNEL_CONTEXT_CHANNELS` | `""` | Comma-separated channel IDs to auto-track |
| `CHANNEL_CONTEXT_RECENT_COUNT` | `20` | Messages to keep in memory buffer |
| `CHANNEL_CONTEXT_BATCH_INTERVAL` | `60` | Minutes between batch indexing |
| `CHANNEL_CONTEXT_RETENTION_DAYS` | `30` | Days to retain indexed messages |
| `CHANNEL_CONTEXT_QDRANT_COLLECTION` | `channel_conversations` | Qdrant collection name |
| `CHANNEL_CONTEXT_SEARCH_THRESHOLD` | `0.4` | Minimum score for semantic search |
| `CHANNEL_CONTEXT_SEARCH_LIMIT` | `5` | Max results from semantic search |
| `CHANNEL_CONTEXT_EXTRACT_MEMORIES` | `false` | Enable Tier 3 Mem0 extraction |
| `CHANNEL_CONTEXT_MEMORY_INTERVAL` | `50` | Messages between memory extraction |

### Enabling the Feature

1. Set `CHANNEL_CONTEXT_ENABLED=true` in your environment
2. Ensure Qdrant is running and accessible
3. Deploy the updated bot
4. Either:
   - **Via config:** Set `CHANNEL_CONTEXT_CHANNELS` to a comma-separated list of channel IDs
   - **Via command:** Use `!channeltrack enable` in channels you want to track

### Pre-Configured Channels

You can pre-configure channels to track automatically on startup by setting `CHANNEL_CONTEXT_CHANNELS`:

```yaml
CHANNEL_CONTEXT_CHANNELS: "1234567890,0987654321,1122334455"
```

This is useful for:
- Initial deployment without manual setup
- Ensuring specific channels are always tracked
- Infrastructure-as-code approaches

Pre-configured channels are persisted to MongoDB on first startup, so they'll remain tracked even if removed from the environment variable later. Use `!channeltrack disable` to stop tracking.

## Commands

### Admin Commands

#### `!channeltrack enable`
Enable conversation tracking for the current channel.

```
!channeltrack enable
```

**Response:** Confirmation message with privacy notice about 30-day retention.

#### `!channeltrack disable`
Disable conversation tracking for the current channel.

```
!channeltrack disable
```

**Response:** Confirmation that tracking is disabled. Previously indexed messages remain until expiry.

#### `!channeltrack status`
Show tracking status and statistics for the current channel.

```
!channeltrack status
```

**Response:** Shows enabled status, buffer count, indexed count, pending count, and configuration.

### User Commands

#### `!context`
View what the bot knows about recent channel conversation.

```
!context
```

**Response:** Shows statistics, recent message preview, and any learned channel facts.

## How It Works

### Message Recording Flow

1. User sends message in tracked channel
2. Bot's `messageCreate` event fires
3. `ChannelContextService.recordMessage()` is called (non-blocking)
4. Message added to in-memory circular buffer (Tier 1)
5. Message queued for batch indexing (Tier 2)
6. If threshold reached, channel memories extracted (Tier 3)

### Context Injection Flow

1. User invokes chat command (e.g., `!chat clair hello`)
2. `ChatService.chat()` retrieves context in parallel:
   - User memories from Mem0
   - Channel context from ChannelContextService
3. `buildHybridContext()` combines:
   - Recent messages (Tier 1)
   - Semantically relevant past messages (Tier 2)
   - Channel facts (Tier 3)
4. Combined context injected into system prompt
5. LLM responds with full conversation awareness

### Batch Indexing

Every hour (configurable):
1. Collect all pending messages across tracked channels
2. Filter messages (>10 chars, non-bot)
3. Generate embeddings via OpenAI API (batched)
4. Upsert to Qdrant with 30-day expiry timestamp
5. Clear processed messages from queue

### Cleanup

Daily:
1. Query Qdrant for expired messages (`expiresAt < now`)
2. Delete expired points
3. Log cleanup completion

## Interaction with Ranked Recall (v2)

When `RECALL_V2_ENABLED=true`, `ChatService` no longer injects the three context tiers directly into the system prompt via `buildHybridContext`. Instead, two of the tiers are handed off to `RecallService` as ranked recall sources:

- **Tier 2 (semantic history)** — supplied via `ChannelContextService.searchRelevantHistory(channelId, query)`, unchanged.
- **Tier 3 (channel facts)** — supplied via the new `getChannelFactsRaw(channelId)` method, which returns the raw `{id, memory}` array that `getChannelFacts` would otherwise format into a string. `RecallService` needs the structured form so it can rank individual facts and use their IDs as ledger keys.

The **Tier 1 in-memory buffer** is kept outside the ranker entirely. `ChatService` injects it directly into the prompt using the new `buildRecentContext(channelId)` method, which returns only the participants list and recent messages — no semantic hits and no facts. A cross-block exclusion set is maintained so a message already present in the recent buffer cannot also appear as a ranked semantic hit, preventing duplication.

When `RECALL_V2_ENABLED=false` (the default), none of this applies — `buildHybridContext` assembles all three tiers as described in the section above.

## Privacy Considerations

- Only tracks messages in explicitly opted-in channels
- Admin-only opt-in control
- 30-day retention with automatic deletion
- Users can view tracked context via `!context`
- Messages are only used for conversation context, not shared externally

## Cost Estimates

For 5 active channels with ~100 messages/hour each:

| Component | Monthly Cost |
|-----------|-------------|
| Embeddings (text-embedding-3-small) | ~$0.36 |
| Memory extraction (gpt-4o-mini) | ~$3.00 |
| **Total** | **~$3.36** |

## Troubleshooting

### Channel context not working

1. Check `CHANNEL_CONTEXT_ENABLED=true` is set
2. Verify `!channeltrack status` shows enabled
3. Check bot logs for initialization errors
4. Ensure Qdrant is accessible

### No semantic search results

1. Wait for batch index cycle (default: 60 minutes)
2. Check `!context` to see indexed count
3. Verify Qdrant collection exists
4. Lower `CHANNEL_CONTEXT_SEARCH_THRESHOLD` if needed

### High latency

1. Reduce `CHANNEL_CONTEXT_RECENT_COUNT` for smaller prompts
2. Reduce `CHANNEL_CONTEXT_SEARCH_LIMIT` for faster searches
3. Check Qdrant performance

## Database Schema

### MongoDB: `channel_tracking_config`

```javascript
{
  channelId: String,      // Discord channel ID
  guildId: String,        // Discord guild ID
  enabled: Boolean,       // Tracking enabled
  enabledAt: Date,        // When enabled
  enabledBy: String,      // User who enabled
  disabledAt: Date,       // When disabled (if applicable)
  lastActivity: Date,     // Last message timestamp
  messageCount: Number,   // Total messages tracked
  createdAt: Date         // Record creation time
}
```

### Qdrant: `channel_conversations`

```javascript
{
  id: UUID,
  vector: Float[1536],    // text-embedding-3-small
  payload: {
    channelId: String,
    guildId: String,
    messageId: String,
    authorId: String,
    authorName: String,
    content: String,
    timestamp: ISO8601,
    expiresAt: ISO8601    // 30 days from timestamp
  }
}
```
