# Agent SDK Session Resume + Event Passthrough

## Problem

When resuming a chat session that used the Agent SDK provider, the current `ai/session/resume` handler creates a **brand new** Claude Code session and replays messages from the DB. This destroys the SDK's internal context — Claude Code manages its own session history, compaction, and context window internally. The SDK session ID is stored in-memory on the provider instance and lost on server restart.

For non-Agent-SDK providers (claude HTTP, openai, gemini, ollama), message replay is correct because those are stateless API calls. But the Agent SDK is fundamentally different — it's a persistent subprocess with its own session management.

## Architecture

```
ai/session/resume { chatSessionId }
  → adapter detects provider = 'agent-sdk'
  → loads cli_session_id from chat session record in Rust DB
  → creates AI session with cliSessionId set
  → LocalAIService.createSession() calls provider.setSessionId(id)
  → next query() call passes resume: sdkSessionId
  → SDK resumes its own session with full context intact
  → return { aiSessionId, resumed: true, sdkSessionId }

(For non-agent-sdk providers, existing message-replay flow is unchanged)
```

---

## Step 1: Fix auth token crash (trivial)

**File:** `rust/src/main.rs:321`

The line `&auth_token[..8]` panics when the token is shorter than 8 chars.

**Already fixed** — guarded with `if auth_token.len() > 16`.

---

## Step 2: Add `cli_session_id` to Rust sessions table

**File:** `rust/crates/ecp-services/src/chat.rs`

### Schema migration

Add column to `sessions` table:

```sql
ALTER TABLE sessions ADD COLUMN cli_session_id TEXT;
```

Use the existing migration pattern: check `tableExists('sessions')` then `addColumnIfNotExists`.

### `create_session()` — add parameter

```rust
fn create_session(
    &self, id: &str, title: Option<&str>, provider: &str, model: &str,
    system_prompt: Option<&str>, workflow_id: Option<&str>,
    cli_session_id: Option<&str>,  // NEW
) -> Result<(), rusqlite::Error>
```

Update INSERT to include `cli_session_id`.

### `get_session()` / `session_row_to_json()` — include new field

Add `cli_session_id` to the SELECT query and JSON output:

```rust
"cliSessionId": row.get::<_, Option<String>>(16)?,  // index 16
```

**Important:** Update the SELECT column list and adjust the column index.

### `update_session()` — add `cli_session_id` parameter

```rust
fn update_session(
    &self, id: &str, title: Option<&str>, status: Option<&str>,
    model: Option<&str>, provider: Option<&str>, system_prompt: Option<&str>,
    error_message: Option<&str>,
    cli_session_id: Option<&str>,  // NEW
) -> Result<bool, rusqlite::Error>
```

Add the `cli_session_id` SET clause in the dynamic update builder.

### `SessionCreateParams` — add field

```rust
#[serde(rename = "cliSessionId")]
cli_session_id: Option<String>,
```

### `SessionUpdateParams` — add field

```rust
#[serde(rename = "cliSessionId")]
cli_session_id: Option<String>,
```

### Handler updates

- `chat/session/create`: pass `p.cli_session_id.as_deref()` to `create_session()`
- `chat/session/update`: pass `p.cli_session_id.as_deref()` to `update_session()`

### Test

Add test: create session with `cliSessionId`, get it back, verify field present. Update session's `cliSessionId`, verify change persists.

---

## Step 3: Agent SDK provider — add `setSessionId()`

**File:** `src/services/ai/providers/agent-sdk.ts`

Add method (matching claude/openai/gemini providers):

```typescript
setSessionId(sessionId: string): void {
  this.sdkSessionId = sessionId;
}
```

This allows `LocalAIService.createSession()` to restore the SDK session ID on resume (the existing code at line 247 already checks for `setSessionId in provider`).

---

## Step 4: Persist SDK session ID after messages

**File:** `src/services/ai/adapter.ts`

After `sendMessage` / `sendMessageStreaming` completes for an agent-sdk session, the adapter should persist the captured `cliSessionId` back to the chat DB.

In the existing `handleSendMessage()` flow, after the AI response is received:

```typescript
// After getting response from LocalAIService
const aiSession = this.service.getSession(sessionId);
if (aiSession?.cliSessionId && chatSessionId) {
  // Persist SDK session ID to chat DB
  await this.ecpRequest?.('chat/session/update', {
    sessionId: chatSessionId,
    cliSessionId: aiSession.cliSessionId,
  });
}
```

The `storageSessionId` field on `SendMessageOptions` maps the AI session to the chat DB session — use that as the `chatSessionId`.

---

## Step 5: Resume handler — Agent SDK branch

**File:** `src/services/ai/adapter.ts` — `handleResumeSession()`

