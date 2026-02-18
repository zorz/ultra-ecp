//! ECP method name constants — every JSON-RPC method grouped by namespace.
//!
//! Generated from the TypeScript protocol spec. Each constant is the exact
//! string sent over the wire as the `method` field of a JSON-RPC request.

/// All ECP method names, grouped by service namespace.
pub struct Methods;

impl Methods {
    // ── Document ────────────────────────────────────────────────────────
    pub const DOCUMENT_OPEN: &str = "document/open";
    pub const DOCUMENT_CLOSE: &str = "document/close";
    pub const DOCUMENT_INFO: &str = "document/info";
    pub const DOCUMENT_LIST: &str = "document/list";
    pub const DOCUMENT_CONTENT: &str = "document/content";
    pub const DOCUMENT_LINE: &str = "document/line";
    pub const DOCUMENT_LINES: &str = "document/lines";
    pub const DOCUMENT_TEXT_IN_RANGE: &str = "document/textInRange";
    pub const DOCUMENT_VERSION: &str = "document/version";
    pub const DOCUMENT_INSERT: &str = "document/insert";
    pub const DOCUMENT_DELETE: &str = "document/delete";
    pub const DOCUMENT_REPLACE: &str = "document/replace";
    pub const DOCUMENT_SET_CONTENT: &str = "document/setContent";
    pub const DOCUMENT_CURSORS: &str = "document/cursors";
    pub const DOCUMENT_SET_CURSORS: &str = "document/setCursors";
    pub const DOCUMENT_SET_CURSOR: &str = "document/setCursor";
    pub const DOCUMENT_ADD_CURSOR: &str = "document/addCursor";
    pub const DOCUMENT_MOVE_CURSORS: &str = "document/moveCursors";
    pub const DOCUMENT_SELECT_ALL: &str = "document/selectAll";
    pub const DOCUMENT_CLEAR_SELECTIONS: &str = "document/clearSelections";
    pub const DOCUMENT_SELECTIONS: &str = "document/selections";
    pub const DOCUMENT_UNDO: &str = "document/undo";
    pub const DOCUMENT_REDO: &str = "document/redo";
    pub const DOCUMENT_CAN_UNDO: &str = "document/canUndo";
    pub const DOCUMENT_CAN_REDO: &str = "document/canRedo";
    pub const DOCUMENT_IS_DIRTY: &str = "document/isDirty";
    pub const DOCUMENT_MARK_CLEAN: &str = "document/markClean";
    pub const DOCUMENT_POSITION_TO_OFFSET: &str = "document/positionToOffset";
    pub const DOCUMENT_OFFSET_TO_POSITION: &str = "document/offsetToPosition";
    pub const DOCUMENT_WORD_AT_POSITION: &str = "document/wordAtPosition";

    // ── File ────────────────────────────────────────────────────────────
    pub const FILE_READ: &str = "file/read";
    pub const FILE_WRITE: &str = "file/write";
    pub const FILE_STAT: &str = "file/stat";
    pub const FILE_EXISTS: &str = "file/exists";
    pub const FILE_DELETE: &str = "file/delete";
    pub const FILE_RENAME: &str = "file/rename";
    pub const FILE_COPY: &str = "file/copy";
    pub const FILE_READ_DIR: &str = "file/readDir";
    pub const FILE_LIST: &str = "file/list";
    pub const FILE_CREATE_DIR: &str = "file/createDir";
    pub const FILE_DELETE_DIR: &str = "file/deleteDir";
    pub const FILE_BROWSE_DIR: &str = "file/browseDir";
    pub const FILE_SEARCH: &str = "file/search";
    pub const FILE_GLOB: &str = "file/glob";
    pub const FILE_GREP: &str = "file/grep";
    pub const FILE_EDIT: &str = "file/edit";
    pub const FILE_WATCH: &str = "file/watch";
    pub const FILE_UNWATCH: &str = "file/unwatch";
    pub const FILE_PATH_TO_URI: &str = "file/pathToUri";
    pub const FILE_URI_TO_PATH: &str = "file/uriToPath";
    pub const FILE_GET_PARENT: &str = "file/getParent";
    pub const FILE_GET_BASENAME: &str = "file/getBasename";
    pub const FILE_JOIN: &str = "file/join";

