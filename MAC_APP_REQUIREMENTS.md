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

## File Watcher — routing bug + URI format mismatch

### Critical: Router doesn't dispatch `file/watch` to WatchService

The WatchService has namespace `"watch"` but handles methods `"file/watch"` and `"file/unwatch"`. The router's exact-match loop finds `FileService` (namespace `"file"`) first, which returns `method_not_found`. The router returns this error immediately and **never reaches the fallback loop** that would try WatchService.

**Result:** `file/watch` always fails. No watching ever happens. Clients silently get no file change events.

**Swift workaround applied:** Changed to use `watch/start` and `watch/stop` which route correctly to WatchService's namespace.

**Rust fix (recommended):** Either add `file/watch` forwarding in `FileService`, or change WatchService's namespace to `"file"` and merge with FileService, or fix the router to try the fallback loop when exact-match returns `method_not_found`.

### URI format mismatch

The `WatchService` emits file change notifications with **bare absolute paths** as URIs:

```rust
let uri = path.to_string_lossy().to_string();
// Result: "/Users/keith/project/src/main.ts"
```

But the `FileService` uses `file://` prefixed URIs for tree nodes:

```rust
fn file_uri(path: &Path) -> String {
    format!("file://{}", path.display())
    // Result: "file:///Users/keith/project/src/main.ts"
}
```

The Swift client normalizes incoming bare paths to `file://` URIs (workaround applied), but the Rust watcher should emit consistent URIs matching the rest of the ECP.

### Also: `resolve_path` doesn't strip `file://` prefix

When the client sends `{ "uri": "file://." }` to `file/watch`, the `resolve_path` function treats `"file://."` as a relative path and joins it with the workspace root, creating an invalid path like `/Users/keith/project/file://.`.

### Fix

1. In `watch.rs` event processor, emit `file://` prefixed URIs:

```rust
let uri = format!("file://{}", path.display());
```

2. In `resolve_path`, strip `file://` prefix before resolving:

```rust
fn resolve_path(&self, path: &str) -> PathBuf {
    let stripped = path.strip_prefix("file://").unwrap_or(path);
    let p = std::path::Path::new(stripped);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        self.workspace_root.join(stripped)
    }
}
```

---

## `session/setCurrent` + `session/markDirty` — flexGuiState not persisted

### Problem

The Mac app saves workspace layout state (sidebar visibility, pinned state, widths, content tabs, etc.) via `session/setCurrent` with a `flexGuiState` dictionary, then calls `session/markDirty` to trigger persistence. The state is sent correctly — `WorkspaceStore.buildFlexGuiState()` includes `leftSidebarPinned`, `rightSidebarPinned`, and all other layout fields — but the ECP does not persist this state across restarts.

On next launch, `session/loadLast` returns the session but the `flexGuiState` is either missing or stale, so sidebar pinned/unpinned state (and possibly other layout preferences) revert to defaults.

### What the client sends

On every layout change (debounced 1s), the client calls:

```json
{
  "method": "session/setCurrent",
  "params": {
    "state": {
      "workspaceRoot": "/Users/keith/project",
      "flexGuiState": {
        "version": 1,
        "ui": {
          "leftSidebarVisible": true,
          "leftSidebarWidth": 210,
          "leftSidebarPinned": false,
          "rightSidebarVisible": true,
          "rightSidebarWidth": 280,
          "rightSidebarPinned": true,
          "rightSidebarTab": "files",
          "contentPanelVisible": true,
          "contentPanelRatio": 0.5,
          "followMode": false
        },
        "editorFiles": [...],
        "chat": { "storageSessionId": "..." }
      }
    }
  }
}
```

Followed by:

```json
{ "method": "session/markDirty", "params": null }
```

### What the client reads on restore

On startup, the client calls `session/loadLast` and reads `result.flexGuiState.ui` to restore all layout state including pinned sidebars.

### Fix

Ensure `session/setCurrent` persists the full `flexGuiState` object (or at minimum the `ui` sub-dictionary) to the session database, and that `session/loadLast` returns it intact.

---

## Multi-Workspace Support — Single ECP Server

### Problem

