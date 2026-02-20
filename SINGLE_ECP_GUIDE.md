# Single-Process Multi-Workspace ECP Server

The ECP server runs as a **single process** serving multiple workspaces concurrently. Each WebSocket connection scopes itself to one workspace via `workspace/open`. Global services (secrets, models, AI bridge) are shared; workspace services (file, git, terminal, chat, etc.) are instantiated per workspace with ref-counting.

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│              Single ECP Server Process                     │
│                                                           │
│  Global Services (shared):                                │
│  ├─ Secret, Models, Document (deprecated)                 │
│  ├─ Bridge-delegated: AI, Auth, Agent, Workflow, Syntax   │
│  └─ Global ChatDb (~/.ultra/chat.db)                      │
│                                                           │
│  WorkspaceRegistry (ref-counted per path):                │
│  ├─ /project-a/ → File, Git, Watch, Terminal, Session,    │
│  │                 Chat, Database, LSP                     │
│  └─ /project-b/ → File, Git, Watch, Terminal, Session,    │
│                    Chat, Database, LSP                     │
│                                                           │
│  Per-connection state (in transport):                     │
│  ├─ ws-conn-1 → workspace_id for /project-a/             │
│  ├─ ws-conn-2 → workspace_id for /project-b/             │
│  └─ ws-conn-3 → workspace_id for /project-a/ (shared)    │
│                                                           │
│  Notification channels:                                   │
│  ├─ Global broadcast (theme, config changes)              │
│  └─ Per-workspace broadcast (file, git, terminal events)  │
└───────────────────────────────────────────────────────────┘
```

## Connection Lifecycle

```
Client connects via WebSocket
  → auth/handshake (token validation)
  → workspace/open { path: "/path/to/project" }
    ← { workspaceId: "ws-abc123", path: "/path/to/project" }
  → file/read { path: "src/main.rs" }     ← routed to workspace's FileService
  → git/status {}                          ← routed to workspace's GitService
  → ai/chat { ... }                        ← routed to global AI bridge service
  → workspace/close                        ← decrements refcount