    // ── Git ─────────────────────────────────────────────────────────────
    pub const GIT_IS_REPO: &str = "git/isRepo";
    pub const GIT_GET_ROOT: &str = "git/getRoot";
    pub const GIT_STATUS: &str = "git/status";
    pub const GIT_BRANCH: &str = "git/branch";
    pub const GIT_STAGE: &str = "git/stage";
    pub const GIT_STAGE_ALL: &str = "git/stageAll";
    pub const GIT_UNSTAGE: &str = "git/unstage";
    pub const GIT_DISCARD: &str = "git/discard";
    pub const GIT_DIFF: &str = "git/diff";
    pub const GIT_DIFF_LINES: &str = "git/diffLines";
    pub const GIT_DIFF_BUFFER: &str = "git/diffBuffer";
    pub const GIT_COMMIT: &str = "git/commit";
    pub const GIT_AMEND: &str = "git/amend";
    pub const GIT_LOG: &str = "git/log";
    pub const GIT_FILE_LOG: &str = "git/fileLog";
    pub const GIT_BRANCHES: &str = "git/branches";
    pub const GIT_CREATE_BRANCH: &str = "git/createBranch";
    pub const GIT_SWITCH_BRANCH: &str = "git/switchBranch";
    pub const GIT_DELETE_BRANCH: &str = "git/deleteBranch";
    pub const GIT_RENAME_BRANCH: &str = "git/renameBranch";
    pub const GIT_PUSH: &str = "git/push";
    pub const GIT_PULL: &str = "git/pull";
    pub const GIT_FETCH: &str = "git/fetch";
    pub const GIT_REMOTES: &str = "git/remotes";
    pub const GIT_SET_UPSTREAM: &str = "git/setUpstream";
    pub const GIT_MERGE: &str = "git/merge";
    pub const GIT_MERGE_ABORT: &str = "git/mergeAbort";
    pub const GIT_CONFLICTS: &str = "git/conflicts";
    pub const GIT_IS_MERGING: &str = "git/isMerging";
    pub const GIT_STASH: &str = "git/stash";
    pub const GIT_STASH_POP: &str = "git/stashPop";
    pub const GIT_STASH_LIST: &str = "git/stashList";
    pub const GIT_STASH_DROP: &str = "git/stashDrop";
    pub const GIT_STASH_APPLY: &str = "git/stashApply";
    pub const GIT_BLAME: &str = "git/blame";
    pub const GIT_SHOW: &str = "git/show";

    // ── Config ──────────────────────────────────────────────────────────
    pub const CONFIG_GET: &str = "config/get";
    pub const CONFIG_SET: &str = "config/set";
    pub const CONFIG_GET_ALL: &str = "config/getAll";
    pub const CONFIG_RESET: &str = "config/reset";
    pub const CONFIG_SCHEMA: &str = "config/schema";

    // ── Session ─────────────────────────────────────────────────────────
    pub const SESSION_SAVE: &str = "session/save";
    pub const SESSION_LOAD: &str = "session/load";
    pub const SESSION_LIST: &str = "session/list";
    pub const SESSION_DELETE: &str = "session/delete";
    pub const SESSION_CURRENT: &str = "session/current";
    pub const SESSION_SET_CURRENT: &str = "session/setCurrent";
    pub const SESSION_MARK_DIRTY: &str = "session/markDirty";
    pub const SESSION_LOAD_LAST: &str = "session/loadLast";

    // ── Terminal ────────────────────────────────────────────────────────
    pub const TERMINAL_CREATE: &str = "terminal/create";
    pub const TERMINAL_ATTACH_TMUX: &str = "terminal/attachTmux";
    pub const TERMINAL_CLOSE: &str = "terminal/close";
    pub const TERMINAL_CLOSE_ALL: &str = "terminal/closeAll";
    pub const TERMINAL_WRITE: &str = "terminal/write";
    pub const TERMINAL_RESIZE: &str = "terminal/resize";
    pub const TERMINAL_GET_BUFFER: &str = "terminal/getBuffer";
    pub const TERMINAL_SCROLL: &str = "terminal/scroll";
    pub const TERMINAL_SCROLL_TO_BOTTOM: &str = "terminal/scrollToBottom";
    pub const TERMINAL_GET_INFO: &str = "terminal/getInfo";
    pub const TERMINAL_LIST: &str = "terminal/list";
    pub const TERMINAL_EXISTS: &str = "terminal/exists";
    pub const TERMINAL_IS_RUNNING: &str = "terminal/isRunning";
    pub const TERMINAL_EXECUTE: &str = "terminal/execute";
    pub const TERMINAL_SPAWN: &str = "terminal/spawn";