Add an early branch for agent-sdk sessions:

```typescript
// After loading chatSession metadata...

if (provider === 'agent-sdk' && chatSession.cliSessionId) {
  // Agent SDK sessions resume via the SDK's own session management.
  // Don't replay messages — the SDK manages its own context/compaction.
  const session = await this.service.createSession({
    provider: { type: 'agent-sdk', name: 'Claude (Agent SDK)', model },
    systemPrompt,
    cliSessionId: chatSession.cliSessionId,
    cwd: this.getWorkspacePath(),
  });

  return {
    result: {
      aiSessionId: session.id,
      provider: 'agent-sdk',
      model: model ?? session.provider.model,
      sdkSessionId: chatSession.cliSessionId,
      resumed: true,
      // No contextTokens/messagesLoaded — SDK manages its own context
    },
  };
}

// ... existing message-replay flow for other providers ...
```

---

## Step 6: Relay SDK events to client

**File:** `src/services/ai/providers/agent-sdk.ts`

### `compact_boundary` events

The SDK emits `SDKCompactBoundaryMessage` when it auto-compacts. Relay to the client:

```typescript
case 'system': {
  const subtype = msg.subtype as string;
  if (subtype === 'init') {
    this.sdkSessionId = msg.session_id as string;
  } else if (subtype === 'compact_boundary') {
    const metadata = msg.compact_metadata as {
      trigger: 'manual' | 'auto';
      pre_tokens: number;
    };
    onEvent({
      type: 'compact_boundary',
      trigger: metadata.trigger,
      preTokens: metadata.pre_tokens,
    } as StreamEvent);
  }
  break;
}
```

### `result` message — capture usage

The `SDKResultMessage` includes `usage`, `modelUsage`, and `total_cost_usd`. Capture and emit:

```typescript
case 'result': {
  if (subtype === 'success') {
    const usage = msg.usage as { input_tokens: number; output_tokens: number } | undefined;
    const modelUsage = msg.modelUsage as Record<string, { contextWindow: number }> | undefined;
    const cost = msg.total_cost_usd as number | undefined;

    onEvent({
      type: 'result_usage',
      usage,
      modelUsage,
      totalCostUsd: cost,
    } as StreamEvent);
  }
  break;
}
```

### Add new StreamEvent types

**File:** `src/services/ai/types.ts`

```typescript
export interface CompactBoundaryEvent {
  type: 'compact_boundary';
  trigger: 'manual' | 'auto';
  preTokens: number;
}

export interface ResultUsageEvent {
  type: 'result_usage';
  usage?: { input_tokens: number; output_tokens: number };
  modelUsage?: Record<string, { contextWindow: number; costUSD: number }>;
  totalCostUsd?: number;
}
```

Add to the `StreamEvent` union and `StreamEventType`.

---

## Files Modified

| File | Changes |
|------|---------|
| `rust/src/main.rs` | Fix auth token panic for short tokens |
| `rust/crates/ecp-services/src/chat.rs` | Add `cli_session_id` column, migrate, update CRUD + params |
| `rust/tests/service_tests.rs` | Test `cliSessionId` on session create/get/update |
| `src/services/ai/providers/agent-sdk.ts` | Add `setSessionId()`, relay `compact_boundary` + `result` usage |
| `src/services/ai/adapter.ts` | Agent SDK resume branch, persist `cliSessionId` after send |
| `src/services/ai/types.ts` | Add `CompactBoundaryEvent`, `ResultUsageEvent` to StreamEvent union |

---

## Implementation Order

1. **Rust:** `cli_session_id` column + migration + CRUD updates + test
2. **TS:** `agent-sdk.ts` — add `setSessionId()` (one-liner)
3. **TS:** `adapter.ts` — Agent SDK resume branch + persist cliSessionId after send
4. **TS:** `agent-sdk.ts` — relay `compact_boundary` + `result` usage events
5. **TS:** `types.ts` — new event types
6. **Verify:** `cargo test`, manual test with agent-sdk provider

---

## Verification

1. `cargo test` — all existing tests pass + new cliSessionId test
2. Manual test:
   - Start server, create chat session with agent-sdk provider
   - Send a message → verify `cliSessionId` is captured in DB
   - Call `ai/session/resume { chatSessionId }` → verify `resumed: true`, `sdkSessionId` present
   - Send another message on resumed session → verify SDK has full prior context
3. Compact boundary test:
   - Use agent-sdk in a long conversation until SDK auto-compacts
   - Verify `compact_boundary` event is emitted to client
4. Non-agent-sdk resume (regression):
   - Create a claude/openai session, add messages
   - Call `ai/session/resume` → verify message-replay flow still works
