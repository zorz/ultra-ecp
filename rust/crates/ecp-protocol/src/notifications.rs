//! ECP notification event name constants.
//!
//! Notifications are server-to-client messages with no response expected.
//! Clients subscribe to these for real-time updates.

/// All ECP notification names, grouped by service namespace.
pub struct Notifications;

impl Notifications {
    // ── Authentication ──────────────────────────────────────────────────
    pub const AUTH_REQUIRED: &str = "auth/required";

    // ── Server lifecycle ────────────────────────────────────────────────
    pub const SERVER_CONNECTED: &str = "server/connected";

    // ── File system ─────────────────────────────────────────────────────
    pub const FILE_DID_CHANGE: &str = "file/didChange";
    pub const FILE_DID_CREATE: &str = "file/didCreate";
    pub const FILE_DID_DELETE: &str = "file/didDelete";

    // ── Terminal ────────────────────────────────────────────────────────
    pub const TERMINAL_OUTPUT: &str = "terminal/output";
    pub const TERMINAL_EXIT: &str = "terminal/exit";
    pub const TERMINAL_TITLE: &str = "terminal/title";

    // ── Document ────────────────────────────────────────────────────────
    pub const DOCUMENT_DID_CHANGE: &str = "document/didChange";
    pub const DOCUMENT_DID_CHANGE_CURSORS: &str = "document/didChangeCursors";
    pub const DOCUMENT_DID_OPEN: &str = "document/didOpen";
    pub const DOCUMENT_DID_CLOSE: &str = "document/didClose";

    // ── LSP ─────────────────────────────────────────────────────────────
    pub const LSP_DID_PUBLISH_DIAGNOSTICS: &str = "lsp/didPublishDiagnostics";
    pub const LSP_SERVER_STATUS_CHANGED: &str = "lsp/serverStatusChanged";

    // ── Theme ───────────────────────────────────────────────────────────
    pub const THEME_CHANGED: &str = "theme/changed";

    // ── Workspace ───────────────────────────────────────────────────────
    pub const WORKSPACE_DID_CHANGE_ROOT: &str = "workspace/didChangeRoot";

    // ── UI ──────────────────────────────────────────────────────────────
    pub const UI_SET_LAYOUT: &str = "ui/setLayout";
    pub const UI_ADD_PANEL: &str = "ui/addPanel";
    pub const UI_REMOVE_PANEL: &str = "ui/removePanel";
    pub const UI_UPDATE_PANEL: &str = "ui/updatePanel";

    // ── Layout ──────────────────────────────────────────────────────────
    pub const LAYOUT_DID_REQUEST_ADD_TAB: &str = "layout/didRequestAddTab";
    pub const LAYOUT_DID_REQUEST_SPLIT: &str = "layout/didRequestSplit";
    pub const LAYOUT_DID_REQUEST_FOCUS: &str = "layout/didRequestFocus";
    pub const LAYOUT_DID_REQUEST_OPEN_FILE: &str = "layout/didRequestOpenFile";
    pub const LAYOUT_DID_REQUEST_PRESET: &str = "layout/didRequestPreset";
    pub const LAYOUT_DID_REQUEST_CLOSE: &str = "layout/didRequestClose";

    // ── AI ──────────────────────────────────────────────────────────────
    pub const AI_STREAM_EVENT: &str = "ai/stream/event";
    pub const AI_TODO_UPDATED: &str = "ai/todo/updated";
    pub const AI_SESSION_CREATED: &str = "ai/session_created";
    pub const AI_SESSION_DELETED: &str = "ai/session_deleted";
    pub const AI_SESSION_UPDATED: &str = "ai/session_updated";
    pub const AI_MESSAGE_ADDED: &str = "ai/message_added";
    pub const AI_AGENT_HANDOFF: &str = "ai/agent/handoff";
    pub const AI_AGENT_UPDATED: &str = "ai/agent/updated";

    // ── Workflow ─────────────────────────────────────────────────────────
    pub const WORKFLOW_CREATED: &str = "workflow/created";
    pub const WORKFLOW_UPDATED: &str = "workflow/updated";
    pub const WORKFLOW_DELETED: &str = "workflow/deleted";
    pub const WORKFLOW_ACTIVITY: &str = "workflow/activity";
    pub const WORKFLOW_OUTPUT: &str = "workflow/output";
    pub const WORKFLOW_EXECUTION_STARTED: &str = "workflow/execution/started";
    pub const WORKFLOW_EXECUTION_PAUSED: &str = "workflow/execution/paused";
    pub const WORKFLOW_EXECUTION_COMPLETED: &str = "workflow/execution/completed";
    pub const WORKFLOW_EXECUTION_FAILED: &str = "workflow/execution/failed";
    pub const WORKFLOW_EXECUTION_CANCELLED: &str = "workflow/execution/cancelled";
    pub const WORKFLOW_MESSAGE_DELTA: &str = "workflow/message/delta";
    pub const WORKFLOW_MESSAGE_COMPLETED: &str = "workflow/message/completed";
    pub const WORKFLOW_CHECKPOINT_REACHED: &str = "workflow/checkpoint/reached";
    pub const WORKFLOW_PERMISSION_REQUEST: &str = "workflow/permission/request";
    pub const WORKFLOW_TOOL_EXECUTION: &str = "workflow/tool/execution";

    // ── Chat ────────────────────────────────────────────────────────────
    pub const CHAT_ACTIVITY: &str = "chat/activity";
    pub const CHAT_TODO_REPLACED: &str = "chat/todo/replaced";
    pub const CHAT_TODO_UPDATED: &str = "chat/todo/updated";
    pub const CHAT_DOCUMENT_CREATED: &str = "chat/document/created";
    pub const CHAT_DOCUMENT_UPDATED: &str = "chat/document/updated";

    // ── Agent ───────────────────────────────────────────────────────────
    pub const AGENT_CREATED: &str = "agent/created";
    pub const AGENT_DELETED: &str = "agent/deleted";
    pub const AGENT_STATUS: &str = "agent/status";
}

/// Type alias for notification names.
pub type NotificationName = &'static str;
