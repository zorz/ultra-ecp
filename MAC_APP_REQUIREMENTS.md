# Mac App Requirements for Rust ECP

Requirements from the ultra-gui (Mac) and ultra-ui (shared Swift library) that the Rust ECP must satisfy.

---

## `models/list` — REQUIRED

The Mac app calls `models/list` on startup via `ModelStore.load()`. This is currently handled inline in the TypeScript `ecp-server.ts` (not a service adapter), so it's **not covered by the AI bridge**.

### Request

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "models/list",
  "params": null
}
```

No parameters. The method takes no arguments.

### Expected Response

The response is the full `ModelsConfig` object, which has a `models` array that the client parses:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "version": 1,
    "lastUpdated": "2025-01-15T00:00:00.000Z",
    "defaults": {
      "fast": "claude-haiku-4-5-20251001",
      "smart": "claude-opus-4-5-20251101",
      "code": "claude-sonnet-4-5-20250929",
      "balanced": "claude-sonnet-4-5-20250929",
      "cheap": "gemini-2.0-flash-lite",
      "vision": "gpt-4o"
    },
    "providerDefaults": {
      "anthropic": "claude-opus-4-5-20251101",
      "openai": "gpt-4o",
      "google": "gemini-2.0-flash",
      "ollama": "",
      "custom": ""
    },
    "models": [
      {
        "id": "claude-sonnet-4-5-20250929",
        "name": "Claude Sonnet 4.5",
        "provider": "anthropic",
        "capabilities": ["chat", "code", "vision", "tool_use"],
        "contextWindow": 200000,
        "maxOutputTokens": 16384,
        "pricing": "medium",
        "speed": "medium",
        "quality": "excellent",
        "available": true
      }
    ]
  }
}
```

### Fields the Client Reads

The Swift `ModelStore.parseModel()` extracts these fields from each object in the `models` array:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string | **yes** | Model identifier, e.g. `"claude-sonnet-4-5-20250929"` |
| `name` | string | **yes** | Display name, e.g. `"Claude Sonnet 4.5"` |
| `provider` | string | **yes** | One of: `"anthropic"`, `"openai"`, `"google"`, `"ollama"`, `"agent-sdk"`, `"custom"` |
| `capabilities` | string[] | no | e.g. `["chat", "code", "vision", "tool_use"]` |
| `contextWindow` | int | no | Token context window size |
| `maxOutputTokens` | int | no | Max output tokens |

The `defaults`, `providerDefaults`, and other top-level fields (`pricing`, `speed`, `quality`, `available`, etc.) are not currently read by the Swift client but should be included for completeness.

### Implementation

The TypeScript ECP reads from `~/.ultra/models.json`. If the file doesn't exist, it copies the bundled config from `config/models.json` first. The Rust ECP should do the same:

1. Check if `~/.ultra/models.json` exists
2. If not, copy `config/models.json` to `~/.ultra/models.json`
3. Read and parse `~/.ultra/models.json`
4. Return the parsed JSON as the result

This is a pure file-read operation — no API calls needed. The config file is the source of truth.

### `models/refresh` — NICE TO HAVE

Not called on startup, but available via command palette. Fetches fresh model lists from provider APIs (Anthropic, OpenAI, Google, Ollama) and rewrites `~/.ultra/models.json`. Lower priority — the static config file covers the common case.

---

## `chat/session/create` — FIXED

~~Response key was `"sessionId"` instead of `"id"`.~~ Fixed.

---

## `theme/current` — FIXED (theme files loaded) but wrong theme selected

### Status

Theme file loading works — `load_theme()` correctly reads from `config/themes/{id}.json` and returns 577 colors + 179 tokenColors. **Verified working.**

### Remaining bug: Settings not loaded from disk

The `SessionService` uses in-memory `default_settings()` which hardcodes:

```rust
s.insert("workbench.colorTheme".into(), json!("catppuccin-mocha"));
```

But the user's settings file at `~/.ultra/settings.jsonc` has:

```jsonc
"workbench.colorTheme": "catppuccin-frappe",
```

