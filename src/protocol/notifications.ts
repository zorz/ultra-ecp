/**
 * ECP Notification Constants
 *
 * All notification event names emitted by the ECP server (and client-side
 * synthetic events). Clients subscribe to these to receive real-time updates.
 *
 * Sources:
 *   Server emitters:  sendNotification / emitNotification / createNotification
 *   Client listeners: ecp.subscribe(...)
 */

export const Notifications = {
  // ── Authentication ────────────────────────────────────────────────────
  Auth: {
    /** Sent during WebSocket handshake when credentials are required. */
    Required: 'auth/required',
  },

  // ── Server lifecycle ──────────────────────────────────────────────────
  Server: {
    /** Sent to the client after a successful WebSocket connection. */
    Connected: 'server/connected',
  },

  // ── Client-side synthetic events ──────────────────────────────────────
  Ecp: {
    /** Emitted by the client ecpStore after a successful reconnection. */
    Reconnected: 'ecp/reconnected',
  },

  // ── File system ───────────────────────────────────────────────────────
  File: {
    DidChange: 'file/didChange',
    DidCreate: 'file/didCreate',
    DidDelete: 'file/didDelete',
  },

  // ── Terminal ──────────────────────────────────────────────────────────
  Terminal: {
    Output: 'terminal/output',
    Exit: 'terminal/exit',
    Title: 'terminal/title',
  },

  // ── Open document (editor buffer) ─────────────────────────────────────
  Document: {
    DidChange: 'document/didChange',
    DidChangeCursors: 'document/didChangeCursors',
    DidOpen: 'document/didOpen',
    DidClose: 'document/didClose',
  },

  // ── LSP ───────────────────────────────────────────────────────────────
  Lsp: {
    DidPublishDiagnostics: 'lsp/didPublishDiagnostics',
    ServerStatusChanged: 'lsp/serverStatusChanged',
  },

  // ── Theme ─────────────────────────────────────────────────────────────
  Theme: {
    Changed: 'theme/changed',
  },

  // ── Workspace ─────────────────────────────────────────────────────────
  Workspace: {
    DidChangeRoot: 'workspace/didChangeRoot',
  },

  // ── System prompt ─────────────────────────────────────────────────────
  SystemPrompt: {
    DidChange: 'systemPrompt/didChange',
  },

  // ── UI (built-in panel management) ────────────────────────────────────
  Ui: {
    SetLayout: 'ui/setLayout',
    AddPanel: 'ui/addPanel',
    RemovePanel: 'ui/removePanel',
    UpdatePanel: 'ui/updatePanel',
    LayoutSet: 'ui/layout/set',
    PresetsSwitch: 'ui/presets/switch',
  },

  // ── Layout (agent-driven layout requests) ─────────────────────────────
  Layout: {
    DidRequestAddTab: 'layout/didRequestAddTab',
    DidRequestSplit: 'layout/didRequestSplit',
    DidRequestFocus: 'layout/didRequestFocus',
    DidRequestOpenFile: 'layout/didRequestOpenFile',
    DidRequestPreset: 'layout/didRequestPreset',
    DidRequestClose: 'layout/didRequestClose',
    DidRequestCloseTab: 'layout/didRequestCloseTab',
    DidRequestActivateTab: 'layout/didRequestActivateTab',
    DidRequestState: 'layout/didRequestState',
  },

  // ── AI service ────────────────────────────────────────────────────────
  Ai: {
    StreamEvent: 'ai/stream/event',
    TodoUpdated: 'ai/todo/updated',

    // Dynamic session lifecycle (forwarded from ai service onSessionEvent)
    SessionCreated: 'ai/session_created',
    SessionDeleted: 'ai/session_deleted',
    SessionUpdated: 'ai/session_updated',
    MessageAdded: 'ai/message_added',

    Agent: {
      Handoff: 'ai/agent/handoff',
      Updated: 'ai/agent/updated',
      Joined: 'ai/agent/joined',
      Left: 'ai/agent/left',
    },

    Persona: {
      Created: 'ai/persona/created',
      Updated: 'ai/persona/updated',
      Deleted: 'ai/persona/deleted',
    },
  },

  // ── Agent service (standalone agent CRUD) ─────────────────────────────
  Agent: {
    Created: 'agent/created',
    Deleted: 'agent/deleted',
    Status: 'agent/status',
  },

  // ── Chat service ──────────────────────────────────────────────────────
  Chat: {
    Activity: 'chat/activity',

    Todo: {
      Replaced: 'chat/todo/replaced',
      Updated: 'chat/todo/updated',
      Deleted: 'chat/todo/deleted',
    },

    Document: {
      Created: 'chat/document/created',
      Updated: 'chat/document/updated',
      Deleted: 'chat/document/deleted',
    },
  },

  // ── Workflow service ──────────────────────────────────────────────────
  Workflow: {
    Created: 'workflow/created',
    Updated: 'workflow/updated',
    Deleted: 'workflow/deleted',
    DefaultChanged: 'workflow/defaultChanged',
    Activity: 'workflow/activity',
    Output: 'workflow/output',
    AwaitingInput: 'workflow/awaiting_input',
    SplitStarted: 'workflow/split/started',
    MergeCompleted: 'workflow/merge/completed',

    Execution: {
      Started: 'workflow/execution/started',
      Paused: 'workflow/execution/paused',
      Resumed: 'workflow/execution/resumed',
      Completed: 'workflow/execution/completed',
      Failed: 'workflow/execution/failed',
      Cancelled: 'workflow/execution/cancelled',
    },

    Message: {
      Created: 'workflow/message/created',
      Started: 'workflow/message/started',
      Delta: 'workflow/message/delta',
      Completed: 'workflow/message/completed',
      ToolUse: 'workflow/message/tool_use',
      Error: 'workflow/message/error',
    },

    Node: {
      Completed: 'workflow/node/completed',
    },

    Checkpoint: {
      Reached: 'workflow/checkpoint/reached',
      Responded: 'workflow/checkpoint/responded',
    },

    Permission: {
      Request: 'workflow/permission/request',
      Granted: 'workflow/permission/granted',
      Denied: 'workflow/permission/denied',
    },

    ToolCall: {
      Created: 'workflow/toolCall/created',
      Approved: 'workflow/toolCall/approved',
      Denied: 'workflow/toolCall/denied',
    },

    Tool: {
      Execution: 'workflow/tool/execution',
    },

    Agent: {
      Created: 'workflow/agent/created',
      Updated: 'workflow/agent/updated',
      Deleted: 'workflow/agent/deleted',
    },

    ReviewPanel: {
      Started: 'workflow/review_panel/started',
      Completed: 'workflow/review_panel/completed',
      Vote: 'workflow/review_panel/vote',
      Decision: 'workflow/review_panel/decision',
    },

    Context: {
      Added: 'workflow/context/added',
      Compacted: 'workflow/context/compacted',
      Expanded: 'workflow/context/expanded',
    },
  },
} as const;

// ── Utility type: union of all notification name strings ────────────────
type DeepValues<T> = T extends object ? DeepValues<T[keyof T]> : T;
export type NotificationName = DeepValues<typeof Notifications>;