The Mac app currently spawns a **separate ECP server process per workstream** (per open project). Each process has its own WebSocket port, auth token, file watchers, git context, terminals, and chat database. This works but wastes resources — multiple processes, multiple databases, duplicated global state.

### Goal

A single ECP server process serves **all workstreams**. Each workstream opens its own WebSocket connection to the shared server. After authentication, the connection calls `workspace/open` to scope itself to a project directory. All subsequent requests on that connection are routed to workspace-specific service instances.

### Architecture: Per-Connection Workspace Scoping

The server already supports up to 32 simultaneous WebSocket connections with per-connection state (client UUID, auth status). The change is to add a **workspace context per connection**.

```
┌──────────────────────────────────────────────────────┐
│              Single ECP Server Process                │
│                                                      │
│  Global Services (shared):                           │
│  ├─ Auth, Models, Themes, Settings, AI Bridge        │
│  └─ Global chat DB (~/.ultra/chat.db)                │
│                                                      │
│  Per-Workspace Services (created on workspace/open): │
│  ├─ /project-a/ → File, Git, Watch, Terminal, Chat   │
│  └─ /project-b/ → File, Git, Watch, Terminal, Chat   │
│                                                      │
│  Connection → Workspace mapping:                     │
│  ├─ ws-conn-1 → /project-a/                          │
│  ├─ ws-conn-2 → /project-b/                          │
│  └─ ws-conn-3 → /project-a/ (shared services)       │
└──────────────────────────────────────────────────────┘
```

### New Methods

#### `workspace/open`

Called after `auth/handshake`. Scopes the connection to a workspace directory.

```json
{
  "method": "workspace/open",
  "params": { "path": "/Users/keith/Development/project-a" }
}
```

**Behavior:**
- Creates a new set of per-workspace services (FileService, GitService, WatchService, TerminalService, ChatService, LSPService) initialized with the given path as workspace root
- If services already exist for that path (another connection opened the same workspace), reuses them (reference-counted)
- Associates the calling connection with that workspace — all subsequent requests on this connection route to these services
- Opens (or reuses) `workspace_root/.ultra/chat.db` as the project database

**Response:**
```json
{
  "result": {
    "workspaceId": "ws-uuid-here",
    "path": "/Users/keith/Development/project-a"
  }
}
```

#### `workspace/close`

Called when a workstream tab is closed.

```json
{
  "method": "workspace/close",
  "params": { "workspaceId": "ws-uuid-here" }
}
```

**Behavior:**
- Dissociates the connection from the workspace
- Decrements the reference count for that workspace's services
- When refcount reaches 0: stops file watchers, kills terminals, shuts down LSP servers, closes the project chat database

### Per-Connection Request Routing

After `workspace/open`, the router resolves `connection → workspace → services` instead of using a global singleton:

```
Request arrives on connection C
  → Look up C's workspace (set by workspace/open)
  → Route to that workspace's FileService / GitService / etc.
```

**No changes to existing method signatures.** Methods like `file/read`, `git/status`, `terminal/create` stay exactly the same — the workspace context is implicit from the connection, not passed as a parameter.

### Per-Workspace Notifications

Notifications must only be sent to connections registered for the relevant workspace:

| Notification | Scope | Routing |
|-------------|-------|---------|
| `file/didChange`, `file/didCreate`, `file/didDelete` | Per-workspace | Only connections for that workspace |
| `git/*` events | Per-workspace | Only connections for that workspace |
| `terminal/output`, `terminal/exit` | Per-workspace | Only connections for that workspace |
| `chat/*` notifications | Per-workspace | Only connections for that workspace |
| `theme/didChange` | Global | All connections |
| `config/didChange` | Global | All connections |

**Implementation:** Replace the single broadcast channel with per-workspace broadcast channels. Global notifications use a separate global channel that all connections subscribe to.

### Startup Changes

- `--workspace` CLI arg becomes **optional** (defaults to `~` for the lobby)
- Per-workspace services are **not** created at server start — created lazily on `workspace/open`
- Global services (Auth, Models, Themes, Settings, AI Bridge) still initialize at startup
- The server starts and listens for connections without needing a workspace

### Services: Global vs Per-Workspace

**Global (shared across all workspaces):**