**The Rust ECP does not read `~/.ultra/settings.jsonc` on startup.** The TypeScript ECP reads this file and uses it as the source of truth. The Rust ECP must do the same:

1. On startup, read `~/.ultra/settings.jsonc` (note: JSONC format — has comments that need stripping)
2. Merge file settings over `default_settings()`
3. Then `config/get` and `theme/current` will return the correct user preferences

The `strip_jsonc_comments()` function already exists in `session.rs` — just needs to be used during init to load the settings file.

---

## `ai/session/create` — provider name validation issue

### Problem

The TypeScript AI adapter (bridge) validates the `provider` param against:

```
'claude' | 'openai' | 'gemini' | 'ollama' | 'agent-sdk'
```

The Swift client maps correctly (`"anthropic"` → `"claude"` via `ModelStore.ecpProvider`), so this should work. However, if the provider mapping fails or the model store doesn't load, the raw `"anthropic"` gets sent and the bridge rejects it with:

```
"provider: Invalid enum value. Expected 'claude' | 'openai' | 'gemini' | 'ollama' | 'agent-sdk', received 'anthropic'"
```

**Verified**: When `provider: "claude"` is sent, `ai/session/create` works correctly through the bridge.

### Action

No change needed in the Rust ECP. The Swift client handles the mapping. If the user sees this error, it's likely because `models/list` failed to load and the app fell back to the unmapped default.

---

## Agent SDK models missing from `models/list`

### Problem

`~/.ultra/models.json` contains 59 models from anthropic, openai, google, ollama — but **no `agent-sdk` provider entries**. The Agent SDK models are added dynamically by the TypeScript `models/refresh` handler (in `src/services/ai/model-registry.ts`), which checks if `@anthropic-ai/claude-agent-sdk` is installed.

### Fix (choose one)

**Option A**: Run `models/refresh` once from the TypeScript ECP to populate the file, then the Rust ECP will serve them from `~/.ultra/models.json`.

**Option B**: Add the three Agent SDK models directly to `~/.ultra/models.json`:

```json
{
  "id": "agent-sdk:claude-opus-4-6",
  "name": "Claude Opus 4.6 (Agent SDK)",
  "provider": "agent-sdk",
  "capabilities": ["chat", "code", "reasoning", "vision", "tool_use", "streaming"],
  "contextWindow": 200000,
  "maxOutputTokens": 32768
},
{
  "id": "agent-sdk:claude-sonnet-4-5-20250929",
  "name": "Claude Sonnet 4.5 (Agent SDK)",
  "provider": "agent-sdk",
  "capabilities": ["chat", "code", "reasoning", "vision", "tool_use", "streaming"],
  "contextWindow": 200000,
  "maxOutputTokens": 16384
},
{
  "id": "agent-sdk:claude-haiku-4-5-20251001",
  "name": "Claude Haiku 4.5 (Agent SDK)",
  "provider": "agent-sdk",
  "capabilities": ["chat", "code", "reasoning", "vision", "tool_use", "streaming"],
  "contextWindow": 200000,
  "maxOutputTokens": 8192
}
```

**Option C** (best): Implement `models/refresh` in the Rust ECP as a bridge-forwarded method, so the TypeScript model registry adds them automatically.

---

## `chat/session/list` — FIXED

~~Response was wrapped in `{"sessions": [...]}` instead of returning a direct array.~~ Fixed: returns `Value::Array(sessions)`. Also added `messageCount` (LEFT JOIN with messages) and `lastMessageAt` fields matching TypeScript ECP.

---

## `chat/message/list` — FIXED

~~All chat list endpoints returned wrapped objects instead of direct arrays.~~ Fixed: all list handlers (`message/list`, `message/search`, `message/recent`, `session/list`, `toolCall/list`, `permission/list`, `todo/list`, `compaction/list`, `document/list`, `document/search`, `document/hierarchy`, `document/vulnerabilities`, `document/pending-reviews`, `activity/since`, `sessionAgent/list`) now return `Value::Array(...)` matching TypeScript ECP.