Client disconnects
  → on_client_disconnected fires (cleanup if workspace/close wasn't called)
```

## Request Flow

Every request carries a `RequestContext` built by the transport layer:

```rust
pub struct RequestContext {
    pub client_id: String,                // unique per WebSocket connection
    pub workspace_id: Option<String>,     // set after workspace/open
}
```

The router dispatches in three phases:

1. **Workspace lifecycle** — `workspace/open` and `workspace/close` handled inline
2. **Global services** — matched by namespace (secret, models, ai, auth, agent, workflow, syntax, document)
3. **Workspace services** — resolved via `context.workspace_id` from the registry

If a workspace-scoped method is called before `workspace/open`, the server returns error code `-32020` ("No workspace opened").

## Service Scoping

Every service declares its scope:

```rust
pub enum ServiceScope {
    Global,     // shared across all workspaces
    Workspace,  // instantiated per workspace
}
```

| Scope | Services |
|-------|----------|
| Global | Secret, Models, Document, AI*, Auth*, Agent*, Workflow*, Syntax* |
| Workspace | File, Git, Watch, Terminal, Session, Chat, Database, LSP |

*Bridge-delegated services — forwarded to the TypeScript AI bridge subprocess. The router injects `_workspaceId` into their params so the bridge can thread workspace context through callbacks.

## WorkspaceRegistry

The `WorkspaceRegistry` manages per-workspace service instances with ref-counting. Multiple connections to the same path share a single `WorkspaceServices` instance.

### API

| Method | Description |
|--------|-------------|
| `open(path, client_id)` | Opens or reuses a workspace. Returns `(workspace_id, notification_rx)`. Bumps refcount if the path is already open. |
| `close(client_id)` | Explicit close. Decrements refcount; shuts down services when it reaches 0. |
| `client_disconnected(client_id)` | Implicit close on WebSocket disconnect. Same refcount logic. |
| `get(workspace_id)` | Sync lookup returning `Option<Arc<WorkspaceServices>>`. Used by the router for every request. |
| `shutdown_all()` | Server shutdown — drains all workspaces and shuts down their services. |

### Ref-Counting

```
Connection 1: workspace/open /project-a   → refcount = 1 (new WorkspaceServices created)
Connection 2: workspace/open /project-a   → refcount = 2 (services reused)
Connection 1: workspace/close             → refcount = 1 (services still alive)
Connection 2: disconnects                 → refcount = 0 (services shut down and dropped)
```

Paths are canonicalized so `/project-a/` and `/project-a` resolve to the same workspace. In-flight requests on an `Arc<WorkspaceServices>` complete safely even if the registry drops its reference.

### Lock Discipline

The registry uses `parking_lot::RwLock` (sync) for map operations so that `get()` can be called from both sync and async contexts. Async operations (service init and shutdown) always run **outside** the lock:

```rust
// Lock held only for map mutation
let to_shutdown = {
    let mut workspaces = self.workspaces.write();
    // ... decrement, remove if 0 ...
}; // lock released

// Async shutdown outside the lock
if let Some(services) = to_shutdown {
    services.shutdown().await;
}
```

## Notifications

Two independent broadcast channels:

| Channel | Buffer | Scope | Examples |
|---------|--------|-------|----------|
| Global | 1024 | All authenticated clients | Theme changes, config updates |
| Per-workspace | 256 | Clients with that workspace open | File changes, git events, terminal output |

A client subscribes to the workspace channel after `workspace/open` succeeds. For clients using the `--workspace` default without calling `workspace/open`, the transport auto-subscribes after authentication via `handler.default_workspace_id()`. The transport `select!` loop listens to both:

```rust
tokio::select! {
    msg = ws_rx.next() => { /* incoming message */ }
    notification = global_rx.recv() => { /* forward to client */ }
    notification = async {
        match &mut workspace_rx {
            Some(rx) => rx.recv().await,
            None => std::future::pending().await,  // dormant until workspace/open
        }
    } => { /* forward to client */ }
}
```

Currently only `WatchService` emits workspace notifications (file change events).

## Bridge Workspace Threading

Bridge-delegated services (AI, Auth, Agent, Workflow, Syntax) run in a TypeScript subprocess communicating over JSON-RPC stdin/stdout.

**Outbound (Rust → Bridge):** The router injects `_workspaceId` into params before forwarding to the bridge service:

```json
{ "method": "ai/chat", "params": { "message": "hello", "_workspaceId": "ws-abc123" } }
```

**Inbound (Bridge → Rust callbacks):** The bridge includes `_workspaceId` in callback requests so Rust routes them to the correct workspace:

```json
{ "callback_id": "cb-1", "method": "chat/persona/get", "params": { "id": "default" }, "_workspaceId": "ws-abc123" }
```

The TypeScript bridge uses `AsyncLocalStorage` to thread the workspace ID through async callback chains without explicit parameter passing.

## CLI Usage

```
ultra-ecp                                    # No default workspace — clients must call workspace/open
ultra-ecp --workspace /path/to/project       # Pre-open a default workspace (backward compat)
ultra-ecp --port 8080                        # Custom port (default: 7070)
ultra-ecp --token mysecret                   # Custom auth token (default: random)
ultra-ecp --no-bridge                        # Skip AI bridge subprocess
ultra-ecp --bun-path /path/to/bun            # Custom bun runtime path
```

When `--workspace` is provided, that path is pre-opened and set as the default workspace. Connections that don't call `workspace/open` will use this default, preserving backward compatibility with single-workspace clients. The transport auto-subscribes these clients to the default workspace's notification channel after authentication, so file change events and other workspace notifications are delivered without requiring an explicit `workspace/open`.

## Error Codes

| Code | Constructor | Meaning |
|------|-------------|---------|
| -32020 | `ECPError::no_workspace()` | No workspace opened — client must send `workspace/open` first |
| -32021 | `ECPError::workspace_not_found(id)` | Workspace ID not found in registry (stale reference) |

## Key Files

| File | Purpose |
|------|---------|
| `rust/src/main.rs` | Server entry point, global service registration, bridge wiring |
| `rust/crates/ecp-server/src/router.rs` | `ECPServer` — request routing (global → workspace) |
| `rust/crates/ecp-server/src/registry.rs` | `WorkspaceRegistry` — ref-counted workspace lifecycle |
| `rust/crates/ecp-transport/src/server.rs` | WebSocket transport, `RequestHandler` trait, notification multiplexing |
| `rust/crates/ecp-protocol/src/context.rs` | `RequestContext` — per-connection state |
| `rust/crates/ecp-services/src/lib.rs` | `Service` trait, `ServiceScope` enum |
| `rust/crates/ecp-ai-bridge/src/lib.rs` | AI bridge subprocess, callback handler with workspace threading |
| `ai-bridge/index.ts` | TypeScript bridge — `AsyncLocalStorage` workspace context |

## Testing

The test suite covers multi-workspace scenarios:

- **Service tests** (125): Test individual services via `Service::handle()` directly — no workspace routing involved.
- **Integration tests** (14): WebSocket end-to-end including:
  - `workspace/open` → file/read succeeds
  - Global services work without any workspace open
  - Chat and document lifecycle within a workspace
  - Auth handshake flow
