Gap Analysis: Rust ECP vs TypeScript ECP                                                                                                                            
                                                                                                                                                                      
  CRITICAL — Entirely Missing Services                                                                                                                                
                                                                                                                                                                    
  1. AI Service (ai/*) — 40+ methods — THE MOST CRITICAL GAP

  The TypeScript ECP has a full AIServiceAdapter that handles all ai/* methods. The Rust ECP has:
  - An AIBridge crate that spawns a TypeScript subprocess
  - The subprocess (ai-bridge/index.ts) only handles 6 basic methods: ai/message/create, ai/message/stream, ai/models/list, ai/provider/status, ai/tools/list, ai/ping
  - No Rust service is registered for ai/* methods — they'd return MethodNotFound

  Missing ai/* methods the Mac client calls:

  Group: Providers
  Methods: ai/providers, ai/provider/capabilities, ai/provider/available, ai/provider/models
  ────────────────────────────────────────
  Group: Sessions
  Methods: ai/session/create, ai/session/get, ai/session/list, ai/session/delete, ai/session/clear
  ────────────────────────────────────────
  Group: Messages
  Methods: ai/message/send, ai/message/stream, ai/message/cancel, ai/message/add, ai/messages
  ────────────────────────────────────────
  Group: Tools
  Methods: ai/tools, ai/tools/ecp, ai/tool/execute
  ────────────────────────────────────────
  Group: Permissions
  Methods: ai/permission/approve, ai/permission/deny, ai/permission/remove, ai/permissions, ai/permissions/auto-approved, ai/permissions/session,
    ai/permissions/session/clear, ai/permissions/folder, ai/permissions/global
  ────────────────────────────────────────
  Group: Middleware
  Methods: ai/middleware/list, ai/middleware/enable, ai/pipeline/config
  ────────────────────────────────────────
  Group: Todos
  Methods: ai/todo/write, ai/todo/get
  ────────────────────────────────────────
  Group: Agents
  Methods: ai/agent/list, ai/agent/get, ai/agent/status, ai/agent/update, ai/agent/config/reload, ai/session/agents, ai/session/agent/add, ai/session/agent/remove,
    ai/mention/suggest
  ────────────────────────────────────────
  Group: Personas
  Methods: ai/persona/list, ai/persona/get, ai/persona/create, ai/persona/update, ai/persona/delete, ai/persona/compress

  The critical Agent SDK integration is in the TypeScript AgentSDKProvider which uses @anthropic-ai/claude-agent-sdk to run Claude with full agentic capabilities —
  tool use, permissions, MCP server, streaming events. This all runs in-process in the TypeScript ECP. The Rust bridge subprocess doesn't integrate the Agent SDK at
  all — it only uses the basic @anthropic-ai/sdk for simple message create/stream.

  2. Auth Service (auth/*) — 11 methods

  ┌─────────────────────┬───────────────────────┐
  │       Method        │        Purpose        │
  ├─────────────────────┼───────────────────────┤
  │ auth/providers      │ List auth providers   │
  ├─────────────────────┼───────────────────────┤
  │ auth/status         │ Get auth status       │
  ├─────────────────────┼───────────────────────┤
  │ auth/oauth/start    │ Start OAuth flow      │
  ├─────────────────────┼───────────────────────┤
  │ auth/oauth/callback │ Handle OAuth callback │
  ├─────────────────────┼───────────────────────┤
  │ auth/oauth/clear    │ Clear OAuth token     │
  ├─────────────────────┼───────────────────────┤
  │ auth/apikey/set     │ Store API key         │
  ├─────────────────────┼───────────────────────┤
  │ auth/apikey/get     │ Retrieve API key      │
  ├─────────────────────┼───────────────────────┤
  │ auth/apikey/delete  │ Delete API key        │
  ├─────────────────────┼───────────────────────┤
  │ auth/apikey/clear   │ Clear all keys        │
  ├─────────────────────┼───────────────────────┤
  │ auth/switch         │ Switch provider       │
  ├─────────────────────┼───────────────────────┤
  │ auth/logout         │ Logout                │
  └─────────────────────┴───────────────────────┘

  3. Agent Service (agent/*) — 16 methods

  Studio agent registry and lifecycle: agent/create, agent/get, agent/list, agent/delete, agent/invoke, agent/state/get, agent/state/save, agent/message/send,
  agent/message/list, agent/message/acknowledge, agent/memory/get, agent/memory/set, agent/memory/delete, agent/memory/keys, agent/role/list, agent/role/get

  4. Workflow Service (workflow/*) — ~35 methods

  Full workflow engine: execution, checkpoints, context management, agent management, permissions, feedback.

  5. Syntax Service (syntax/*) — ~15 methods

  Shiki-based syntax highlighting with sessions, themes, language detection.

  IMPORTANT — Chat Service Gaps

  The Rust chat service is missing these method groups that the TypeScript has:

  Missing Group: Documents
  Methods: chat/document/create, chat/document/get, chat/document/list, chat/document/update, chat/document/delete, chat/document/search, chat/document/hierarchy,
    chat/document/vulnerabilities, chat/document/pending-reviews, chat/document/count-by-type
  ────────────────────────────────────────
  Missing Group: Plans (legacy)
  Methods: chat/plan/create, chat/plan/get, chat/plan/list, chat/plan/update, chat/plan/delete, chat/plan/content
  ────────────────────────────────────────
  Missing Group: Specs (legacy)
  Methods: chat/spec/create, chat/spec/get, chat/spec/list, chat/spec/update, chat/spec/delete, chat/spec/hierarchy, chat/spec/link-plan
  ────────────────────────────────────────
  Missing Group: Activity
  Methods: chat/activity/log, chat/activity/since
  ────────────────────────────────────────
  Missing Group: Compaction
  Methods: chat/compaction/get, chat/compaction/expand, chat/compaction/collapse
  ────────────────────────────────────────
  Missing Group: Context
  Methods: chat/context/build
  ────────────────────────────────────────
  Missing Group: Todo
  Methods: chat/todo/get, chat/todo/replace
  ────────────────────────────────────────
  Missing Group: Stats
  Methods: chat/stats

  What Works Today

  The Rust ECP currently handles the "editor" side well:
  - File, Git, Terminal, Document, Session, Secret, Database, LSP, Watch — all good
  - Chat basic CRUD — sessions, messages, tool calls, permissions, todos, compactions — good

  What's Completely Broken for Agent SDK

  The Rust ECP cannot function as an Agent SDK host because:

  1. No ai/* service registered — all AI methods return MethodNotFound
  2. The bridge subprocess only does basic Anthropic API calls, not Agent SDK query()
  3. The Agent SDK provider (agent-sdk.ts) runs in-process in the TypeScript ECP, using @anthropic-ai/claude-agent-sdk's query() function which:
    - Manages the full agentic loop (tool calls, permissions, multi-turn)
    - Streams 15+ event types (text deltas, tool use requests, tool results, auth status, etc.)
    - Handles canUseTool permission callbacks
    - Creates in-process MCP servers for ECP document tools
    - Resolves the claude CLI path
    - Manages SDK session IDs for multi-turn resume

  Recommended Approach

  The cleanest path to Agent SDK parity:

  1. Expand the AI bridge subprocess to include the full Agent SDK provider — replace ai-bridge/index.ts with the complete LocalAIService + AgentSDKProvider +
  AIServiceAdapter code from the TypeScript ECP
  2. Register an AIService in Rust that forwards all ai/* methods to the bridge subprocess
  3. Add streaming support to the bridge protocol — the bridge needs to emit notifications (not just request/response) for stream events
  4. Add auth/* as a thin Rust service that delegates to the secret service for API key storage and the bridge for OAuth
  5. Chat document/plan/spec tables and methods (the Agent SDK's MCP tools call back into these)

  The Agent SDK integration is fundamentally a TypeScript dependency — it requires @anthropic-ai/claude-agent-sdk. The bridge subprocess approach is correct; it just
  needs to be expanded from "basic API wrapper" to "full Agent SDK host."