    // ── LSP ─────────────────────────────────────────────────────────────
    pub const LSP_START: &str = "lsp/start";
    pub const LSP_STOP: &str = "lsp/stop";
    pub const LSP_STATUS: &str = "lsp/status";
    pub const LSP_DOCUMENT_OPEN: &str = "lsp/documentOpen";
    pub const LSP_DOCUMENT_CHANGE: &str = "lsp/documentChange";
    pub const LSP_DOCUMENT_SAVE: &str = "lsp/documentSave";
    pub const LSP_DOCUMENT_CLOSE: &str = "lsp/documentClose";
    pub const LSP_COMPLETION: &str = "lsp/completion";
    pub const LSP_HOVER: &str = "lsp/hover";
    pub const LSP_SIGNATURE_HELP: &str = "lsp/signatureHelp";
    pub const LSP_DEFINITION: &str = "lsp/definition";
    pub const LSP_REFERENCES: &str = "lsp/references";
    pub const LSP_DOCUMENT_SYMBOL: &str = "lsp/documentSymbol";
    pub const LSP_RENAME: &str = "lsp/rename";
    pub const LSP_DIAGNOSTICS: &str = "lsp/diagnostics";
    pub const LSP_ALL_DIAGNOSTICS: &str = "lsp/allDiagnostics";
    pub const LSP_DIAGNOSTICS_SUMMARY: &str = "lsp/diagnosticsSummary";
    pub const LSP_SET_SERVER_CONFIG: &str = "lsp/setServerConfig";
    pub const LSP_GET_SERVER_CONFIG: &str = "lsp/getServerConfig";
    pub const LSP_GET_LANGUAGE_ID: &str = "lsp/getLanguageId";
    pub const LSP_HAS_SERVER_FOR: &str = "lsp/hasServerFor";

    // ── Secret ──────────────────────────────────────────────────────────
    pub const SECRET_GET: &str = "secret/get";
    pub const SECRET_SET: &str = "secret/set";
    pub const SECRET_DELETE: &str = "secret/delete";
    pub const SECRET_LIST: &str = "secret/list";
    pub const SECRET_HAS: &str = "secret/has";
    pub const SECRET_INFO: &str = "secret/info";
    pub const SECRET_PROVIDERS: &str = "secret/providers";

    // ── Database ────────────────────────────────────────────────────────
    pub const DATABASE_CREATE_CONNECTION: &str = "database/createConnection";
    pub const DATABASE_CONNECT: &str = "database/connect";
    pub const DATABASE_DISCONNECT: &str = "database/disconnect";
    pub const DATABASE_DELETE_CONNECTION: &str = "database/deleteConnection";
    pub const DATABASE_LIST_CONNECTIONS: &str = "database/listConnections";
    pub const DATABASE_GET_CONNECTION: &str = "database/getConnection";
    pub const DATABASE_TEST_CONNECTION: &str = "database/testConnection";
    pub const DATABASE_UPDATE_CONNECTION: &str = "database/updateConnection";
    pub const DATABASE_QUERY: &str = "database/query";
    pub const DATABASE_TRANSACTION: &str = "database/transaction";
    pub const DATABASE_CANCEL: &str = "database/cancel";
    pub const DATABASE_FETCH_ROWS: &str = "database/fetchRows";
    pub const DATABASE_LIST_SCHEMAS: &str = "database/listSchemas";
    pub const DATABASE_LIST_TABLES: &str = "database/listTables";
    pub const DATABASE_DESCRIBE_TABLE: &str = "database/describeTable";
    pub const DATABASE_GET_TABLE_DDL: &str = "database/getTableDDL";
    pub const DATABASE_HISTORY: &str = "database/history";
    pub const DATABASE_SEARCH_HISTORY: &str = "database/searchHistory";
    pub const DATABASE_CLEAR_HISTORY: &str = "database/clearHistory";
    pub const DATABASE_FAVORITE_QUERY: &str = "database/favoriteQuery";
    pub const DATABASE_GET_FAVORITES: &str = "database/getFavorites";

    // ── AI ──────────────────────────────────────────────────────────────
    pub const AI_PROVIDERS: &str = "ai/providers";
    pub const AI_PROVIDER_CAPABILITIES: &str = "ai/provider/capabilities";
    pub const AI_PROVIDER_AVAILABLE: &str = "ai/provider/available";
    pub const AI_PROVIDER_MODELS: &str = "ai/provider/models";
    pub const AI_SESSION_CREATE: &str = "ai/session/create";
    pub const AI_SESSION_GET: &str = "ai/session/get";
    pub const AI_SESSION_LIST: &str = "ai/session/list";
    pub const AI_SESSION_DELETE: &str = "ai/session/delete";
    pub const AI_SESSION_CLEAR: &str = "ai/session/clear";
    pub const AI_MESSAGE_SEND: &str = "ai/message/send";
    pub const AI_MESSAGE_STREAM: &str = "ai/message/stream";
    pub const AI_MESSAGE_CANCEL: &str = "ai/message/cancel";
    pub const AI_MESSAGE_ADD: &str = "ai/message/add";
    pub const AI_MESSAGES: &str = "ai/messages";
    pub const AI_TOOLS: &str = "ai/tools";
    pub const AI_TOOLS_ECP: &str = "ai/tools/ecp";
    pub const AI_TOOL_EXECUTE: &str = "ai/tool/execute";
    pub const AI_PERMISSION_APPROVE: &str = "ai/permission/approve";
    pub const AI_PERMISSION_DENY: &str = "ai/permission/deny";

