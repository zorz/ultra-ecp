# Context Compaction & Session Resume — Client Guide

## Overview

Long chat sessions accumulate hundreds of messages that eventually exceed the AI model's context window. The ECP server provides **compaction** (summarizing old messages) and **session resume** (rebuilding context from DB for a new AI session). The Mac/iPad app needs to call two RPCs and handle one UI concern.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        ECP Server                           │
│                                                             │
│  Rust (chat.rs)              AI Bridge (adapter.ts)         │
│  ┌─────────────────┐        ┌──────────────────────────┐   │
│  │ compactions table│◄──────│ CompactionService         │   │
│  │ messages table   │◄──────│  └ AI summarization       │   │
│  │ sessions table   │       │ ContextWindowService      │   │
│  └────────┬────────┘        │  └ head/torso/tail model  │   │
│           │                 └──────────┬───────────────┘   │
│           │   chat/compaction/*        │ ai/session/resume  │
│           │   chat/message/list        │ ai/context/compact │
│           │   chat/context/build       │                    │
│           └────────────────────────────┘                    │
└─────────────────────────────────────────────────────────────┘
           ▲                              ▲
           │  Rust RPCs (data)            │  Bridge RPCs (AI)
           │                              │
     ┌─────┴──────────────────────────────┴─────┐
     │            Mac / iPad App                 │
     │                                           │
     │  On session load:  ai/session/resume      │
     │  Manual compact:   ai/context/compact     │
     │  View compactions: chat/compaction/list    │
     └───────────────────────────────────────────┘
```

**Key insight:** The client does NOT do any compaction or context-building logic itself. It calls `ai/session/resume` and the server handles everything — loading messages, loading compactions, building curated context, auto-compacting if needed, and creating a new AI session.

---

## RPC Reference

### `ai/session/resume` — Resume a chat session

The primary endpoint for session resume. Call this when the user reopens an existing chat session (e.g., after app restart, switching back to a tab, or continuing a previous conversation).

**Request:**
```json
{
  "method": "ai/session/resume",
  "params": {
    "chatSessionId": "sess-abc-123",
    "provider": "agent-sdk",
    "model": "claude-sonnet-4-5-20250929"
  }
}
```

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `chatSessionId` | string | **yes** | The chat DB session ID (from `chat/session/create`) |
| `provider` | string | no | Override the session's original provider. Omit to use what's stored. |
| `model` | string | no | Override the session's original model. Omit to use what's stored. |

**Response:**
```json
{
  "result": {
    "aiSessionId": "ai-xyz-789",
    "provider": "agent-sdk",
    "model": "claude-sonnet-4-5-20250929",
    "contextTokens": 45200,
    "contextWindow": 200000,
    "messagesLoaded": 34,
    "compactionsApplied": 2,
    "autoCompacted": false,
    "resumed": true,
    "sdkSessionId": "sdk-session-id"
  }
}
```

| Field | Type | Notes |
|-------|------|-------|
| `aiSessionId` | string | The new AI session ID — use this for `ai/session/send` |
| `provider` | string | Resolved provider |
| `model` | string | Resolved model |
| `contextTokens` | number | Estimated tokens in the rebuilt context |
| `contextWindow` | number | Model's max context window |
| `messagesLoaded` | number | How many active messages were included |
| `compactionsApplied` | number | How many compaction summaries were injected |
| `autoCompacted` | boolean | Whether the server auto-compacted because context exceeded the window |
| `resumed` | boolean | Present for Agent SDK sessions that resumed via SDK session ID |
| `sdkSessionId` | string? | Present for Agent SDK sessions — the SDK's own session identifier |

**What happens server-side:**

1. Loads the chat session metadata from `sessions` table
2. For **Agent SDK** sessions with a `cliSessionId`: creates a new AI session using the SDK's built-in session resume (the SDK manages its own context). Returns immediately.
3. For **other providers** (claude, openai, gemini, ollama):
   a. Loads active messages (`is_active = 1`) from `messages` table
   b. Loads compaction records from `compactions` table
   c. Builds curated context using the **rolling window strategy**:
      - **Head:** System prompt (always included)
      - **Torso:** Compaction summaries (as system messages) + active messages, chronologically sorted
      - **Tail:** Reserved for response tokens (min 25% of window, max 8000 tokens)
      - Trims oldest entries if over budget
   d. If context still exceeds window AND there are >15 active messages, **auto-compacts**: calls the AI to summarize older messages, stores the compaction, marks messages inactive, then rebuilds context
   e. Creates a new AI session pre-loaded with the curated messages

### `ai/context/compact` — Manual compaction

Trigger compaction manually. Use this for a "Compact conversation" button in the UI.

**Request:**
```json
{
  "method": "ai/context/compact",
  "params": {
    "chatSessionId": "sess-abc-123",
    "keepRecentCount": 10
  }
}
```

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `chatSessionId` | string | **yes** | The chat DB session ID |
| `keepRecentCount` | number | no | How many recent messages to keep uncompacted (default: 10) |

**Response:**
```json
{
  "result": {
    "compactionId": "cmp-def-456",
    "summary": "## Conversation Summary\n- Discussed auth implementation...",
    "messagesCompacted": 42,
    "originalTokenCount": 28500,
    "compressedTokenCount": 1200
  }
}
```

**What happens server-side:**

1. Loads active messages for the session
2. Selects all but the `keepRecentCount` most recent messages
3. Requires at least 3 messages to compact (errors otherwise)
4. Sends the conversation text to a temp AI session for summarization
5. Stores the compaction record via `chat/compaction/create`
6. Marks compacted messages as inactive (`is_active = 0`) via `chat/compaction/apply`
7. Returns the compaction result

---

## Compaction Data RPCs (Rust)

These are lower-level RPCs for viewing and managing compaction records. The client may use these for UI features like viewing compaction history or expanding/collapsing compacted sections.

### `chat/compaction/list`

```json
{ "method": "chat/compaction/list", "params": { "sessionId": "sess-abc" } }
```

Returns an array of compaction records, sorted by `createdAt` ascending:

```json
[
  {
    "id": "cmp-def-456",
    "sessionId": "sess-abc",
    "summary": "## Conversation Summary\n...",
    "startMessageId": "msg-001",
    "endMessageId": "msg-042",
    "messagesCompacted": 42,
    "originalTokenCount": 28500,
    "compressedTokenCount": 1200,
    "createdAt": 1737000000000
  }
]
```

### `chat/compaction/get`

```json
{ "method": "chat/compaction/get", "params": { "id": "cmp-def-456" } }
```

Returns `{ "compaction": { ... } }` or error if not found.

### `chat/compaction/expand`

Re-activates messages that were compacted. Use for "Show original messages" UI.

```json
{ "method": "chat/compaction/expand", "params": { "id": "cmp-def-456" } }
```

Sets `is_active = 1` on messages whose `compacted_into_id` matches the compaction ID.

### `chat/compaction/collapse`

Re-hides messages for a compaction. Reverse of expand.

```json
{ "method": "chat/compaction/collapse", "params": { "id": "cmp-def-456" } }
```

Sets `is_active = 0` on the same messages.

### `chat/compaction/delete`

Deletes a compaction record (does NOT re-activate messages — call expand first if needed).

```json
{ "method": "chat/compaction/delete", "params": { "id": "cmp-def-456" } }
```

### `chat/context/build`

Returns raw session data for debugging or custom context building. Not needed for normal resume flow.

```json
{ "method": "chat/context/build", "params": { "sessionId": "sess-abc" } }
```

Returns `{ "sessionId": "...", "context": { "session": {...}, "messages": [...], "documents": [...], "todos": [...], "compactions": [...] } }`.

---

## Client Implementation Guide

### Session Resume Flow

When the user opens an existing chat session:

```swift
// 1. Call resume — this handles EVERYTHING server-side
let result = try await ecp.request("ai/session/resume", [
    "chatSessionId": storedSession.id,
    // Optionally override provider/model if user changed it:
    // "provider": selectedProvider,
    // "model": selectedModel,
])

// 2. Store the new AI session ID for subsequent messages
let aiSessionId = result["aiSessionId"].string!

// 3. Update UI with context info (optional, for status display)
let contextTokens = result["contextTokens"].int ?? 0
let contextWindow = result["contextWindow"].int ?? 200000
let wasAutoCompacted = result["autoCompacted"].bool ?? false

if wasAutoCompacted {
    // Show a subtle indicator: "Older messages were summarized to fit context window"
}

// 4. Send new messages using the AI session ID
try await ecp.request("ai/session/send", [
    "sessionId": aiSessionId,
    "content": userMessage,
    "storageSessionId": storedSession.id,  // for DB persistence
])
```

### Manual Compact Button

Add a "Compact" or "Summarize older messages" action accessible from the chat session menu:

```swift
func compactSession() async {
    let result = try await ecp.request("ai/context/compact", [
        "chatSessionId": currentSession.id,
        "keepRecentCount": 10,
    ])

    let compacted = result["messagesCompacted"].int ?? 0
    let saved = (result["originalTokenCount"].int ?? 0) - (result["compressedTokenCount"].int ?? 0)

    // Show confirmation: "Summarized 42 messages, saved ~27K tokens"

    // Reload messages to reflect the compacted state
    await reloadMessages()
}
```

### Displaying Compacted Messages

Messages with `is_active = 0` are excluded from `chat/message/list` by default. To show compaction summaries in the message list:

1. Load compactions via `chat/compaction/list`
2. Render each compaction as a collapsible "Summary" card in the message timeline, positioned chronologically by `createdAt`
3. On expand: call `chat/compaction/expand` to re-activate original messages, reload the message list
4. On collapse: call `chat/compaction/collapse` to hide them again

### What NOT to implement client-side

- **Token counting** — the server estimates tokens (~4 chars/token)
- **Context window management** — the server's `RollingContextWindow` handles head/torso/tail budgeting
- **Compaction logic** — the server creates a temp AI session, generates a summary, and stores it
- **Message deactivation** — the server marks messages as `is_active = 0`
- **Auto-compaction triggers** — `ai/session/resume` auto-compacts when needed

---

## Database Schema (for reference)

### `compactions` table

```sql
id                      TEXT PRIMARY KEY
session_id              TEXT NOT NULL (FK → sessions)
summary                 TEXT NOT NULL
start_message_id        TEXT          -- first compacted message
end_message_id          TEXT          -- last compacted message
messages_compacted      INTEGER
original_token_count    INTEGER
compressed_token_count  INTEGER
created_at              INTEGER       -- ms timestamp
```

### Relevant `messages` columns

```sql
is_active               INTEGER DEFAULT 1   -- 0 = compacted/hidden
compacted_into_id       TEXT                 -- FK to messages (for expand/collapse tracking)
```

When `is_active = 0`, the message is excluded from `chat/message/list` results. The `compacted_into_id` links to the compaction record for expand/collapse operations.