---

## `chat/activity/log` — FIXED

Rewrote to reconstruct activity from data tables (sessions, messages, tool_calls, documents, todos) matching TypeScript ECP behavior. `chat/activity/since` also fixed. `chat/activity/add` is now a no-op.

### ~~WRONG HANDLER (creates instead of listing)~~

### Problem

The Rust `chat/activity/log` handler **creates a new activity entry** instead of **listing activity**. The Swift client calls `chat/activity/log` to **load** the activity log (returns an array of entries), but the Rust handler inserts a row and returns `{ "success": true }`.

### Rust (current — WRONG)

```rust
"chat/activity/log" => {
    let p: ActivityLogParams = parse_params(params)?;
    let id = format!("act-{}", uuid_v4());
    // ... inserts into activity table ...
    Ok(json!({ "success": true }))
}
```

### TypeScript (correct behavior)

The TypeScript ECP's `handleGetActivityLog()` **reconstructs** activity from data tables (sessions, messages, tool_calls) — it does NOT read from an "activity" table. It builds a unified activity feed by querying each table and creating synthetic entries:

```typescript
private handleGetActivityLog(params: unknown) {
    const p = (params || {}) as { sessionId?: string; limit?: number };
    return this.reconstructActivity(p.sessionId, p.limit ?? 100);
}
```

`reconstructActivity()` queries sessions, messages, tool_calls, and permissions tables, builds activity entries with fields like `id`, `sessionId`, `activityType`, `entityType`, `entityId`, `summary`, `details`, `createdAt`, and returns them sorted newest-first as a **flat array**.

### Expected Request from Swift

```json
{
    "method": "chat/activity/log",
    "params": { "sessionId": "optional-session-id", "limit": 200 }
}
```

Note: `sessionId` is **optional** — when omitted, returns activity across all sessions.

### Expected Response

A bare array (no wrapping object):

```json
[
    {
        "id": 1,
        "sessionId": "sess-abc",
        "activityType": "session_created",
        "entityType": "session",
        "entityId": "sess-abc",
        "summary": "Session created: agent-sdk/claude-opus-4-6",
        "details": { "title": "...", "provider": "agent-sdk", "model": "..." },
        "createdAt": 1737000000000
    },
    {
        "id": 2,
        "sessionId": "sess-abc",
        "activityType": "message_added",
        "entityType": "message",
        "entityId": "msg-xyz",
        "summary": "user: Hello...",
        "details": { "role": "user", "model": null },
        "createdAt": 1737000001000
    }
]
```

### Fix

Replace the `chat/activity/log` handler with one that reconstructs activity from data tables (same approach as TypeScript). The handler should:

1. Accept `{ sessionId?: string, limit?: number }` (both optional)
2. Query **sessions** table → create `session_created` entries
3. Query **messages** table (where `is_active = 1`) → create `message_added` entries
4. Query **tool_calls** table → create `tool_call_started` and `tool_call_completed` entries
5. Query tool_calls with permission statuses → create `permission_requested/granted/denied` entries
6. Sort all entries by `createdAt` descending
7. Return the combined array

The existing `chat/activity/log` behavior (creating entries) should be moved to `chat/activity/add` instead (the Swift client doesn't call this, but it's the correct method name for writes).

### Params Struct Fix

Change `ActivityLogParams` to accept the list-style params:

```rust
struct ActivityLogParams {
    #[serde(rename = "sessionId")]
    session_id: Option<String>,  // optional
    limit: Option<i64>,          // optional, default 100
}
```

---

## `chat/toolCall/list` — FIXED

Added `limit` parameter (default 100), `ORDER BY started_at DESC`, and JSON parsing of `input`/`output` fields (with truncation fallback for strings > 2000 chars).

### ~~Two bugs: no LIMIT, raw JSON strings~~

### Problem 1: No LIMIT clause

The Rust `list_tool_calls()` returns ALL tool calls for a session with no limit:

```rust
"SELECT ... FROM tool_calls WHERE session_id = ?1 ORDER BY started_at ASC"
```