    // ── Chat ────────────────────────────────────────────────────────────
    pub const CHAT_SESSION_CREATE: &str = "chat/session/create";
    pub const CHAT_SESSION_GET: &str = "chat/session/get";
    pub const CHAT_SESSION_UPDATE: &str = "chat/session/update";
    pub const CHAT_SESSION_DELETE: &str = "chat/session/delete";
    pub const CHAT_SESSION_LIST: &str = "chat/session/list";
    pub const CHAT_MESSAGE_ADD: &str = "chat/message/add";
    pub const CHAT_MESSAGE_UPDATE: &str = "chat/message/update";
    pub const CHAT_MESSAGE_DELETE: &str = "chat/message/delete";
    pub const CHAT_MESSAGE_LIST: &str = "chat/message/list";
    pub const CHAT_MESSAGE_SEARCH: &str = "chat/message/search";

    // ── Workflow ─────────────────────────────────────────────────────────
    pub const WORKFLOW_LIST: &str = "workflow/list";
    pub const WORKFLOW_GET: &str = "workflow/get";
    pub const WORKFLOW_CREATE: &str = "workflow/create";
    pub const WORKFLOW_UPDATE: &str = "workflow/update";
    pub const WORKFLOW_DELETE: &str = "workflow/delete";
    pub const WORKFLOW_EXECUTE_START: &str = "workflow/execute/start";
    pub const WORKFLOW_EXECUTE_STEP: &str = "workflow/execute/step";
    pub const WORKFLOW_EXECUTE_PAUSE: &str = "workflow/execute/pause";
    pub const WORKFLOW_EXECUTE_RESUME: &str = "workflow/execute/resume";
    pub const WORKFLOW_EXECUTE_CANCEL: &str = "workflow/execute/cancel";
    pub const WORKFLOW_EXECUTE_GET: &str = "workflow/execute/get";
    pub const WORKFLOW_EXECUTE_LIST: &str = "workflow/execute/list";

    // ── Auth ────────────────────────────────────────────────────────────
    pub const AUTH_PROVIDERS: &str = "auth/providers";
    pub const AUTH_STATUS: &str = "auth/status";
    pub const AUTH_OAUTH_START: &str = "auth/oauth/start";
    pub const AUTH_OAUTH_CALLBACK: &str = "auth/oauth/callback";
    pub const AUTH_APIKEY_SET: &str = "auth/apikey/set";
    pub const AUTH_APIKEY_GET: &str = "auth/apikey/get";
    pub const AUTH_APIKEY_DELETE: &str = "auth/apikey/delete";
    pub const AUTH_LOGOUT: &str = "auth/logout";

    // ── Models ──────────────────────────────────────────────────────────
    pub const MODELS_LIST: &str = "models/list";
    pub const MODELS_REFRESH: &str = "models/refresh";

    // ── Layout ──────────────────────────────────────────────────────────
    pub const LAYOUT_ADD_TAB: &str = "layout/addTab";
    pub const LAYOUT_SPLIT_TILE: &str = "layout/splitTile";
    pub const LAYOUT_FOCUS_TILE: &str = "layout/focusTile";
    pub const LAYOUT_OPEN_FILE: &str = "layout/openFile";
    pub const LAYOUT_SET_PRESET: &str = "layout/setPreset";
    pub const LAYOUT_CLOSE_TILE: &str = "layout/closeTile";
    pub const LAYOUT_GET_LAYOUT: &str = "layout/getLayout";
    pub const LAYOUT_REPORT_STATE: &str = "layout/reportState";
    pub const LAYOUT_CLOSE_TAB: &str = "layout/closeTab";
    pub const LAYOUT_ACTIVATE_TAB: &str = "layout/activateTab";
}

/// Union type for method name validation.
/// Returns true if the given string is a known ECP method.
pub fn is_known_method(method: &str) -> bool {
    // Route by namespace prefix for O(1) dispatch
    match method.split('/').next() {
        Some("document") | Some("file") | Some("git") | Some("config") |
        Some("session") | Some("keybindings") | Some("commands") |
        Some("theme") | Some("workspace") | Some("systemPrompt") |
        Some("terminal") | Some("lsp") | Some("syntax") | Some("secret") |
        Some("database") | Some("ai") | Some("chat") | Some("workflow") |
        Some("agent") | Some("auth") | Some("models") | Some("layout") |
        Some("shell") => true,
        _ => false,
    }
}

/// Type alias — the method name is always a `&str` at the protocol level.
pub type MethodName = &'static str;