| Service | Why Global |
|---------|-----------|
| Auth | Single token per server instance |
| Models | User-level `~/.ultra/models.json` |
| Themes | User-level `~/.ultra/config/themes/` |
| Settings | User-level `~/.ultra/settings.jsonc` (base layer) |
| AI Bridge | Single subprocess, stateless per-request |
| Global Chat DB | `~/.ultra/chat.db` for cross-project data |

**Per-Workspace (instantiated on `workspace/open`):**

| Service | Notes |
|---------|-------|
| FileService | Own root, own path resolution |
| GitService | Own repo context, own working directory |
| WatchService | Own file system watchers |
| TerminalService | Own shell processes (cwd = workspace root) |
| ChatService | Own `workspace/.ultra/chat.db` + shared global DB |
| SessionService | Workspace-level settings overlay |
| LSPService | Own language server instances per language |

### Mac App Changes (for reference)

Once the ECP supports this, the Mac app will:

1. Move `ServerLauncher` from per-`Workstream` to `AppState` (single server process)
2. Each `Workstream` opens its own WebSocket connection to `127.0.0.1:<port>`
3. After `auth/handshake`, each connection calls `workspace/open` with its project path
4. On workstream close, calls `workspace/close` then disconnects
5. Health monitor moves to `AppState` level (one server to monitor, restart restores all connections)

### Why Per-Connection (Not Per-Request workspaceId)

- **No changes to existing method signatures** — `file/read`, `git/status`, etc. stay the same
- **Router already has per-connection context** (client UUID) — just add workspace to it
- **Mac app already uses one connection per workstream** — maps naturally
- **Notifications are already per-connection** — just filter by workspace
- **Simpler client code** — no need to thread workspaceId through every store method

---

## AI Bridge — Compiled Binary Support for App Bundle

### Problem

The Mac app bundles the Rust `ultra-ecp` binary at `Ultra.app/Contents/MacOS/ultra-ecp`. The AI bridge is compiled into a standalone Mach-O binary via `bun build index.ts --compile` and placed at `Ultra.app/Contents/MacOS/ai-bridge`.

The current `main.rs` only looks for `ai-bridge/index.ts` (a script to run via bun). In the app bundle there is no `ai-bridge/index.ts` — only a compiled `ai-bridge` binary next to `ultra-ecp`. So the bridge fails to start and all AI/auth/agent/workflow/syntax services are unavailable.

### Fix

In `main.rs`, check for a compiled `ai-bridge` binary next to the executable **before** looking for the TypeScript source. When found, run it directly instead of via bun.

**Detection logic** (check in this order):
1. `exe_dir.join("ai-bridge")` — compiled binary next to ultra-ecp (app bundle case)
2. `exe_dir.join("../../../ai-bridge/index.ts")` — dev: exe at `rust/target/release/` → project root
3. `exe_dir.join("../../ai-bridge/index.ts")` — dev: exe at `rust/target/` → project root
4. `PathBuf::from("ai-bridge/index.ts")` — CWD fallback

When a compiled binary is found (case 1), spawn it directly — no runtime needed:
```rust
Command::new(compiled_binary_path)
    .arg("--workspace").arg(workspace_root)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
```

When a TypeScript source is found (cases 2-4), use the existing bun runtime approach:
```rust
Command::new(bun_runtime)
    .arg("run").arg(script_path)
    .arg("--workspace").arg(workspace_root)
    ...
```

**Implementation options:**

**Option A (minimal — main.rs only):** Detect the compiled binary in `main.rs` and set the `AIBridgeConfig` fields so the existing `start()` method works. Set `runtime` to the compiled binary path and `script_path` to a dummy/empty value, then skip the `"run"` arg. This is hacky but avoids changing the crate.

**Option B (clean — config + lib change):** Add `compiled_binary: Option<PathBuf>` to `AIBridgeConfig`. In `AIBridge::start()`, branch:
```rust
let mut child = if let Some(ref bin) = config.compiled_binary {
    Command::new(bin)
        .arg("--workspace").arg(&config.workspace_root)
        // ... stdin/stdout/stderr
        .spawn()?
} else {
    Command::new(&config.runtime)
        .arg("run").arg(&config.script_path)
        .arg("--workspace").arg(&config.workspace_root)
        // ... stdin/stdout/stderr
        .spawn()?
};
```

