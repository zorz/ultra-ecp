# Rust ECP Server — Migration & Integration Guide

This document describes how to replace the TypeScript ECP server (`bun run src/main.ts`) with the Rust ECP server (`rust/target/release/ultra-ecp`). The Rust server is a drop-in replacement: same WebSocket protocol, same JSON-RPC methods, same auth handshake, same notification events.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Building the Rust Binary](#building-the-rust-binary)
3. [Runtime Requirements](#runtime-requirements)
4. [Launching the Server](#launching-the-server)
5. [Connecting from the Mac Client](#connecting-from-the-mac-client)
6. [Service Map: What Runs Where](#service-map-what-runs-where)
7. [Known Gaps vs TypeScript ECP](#known-gaps-vs-typescript-ecp)
8. [AI Bridge Subprocess](#ai-bridge-subprocess)
9. [File Layout](#file-layout)
10. [Testing](#testing)
11. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  Mac Client (Swift)                                              │
│    Connects via WebSocket to ws://127.0.0.1:PORT/ws              │
│    Auth handshake, JSON-RPC 2.0, notification subscription       │
└──────────────────┬───────────────────────────────────────────────┘
                   │ WebSocket (JSON-RPC 2.0)
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Rust ECP Server  (ultra-ecp binary)                             │
│                                                                  │
│  Transport Layer (axum WebSocket)                                │
│    /ws     — JSON-RPC endpoint with auth                         │
│    /health — Health check (GET)                                  │
│                                                                  │
│  Server Router                                                   │
│    Namespace-based dispatch → Service.handle(method, params)     │
│                                                                  │
│  ┌─ Native Rust Services ──────────────────────────────────────┐ │
│  │  file, git, terminal, document, session, secret,            │ │
│  │  chat, database, lsp, watch                                 │ │
│  │  (10 services, ~200 methods)                                │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌─ Bridge-Forwarded Services ─────────────────────────────────┐ │
│  │  ai, auth, agent, workflow, syntax                          │ │
│  │  (5 thin wrappers → delegate to TypeScript bridge)          │ │
│  └────────────────────┬────────────────────────────────────────┘ │
└───────────────────────┼──────────────────────────────────────────┘
                        │ stdin/stdout JSON-RPC (newline-delimited)
                        ▼
┌──────────────────────────────────────────────────────────────────┐
│  AI Bridge Subprocess  (bun run ai-bridge/index.ts)              │
│                                                                  │
│  Imports existing TypeScript service code from src/services/:    │
│    AIServiceAdapter, AuthServiceAdapter, AgentServiceAdapter,    │
│    SyntaxServiceAdapter                                          │
│                                                                  │
│  Agent SDK integration:                                          │
│    @anthropic-ai/claude-agent-sdk — full agentic loop            │
│    Tool execution → callbacks to Rust (file/read, git/status)    │
│    Streaming → notifications → broadcast → WebSocket clients     │
│    Permissions → bidirectional approve/deny flow                 │
└──────────────────────────────────────────────────────────────────┘
```

The key design:
- **10 services run natively in Rust** — fast, no subprocess overhead.
- **5 services forward to a TypeScript bridge subprocess** — these require the Anthropic Agent SDK, Shiki, and other TypeScript-only libraries.
- The bridge communicates over **stdin/stdout** using newline-delimited JSON. Three message types: request/response, notifications, callbacks.
- From the client's perspective, all methods behave identically to the TypeScript ECP.

---

## Building the Rust Binary

```bash
cd rust/
cargo build --release
```

The binary is at: `rust/target/release/ultra-ecp`

Release profile is configured with LTO, single codegen unit, and symbol stripping for a small optimized binary.

### Prerequisites

- Rust toolchain (stable, edition 2024). Install via https://rustup.rs
- Bun runtime (for the AI bridge subprocess). Install via https://bun.sh

---

## Runtime Requirements

The Rust binary needs two things at runtime:

### 1. The AI Bridge Script

The bridge subprocess script at `ai-bridge/index.ts`. The binary resolves this path in order:

1. `{binary_dir}/../../ai-bridge/index.ts` (relative to the binary)
2. `./ai-bridge/index.ts` (relative to cwd)
3. `{workspace_root}/ai-bridge/index.ts` (relative to the --workspace arg)

For a production deployment, place the binary and the `ai-bridge/` directory in a known relative location, OR set the working directory so `./ai-bridge/index.ts` resolves.

### 2. Bridge Dependencies

```bash
cd ai-bridge/
bun install
```

This installs: `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk`, `shiki`, `zod`.

### 3. The TypeScript Source Tree

The bridge subprocess imports TypeScript services from the **parent project source**:

```typescript
import { LocalAIService } from "../src/services/ai/local.ts";
import { AIServiceAdapter } from "../src/services/ai/adapter.ts";
// ... etc
```

The `src/services/` directory must be present relative to `ai-bridge/`. This means the Rust binary must run from within (or relative to) the ultra-ecp project tree. The TypeScript source is NOT compiled — Bun executes it directly.

### 4. Bun

The bridge is started as `bun run ai-bridge/index.ts --workspace <path>`. Bun must be on `PATH`.

### Without the Bridge

If Bun is unavailable or the bridge script is missing, pass `--no-bridge`. The server will start with only the 10 native Rust services. AI, auth, agent, workflow, and syntax methods will return `MethodNotFound (-32601)`.

---

## Launching the Server

### CLI Flags

```
ultra-ecp [OPTIONS]

Options:
  --port <PORT>              Port to listen on [default: 7070] (use 0 for OS-assigned)
  --hostname <HOSTNAME>      Hostname to bind to [default: 127.0.0.1]
  --workspace <PATH>         Workspace root directory [default: cwd]
  --token <TOKEN>            Auth token [default: random 64-hex-char string]
  --max-connections <N>      Maximum concurrent WebSocket connections [default: 32]
  --verbose                  Enable debug-level logging
  --no-bridge                Skip starting the AI bridge subprocess
```

### Drop-In Replacement

Replace:
```bash
bun run src/main.ts --port 7070 --workspace /path/to/project --token mytoken
```

With:
```bash
./rust/target/release/ultra-ecp --port 7070 --workspace /path/to/project --token mytoken
```

Same flags, same behavior.

### Startup Output

The binary prints structured output to stdout:

```
╔══════════════════════════════════════════════════════════════╗
║                     Ultra ECP Server                        ║
║                        (Rust)                               ║
╚══════════════════════════════════════════════════════════════╝

  Workspace:  /Users/keith/myproject
  Port:       7070
  Binding:    127.0.0.1 (localhost only)

  AI Bridge:  started (5 services delegated)

────────────────────────────────────────────────────────────────

  Server running!

  WebSocket endpoint:
    ws://127.0.0.1:7070/ws

  Auth token:
    a1b2c3d4...e5f6g7h8

────────────────────────────────────────────────────────────────

  Press Ctrl+C to stop.
```

If you parse stdout to discover the port/token (e.g. when using `--port 0`), the format is identical to what the TypeScript server prints.

---

## Connecting from the Mac Client

The WebSocket protocol is identical. No client changes needed.

### Endpoints

| Path | Method | Purpose |
|------|--------|---------|
| `/ws` | GET (WebSocket upgrade) | JSON-RPC 2.0 endpoint |
| `/health` | GET | Health check → `{ "status": "ok", "clients": N }` |

### Auth Handshake (unchanged)

1. Client connects to `ws://127.0.0.1:{port}/ws`
2. Server sends `auth/required` notification:
   ```json
   {
     "jsonrpc": "2.0",
     "method": "auth/required",
     "params": { "serverVersion": "0.1.0", "timeout": 10000 }
   }
   ```
3. Client sends `auth/handshake` request:
   ```json
   {
     "jsonrpc": "2.0",
     "id": 1,
     "method": "auth/handshake",
     "params": {
       "token": "<64-char-hex-token>",
       "client": { "name": "ultra-mac", "version": "1.0" }
     }
   }
   ```
4. Server responds with `clientId`, `sessionId`, `serverVersion`, `workspaceRoot`
5. Server sends `server/connected` notification
6. Client can now send JSON-RPC requests and receive notifications

Legacy auth (`?token=` query param) is still supported.

### Heartbeat

- Server sends WebSocket pings every 30 seconds
- Clients that don't respond to pings are disconnected after 5x the interval

---

## Service Map: What Runs Where

### Native Rust Services (10)

These run directly in the Rust process — no bridge needed:

| Namespace | Service | Key Methods |
|-----------|---------|-------------|
| `file` | FileService | read, write, stat, exists, delete, rename, copy, readDir, search, glob, grep |
| `git` | GitService | status, branch, stage, stageAll, unstage, commit, push, pull, log, diff, branches, merge, stash, blame |
| `terminal` | TerminalService | create, execute, write, getBuffer, close, list, resize |
| `document` | DocumentService | open, close, content, insert, delete, replace, undo, redo, cursors |
| `session` | SessionService | save, load, list, current + config/\*, theme/\*, workspace/\*, keybindings/\*, systemPrompt/\*, commands/\* |
| `secret` | SecretService | get, set, delete, list, has, providers |
| `chat` | ChatService | session/\*, message/\*, toolCall/\*, permission/\*, todo/\*, compaction/\*, document/\*, activity/\*, stats, context/build |
| `database` | DatabaseService | createConnection, query, transaction, listTables, describeTable, history |
| `lsp` | LSPService | start, stop, completion, hover, definition, references, diagnostics, rename |
| `watch` | WatchService | start, stop, list + emits file/didCreate, file/didChange, file/didDelete |

### Bridge-Forwarded Services (5)

These forward to the TypeScript bridge subprocess:

| Namespace | Service | Implementation |
|-----------|---------|---------------|
| `ai` | AIService | `src/services/ai/adapter.ts` — Agent SDK, sessions, streaming, tools, permissions, todos |
| `auth` | AuthService | `src/services/auth/adapter.ts` — OAuth, API keys, provider management |
| `agent` | AgentService | `src/services/agents/adapter.ts` — agent CRUD, invocation, state, memory, roles |
| `workflow` | WorkflowService | `src/services/workflow/` — execution engine, checkpoints, agent coordination |
| `syntax` | SyntaxService | `src/services/syntax/adapter.ts` — Shiki highlighting, sessions, themes |

The Rust side has zero logic for these — it's a transparent passthrough. The bridge subprocess imports and runs the **exact same TypeScript code** that the TypeScript ECP uses.

---

## Known Gaps vs TypeScript ECP

These namespaces exist in the TypeScript ECP but are **not yet implemented** in the Rust ECP:

### `shell/` (3 methods)

In the TS ECP, these are inline in `ecp-server.ts`, not a separate service:

- `shell/reveal` — Reveal file in Finder (`open -R`)
- `shell/openExternal` — Open URL/file with default app (`open`)
- `shell/rebuild` — Trigger app rebuild

**To add:** Create a small `ShellService` in Rust, or handle these inline in the router. They're just `std::process::Command::new("open")` calls.

### `layout/` (10 methods)

In the TS ECP, these are inline notification-relay methods:

- `layout/addTab`, `layout/splitTile`, `layout/focusTile`, `layout/openFile`
- `layout/closeTile`, `layout/closeTab`, `layout/activateTab`
- `layout/setPreset`, `layout/getLayout`, `layout/reportState`

Each method just emits a corresponding `layout/didRequest*` notification. The Mac client handles the actual layout logic.

**To add:** Create a `LayoutService` that receives these requests and re-emits them as notifications via the broadcast channel. ~50 lines of code.

### `models/` (2 methods)

- `models/list` — List available LLM models
- `models/refresh` — Refresh model list

Currently these are part of the AI service adapter in TypeScript. They may already work via the bridge's `ai` namespace (the TS adapter handles `ai/models/list` → model registry).

### `ensemble/` / `search/`

These exist as TypeScript directories but aren't standard ECP methods — they're used internally by the AI service for RAG/search. No ECP methods to implement.

### Missing Middleware

The TS ECP has a 4-stage middleware chain (settings snapshot, caller telemetry, working set, validation). The Rust ECP has a middleware interface but only the basic chain. For production use, you may want to port:

- **Caller assertion**: AI-namespace requests asserted as `agent`, all others as `human`
- **Settings snapshot**: Captures user settings at request time

---

## AI Bridge Subprocess

### Protocol

The bridge communicates over stdin/stdout with newline-delimited JSON objects. Three message types:

#### 1. Request/Response (Rust → Bridge)

Rust sends:
```json
{ "id": 1, "method": "ai/models/list", "params": {} }
```

Bridge responds:
```json
{ "id": 1, "result": { "models": [...] } }
```

Or on error:
```json
{ "id": 1, "error": { "code": -32000, "message": "Provider not configured" } }
```

#### 2. Notifications (Bridge → Rust)

Bridge emits (no `id`):
```json
{ "method": "ai/stream/event", "params": { "sessionId": "...", "type": "text_delta", "text": "Hello" } }
```

Rust wraps this as an `ECPNotification` and broadcasts it through the WebSocket to all connected clients.

#### 3. Callbacks (Bridge → Rust → Bridge)

When the Agent SDK needs to call an ECP tool (e.g., read a file):

Bridge sends:
```json
{ "callbackId": "cb-1", "method": "file/read", "params": { "path": "src/main.rs" } }
```

Rust executes `file/read` against its own router, then responds:
```json
{ "callbackId": "cb-1", "result": { "content": "...", "size": 1234 } }
```

This is how the Agent SDK can use all ECP tools (file, git, terminal, etc.) during agentic execution.

### Bridge Initialization Sequence

1. Rust spawns `bun run ai-bridge/index.ts --workspace <path>`
2. Bridge emits `ai/bridge/ready` notification
3. Bridge initializes services asynchronously:
   - AI Service (Agent SDK, providers, sessions)
   - Auth Service (OAuth, API keys via Rust SecretService callbacks)
   - Agent Service (agent registry)
   - Syntax Service (Shiki highlighting)
4. For each service, emits `ai/bridge/service-ready` notification
5. Bridge is now ready to handle requests

### Bridge Failure

If the bridge fails to start (Bun not found, script missing, dependency error):
- The 5 bridge-forwarded services are not registered
- All `ai/*`, `auth/*`, `agent/*`, `workflow/*`, `syntax/*` requests return `MethodNotFound`
- The 10 native Rust services work normally
- A warning is printed to stdout

---

## File Layout

```
ultra-ecp/
├── RUST_MIGRATION.md           ← This file
├── ai-bridge/
│   ├── index.ts                ← Bridge subprocess entry point
│   ├── package.json            ← Bridge dependencies
│   └── node_modules/           ← Installed by `bun install`
│
├── rust/
│   ├── Cargo.toml              ← Workspace root
│   ├── Cargo.lock
│   ├── src/
│   │   └── main.rs             ← Binary entry point
│   ├── crates/
│   │   ├── ecp-protocol/       ← JSON-RPC types, error codes, notifications
│   │   ├── ecp-transport/      ← WebSocket server (axum), auth handshake
│   │   ├── ecp-server/         ← Request router, middleware chain
│   │   ├── ecp-services/       ← All service implementations
│   │   │   ├── src/
│   │   │   │   ├── lib.rs      ← Service trait
│   │   │   │   ├── file.rs     ← FileService
│   │   │   │   ├── git.rs      ← GitService
│   │   │   │   ├── terminal.rs ← TerminalService
│   │   │   │   ├── document.rs ← DocumentService
│   │   │   │   ├── session.rs  ← SessionService (+ config, theme, workspace, etc.)
│   │   │   │   ├── secret.rs   ← SecretService
│   │   │   │   ├── chat.rs     ← ChatService (SQLite, documents, activity)
│   │   │   │   ├── database.rs ← DatabaseService (PostgreSQL)
│   │   │   │   ├── lsp.rs      ← LSPService
│   │   │   │   ├── watch.rs    ← WatchService (notify crate)
│   │   │   │   └── bridge_services.rs  ← 5 thin forwarding services
│   │   │   └── Cargo.toml
│   │   └── ecp-ai-bridge/      ← Bridge subprocess management
│   │       └── src/lib.rs      ← AIBridge (spawn, request, callback, notify)
│   ├── tests/
│   │   ├── service_tests.rs    ← 107 service-level tests
│   │   └── integration_tests.rs ← 12 WebSocket end-to-end tests
│   └── target/
│       └── release/
│           └── ultra-ecp       ← The binary
│
├── src/                        ← TypeScript source (used by bridge subprocess)
│   ├── main.ts                 ← TypeScript ECP entry point (being replaced)
│   ├── protocol/               ← Shared protocol types
│   └── services/               ← Service implementations imported by bridge
│       ├── ai/
│       ├── auth/
│       ├── agents/
│       ├── syntax/
│       └── ...
│
└── package.json                ← TypeScript ECP package
```

---

## Integration Steps for the Mac App

### Step 1: Build the Binary

```bash
cd ultra-ecp/rust
cargo build --release
```

### Step 2: Install Bridge Dependencies

```bash
cd ultra-ecp/ai-bridge
bun install
```

### Step 3: Replace the Server Launch

In the Mac app's server management code, replace:

```swift
// OLD: Launch TypeScript ECP
let process = Process()
process.executableURL = URL(fileURLWithPath: "/path/to/bun")
process.arguments = ["run", "src/main.ts", "--port", "\(port)", "--workspace", workspace, "--token", token]
process.currentDirectoryURL = ecpProjectURL
```

With:

```swift
// NEW: Launch Rust ECP
let process = Process()
process.executableURL = ecpProjectURL.appendingPathComponent("rust/target/release/ultra-ecp")
process.arguments = ["--port", "\(port)", "--workspace", workspace, "--token", token]
process.currentDirectoryURL = ecpProjectURL  // Important: cwd must be project root for bridge resolution
```

The `currentDirectoryURL` must be set to the ultra-ecp project root so the bridge script resolves via `./ai-bridge/index.ts`.

### Step 4: No Client Protocol Changes

The WebSocket connection, auth handshake, JSON-RPC format, and notification events are all identical. No changes to the Swift WebSocket client code.

### Step 5: Handle the `shell/` and `layout/` Gaps (if needed)

If the Mac client calls `shell/reveal`, `shell/openExternal`, or any `layout/*` methods:

**Option A (recommended):** Handle these client-side in Swift. `shell/reveal` is just `NSWorkspace.shared.activateFileViewerSelecting([url])`. `layout/*` methods are notifications to the client — the client can handle them locally without a server round-trip.

**Option B:** Add these as small Rust services (see [Known Gaps](#known-gaps-vs-typescript-ecp)).

---

## Testing

### Run All Tests

```bash
cd rust/
cargo test
```

**119 tests:**
- 107 service-level tests (every service's methods tested with wire-format assertions)
- 12 integration tests (WebSocket connection, auth, chat lifecycle, document lifecycle, bridge error handling)

### Key Test Files

- `rust/tests/service_tests.rs` — Tests each service's `handle()` method directly. Validates response shapes match what the Mac client expects.
- `rust/tests/integration_tests.rs` — Spins up a real WebSocket server, connects, authenticates, and exercises full request/response cycles.

### Manual Verification

```bash
# Start the server
./rust/target/release/ultra-ecp --port 7070 --workspace .

# In another terminal, test with wscat (or any WebSocket client):
# 1. Connect
wscat -c ws://127.0.0.1:7070/ws

# 2. Wait for auth/required, then send handshake:
{"jsonrpc":"2.0","id":1,"method":"auth/handshake","params":{"token":"<token-from-stdout>"}}

# 3. Test a method:
{"jsonrpc":"2.0","id":2,"method":"file/read","params":{"path":"README.md"}}
```

---

## Troubleshooting

### Bridge fails to start

```
AI Bridge:  FAILED (Failed to start AI bridge: ...)
```

Check:
1. Is `bun` on PATH? Run `which bun`.
2. Does `ai-bridge/index.ts` exist relative to cwd?
3. Are dependencies installed? Run `cd ai-bridge && bun install`.
4. Check stderr: run with `--verbose` to see bridge subprocess output.

### Methods return MethodNotFound

If `ai/*` or `auth/*` methods return -32601:
- The bridge likely failed to start. Check the startup output.
- Use `--verbose` to see bridge subprocess logs.
- Run with `--no-bridge` to confirm native services work independently.

### Connection refused

- Confirm the port is correct and not in use.
- The server binds to `127.0.0.1` by default — only localhost connections work.
- Check that the auth token matches.

### Chat database issues

The chat service stores data in SQLite at `{workspace}/.ultra/chat.db`. The database and tables are created automatically on first use. If you see schema errors, delete the database file and restart.

### Performance

The Rust server handles native service requests with ~0.1ms latency (vs ~2ms for TypeScript). Bridge-forwarded requests add stdin/stdout serialization overhead (~1-2ms). AI streaming notifications flow through the same broadcast channel as native notifications — no performance difference.