The TypeScript ECP uses `LIMIT ?` (default 100). For projects with heavy tool usage (like atwave-dwh), returning all tool calls produces a response so large it can crash the WebSocket connection.

### Problem 2: `input` and `output` returned as raw strings

The Rust handler returns `input` and `output` as raw SQLite strings:

```rust
"input": row.get::<_, Option<String>>(7)?,   // raw JSON string
"output": row.get::<_, Option<String>>(8)?,  // raw JSON string
```

The TypeScript ECP parses these:

```typescript
input: r.input ? JSON.parse(r.input) : null,
output: r.output ? JSON.parse(r.output) : null,
```

The Swift client reads `dict["input"]?.dictionary` and `dict["output"]?.dictionary` — a raw string won't match `.dictionary`, so input/output are always nil.

### Fix

1. Add `limit` parameter to `SessionIdParam` (or create a new params struct) — accept optional `limit`, default to 100
2. Add `LIMIT ?` to the SQL query
3. Parse `input` and `output` from JSON strings into `serde_json::Value` objects before including in the response:

```rust
"input": row.get::<_, Option<String>>(7)?
    .and_then(|s| serde_json::from_str::<Value>(&s).ok()),
"output": row.get::<_, Option<String>>(8)?
    .and_then(|s| serde_json::from_str::<Value>(&s).ok()),
```

---

## `chat/document/*` — FIXED (full parity rewrite)

All 10 document operations rewritten to match TypeScript ECP:
- **create**: Returns full document (was: only `{ documentId }`). Added `validationCriteria`.
- **get**: Returns raw document or null (was: wrapped `{ document }` or error).
- **list**: Supports all 7 filters (sessionId, agentId, docType, status, parentId, severity, reviewStatus) + limit/offset pagination (was: only sessionId + docType, no pagination).
- **update**: Supports all fields (added priority, reviewedByAgentId, reviewStatus, validationCriteria). Returns full document (was: `{ success }`).
- **search**: Filters by `docType` (was: sessionId). Matches TypeScript.
- **hierarchy**: Takes root document `id`, returns nested `DocumentWithChildren` structure (was: sessionId, flat array).
- **vulnerabilities**: Filters `status NOT IN ('archived','completed')`, sorts by severity priority, sessionId optional (was: no status filter, sessionId required).
- **pending-reviews**: Filters by `review_status = 'pending'`, no params required, sorts by priority DESC (was: filtered by `doc_type = 'review'`, required sessionId).
- **count-by-type**: Global count, no params required, excludes archived, returns flat `{ docType: count }` object (was: session-scoped, required sessionId, returned wrapped array).

### ~~`sessionId` should be optional~~

### Problem

The Rust `DocumentListParams` requires `session_id` as a non-optional field:

```rust
struct DocumentListParams {
    #[serde(rename = "sessionId")]
    session_id: String,         // REQUIRED
    doc_type: Option<String>,
}
```

The Swift client sends `sessionId` as **optional** — when loading workspace-scoped documents, it omits `sessionId`:

```swift
var paramsDict: [String: AnyCodable] = [:]
if let sid = sessionId {
    paramsDict["sessionId"] = AnyCodable(sid)
}
```

When `sessionId` is omitted, `parse_params()` fails with a deserialization error.

### Fix

Make `session_id` optional in `DocumentListParams`:

```rust
struct DocumentListParams {
    #[serde(rename = "sessionId")]
    session_id: Option<String>,  // optional
    #[serde(alias = "type", alias = "docType", rename = "docType")]
    doc_type: Option<String>,
}
```

And update `list_documents()` to handle the optional case — when `session_id` is None, return all documents (or an empty list).

---

## Methods NOT Needed

These gap methods from RUST_MIGRATION.md are **not used** by the Mac app:

- `shell/reveal` — handled client-side via `NSWorkspace`
- `shell/openExternal` — handled client-side via `NSWorkspace`
- `shell/rebuild` — not used
- `layout/*` (all 10 methods) — layout is managed entirely client-side in `WorkspaceStore`