### App Bundle Layout

```
Ultra.app/
  Contents/
    MacOS/
      Ultra          ← SwiftUI app binary
      ultra-ecp      ← Rust ECP server (7MB)
      ai-bridge      ← Compiled ai-bridge (bun --compile, ~70MB)
    Resources/
      config/themes/ ← Theme JSON files
```

The Xcode build script (`Scripts/build-ecp.sh`) handles:
1. Copying `ultra-ecp/rust/target/release/ultra-ecp` → `Contents/MacOS/ultra-ecp`
2. Compiling `ultra-ecp/ai-bridge/index.ts` → `Contents/MacOS/ai-bridge` via `bun build --compile`
3. Code-signing both binaries

---

## Methods NOT Needed

These gap methods from RUST_MIGRATION.md are **not used** by the Mac app:

- `shell/reveal` — handled client-side via `NSWorkspace`
- `shell/openExternal` — handled client-side via `NSWorkspace`
- `shell/rebuild` — not used
- `layout/*` (all 10 methods) — layout is managed entirely client-side in `WorkspaceStore`

---

## Known Bugs

### Tool execution blocks not persisting across app reloads — FIXED

~~**Symptom:** Tool execution blocks missing after reload.~~

**Fixed:** The Rust ECP's `messages` table now has a `blocks_json TEXT` column (matching TS migration 007). Changes:
- Schema: `blocks_json TEXT` added to `UNIFIED_SCHEMA` DDL
- Migration: `ensure_column("messages", "blocks_json", "TEXT")` for existing databases
- `MessageAddParams` + `MessageUpdateParams`: accept `blocksJson` field
- `add_message()`: stores `blocks_json` in INSERT
- `update_message()`: supports updating `blocks_json`
- All 5 message SELECT queries + `message_row_to_json()`: include `blocksJson` in output

Full persistence path: Swift sends `blocksJson` via `chat/message/add` → Rust stores in `blocks_json` column → Swift reads via `chat/message/list` response.

### `session/setCurrent` + `session/markDirty` not persisting flexGuiState — FIXED

~~**Symptom:** Sidebar pinned state not restored on reload.~~

**Fixed:** Two bugs were causing this:
1. `SessionState` struct only had typed fields — `flexGuiState` was silently dropped during deserialization. **Fix:** Added `#[serde(flatten)] pub extra: HashMap<String, Value>` catch-all to preserve all unknown fields.
2. `session/markDirty` only updated `updated_at` in memory — no disk persistence. **Fix:** `markDirty` now writes the full session state to `~/.ultra/sessions/workspace-{hash}.json`.

The `SessionState` struct also uses `#[serde(rename_all = "camelCase")]` with `alias` attributes for backward compatibility with old snake_case session files.

### File watcher notifications not reaching clients — FIXED

~~**Symptom:** File changes not reflected in editor or file tree after multi-workspace refactor.~~

**Fixed:** The multi-workspace refactor moved WatchService notifications from the global broadcast channel to per-workspace channels. But clients using the `--workspace` default (without calling `workspace/open`) never subscribed to the per-workspace channel. **Fix:** Added `default_workspace_id()` to `RequestHandler` trait. Transport auto-subscribes to the default workspace's notification channel immediately after authentication.

### Document change notifications not emitted — FIXED

~~**Symptom:** Documents created or updated by AI agents never appear or refresh in the Mac app's document list.~~

**Fixed:** Added `emit_notification()` calls to the three document mutation handlers in `chat.rs`:
- `chat/document/create` → emits `chat/document/created` with `{ "document": <full doc> }`
- `chat/document/update` → emits `chat/document/updated` with `{ "document": <full doc> }` (when update returns a document)
- `chat/document/delete` → emits `chat/document/deleted` with `{ "id": "<doc-id>" }` (when delete succeeds)

Also added missing `CHAT_DOCUMENT_DELETED` constant to `ecp-protocol/src/notifications.rs`. Notifications flow through the per-workspace broadcast channel (same as `stats/updated` and `file/didChange`).

---
