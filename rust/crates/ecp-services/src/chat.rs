//! Chat service — SQLite-backed session/message storage with tool tracking, todos, and permissions.
//!
//! Schema matches the TypeScript ECP unified schema (migration 005) exactly,
//! ensuring 1:1 compatibility with existing `.ultra/chat.db` databases.

use std::sync::Arc;

use ecp_protocol::{ECPError, HandlerResult};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::Service;

// ─────────────────────────────────────────────────────────────────────────────
// Unified schema — matches TypeScript migration 005 exactly
// ─────────────────────────────────────────────────────────────────────────────

/// Full DDL from TypeScript migration 005 (unified schema).
/// Table creation order respects foreign key dependencies.
const UNIFIED_SCHEMA: &str = r#"
-- ============================================================================
-- Agent Registry
-- ============================================================================

CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    role TEXT CHECK(role IN ('primary', 'specialist', 'reviewer', 'orchestrator')) DEFAULT 'primary',
    provider TEXT NOT NULL DEFAULT 'claude',
    model TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
    system_prompt TEXT,
    tools TEXT,
    persona TEXT,
    is_system INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);
CREATE INDEX IF NOT EXISTS idx_agents_role ON agents(role);
CREATE INDEX IF NOT EXISTS idx_agents_active ON agents(is_active);

-- ============================================================================
-- Workflows
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    source_type TEXT CHECK(source_type IN ('file', 'inline')) DEFAULT 'inline',
    source_path TEXT,
    definition TEXT,
    trigger_type TEXT CHECK(trigger_type IN ('manual', 'on_message', 'on_file_change', 'scheduled')),
    trigger_config TEXT,
    is_system INTEGER DEFAULT 0,
    is_default INTEGER DEFAULT 0,
    agent_pool TEXT,
    default_agent_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_workflows_name ON workflows(name);
CREATE INDEX IF NOT EXISTS idx_workflows_default ON workflows(is_default);

-- ============================================================================
-- Sessions
-- ============================================================================

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT,
    workflow_id TEXT,
    provider TEXT NOT NULL DEFAULT 'claude',
    model TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
    system_prompt TEXT,
    status TEXT NOT NULL CHECK(status IN (
        'pending', 'active', 'running', 'paused', 'awaiting_input',
        'completed', 'failed', 'cancelled', 'archived'
    )) DEFAULT 'active',
    current_node_id TEXT,
    iteration_count INTEGER DEFAULT 0,
    max_iterations INTEGER DEFAULT 10,
    initial_input TEXT,
    final_output TEXT,
    error_message TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER,
    completed_at INTEGER,
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_workflow ON sessions(workflow_id);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

-- ============================================================================
-- Session Agents
-- ============================================================================

CREATE TABLE IF NOT EXISTS session_agents (
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    role TEXT DEFAULT 'primary',
    joined_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    left_at INTEGER,
    PRIMARY KEY (session_id, agent_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_agents_agent ON session_agents(agent_id);

-- ============================================================================
-- Node Executions
-- ============================================================================

CREATE TABLE IF NOT EXISTS node_executions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    node_type TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN (
        'pending', 'running', 'completed', 'failed', 'skipped'
    )) DEFAULT 'pending',
    iteration_number INTEGER DEFAULT 0,
    input TEXT,
    output TEXT,
    agent_id TEXT,
    agent_name TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    duration_ms INTEGER,
    tokens_in INTEGER,
    tokens_out INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_node_exec_session ON node_executions(session_id);
CREATE INDEX IF NOT EXISTS idx_node_exec_status ON node_executions(status);
CREATE INDEX IF NOT EXISTS idx_node_exec_agent ON node_executions(agent_id);

-- ============================================================================
-- Messages
-- ============================================================================

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    node_execution_id TEXT,
    role TEXT NOT NULL CHECK(role IN (
        'user', 'assistant', 'system',
        'tool_call', 'tool_result', 'feedback'
    )),
    content TEXT NOT NULL,
    agent_id TEXT,
    agent_name TEXT,
    agent_role TEXT,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    tokens INTEGER,
    duration_ms INTEGER,
    feedback_source_agent_id TEXT,
    feedback_target_agent_id TEXT,
    feedback_vote TEXT CHECK(feedback_vote IN ('critical', 'queue', 'approve')),
    feedback_status TEXT CHECK(feedback_status IN ('pending', 'addressed', 'queued', 'dismissed')),
    is_active INTEGER DEFAULT 1,
    compacted_into_id TEXT,
    is_complete INTEGER DEFAULT 1,
    iteration_number INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (node_execution_id) REFERENCES node_executions(id) ON DELETE SET NULL,
    FOREIGN KEY (compacted_into_id) REFERENCES messages(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(session_id, role);
CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id);
CREATE INDEX IF NOT EXISTS idx_messages_active ON messages(session_id, is_active);
CREATE INDEX IF NOT EXISTS idx_messages_node ON messages(node_execution_id);
CREATE INDEX IF NOT EXISTS idx_messages_streaming ON messages(session_id, is_complete) WHERE is_complete = 0;
CREATE INDEX IF NOT EXISTS idx_messages_feedback ON messages(session_id, role, feedback_status) WHERE role = 'feedback';

-- ============================================================================
-- Tool Calls
-- ============================================================================

CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    message_id TEXT,
    node_execution_id TEXT,
    agent_id TEXT,
    agent_name TEXT,
    tool_name TEXT NOT NULL,
    input TEXT,
    output TEXT,
    status TEXT NOT NULL CHECK(status IN (
        'pending', 'awaiting_permission', 'approved', 'denied',
        'running', 'success', 'error'
    )) DEFAULT 'pending',
    error_message TEXT,
    started_at INTEGER DEFAULT (unixepoch() * 1000),
    completed_at INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL,
    FOREIGN KEY (node_execution_id) REFERENCES node_executions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_status ON tool_calls(status);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_calls_agent ON tool_calls(agent_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_node ON tool_calls(node_execution_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_message ON tool_calls(message_id);

-- ============================================================================
-- Documents
-- ============================================================================

CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    agent_id TEXT,
    doc_type TEXT NOT NULL CHECK(doc_type IN (
        'prd', 'assessment', 'vulnerability', 'spec', 'plan',
        'report', 'decision', 'runbook', 'review', 'note'
    )),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    summary TEXT,
    metadata TEXT,
    parent_id TEXT,
    status TEXT DEFAULT 'draft' CHECK(status IN (
        'draft', 'active', 'in_review', 'approved',
        'rejected', 'completed', 'archived'
    )),
    severity TEXT CHECK(severity IN ('info', 'low', 'medium', 'high', 'critical')),
    priority INTEGER DEFAULT 0,
    reviewed_by_agent_id TEXT,
    review_status TEXT CHECK(review_status IN (
        'pending', 'approved', 'changes_requested', 'critical'
    )),
    file_path TEXT,
    validation_criteria TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL,
    FOREIGN KEY (parent_id) REFERENCES documents(id) ON DELETE SET NULL,
    FOREIGN KEY (reviewed_by_agent_id) REFERENCES agents(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(doc_type);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_agent ON documents(agent_id);
CREATE INDEX IF NOT EXISTS idx_documents_session ON documents(session_id);
CREATE INDEX IF NOT EXISTS idx_documents_parent ON documents(parent_id);
CREATE INDEX IF NOT EXISTS idx_documents_severity ON documents(severity) WHERE severity IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_review ON documents(review_status) WHERE review_status IS NOT NULL;

-- ============================================================================
-- Todos
-- ============================================================================

CREATE TABLE IF NOT EXISTS todos (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    document_id TEXT,
    agent_id TEXT,
    assigned_agent_id TEXT,
    content TEXT NOT NULL,
    active_form TEXT,
    status TEXT NOT NULL CHECK(status IN (
        'pending', 'in_progress', 'completed', 'blocked'
    )) DEFAULT 'pending',
    order_index INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER,
    completed_at INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE SET NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL,
    FOREIGN KEY (assigned_agent_id) REFERENCES agents(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_todos_session ON todos(session_id);
CREATE INDEX IF NOT EXISTS idx_todos_document ON todos(document_id);
CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
CREATE INDEX IF NOT EXISTS idx_todos_agent ON todos(agent_id);
CREATE INDEX IF NOT EXISTS idx_todos_assigned ON todos(assigned_agent_id);

-- ============================================================================
-- Permissions
-- ============================================================================

CREATE TABLE IF NOT EXISTS permissions (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    workflow_id TEXT,
    tool_name TEXT NOT NULL,
    pattern TEXT,
    scope TEXT NOT NULL CHECK(scope IN (
        'once', 'session', 'workflow', 'project', 'global'
    )),
    decision TEXT NOT NULL CHECK(decision IN ('approved', 'denied')),
    granted_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    expires_at INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_permissions_session ON permissions(session_id);
CREATE INDEX IF NOT EXISTS idx_permissions_tool ON permissions(tool_name);
CREATE INDEX IF NOT EXISTS idx_permissions_scope ON permissions(scope);
CREATE UNIQUE INDEX IF NOT EXISTS idx_permissions_unique ON permissions(
    tool_name, scope,
    COALESCE(session_id, ''),
    COALESCE(workflow_id, ''),
    COALESCE(pattern, '')
);

-- ============================================================================
-- Checkpoints
-- ============================================================================

CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    node_execution_id TEXT,
    checkpoint_type TEXT NOT NULL CHECK(checkpoint_type IN (
        'approval', 'arbiter', 'input_required', 'confirmation'
    )),
    prompt_message TEXT,
    options TEXT,
    decision TEXT,
    feedback TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    decided_at INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (node_execution_id) REFERENCES node_executions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_pending ON checkpoints(session_id, decided_at) WHERE decided_at IS NULL;

-- ============================================================================
-- Feedback Queue
-- ============================================================================

CREATE TABLE IF NOT EXISTS feedback_queue (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN (
        'queued', 'pending_review', 'addressed', 'dismissed'
    )) DEFAULT 'queued',
    priority INTEGER DEFAULT 0,
    surface_trigger TEXT CHECK(surface_trigger IN (
        'task_complete', 'iteration_end', 'manual', 'immediate'
    )) DEFAULT 'iteration_end',
    queued_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    surfaced_at INTEGER,
    resolved_at INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_feedback_session ON feedback_queue(session_id);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback_queue(status);
CREATE INDEX IF NOT EXISTS idx_feedback_pending ON feedback_queue(session_id, status)
    WHERE status IN ('queued', 'pending_review');

-- ============================================================================
-- Review Panels
-- ============================================================================

CREATE TABLE IF NOT EXISTS review_panels (
    id TEXT PRIMARY KEY,
    node_execution_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    config TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    outcome TEXT,
    summary TEXT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    error TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_review_panels_session ON review_panels(session_id);
CREATE INDEX IF NOT EXISTS idx_review_panels_status ON review_panels(status);

CREATE TABLE IF NOT EXISTS review_votes (
    id TEXT PRIMARY KEY,
    panel_id TEXT NOT NULL,
    reviewer_id TEXT NOT NULL,
    vote TEXT NOT NULL,
    feedback TEXT NOT NULL,
    issues TEXT,
    weight REAL NOT NULL DEFAULT 1.0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (panel_id) REFERENCES review_panels(id) ON DELETE CASCADE,
    FOREIGN KEY (reviewer_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_review_votes_panel ON review_votes(panel_id);
CREATE INDEX IF NOT EXISTS idx_review_votes_reviewer ON review_votes(reviewer_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_votes_unique ON review_votes(panel_id, reviewer_id);

-- ============================================================================
-- Compactions
-- ============================================================================

CREATE TABLE IF NOT EXISTS compactions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    start_message_id TEXT,
    end_message_id TEXT,
    original_token_count INTEGER,
    compressed_token_count INTEGER,
    messages_compacted INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_compactions_session ON compactions(session_id);

-- ============================================================================
-- Activity log (Rust addition — compatible extension)
-- ============================================================================

CREATE TABLE IF NOT EXISTS activity (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    summary TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_session ON activity(session_id, created_at);

-- ============================================================================
-- Schema version tracking
-- ============================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
);
"#;

// ─────────────────────────────────────────────────────────────────────────────
// Database wrapper (rusqlite is sync — we run it on spawn_blocking)
// ─────────────────────────────────────────────────────────────────────────────

struct ChatDb {
    conn: rusqlite::Connection,
}

impl ChatDb {
    fn open(path: &std::path::Path) -> Result<Self, rusqlite::Error> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = rusqlite::Connection::open(path)?;
        // journal_mode returns a row — use query form since extra_check rejects it via execute_batch
        let _: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        let db = Self { conn };
        db.run_migrations()?;
        Ok(db)
    }

    fn run_migrations(&self) -> Result<(), rusqlite::Error> {
        // Phase 1: Migrate from old Rust schema if needed
        // (handles databases created by the simplified Rust schema)

        // Rename documents.type → doc_type (old Rust schema used "type")
        if self.column_exists("documents", "type") && !self.column_exists("documents", "doc_type") {
            let _ = self.conn.execute_batch("ALTER TABLE documents RENAME COLUMN \"type\" TO doc_type");
        }

        // Rename compaction columns to match TS names
        if self.column_exists("compactions", "message_count") && !self.column_exists("compactions", "messages_compacted") {
            let _ = self.conn.execute_batch("ALTER TABLE compactions RENAME COLUMN message_count TO messages_compacted");
            let _ = self.conn.execute_batch("ALTER TABLE compactions RENAME COLUMN tokens_before TO original_token_count");
            let _ = self.conn.execute_batch("ALTER TABLE compactions RENAME COLUMN tokens_after TO compressed_token_count");
        }

        // Phase 2: Create all tables (CREATE TABLE IF NOT EXISTS — safe for all cases)
        self.conn.execute_batch(UNIFIED_SCHEMA)?;

        // Phase 2b: Seed data — INSERT statements must use conn.execute (not execute_batch)
        // because rusqlite's execute_batch uses prepared statements which reject INSERT.
        self.seed_default_agents();
        let _ = self.conn.execute(
            "INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (5, 'unified-schema', datetime('now'))",
            [],
        );

        // Phase 3: FTS5 full-text search on messages (separate to handle gracefully)
        let _ = self.conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                content,
                content='messages',
                content_rowid='rowid'
            )"
        );
        let _ = self.conn.execute_batch(
            "CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
                INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
            END"
        );
        let _ = self.conn.execute_batch(
            "CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
                INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
            END"
        );
        let _ = self.conn.execute_batch(
            "CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF content ON messages BEGIN
                INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
                INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
            END"
        );

        // Phase 4: Add missing columns to tables that existed before migration
        // (handles the transition from old Rust schema to unified schema)
        self.ensure_column("sessions", "workflow_id", "TEXT");
        self.ensure_column("sessions", "current_node_id", "TEXT");
        self.ensure_column("sessions", "iteration_count", "INTEGER DEFAULT 0");
        self.ensure_column("sessions", "max_iterations", "INTEGER DEFAULT 10");
        self.ensure_column("sessions", "initial_input", "TEXT");
        self.ensure_column("sessions", "final_output", "TEXT");
        self.ensure_column("sessions", "error_message", "TEXT");
        self.ensure_column("sessions", "completed_at", "INTEGER");

        self.ensure_column("messages", "node_execution_id", "TEXT");
        self.ensure_column("messages", "agent_name", "TEXT");
        self.ensure_column("messages", "agent_role", "TEXT");
        self.ensure_column("messages", "tokens", "INTEGER");
        self.ensure_column("messages", "is_active", "INTEGER DEFAULT 1");
        self.ensure_column("messages", "is_complete", "INTEGER DEFAULT 1");
        self.ensure_column("messages", "compacted_into_id", "TEXT");
        self.ensure_column("messages", "iteration_number", "INTEGER DEFAULT 0");
        self.ensure_column("messages", "feedback_source_agent_id", "TEXT");
        self.ensure_column("messages", "feedback_target_agent_id", "TEXT");
        self.ensure_column("messages", "feedback_vote", "TEXT");
        self.ensure_column("messages", "feedback_status", "TEXT");

        self.ensure_column("tool_calls", "node_execution_id", "TEXT");
        self.ensure_column("tool_calls", "agent_name", "TEXT");

        self.ensure_column("todos", "document_id", "TEXT");
        self.ensure_column("todos", "agent_id", "TEXT");
        self.ensure_column("todos", "assigned_agent_id", "TEXT");

        self.ensure_column("permissions", "workflow_id", "TEXT");

        self.ensure_column("documents", "agent_id", "TEXT");
        self.ensure_column("documents", "summary", "TEXT");
        self.ensure_column("documents", "status", "TEXT DEFAULT 'draft'");
        self.ensure_column("documents", "severity", "TEXT");
        self.ensure_column("documents", "priority", "INTEGER DEFAULT 0");
        self.ensure_column("documents", "reviewed_by_agent_id", "TEXT");
        self.ensure_column("documents", "review_status", "TEXT");
        self.ensure_column("documents", "file_path", "TEXT");
        self.ensure_column("documents", "validation_criteria", "TEXT");

        Ok(())
    }

    fn seed_default_agents(&self) {
        let agents = [
            ("assistant", "Assistant", "General-purpose AI assistant for coding, analysis, and conversation", "primary",
             "You are a helpful AI assistant. You have access to tools to read, write, and edit files, search code, and run commands. Use these tools to help the user with their tasks.",
             r#"["Read", "Write", "Edit", "Glob", "Grep", "Bash"]"#),
            ("coder", "Coder", "Specialized agent for writing and modifying code", "specialist",
             "You are a skilled software engineer. Focus on writing clean, well-structured, correct code. Read relevant files before making changes to understand context.",
             r#"["Read", "Write", "Edit", "Glob", "Grep", "Bash"]"#),
            ("code-reviewer", "Code Reviewer", "Reviews code for correctness, style, and best practices", "reviewer",
             "You are a thorough code reviewer. Evaluate code changes for correctness, security, performance, and maintainability. Provide assessment as: VOTE: [approve|queue|critical] FEEDBACK: [details]",
             r#"["Read", "Glob", "Grep"]"#),
            ("architect", "Architect", "Reviews code from an architectural perspective", "reviewer",
             "You are a software architect. Review code from a high-level design perspective: system design, modularity, scalability, dependencies, patterns. Provide assessment as: VOTE: [approve|queue|critical] FEEDBACK: [details]",
             r#"["Read", "Glob", "Grep"]"#),
            ("planner", "Planner", "Helps break down tasks and create implementation plans", "orchestrator",
             "You are a technical planner. Break down complex tasks into manageable steps. Identify dependencies, prerequisites, and risks. Create clear, actionable plans.",
             r#"["Read", "Glob", "Grep"]"#),
            ("debugger", "Debugger", "Specialized in finding and fixing bugs", "specialist",
             "You are an expert debugger. Find and fix bugs using systematic debugging: reproduce, isolate, identify, fix, verify. Focus on root causes, not symptoms.",
             r#"["Read", "Write", "Edit", "Glob", "Grep", "Bash"]"#),
            ("security-auditor", "Security Auditor", "Identifies security vulnerabilities and recommends fixes", "reviewer",
             "You are a security auditor. Analyze code for vulnerabilities (OWASP Top 10, injection, auth issues, data exposure, etc.). Create vulnerability documents with severity ratings and remediation guidance.",
             r#"["Read", "Glob", "Grep"]"#),
        ];
        for (id, name, desc, role, prompt, tools) in &agents {
            let _ = self.conn.execute(
                "INSERT OR IGNORE INTO agents (id, name, description, role, provider, model, system_prompt, tools, is_system, created_at) VALUES (?1, ?2, ?3, ?4, 'claude', 'claude-sonnet-4-20250514', ?5, ?6, 1, unixepoch() * 1000)",
                rusqlite::params![id, name, desc, role, prompt, tools],
            );
        }
    }

    fn column_exists(&self, table: &str, column: &str) -> bool {
        self.conn
            .prepare(&format!("SELECT \"{column}\" FROM \"{table}\" LIMIT 0"))
            .is_ok()
    }

    fn ensure_column(&self, table: &str, column: &str, definition: &str) {
        if !self.column_exists(table, column) {
            let _ = self.conn.execute_batch(&format!(
                "ALTER TABLE \"{table}\" ADD COLUMN \"{column}\" {definition}"
            ));
        }
    }

    // ── Session CRUD ─────────────────────────────────────────────────────

    fn create_session(
        &self, id: &str, title: Option<&str>, provider: &str, model: &str,
        system_prompt: Option<&str>, workflow_id: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        let now = now_ms() as i64;
        self.conn.execute(
            "INSERT INTO sessions (id, title, provider, model, system_prompt, workflow_id, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?7)",
            rusqlite::params![id, title, provider, model, system_prompt, workflow_id, now],
        )?;
        Ok(())
    }

    fn get_session(&self, id: &str) -> Result<Option<Value>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, workflow_id, provider, model, system_prompt, status,
                    current_node_id, iteration_count, max_iterations,
                    initial_input, final_output, error_message,
                    created_at, updated_at, completed_at
             FROM sessions WHERE id = ?1"
        )?;
        let mut rows = stmt.query(rusqlite::params![id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(session_row_to_json(row)?))
        } else {
            Ok(None)
        }
    }

    fn update_session(
        &self, id: &str, title: Option<&str>, status: Option<&str>,
        model: Option<&str>, provider: Option<&str>, system_prompt: Option<&str>,
        error_message: Option<&str>,
    ) -> Result<bool, rusqlite::Error> {
        let now = now_ms() as i64;
        let mut sets = vec!["updated_at = ?1".to_string()];
        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(now)];
        let mut idx = 2u32;

        macro_rules! add_set {
            ($field:expr, $col:expr) => {
                if let Some(v) = $field {
                    sets.push(format!("{} = ?{}", $col, idx));
                    params_vec.push(Box::new(v.to_string()));
                    idx += 1;
                }
            };
        }

        add_set!(title, "title");
        add_set!(status, "status");
        add_set!(model, "model");
        add_set!(provider, "provider");
        add_set!(system_prompt, "system_prompt");
        add_set!(error_message, "error_message");

        // If status is a terminal state, set completed_at
        if let Some(s) = status {
            if matches!(s, "completed" | "failed" | "cancelled") {
                sets.push(format!("completed_at = ?{}", idx));
                params_vec.push(Box::new(now));
                idx += 1;
            }
        }

        let sql = format!("UPDATE sessions SET {} WHERE id = ?{}", sets.join(", "), idx);
        params_vec.push(Box::new(id.to_string()));

        let params_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        let changed = self.conn.execute(&sql, params_refs.as_slice())?;
        Ok(changed > 0)
    }

    fn delete_session(&self, id: &str) -> Result<bool, rusqlite::Error> {
        let changed = self.conn.execute("DELETE FROM sessions WHERE id = ?1", rusqlite::params![id])?;
        Ok(changed > 0)
    }

    fn list_sessions(&self, limit: i64, offset: i64) -> Result<Vec<Value>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT s.id, s.title, s.provider, s.model, s.created_at,
                    COUNT(m.id) as message_count,
                    MAX(m.created_at) as last_message_at
             FROM sessions s
             LEFT JOIN messages m ON m.session_id = s.id
             GROUP BY s.id
             ORDER BY s.updated_at DESC NULLS LAST, s.created_at DESC
             LIMIT ?1 OFFSET ?2"
        )?;
        let rows = stmt.query_map(rusqlite::params![limit, offset], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "title": row.get::<_, Option<String>>(1)?,
                "provider": row.get::<_, String>(2)?,
                "model": row.get::<_, String>(3)?,
                "createdAt": row.get::<_, i64>(4)?,
                "messageCount": row.get::<_, i64>(5)?,
                "lastMessageAt": row.get::<_, Option<i64>>(6)?,
            }))
        })?;
        rows.collect()
    }

    // ── Message CRUD ─────────────────────────────────────────────────────

    fn add_message(
        &self, id: &str, session_id: &str, role: &str, content: &str,
        model: Option<&str>, input_tokens: Option<i64>, output_tokens: Option<i64>,
        duration_ms: Option<i64>, agent_id: Option<&str>, agent_name: Option<&str>,
        agent_role: Option<&str>, tokens: Option<i64>, is_complete: Option<bool>,
        iteration_number: Option<i64>,
    ) -> Result<(), rusqlite::Error> {
        let now = now_ms() as i64;
        let is_complete_val = if is_complete.unwrap_or(true) { 1i32 } else { 0i32 };
        let iter_num = iteration_number.unwrap_or(0);
        self.conn.execute(
            "INSERT INTO messages (id, session_id, role, content, model, input_tokens, output_tokens,
             duration_ms, agent_id, agent_name, agent_role, tokens, is_active, is_complete,
             iteration_number, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, ?13, ?14, ?15)",
            rusqlite::params![id, session_id, role, content, model, input_tokens, output_tokens,
                duration_ms, agent_id, agent_name, agent_role, tokens, is_complete_val, iter_num, now],
        )?;
        // Touch session updated_at
        self.conn.execute("UPDATE sessions SET updated_at = ?1 WHERE id = ?2", rusqlite::params![now, session_id])?;
        Ok(())
    }

    fn list_messages(&self, session_id: &str, limit: i64, offset: i64, after: Option<i64>) -> Result<Vec<Value>, rusqlite::Error> {
        if let Some(after_ts) = after {
            let mut stmt = self.conn.prepare(
                "SELECT id, session_id, node_execution_id, role, content, agent_id, agent_name, agent_role,
                        model, input_tokens, output_tokens, tokens, duration_ms,
                        feedback_source_agent_id, feedback_target_agent_id, feedback_vote, feedback_status,
                        is_active, compacted_into_id, is_complete, iteration_number, created_at
                 FROM messages WHERE session_id = ?1 AND is_active = 1 AND created_at > ?2
                 ORDER BY created_at ASC LIMIT ?3 OFFSET ?4"
            )?;
            let rows = stmt.query_map(rusqlite::params![session_id, after_ts, limit, offset], |row| {
                message_row_to_json(row)
            })?;
            rows.collect()
        } else {
            let mut stmt = self.conn.prepare(
                "SELECT id, session_id, node_execution_id, role, content, agent_id, agent_name, agent_role,
                        model, input_tokens, output_tokens, tokens, duration_ms,
                        feedback_source_agent_id, feedback_target_agent_id, feedback_vote, feedback_status,
                        is_active, compacted_into_id, is_complete, iteration_number, created_at
                 FROM messages WHERE session_id = ?1 AND is_active = 1
                 ORDER BY created_at ASC LIMIT ?2 OFFSET ?3"
            )?;
            let rows = stmt.query_map(rusqlite::params![session_id, limit, offset], |row| {
                message_row_to_json(row)
            })?;
            rows.collect()
        }
    }

    fn update_message(&self, id: &str, content: Option<&str>, is_complete: Option<bool>, is_active: Option<bool>) -> Result<bool, rusqlite::Error> {
        let mut sets = Vec::new();
        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        let mut idx = 1u32;

        if let Some(c) = content {
            sets.push(format!("content = ?{idx}"));
            params_vec.push(Box::new(c.to_string()));
            idx += 1;
        }
        if let Some(ic) = is_complete {
            sets.push(format!("is_complete = ?{idx}"));
            params_vec.push(Box::new(if ic { 1i32 } else { 0i32 }));
            idx += 1;
        }
        if let Some(ia) = is_active {
            sets.push(format!("is_active = ?{idx}"));
            params_vec.push(Box::new(if ia { 1i32 } else { 0i32 }));
            idx += 1;
        }

        if sets.is_empty() {
            return Ok(false);
        }

        let sql = format!("UPDATE messages SET {} WHERE id = ?{}", sets.join(", "), idx);
        params_vec.push(Box::new(id.to_string()));

        let params_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        let changed = self.conn.execute(&sql, params_refs.as_slice())?;
        Ok(changed > 0)
    }

    fn delete_message(&self, id: &str) -> Result<bool, rusqlite::Error> {
        let changed = self.conn.execute("DELETE FROM messages WHERE id = ?1", rusqlite::params![id])?;
        Ok(changed > 0)
    }

    fn search_messages(&self, query: &str, session_id: Option<&str>, limit: i64) -> Result<Vec<Value>, rusqlite::Error> {
        let pattern = format!("%{query}%");
        if let Some(sid) = session_id {
            let mut stmt = self.conn.prepare(
                "SELECT id, session_id, node_execution_id, role, content, agent_id, agent_name, agent_role,
                        model, input_tokens, output_tokens, tokens, duration_ms,
                        feedback_source_agent_id, feedback_target_agent_id, feedback_vote, feedback_status,
                        is_active, compacted_into_id, is_complete, iteration_number, created_at
                 FROM messages WHERE session_id = ?1 AND is_active = 1 AND content LIKE ?2
                 ORDER BY created_at DESC LIMIT ?3"
            )?;
            let rows = stmt.query_map(rusqlite::params![sid, pattern, limit], |row| message_row_to_json(row))?;
            rows.collect()
        } else {
            let mut stmt = self.conn.prepare(
                "SELECT id, session_id, node_execution_id, role, content, agent_id, agent_name, agent_role,
                        model, input_tokens, output_tokens, tokens, duration_ms,
                        feedback_source_agent_id, feedback_target_agent_id, feedback_vote, feedback_status,
                        is_active, compacted_into_id, is_complete, iteration_number, created_at
                 FROM messages WHERE is_active = 1 AND content LIKE ?1
                 ORDER BY created_at DESC LIMIT ?2"
            )?;
            let rows = stmt.query_map(rusqlite::params![pattern, limit], |row| message_row_to_json(row))?;
            rows.collect()
        }
    }

    fn recent_messages(&self, limit: i64) -> Result<Vec<Value>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, node_execution_id, role, content, agent_id, agent_name, agent_role,
                    model, input_tokens, output_tokens, tokens, duration_ms,
                    feedback_source_agent_id, feedback_target_agent_id, feedback_vote, feedback_status,
                    is_active, compacted_into_id, is_complete, iteration_number, created_at
             FROM messages WHERE is_active = 1 ORDER BY created_at DESC LIMIT ?1"
        )?;
        let rows = stmt.query_map(rusqlite::params![limit], |row| message_row_to_json(row))?;
        rows.collect()
    }

    // ── Tool calls ───────────────────────────────────────────────────────

    fn add_tool_call(
        &self, id: &str, session_id: &str, message_id: Option<&str>,
        tool_name: &str, input: &str, agent_id: Option<&str>,
        agent_name: Option<&str>, node_execution_id: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        let now = now_ms() as i64;
        self.conn.execute(
            "INSERT INTO tool_calls (id, session_id, message_id, tool_name, input, status, agent_id, agent_name, node_execution_id, started_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?8, ?9)",
            rusqlite::params![id, session_id, message_id, tool_name, input, agent_id, agent_name, node_execution_id, now],
        )?;
        Ok(())
    }

    fn complete_tool_call(&self, id: &str, output: Option<&str>, status: &str, error_message: Option<&str>) -> Result<bool, rusqlite::Error> {
        let now = now_ms() as i64;
        let changed = self.conn.execute(
            "UPDATE tool_calls SET output = ?1, status = ?2, error_message = ?3, completed_at = ?4 WHERE id = ?5",
            rusqlite::params![output, status, error_message, now, id],
        )?;
        Ok(changed > 0)
    }

    fn list_tool_calls(&self, session_id: &str, limit: i64) -> Result<Vec<Value>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, message_id, node_execution_id, agent_id, agent_name,
                    tool_name, input, output, status, error_message, started_at, completed_at
             FROM tool_calls WHERE session_id = ?1 ORDER BY started_at DESC LIMIT ?2"
        )?;
        let rows = stmt.query_map(rusqlite::params![session_id, limit], |row| {
            // Truncate input/output to prevent oversized WS messages
            let input_raw: Option<String> = row.get(7)?;
            let output_raw: Option<String> = row.get(8)?;
            let truncate = |s: Option<String>| -> Option<Value> {
                s.map(|v| {
                    if let Ok(parsed) = serde_json::from_str::<Value>(&v) {
                        parsed
                    } else if v.len() > 2000 {
                        Value::String(format!("{}…", &v[..2000]))
                    } else {
                        Value::String(v)
                    }
                })
            };
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "sessionId": row.get::<_, String>(1)?,
                "messageId": row.get::<_, Option<String>>(2)?,
                "nodeExecutionId": row.get::<_, Option<String>>(3)?,
                "agentId": row.get::<_, Option<String>>(4)?,
                "agentName": row.get::<_, Option<String>>(5)?,
                "toolName": row.get::<_, String>(6)?,
                "input": truncate(input_raw),
                "output": truncate(output_raw),
                "status": row.get::<_, String>(9)?,
                "errorMessage": row.get::<_, Option<String>>(10)?,
                "startedAt": row.get::<_, Option<i64>>(11)?,
                "completedAt": row.get::<_, Option<i64>>(12)?,
            }))
        })?;
        rows.collect()
    }

    // ── Todos ────────────────────────────────────────────────────────────

    fn upsert_todo(
        &self, id: &str, session_id: Option<&str>, content: &str,
        active_form: Option<&str>, status: &str, order_index: i64,
        document_id: Option<&str>, agent_id: Option<&str>, assigned_agent_id: Option<&str>,
    ) -> Result<Value, rusqlite::Error> {
        let now = now_ms() as i64;
        let completed_at: Option<i64> = if status == "completed" { Some(now) } else { None };
        self.conn.execute(
            "INSERT INTO todos (id, session_id, content, active_form, status, order_index, document_id, agent_id, assigned_agent_id, created_at, updated_at, completed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET content = ?3, active_form = ?4, status = ?5, order_index = ?6, document_id = ?7, agent_id = ?8, assigned_agent_id = ?9, updated_at = ?10, completed_at = ?11",
            rusqlite::params![id, session_id, content, active_form, status, order_index, document_id, agent_id, assigned_agent_id, now, completed_at],
        )?;
        // Return full todo (matches TypeScript behavior)
        Ok(self.get_todo(id)?.unwrap_or(Value::Null))
    }

    fn get_todo(&self, id: &str) -> Result<Option<Value>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, document_id, agent_id, assigned_agent_id, content, active_form, status, order_index, created_at, updated_at, completed_at
             FROM todos WHERE id = ?1"
        )?;
        let mut rows = stmt.query(rusqlite::params![id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(todo_row_to_json(row)?))
        } else {
            Ok(None)
        }
    }

    fn list_todos(&self, session_id: Option<&str>, document_id: Option<&str>, limit: Option<i64>) -> Result<Vec<Value>, rusqlite::Error> {
        let cols = "id, session_id, document_id, agent_id, assigned_agent_id, content, active_form, status, order_index, created_at, updated_at, completed_at";
        let mut sql = format!("SELECT {cols} FROM todos WHERE 1=1");
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(sid) = session_id {
            sql += " AND session_id = ?";
            params.push(Box::new(sid.to_string()));
        }
        if let Some(did) = document_id {
            sql += " AND document_id = ?";
            params.push(Box::new(did.to_string()));
        }
        sql += " ORDER BY order_index ASC, created_at ASC";
        if let Some(lim) = limit {
            sql += " LIMIT ?";
            params.push(Box::new(lim));
        }

        let mut stmt = self.conn.prepare(&sql)?;
        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(param_refs.as_slice(), |row| todo_row_to_json(row))?;
        rows.collect()
    }

    fn update_todo_status(&self, id: &str, status: &str) -> Result<bool, rusqlite::Error> {
        let now = now_ms() as i64;
        let completed_at: Option<i64> = if status == "completed" { Some(now) } else { None };
        let changed = self.conn.execute(
            "UPDATE todos SET status = ?1, updated_at = ?2, completed_at = ?3 WHERE id = ?4",
            rusqlite::params![status, now, completed_at, id],
        )?;
        Ok(changed > 0)
    }

    fn delete_todo(&self, id: &str) -> Result<bool, rusqlite::Error> {
        let changed = self.conn.execute("DELETE FROM todos WHERE id = ?1", rusqlite::params![id])?;
        Ok(changed > 0)
    }

    // ── Permissions ──────────────────────────────────────────────────────

    fn check_permission(&self, tool_name: &str, session_id: Option<&str>) -> Result<Option<Value>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, tool_name, scope, pattern, decision, granted_at, expires_at, session_id, workflow_id
             FROM permissions WHERE tool_name = ?1 AND (session_id = ?2 OR session_id IS NULL) AND decision = 'approved'
             ORDER BY granted_at DESC LIMIT 1"
        )?;
        let mut rows = stmt.query(rusqlite::params![tool_name, session_id])?;
        if let Some(row) = rows.next()? {
            let expires_at = row.get::<_, Option<i64>>(6)?;
            let now = now_ms() as i64;
            if expires_at.is_some_and(|e| e < now) {
                return Ok(None);
            }
            Ok(Some(json!({
                "id": row.get::<_, String>(0)?,
                "toolName": row.get::<_, String>(1)?,
                "scope": row.get::<_, String>(2)?,
                "pattern": row.get::<_, Option<String>>(3)?,
                "decision": row.get::<_, String>(4)?,
                "grantedAt": row.get::<_, i64>(5)?,
                "expiresAt": expires_at,
                "sessionId": row.get::<_, Option<String>>(7)?,
                "workflowId": row.get::<_, Option<String>>(8)?,
            })))
        } else {
            Ok(None)
        }
    }

    fn grant_permission(
        &self, id: &str, session_id: Option<&str>, workflow_id: Option<&str>,
        tool_name: &str, scope: &str, pattern: Option<&str>, decision: &str,
    ) -> Result<(), rusqlite::Error> {
        let now = now_ms() as i64;
        self.conn.execute(
            "INSERT INTO permissions (id, session_id, workflow_id, tool_name, scope, pattern, decision, granted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![id, session_id, workflow_id, tool_name, scope, pattern, decision, now],
        )?;
        Ok(())
    }

    fn revoke_permission(&self, id: &str) -> Result<bool, rusqlite::Error> {
        let changed = self.conn.execute("DELETE FROM permissions WHERE id = ?1", rusqlite::params![id])?;
        Ok(changed > 0)
    }

    fn list_permissions(&self, session_id: Option<&str>) -> Result<Vec<Value>, rusqlite::Error> {
        if let Some(sid) = session_id {
            let mut stmt = self.conn.prepare(
                "SELECT id, session_id, workflow_id, tool_name, scope, pattern, decision, granted_at, expires_at
                 FROM permissions WHERE session_id = ?1 ORDER BY granted_at DESC"
            )?;
            let rows = stmt.query_map(rusqlite::params![sid], |row| permission_row_to_json(row))?;
            rows.collect()
        } else {
            let mut stmt = self.conn.prepare(
                "SELECT id, session_id, workflow_id, tool_name, scope, pattern, decision, granted_at, expires_at
                 FROM permissions ORDER BY granted_at DESC"
            )?;
            let rows = stmt.query_map([], |row| permission_row_to_json(row))?;
            rows.collect()
        }
    }

    // ── Compactions ──────────────────────────────────────────────────────

    fn create_compaction(
        &self, id: &str, session_id: &str, summary: &str,
        start_msg: Option<&str>, end_msg: Option<&str>,
        messages_compacted: Option<i64>, original_token_count: Option<i64>,
        compressed_token_count: Option<i64>,
    ) -> Result<(), rusqlite::Error> {
        let now = now_ms() as i64;
        self.conn.execute(
            "INSERT INTO compactions (id, session_id, summary, start_message_id, end_message_id, messages_compacted, original_token_count, compressed_token_count, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![id, session_id, summary, start_msg, end_msg, messages_compacted, original_token_count, compressed_token_count, now],
        )?;
        Ok(())
    }

    fn list_compactions(&self, session_id: &str) -> Result<Vec<Value>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, summary, start_message_id, end_message_id,
                    messages_compacted, original_token_count, compressed_token_count, created_at
             FROM compactions WHERE session_id = ?1 ORDER BY created_at ASC"
        )?;
        let rows = stmt.query_map(rusqlite::params![session_id], |row| compaction_row_to_json(row))?;
        rows.collect()
    }

    fn delete_compaction(&self, id: &str) -> Result<bool, rusqlite::Error> {
        let changed = self.conn.execute("DELETE FROM compactions WHERE id = ?1", rusqlite::params![id])?;
        Ok(changed > 0)
    }

    fn get_compaction(&self, id: &str) -> Result<Option<Value>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, summary, start_message_id, end_message_id,
                    messages_compacted, original_token_count, compressed_token_count, created_at
             FROM compactions WHERE id = ?1"
        )?;
        let mut rows = stmt.query(rusqlite::params![id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(compaction_row_to_json(row)?))
        } else {
            Ok(None)
        }
    }

    // ── Documents ─────────────────────────────────────────────────────

    fn create_document(
        &self, id: &str, session_id: Option<&str>, agent_id: Option<&str>,
        doc_type: &str, title: &str, content: &str, summary: Option<&str>,
        status: Option<&str>, severity: Option<&str>, priority: Option<i64>,
        parent_id: Option<&str>, file_path: Option<&str>,
        metadata: Option<&str>, validation_criteria: Option<&str>,
    ) -> Result<Value, rusqlite::Error> {
        let now = now_ms() as i64;
        let status_val = status.unwrap_or("draft");
        let priority_val = priority.unwrap_or(0);
        self.conn.execute(
            "INSERT INTO documents (id, session_id, agent_id, doc_type, title, content, summary, metadata, parent_id, status, severity, priority, file_path, validation_criteria, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)",
            rusqlite::params![id, session_id, agent_id, doc_type, title, content, summary, metadata, parent_id, status_val, severity, priority_val, file_path, validation_criteria, now],
        )?;
        // Return full document (matches TypeScript behavior)
        Ok(self.get_document(id)?.unwrap_or(Value::Null))
    }

    fn get_document(&self, id: &str) -> Result<Option<Value>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, agent_id, doc_type, title, content, summary, metadata,
                    parent_id, status, severity, priority, reviewed_by_agent_id, review_status,
                    file_path, validation_criteria, created_at, updated_at
             FROM documents WHERE id = ?1"
        )?;
        let mut rows = stmt.query(rusqlite::params![id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(document_row_to_json(row)?))
        } else {
            Ok(None)
        }
    }

    fn list_documents(
        &self,
        session_id: Option<&str>, agent_id: Option<&str>, doc_type: Option<&str>,
        status: Option<&str>, parent_id: Option<&str>, severity: Option<&str>,
        review_status: Option<&str>, limit: i64, offset: i64,
    ) -> Result<Vec<Value>, rusqlite::Error> {
        let cols = "id, session_id, agent_id, doc_type, title, content, summary, metadata,
                    parent_id, status, severity, priority, reviewed_by_agent_id, review_status,
                    file_path, validation_criteria, created_at, updated_at";
        let mut sql = format!("SELECT {cols} FROM documents WHERE 1=1");
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        macro_rules! add_filter {
            ($opt:expr, $col:expr) => {
                if let Some(v) = $opt {
                    sql += &format!(" AND {} = ?", $col);
                    params.push(Box::new(v.to_string()));
                }
            };
        }
        add_filter!(session_id, "session_id");
        add_filter!(agent_id, "agent_id");
        add_filter!(doc_type, "doc_type");
        add_filter!(status, "status");
        add_filter!(parent_id, "parent_id");
        add_filter!(severity, "severity");
        add_filter!(review_status, "review_status");

        sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
        params.push(Box::new(limit));
        params.push(Box::new(offset));

        let mut stmt = self.conn.prepare(&sql)?;
        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(param_refs.as_slice(), |row| document_row_to_json(row))?;
        rows.collect()
    }

    fn update_document(
        &self, id: &str, title: Option<&str>, content: Option<&str>,
        summary: Option<&str>, status: Option<&str>, severity: Option<&str>,
        priority: Option<i64>, reviewed_by_agent_id: Option<&str>,
        review_status: Option<&str>, file_path: Option<&str>,
        validation_criteria: Option<&str>, metadata: Option<&str>,
    ) -> Result<Option<Value>, rusqlite::Error> {
        // Check existence first (matches TypeScript: returns null if not found)
        if self.get_document(id)?.is_none() {
            return Ok(None);
        }

        let now = now_ms() as i64;
        let mut sets = vec!["updated_at = ?1".to_string()];
        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(now)];
        let mut idx = 2u32;

        macro_rules! add_set {
            ($field:expr, $col:expr) => {
                if let Some(v) = $field {
                    sets.push(format!("{} = ?{}", $col, idx));
                    params_vec.push(Box::new(v.to_string()));
                    idx += 1;
                }
            };
        }

        add_set!(title, "title");
        add_set!(content, "content");
        add_set!(summary, "summary");
        add_set!(status, "status");
        add_set!(severity, "severity");
        add_set!(metadata, "metadata");
        add_set!(reviewed_by_agent_id, "reviewed_by_agent_id");
        add_set!(review_status, "review_status");
        add_set!(file_path, "file_path");
        add_set!(validation_criteria, "validation_criteria");

        if let Some(p) = priority {
            sets.push(format!("priority = ?{}", idx));
            params_vec.push(Box::new(p));
            idx += 1;
        }

        let sql = format!("UPDATE documents SET {} WHERE id = ?{}", sets.join(", "), idx);
        params_vec.push(Box::new(id.to_string()));

        let params_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        self.conn.execute(&sql, params_refs.as_slice())?;

        // Return updated document (matches TypeScript behavior)
        self.get_document(id)
    }

    fn delete_document(&self, id: &str) -> Result<bool, rusqlite::Error> {
        let changed = self.conn.execute("DELETE FROM documents WHERE id = ?1", rusqlite::params![id])?;
        Ok(changed > 0)
    }

    fn search_documents(&self, query: &str, doc_type: Option<&str>, limit: i64) -> Result<Vec<Value>, rusqlite::Error> {
        let cols = "id, session_id, agent_id, doc_type, title, content, summary, metadata,
                    parent_id, status, severity, priority, reviewed_by_agent_id, review_status,
                    file_path, validation_criteria, created_at, updated_at";
        let pattern = format!("%{query}%");
        if let Some(dt) = doc_type {
            let mut stmt = self.conn.prepare(&format!(
                "SELECT {cols} FROM documents WHERE (title LIKE ?1 OR content LIKE ?1) AND doc_type = ?2
                 ORDER BY created_at DESC LIMIT ?3"
            ))?;
            let rows = stmt.query_map(rusqlite::params![pattern, dt, limit], |row| document_row_to_json(row))?;
            rows.collect()
        } else {
            let mut stmt = self.conn.prepare(&format!(
                "SELECT {cols} FROM documents WHERE title LIKE ?1 OR content LIKE ?1
                 ORDER BY created_at DESC LIMIT ?2"
            ))?;
            let rows = stmt.query_map(rusqlite::params![pattern, limit], |row| document_row_to_json(row))?;
            rows.collect()
        }
    }

    /// Get full document hierarchy starting from a root document ID.
    /// Returns the root document with nested `children` arrays (matches TypeScript).
    fn document_hierarchy(&self, root_id: &str) -> Result<Option<Value>, rusqlite::Error> {
        let cols = "id, session_id, agent_id, doc_type, title, content, summary, metadata,
                    parent_id, status, severity, priority, reviewed_by_agent_id, review_status,
                    file_path, validation_criteria, created_at, updated_at";
        let root = self.get_document(root_id)?;
        let root = match root {
            Some(r) => r,
            None => return Ok(None),
        };

        // Recursive child builder
        fn build_children(conn: &rusqlite::Connection, parent_id: &str, cols: &str) -> Result<Vec<Value>, rusqlite::Error> {
            let mut stmt = conn.prepare(&format!(
                "SELECT {cols} FROM documents WHERE parent_id = ?1 ORDER BY created_at ASC"
            ))?;
            let rows = stmt.query_map(rusqlite::params![parent_id], |row| document_row_to_json(row))?;
            let mut children = Vec::new();
            for row in rows {
                let mut child = row?;
                let child_id = child["id"].as_str().unwrap_or("").to_string();
                let grandchildren = build_children(conn, &child_id, cols)?;
                if let Value::Object(ref mut map) = child {
                    map.insert("children".to_string(), Value::Array(grandchildren));
                }
                children.push(child);
            }
            Ok(children)
        }

        let mut result = root;
        let children = build_children(&self.conn, root_id, cols)?;
        if let Value::Object(ref mut map) = result {
            map.insert("children".to_string(), Value::Array(children));
        }
        Ok(Some(result))
    }

    /// Get active vulnerabilities (not archived/completed), sorted by severity.
    fn get_active_vulnerabilities(&self, session_id: Option<&str>) -> Result<Vec<Value>, rusqlite::Error> {
        let cols = "id, session_id, agent_id, doc_type, title, content, summary, metadata,
                    parent_id, status, severity, priority, reviewed_by_agent_id, review_status,
                    file_path, validation_criteria, created_at, updated_at";
        let severity_order = "CASE severity
            WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2
            WHEN 'low' THEN 3 WHEN 'info' THEN 4 ELSE 5 END";

        if let Some(sid) = session_id {
            let mut stmt = self.conn.prepare(&format!(
                "SELECT {cols} FROM documents WHERE doc_type = 'vulnerability'
                 AND status NOT IN ('archived', 'completed') AND session_id = ?1
                 ORDER BY {severity_order}, created_at DESC"
            ))?;
            let rows = stmt.query_map(rusqlite::params![sid], |row| document_row_to_json(row))?;
            rows.collect()
        } else {
            let mut stmt = self.conn.prepare(&format!(
                "SELECT {cols} FROM documents WHERE doc_type = 'vulnerability'
                 AND status NOT IN ('archived', 'completed')
                 ORDER BY {severity_order}, created_at DESC"
            ))?;
            let rows = stmt.query_map([], |row| document_row_to_json(row))?;
            rows.collect()
        }
    }

    /// Get documents pending review (across all sessions).
    fn get_pending_reviews(&self) -> Result<Vec<Value>, rusqlite::Error> {
        let cols = "id, session_id, agent_id, doc_type, title, content, summary, metadata,
                    parent_id, status, severity, priority, reviewed_by_agent_id, review_status,
                    file_path, validation_criteria, created_at, updated_at";
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {cols} FROM documents WHERE review_status = 'pending'
             ORDER BY priority DESC, created_at ASC"
        ))?;
        let rows = stmt.query_map([], |row| document_row_to_json(row))?;
        rows.collect()
    }

    /// Count documents by type (global, excludes archived).
    fn count_documents_by_type(&self) -> Result<Value, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT doc_type, COUNT(*) as count FROM documents
             WHERE status != 'archived' GROUP BY doc_type"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        let mut counts = serde_json::Map::new();
        for row in rows {
            let (doc_type, count) = row?;
            counts.insert(doc_type, json!(count));
        }
        Ok(Value::Object(counts))
    }

    // ── Activity ──────────────────────────────────────────────────────

    /// Reconstruct activity from data tables (sessions, messages, tool_calls, documents, todos).
    /// Matches TypeScript ECP behavior — no separate activity table needed.
    fn reconstruct_activity(&self, session_id: Option<&str>, limit: i64, since: Option<i64>) -> Result<Vec<Value>, rusqlite::Error> {
        let mut entries: Vec<Value> = Vec::new();

        // Helper: builds WHERE clauses and collects params for each table
        macro_rules! query_activity {
            ($sql_base:expr, $session_col:expr, $time_col:expr, $mapper:expr) => {{
                let mut sql = format!("{} WHERE 1=1", $sql_base);
                let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

                if let Some(sid) = session_id {
                    sql += &format!(" AND {} = ?", $session_col);
                    params.push(Box::new(sid.to_string()));
                }
                if let Some(ts) = since {
                    sql += &format!(" AND {} > ?", $time_col);
                    params.push(Box::new(ts));
                }
                sql += &format!(" ORDER BY {} DESC LIMIT ?", $time_col);
                params.push(Box::new(limit));

                if let Ok(mut stmt) = self.conn.prepare(&sql) {
                    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
                    if let Ok(rows) = stmt.query_map(param_refs.as_slice(), $mapper) {
                        for row in rows.flatten() {
                            entries.push(row);
                        }
                    }
                }
            }};
        }

        // ── Sessions ─────────────────────────────────────────────────
        query_activity!(
            "SELECT id, title, provider, model, status, created_at FROM sessions",
            "id", "created_at",
            |row: &rusqlite::Row<'_>| {
                let sid: String = row.get(0)?;
                let title: Option<String> = row.get(1)?;
                let provider: String = row.get(2)?;
                let model: String = row.get(3)?;
                let status: String = row.get(4)?;
                let created_at: i64 = row.get(5)?;
                Ok(json!({
                    "sessionId": sid, "activityType": "session_created",
                    "entityType": "session", "entityId": sid,
                    "summary": format!("Session created: {provider}/{model}"),
                    "details": { "title": title, "provider": provider, "model": model, "status": status },
                    "createdAt": created_at,
                }))
            }
        );

        // ── Messages ─────────────────────────────────────────────────
        query_activity!(
            "SELECT id, session_id, role, content, agent_id, agent_name, model, created_at FROM messages",
            "session_id", "created_at",
            |row: &rusqlite::Row<'_>| {
                let mid: String = row.get(0)?;
                let sid: String = row.get(1)?;
                let role: String = row.get(2)?;
                let content: String = row.get(3)?;
                let agent_id: Option<String> = row.get(4)?;
                let agent_name: Option<String> = row.get(5)?;
                let model: Option<String> = row.get(6)?;
                let created_at: i64 = row.get(7)?;
                let display = agent_name.as_deref().unwrap_or(&role);
                let snippet: &str = if content.len() > 80 { &content[..80] } else { &content };
                Ok(json!({
                    "sessionId": sid, "activityType": "message_added",
                    "entityType": "message", "entityId": mid,
                    "summary": format!("{display}: {snippet}"),
                    "details": { "role": role, "model": model, "agentId": agent_id, "agentName": agent_name },
                    "createdAt": created_at,
                    "agentId": agent_id, "agentName": agent_name,
                }))
            }
        );

        // ── Tool Calls ───────────────────────────────────────────────
        {
            let mut sql = "SELECT id, session_id, tool_name, status, agent_id, agent_name, started_at, completed_at, error_message FROM tool_calls WHERE 1=1".to_string();
            let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
            if let Some(sid) = session_id {
                sql += " AND session_id = ?";
                params.push(Box::new(sid.to_string()));
            }
            if let Some(ts) = since {
                sql += " AND started_at > ?";
                params.push(Box::new(ts));
            }
            sql += " ORDER BY started_at DESC LIMIT ?";
            params.push(Box::new(limit));

            if let Ok(mut stmt) = self.conn.prepare(&sql) {
                let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
                if let Ok(rows) = stmt.query_map(param_refs.as_slice(), |row: &rusqlite::Row<'_>| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<i64>>(6)?,
                        row.get::<_, Option<i64>>(7)?,
                        row.get::<_, Option<String>>(8)?,
                    ))
                }) {
                    for row in rows.flatten() {
                        let (tc_id, sid, tool_name, status, agent_id, agent_name, started_at, completed_at, error_msg) = row;
                        if let Some(ts) = started_at {
                            entries.push(json!({
                                "sessionId": sid, "activityType": "tool_call_started",
                                "entityType": "tool_call", "entityId": tc_id,
                                "summary": format!("Tool: {tool_name}"),
                                "details": { "toolName": &tool_name, "agentId": &agent_id, "agentName": &agent_name },
                                "createdAt": ts,
                                "agentId": agent_id, "agentName": agent_name,
                            }));
                        }
                        if let Some(ts) = completed_at {
                            let err_suffix = error_msg.as_deref().map(|e| format!(" - {e}")).unwrap_or_default();
                            entries.push(json!({
                                "sessionId": sid, "activityType": "tool_call_completed",
                                "entityType": "tool_call", "entityId": tc_id,
                                "summary": format!("Tool {status}: {tool_name}{err_suffix}"),
                                "details": { "toolName": tool_name, "status": status, "error": error_msg },
                                "createdAt": ts,
                                "agentId": agent_id, "agentName": agent_name,
                            }));
                        }
                    }
                }
            }
        }

        // ── Documents ────────────────────────────────────────────────
        query_activity!(
            "SELECT id, session_id, agent_id, doc_type, title, status, severity, created_at FROM documents",
            "session_id", "created_at",
            |row: &rusqlite::Row<'_>| {
                Ok(json!({
                    "sessionId": row.get::<_, Option<String>>(1)?,
                    "activityType": "document_created",
                    "entityType": "document",
                    "entityId": row.get::<_, String>(0)?,
                    "summary": format!("{}: {}", row.get::<_, String>(3)?, row.get::<_, String>(4)?),
                    "details": { "docType": row.get::<_, String>(3)?, "status": row.get::<_, Option<String>>(5)?, "severity": row.get::<_, Option<String>>(6)? },
                    "createdAt": row.get::<_, i64>(7)?,
                    "agentId": row.get::<_, Option<String>>(2)?,
                }))
            }
        );

        // ── Todos ────────────────────────────────────────────────────
        query_activity!(
            "SELECT id, session_id, agent_id, content, status, created_at FROM todos",
            "session_id", "created_at",
            |row: &rusqlite::Row<'_>| {
                let content: String = row.get(3)?;
                let status: String = row.get(4)?;
                let snippet: &str = if content.len() > 60 { &content[..60] } else { &content };
                Ok(json!({
                    "sessionId": row.get::<_, Option<String>>(1)?,
                    "activityType": "todo_updated",
                    "entityType": "todo",
                    "entityId": row.get::<_, String>(0)?,
                    "summary": format!("Todo [{status}]: {snippet}"),
                    "details": { "status": status },
                    "createdAt": row.get::<_, i64>(5)?,
                    "agentId": row.get::<_, Option<String>>(2)?,
                }))
            }
        );

        // Sort by createdAt descending and apply limit
        entries.sort_by(|a, b| {
            let a_ts = a["createdAt"].as_i64().unwrap_or(0);
            let b_ts = b["createdAt"].as_i64().unwrap_or(0);
            b_ts.cmp(&a_ts)
        });
        entries.truncate(limit as usize);

        // Assign sequential IDs
        for (i, entry) in entries.iter_mut().enumerate() {
            if let Value::Object(map) = entry {
                map.insert("id".to_string(), json!(i + 1));
            }
        }

        Ok(entries)
    }

    // ── Stats ─────────────────────────────────────────────────────────

    fn stats(&self, session_id: Option<&str>) -> Result<Value, rusqlite::Error> {
        if let Some(sid) = session_id {
            let message_count: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM messages WHERE session_id = ?1 AND is_active = 1", rusqlite::params![sid], |r| r.get(0)
            )?;
            let tool_call_count: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM tool_calls WHERE session_id = ?1", rusqlite::params![sid], |r| r.get(0)
            )?;
            let document_count: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM documents WHERE session_id = ?1", rusqlite::params![sid], |r| r.get(0)
            )?;
            let todo_count: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM todos WHERE session_id = ?1", rusqlite::params![sid], |r| r.get(0)
            )?;
            Ok(json!({
                "sessions": 1,
                "messages": message_count,
                "toolCalls": tool_call_count,
                "documents": document_count,
                "todos": todo_count,
            }))
        } else {
            let session_count: i64 = self.conn.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))?;
            let message_count: i64 = self.conn.query_row("SELECT COUNT(*) FROM messages WHERE is_active = 1", [], |r| r.get(0))?;
            let tool_call_count: i64 = self.conn.query_row("SELECT COUNT(*) FROM tool_calls", [], |r| r.get(0))?;
            let document_count: i64 = self.conn.query_row("SELECT COUNT(*) FROM documents", [], |r| r.get(0))?;
            let todo_count: i64 = self.conn.query_row("SELECT COUNT(*) FROM todos", [], |r| r.get(0))?;
            Ok(json!({
                "sessions": session_count,
                "messages": message_count,
                "toolCalls": tool_call_count,
                "documents": document_count,
                "todos": todo_count,
            }))
        }
    }

    // ── Session Agents ──────────────────────────────────────────────────

    fn list_session_agents(&self, session_id: &str, include_left: bool) -> Result<Vec<Value>, rusqlite::Error> {
        let sql = if include_left {
            "SELECT session_id, agent_id, joined_at, left_at, role FROM session_agents WHERE session_id = ?1 ORDER BY joined_at ASC"
        } else {
            "SELECT session_id, agent_id, joined_at, left_at, role FROM session_agents WHERE session_id = ?1 AND left_at IS NULL ORDER BY joined_at ASC"
        };
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map(rusqlite::params![session_id], |row| {
            Ok(json!({
                "sessionId": row.get::<_, String>(0)?,
                "agentId": row.get::<_, String>(1)?,
                "joinedAt": row.get::<_, i64>(2)?,
                "leftAt": row.get::<_, Option<i64>>(3)?,
                "role": row.get::<_, Option<String>>(4)?,
            }))
        })?;
        rows.collect()
    }

    fn add_session_agent(&self, session_id: &str, agent_id: &str, role: &str, agent_name: Option<&str>) -> Result<Value, rusqlite::Error> {
        let now = now_ms() as i64;
        // Ensure agent row exists (FK target)
        self.conn.execute(
            "INSERT OR IGNORE INTO agents (id, name, role, created_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![agent_id, agent_name.unwrap_or(agent_id), role, now],
        )?;
        // Insert or replace session agent
        self.conn.execute(
            "INSERT OR REPLACE INTO session_agents (session_id, agent_id, role, joined_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![session_id, agent_id, role, now],
        )?;
        Ok(json!({ "sessionId": session_id, "agentId": agent_id, "joinedAt": now, "leftAt": null, "role": role }))
    }

    fn remove_session_agent(&self, session_id: &str, agent_id: &str) -> Result<bool, rusqlite::Error> {
        let now = now_ms() as i64;
        let changed = self.conn.execute(
            "UPDATE session_agents SET left_at = ?1 WHERE session_id = ?2 AND agent_id = ?3 AND left_at IS NULL",
            rusqlite::params![now, session_id, agent_id],
        )?;
        Ok(changed > 0)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Row-to-JSON helpers
// ─────────────────────────────────────────────────────────────────────────────

fn session_row_to_json(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "title": row.get::<_, Option<String>>(1)?,
        "workflowId": row.get::<_, Option<String>>(2)?,
        "provider": row.get::<_, String>(3)?,
        "model": row.get::<_, String>(4)?,
        "systemPrompt": row.get::<_, Option<String>>(5)?,
        "status": row.get::<_, String>(6)?,
        "currentNodeId": row.get::<_, Option<String>>(7)?,
        "iterationCount": row.get::<_, Option<i64>>(8)?,
        "maxIterations": row.get::<_, Option<i64>>(9)?,
        "initialInput": row.get::<_, Option<String>>(10)?,
        "finalOutput": row.get::<_, Option<String>>(11)?,
        "errorMessage": row.get::<_, Option<String>>(12)?,
        "createdAt": row.get::<_, i64>(13)?,
        "updatedAt": row.get::<_, Option<i64>>(14)?,
        "completedAt": row.get::<_, Option<i64>>(15)?,
    }))
}

fn message_row_to_json(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "sessionId": row.get::<_, String>(1)?,
        "nodeExecutionId": row.get::<_, Option<String>>(2)?,
        "role": row.get::<_, String>(3)?,
        "content": row.get::<_, String>(4)?,
        "agentId": row.get::<_, Option<String>>(5)?,
        "agentName": row.get::<_, Option<String>>(6)?,
        "agentRole": row.get::<_, Option<String>>(7)?,
        "model": row.get::<_, Option<String>>(8)?,
        "inputTokens": row.get::<_, Option<i64>>(9)?,
        "outputTokens": row.get::<_, Option<i64>>(10)?,
        "tokens": row.get::<_, Option<i64>>(11)?,
        "durationMs": row.get::<_, Option<i64>>(12)?,
        "feedbackSourceAgentId": row.get::<_, Option<String>>(13)?,
        "feedbackTargetAgentId": row.get::<_, Option<String>>(14)?,
        "feedbackVote": row.get::<_, Option<String>>(15)?,
        "feedbackStatus": row.get::<_, Option<String>>(16)?,
        "isActive": row.get::<_, Option<i64>>(17)?.unwrap_or(1) == 1,
        "compactedIntoId": row.get::<_, Option<String>>(18)?,
        "isComplete": row.get::<_, Option<i64>>(19)?.unwrap_or(1) == 1,
        "iterationNumber": row.get::<_, Option<i64>>(20)?.unwrap_or(0),
        "createdAt": row.get::<_, i64>(21)?,
    }))
}

fn todo_row_to_json(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "sessionId": row.get::<_, Option<String>>(1)?,
        "documentId": row.get::<_, Option<String>>(2)?,
        "agentId": row.get::<_, Option<String>>(3)?,
        "assignedAgentId": row.get::<_, Option<String>>(4)?,
        "content": row.get::<_, String>(5)?,
        "activeForm": row.get::<_, Option<String>>(6)?,
        "status": row.get::<_, String>(7)?,
        "orderIndex": row.get::<_, i64>(8)?,
        "createdAt": row.get::<_, i64>(9)?,
        "updatedAt": row.get::<_, Option<i64>>(10)?,
        "completedAt": row.get::<_, Option<i64>>(11)?,
    }))
}

fn document_row_to_json(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let metadata_str = row.get::<_, Option<String>>(7)?;
    let metadata: Value = metadata_str
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(Value::Object(Default::default()));
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "sessionId": row.get::<_, Option<String>>(1)?,
        "agentId": row.get::<_, Option<String>>(2)?,
        "docType": row.get::<_, String>(3)?,
        "title": row.get::<_, String>(4)?,
        "content": row.get::<_, String>(5)?,
        "summary": row.get::<_, Option<String>>(6)?,
        "metadata": metadata,
        "parentId": row.get::<_, Option<String>>(8)?,
        "status": row.get::<_, Option<String>>(9)?,
        "severity": row.get::<_, Option<String>>(10)?,
        "priority": row.get::<_, Option<i64>>(11)?,
        "reviewedByAgentId": row.get::<_, Option<String>>(12)?,
        "reviewStatus": row.get::<_, Option<String>>(13)?,
        "filePath": row.get::<_, Option<String>>(14)?,
        "validationCriteria": row.get::<_, Option<String>>(15)?,
        "createdAt": row.get::<_, i64>(16)?,
        "updatedAt": row.get::<_, Option<i64>>(17)?,
    }))
}

fn compaction_row_to_json(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "sessionId": row.get::<_, String>(1)?,
        "summary": row.get::<_, String>(2)?,
        "startMessageId": row.get::<_, Option<String>>(3)?,
        "endMessageId": row.get::<_, Option<String>>(4)?,
        "messagesCompacted": row.get::<_, Option<i64>>(5)?,
        "originalTokenCount": row.get::<_, Option<i64>>(6)?,
        "compressedTokenCount": row.get::<_, Option<i64>>(7)?,
        "createdAt": row.get::<_, i64>(8)?,
    }))
}



fn permission_row_to_json(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "sessionId": row.get::<_, Option<String>>(1)?,
        "workflowId": row.get::<_, Option<String>>(2)?,
        "toolName": row.get::<_, String>(3)?,
        "scope": row.get::<_, String>(4)?,
        "pattern": row.get::<_, Option<String>>(5)?,
        "decision": row.get::<_, String>(6)?,
        "grantedAt": row.get::<_, i64>(7)?,
        "expiresAt": row.get::<_, Option<i64>>(8)?,
    }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat service (public)
// ─────────────────────────────────────────────────────────────────────────────

pub struct ChatService {
    db: Arc<Mutex<ChatDb>>,
}

impl ChatService {
    pub fn new(workspace_root: &std::path::Path) -> Self {
        let db_path = workspace_root.join(".ultra/chat.db");
        let db = ChatDb::open(&db_path).expect("Failed to open chat database");
        Self {
            db: Arc::new(Mutex::new(db)),
        }
    }

    /// Run a blocking DB operation on the tokio blocking pool.
    async fn with_db<F, R>(&self, f: F) -> Result<R, ECPError>
    where
        F: FnOnce(&ChatDb) -> Result<R, rusqlite::Error> + Send + 'static,
        R: Send + 'static,
    {
        let db = self.db.clone();
        tokio::task::spawn_blocking(move || {
            let db = db.lock();
            f(&db)
        })
        .await
        .map_err(|e| ECPError::server_error(format!("Task join error: {e}")))?
        .map_err(|e| ECPError::server_error(format!("Database error: {e}")))
    }
}

impl Service for ChatService {
    fn namespace(&self) -> &str {
        "chat"
    }

    async fn handle(&self, method: &str, params: Option<Value>) -> HandlerResult {
        match method {
            // ── Sessions ─────────────────────────────────────────────
            "chat/session/create" => {
                let p: SessionCreateParams = parse_params(params)?;
                let id = format!("sess-{}", uuid_v4());
                let provider = p.provider.unwrap_or_else(|| "claude".into());
                let model = p.model.unwrap_or_else(|| "claude-sonnet-4-20250514".into());
                let title_clone = p.title.clone();
                let sp_clone = p.system_prompt.clone();
                let wf_clone = p.workflow_id.clone();
                let id_clone = id.clone();

                self.with_db(move |db| {
                    db.create_session(&id_clone, title_clone.as_deref(), &provider, &model, sp_clone.as_deref(), wf_clone.as_deref())
                }).await?;

                Ok(json!({ "id": id }))
            }

            "chat/session/get" => {
                let p: SessionIdParam = parse_params(params)?;
                let sid = p.session_id.clone();
                let session = self.with_db(move |db| db.get_session(&p.session_id)).await?;
                match session {
                    Some(s) => Ok(json!({ "session": s })),
                    None => Err(ECPError::server_error(format!("Session not found: {sid}"))),
                }
            }

            "chat/session/update" => {
                let p: SessionUpdateParams = parse_params(params)?;
                let updated = self.with_db(move |db| {
                    db.update_session(
                        &p.session_id, p.title.as_deref(), p.status.as_deref(),
                        p.model.as_deref(), p.provider.as_deref(),
                        p.system_prompt.as_deref(), p.error_message.as_deref(),
                    )
                }).await?;
                Ok(json!({ "success": updated }))
            }

            "chat/session/delete" => {
                let p: SessionIdParam = parse_params(params)?;
                let deleted = self.with_db(move |db| db.delete_session(&p.session_id)).await?;
                Ok(json!({ "success": deleted }))
            }

            "chat/session/list" => {
                let p: ListParams = parse_params_optional(params);
                let sessions = self.with_db(move |db| db.list_sessions(p.limit(), p.offset())).await?;
                Ok(Value::Array(sessions))
            }

            // ── Messages ─────────────────────────────────────────────
            "chat/message/add" => {
                let p: MessageAddParams = parse_params(params)?;
                let id = p.id.unwrap_or_else(|| format!("msg-{}", uuid_v4()));
                let id_clone = id.clone();

                self.with_db(move |db| {
                    db.add_message(
                        &id_clone, &p.session_id, &p.role, &p.content,
                        p.model.as_deref(), p.input_tokens, p.output_tokens,
                        p.duration_ms, p.agent_id.as_deref(), p.agent_name.as_deref(),
                        p.agent_role.as_deref(), p.tokens, p.is_complete, p.iteration_number,
                    )
                }).await?;

                Ok(json!({ "messageId": id }))
            }

            "chat/message/update" => {
                let p: MessageUpdateParams = parse_params(params)?;
                let updated = self.with_db(move |db| {
                    db.update_message(&p.id, p.content.as_deref(), p.is_complete, p.is_active)
                }).await?;
                Ok(json!({ "success": updated }))
            }

            "chat/message/delete" => {
                let p: IdParam = parse_params(params)?;
                let deleted = self.with_db(move |db| db.delete_message(&p.id)).await?;
                Ok(json!({ "success": deleted }))
            }

            "chat/message/list" => {
                let p: MessageListParams = parse_params(params)?;
                let limit = p.limit.unwrap_or(100);
                let offset = p.offset.unwrap_or(0);
                let after = p.after;
                let messages = self.with_db(move |db| db.list_messages(&p.session_id, limit, offset, after)).await?;
                Ok(Value::Array(messages))
            }

            "chat/message/search" => {
                let p: MessageSearchParams = parse_params(params)?;
                let limit = p.limit.unwrap_or(50);
                let messages = self.with_db(move |db| db.search_messages(&p.query, p.session_id.as_deref(), limit)).await?;
                Ok(Value::Array(messages))
            }

            "chat/message/recent" => {
                let p: ListParams = parse_params_optional(params);
                let messages = self.with_db(move |db| db.recent_messages(p.limit())).await?;
                Ok(Value::Array(messages))
            }

            // ── Tool calls ───────────────────────────────────────────
            "chat/toolCall/add" => {
                let p: ToolCallAddParams = parse_params(params)?;
                let id = p.id.unwrap_or_else(|| format!("tc-{}", uuid_v4()));
                let id_clone = id.clone();
                let input_str = serde_json::to_string(&p.input).unwrap_or_else(|_| "{}".into());

                self.with_db(move |db| {
                    db.add_tool_call(
                        &id_clone, &p.session_id, p.message_id.as_deref(),
                        &p.tool_name, &input_str, p.agent_id.as_deref(),
                        p.agent_name.as_deref(), p.node_execution_id.as_deref(),
                    )
                }).await?;

                Ok(json!({ "toolCallId": id }))
            }

            "chat/toolCall/complete" => {
                let p: ToolCallCompleteParams = parse_params(params)?;
                let output_str = p.output.map(|v| serde_json::to_string(&v).unwrap_or_else(|_| "null".into()));
                let status = p.status.unwrap_or_else(|| "success".into());

                let updated = self.with_db(move |db| {
                    db.complete_tool_call(&p.id, output_str.as_deref(), &status, p.error_message.as_deref())
                }).await?;

                Ok(json!({ "success": updated }))
            }

            "chat/toolCall/list" => {
                let p: ToolCallListParams = parse_params(params)?;
                let limit = p.limit.unwrap_or(100);
                let calls = self.with_db(move |db| db.list_tool_calls(&p.session_id, limit)).await?;
                Ok(Value::Array(calls))
            }

            // ── Permissions ──────────────────────────────────────────
            "chat/permission/check" => {
                let p: PermissionCheckParams = parse_params(params)?;
                let perm = self.with_db(move |db| db.check_permission(&p.tool_name, p.session_id.as_deref())).await?;
                Ok(json!({ "allowed": perm.is_some(), "permission": perm }))
            }

            "chat/permission/grant" => {
                let p: PermissionGrantParams = parse_params(params)?;
                let id = format!("perm-{}", uuid_v4());
                let id_clone = id.clone();
                let decision = p.decision.unwrap_or_else(|| "approved".into());

                self.with_db(move |db| {
                    db.grant_permission(
                        &id_clone, p.session_id.as_deref(), p.workflow_id.as_deref(),
                        &p.tool_name, &p.scope, p.pattern.as_deref(), &decision,
                    )
                }).await?;

                Ok(json!({ "permissionId": id }))
            }

            "chat/permission/revoke" => {
                let p: IdParam = parse_params(params)?;
                let revoked = self.with_db(move |db| db.revoke_permission(&p.id)).await?;
                Ok(json!({ "success": revoked }))
            }

            "chat/permission/list" => {
                let p: OptionalSessionIdParam = parse_params_optional(params);
                let perms = self.with_db(move |db| db.list_permissions(p.session_id.as_deref())).await?;
                Ok(Value::Array(perms))
            }

            // ── Todos ────────────────────────────────────────────────
            "chat/todo/upsert" => {
                let p: TodoUpsertParams = parse_params(params)?;
                let id = p.id.unwrap_or_else(|| format!("todo-{}", uuid_v4()));
                let status = p.status.unwrap_or_else(|| "pending".into());

                let todo = self.with_db(move |db| {
                    db.upsert_todo(
                        &id, p.session_id.as_deref(), &p.content, p.active_form.as_deref(),
                        &status, p.order_index.unwrap_or(0),
                        p.document_id.as_deref(), p.agent_id.as_deref(), p.assigned_agent_id.as_deref(),
                    )
                }).await?;

                Ok(todo)
            }

            "chat/todo/list" => {
                let p: TodoListParams = parse_params_optional(params);
                let todos = self.with_db(move |db| {
                    db.list_todos(p.session_id.as_deref(), p.document_id.as_deref(), p.limit)
                }).await?;
                Ok(Value::Array(todos))
            }

            "chat/todo/update-status" => {
                let p: TodoStatusParams = parse_params(params)?;
                let updated = self.with_db(move |db| db.update_todo_status(&p.id, &p.status)).await?;
                Ok(json!({ "success": updated }))
            }

            "chat/todo/delete" => {
                let p: IdParam = parse_params(params)?;
                let deleted = self.with_db(move |db| db.delete_todo(&p.id)).await?;
                Ok(json!({ "success": deleted }))
            }

            // ── Compactions ──────────────────────────────────────────
            "chat/compaction/create" => {
                let p: CompactionCreateParams = parse_params(params)?;
                let id = format!("cmp-{}", uuid_v4());
                let id_clone = id.clone();

                self.with_db(move |db| {
                    db.create_compaction(
                        &id_clone, &p.session_id, &p.summary,
                        p.start_message_id.as_deref(), p.end_message_id.as_deref(),
                        p.messages_compacted, p.original_token_count, p.compressed_token_count,
                    )
                }).await?;

                Ok(json!({ "compactionId": id }))
            }

            "chat/compaction/list" => {
                let p: SessionIdParam = parse_params(params)?;
                let compactions = self.with_db(move |db| db.list_compactions(&p.session_id)).await?;
                Ok(Value::Array(compactions))
            }

            "chat/compaction/delete" => {
                let p: IdParam = parse_params(params)?;
                let deleted = self.with_db(move |db| db.delete_compaction(&p.id)).await?;
                Ok(json!({ "success": deleted }))
            }

            "chat/compaction/get" => {
                let p: IdParam = parse_params(params)?;
                let compaction = self.with_db(move |db| db.get_compaction(&p.id)).await?;
                match compaction {
                    Some(c) => Ok(json!({ "compaction": c })),
                    None => Err(ECPError::server_error("Compaction not found")),
                }
            }

            "chat/compaction/expand" => {
                // Mark compacted messages as active again
                let p: IdParam = parse_params(params)?;
                let updated = self.with_db(move |db| {
                    let changed = db.conn.execute(
                        "UPDATE messages SET is_active = 1 WHERE compacted_into_id = ?1",
                        rusqlite::params![p.id],
                    )?;
                    Ok(changed > 0)
                }).await?;
                Ok(json!({ "success": updated }))
            }

            "chat/compaction/collapse" => {
                // Mark messages in compaction range as inactive
                let p: IdParam = parse_params(params)?;
                let updated = self.with_db(move |db| {
                    let changed = db.conn.execute(
                        "UPDATE messages SET is_active = 0, compacted_into_id = ?1 WHERE compacted_into_id = ?1 OR id = ?1",
                        rusqlite::params![p.id],
                    )?;
                    Ok(changed > 0)
                }).await?;
                Ok(json!({ "success": updated }))
            }

            // ── Documents ────────────────────────────────────────────
            "chat/document/create" => {
                let p: DocumentCreateParams = parse_params(params)?;
                let id = format!("doc-{}", uuid_v4());
                let metadata_str = p.metadata.map(|v| serde_json::to_string(&v).unwrap_or_else(|_| "{}".into()));
                let doc_type = p.doc_type.unwrap_or_else(|| "note".into());
                let content = p.content.unwrap_or_default();

                let doc = self.with_db(move |db| {
                    db.create_document(
                        &id, p.session_id.as_deref(), p.agent_id.as_deref(),
                        &doc_type, &p.title, &content, p.summary.as_deref(),
                        p.status.as_deref(), p.severity.as_deref(), p.priority,
                        p.parent_id.as_deref(), p.file_path.as_deref(),
                        metadata_str.as_deref(), p.validation_criteria.as_deref(),
                    )
                }).await?;
                Ok(doc)
            }

            "chat/document/get" => {
                let p: IdParam = parse_params(params)?;
                let doc = self.with_db(move |db| db.get_document(&p.id)).await?;
                Ok(doc.unwrap_or(Value::Null))
            }

            "chat/document/list" => {
                let p: DocumentListParams = parse_params_optional(params);
                let limit = p.limit.unwrap_or(100);
                let offset = p.offset.unwrap_or(0);
                let docs = self.with_db(move |db| {
                    db.list_documents(
                        p.session_id.as_deref(), p.agent_id.as_deref(),
                        p.doc_type.as_deref(), p.status.as_deref(),
                        p.parent_id.as_deref(), p.severity.as_deref(),
                        p.review_status.as_deref(), limit, offset,
                    )
                }).await?;
                Ok(Value::Array(docs))
            }

            "chat/document/update" => {
                let p: DocumentUpdateParams = parse_params(params)?;
                let metadata_str = p.metadata.map(|v| serde_json::to_string(&v).unwrap_or_else(|_| "{}".into()));
                let doc = self.with_db(move |db| {
                    db.update_document(
                        &p.id, p.title.as_deref(), p.content.as_deref(),
                        p.summary.as_deref(), p.status.as_deref(), p.severity.as_deref(),
                        p.priority, p.reviewed_by_agent_id.as_deref(),
                        p.review_status.as_deref(), p.file_path.as_deref(),
                        p.validation_criteria.as_deref(), metadata_str.as_deref(),
                    )
                }).await?;
                Ok(doc.unwrap_or(Value::Null))
            }

            "chat/document/delete" => {
                let p: IdParam = parse_params(params)?;
                let deleted = self.with_db(move |db| db.delete_document(&p.id)).await?;
                Ok(json!({ "success": deleted }))
            }

            "chat/document/search" => {
                let p: DocumentSearchParams = parse_params(params)?;
                let limit = p.limit.unwrap_or(50);
                let docs = self.with_db(move |db| db.search_documents(&p.query, p.doc_type.as_deref(), limit)).await?;
                Ok(Value::Array(docs))
            }

            "chat/document/hierarchy" => {
                let p: IdParam = parse_params(params)?;
                let hierarchy = self.with_db(move |db| db.document_hierarchy(&p.id)).await?;
                Ok(hierarchy.unwrap_or(Value::Null))
            }

            "chat/document/count-by-type" => {
                let counts = self.with_db(move |db| db.count_documents_by_type()).await?;
                Ok(counts)
            }

            "chat/document/vulnerabilities" => {
                let p: ActivityQueryParams = parse_params_optional(params);
                let docs = self.with_db(move |db| db.get_active_vulnerabilities(p.session_id.as_deref())).await?;
                Ok(Value::Array(docs))
            }

            "chat/document/pending-reviews" => {
                let docs = self.with_db(move |db| db.get_pending_reviews()).await?;
                Ok(Value::Array(docs))
            }

            // ── Activity (reconstructed from data tables) ────────────
            "chat/activity/log" => {
                let p: ActivityQueryParams = parse_params_optional(params);
                let limit = p.limit.unwrap_or(100);
                let activities = self.with_db(move |db| db.reconstruct_activity(p.session_id.as_deref(), limit, None)).await?;
                Ok(Value::Array(activities))
            }

            "chat/activity/add" => {
                // No-op: activity is reconstructed from data tables
                Ok(json!({ "success": true }))
            }

            "chat/activity/since" => {
                let p: ActivitySinceParams = parse_params(params)?;
                let limit = p.limit.unwrap_or(100);
                let activities = self.with_db(move |db| db.reconstruct_activity(p.session_id.as_deref(), limit, Some(p.since))).await?;
                Ok(Value::Array(activities))
            }

            // ── Stats ────────────────────────────────────────────────
            "chat/stats" => {
                let p: OptionalSessionIdParam = parse_params_optional(params);
                let stats = self.with_db(move |db| db.stats(p.session_id.as_deref())).await?;
                Ok(json!({ "stats": stats }))
            }

            // ── Context ──────────────────────────────────────────────
            "chat/context/build" => {
                let p: SessionIdParam = parse_params(params)?;
                let sid = p.session_id.clone();
                let context = self.with_db(move |db| {
                    let session = db.get_session(&p.session_id)?;
                    let messages = db.list_messages(&p.session_id, 100, 0, None)?;
                    let documents = db.list_documents(Some(p.session_id.as_str()), None, None, None, None, None, None, 100, 0)?;
                    let todos = db.list_todos(Some(&p.session_id), None, None)?;
                    let compactions = db.list_compactions(&p.session_id)?;
                    Ok(json!({
                        "session": session,
                        "messages": messages,
                        "documents": documents,
                        "todos": todos,
                        "compactions": compactions,
                    }))
                }).await?;
                Ok(json!({ "sessionId": sid, "context": context }))
            }

            // ── Todo get ──────────────────────────────────────────────
            "chat/todo/get" => {
                let p: IdParam = parse_params(params)?;
                let todo = self.with_db(move |db| db.get_todo(&p.id)).await?;
                Ok(todo.unwrap_or(Value::Null))
            }

            // ── Session Agents ──────────────────────────────────────
            "chat/sessionAgent/list" => {
                let p: SessionAgentListParams = parse_params(params)?;
                let include_left = p.include_left.unwrap_or(false);
                let agents = self.with_db(move |db| db.list_session_agents(&p.session_id, include_left)).await?;
                Ok(Value::Array(agents))
            }

            "chat/sessionAgent/add" => {
                let p: SessionAgentAddParams = parse_params(params)?;
                let result = self.with_db(move |db| {
                    db.add_session_agent(&p.session_id, &p.agent_id, p.role.as_deref().unwrap_or("primary"), p.agent_name.as_deref())
                }).await?;
                Ok(json!({ "agent": result }))
            }

            "chat/sessionAgent/remove" => {
                let p: SessionAgentRemoveParams = parse_params(params)?;
                let success = self.with_db(move |db| db.remove_session_agent(&p.session_id, &p.agent_id)).await?;
                Ok(json!({ "success": success }))
            }

            "chat/todo/replace" => {
                let p: TodoReplaceParams = parse_params(params)?;
                let todos = self.with_db(move |db| {
                    if let Some(ref sid) = p.session_id {
                        db.conn.execute("DELETE FROM todos WHERE session_id = ?1", rusqlite::params![sid])?;
                    }
                    for (idx, todo) in p.todos.iter().enumerate() {
                        let id = todo.get("id").and_then(|v| v.as_str()).map(|s| s.to_string())
                            .unwrap_or_else(|| format!("todo-{}", uuid_v4()));
                        let content = todo.get("content").and_then(|v| v.as_str()).unwrap_or("");
                        let active_form = todo.get("activeForm").and_then(|v| v.as_str());
                        let status = todo.get("status").and_then(|v| v.as_str()).unwrap_or("pending");
                        let document_id = todo.get("documentId").and_then(|v| v.as_str());
                        let agent_id = todo.get("agentId").and_then(|v| v.as_str());
                        let assigned_agent_id = todo.get("assignedAgentId").and_then(|v| v.as_str());
                        db.upsert_todo(&id, p.session_id.as_deref(), content, active_form, status, idx as i64, document_id, agent_id, assigned_agent_id)?;
                    }
                    // Return the new todo list (matches TypeScript behavior)
                    db.list_todos(p.session_id.as_deref(), None, None)
                }).await?;
                Ok(Value::Array(todos))
            }

            _ => Err(ECPError::method_not_found(method)),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct SessionCreateParams {
    title: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    #[serde(rename = "systemPrompt")]
    system_prompt: Option<String>,
    #[serde(rename = "workflowId")]
    workflow_id: Option<String>,
}

#[derive(Deserialize)]
struct SessionIdParam {
    #[serde(rename = "sessionId")]
    session_id: String,
}

#[derive(Deserialize)]
struct SessionUpdateParams {
    #[serde(rename = "sessionId")]
    session_id: String,
    title: Option<String>,
    status: Option<String>,
    model: Option<String>,
    provider: Option<String>,
    #[serde(rename = "systemPrompt")]
    system_prompt: Option<String>,
    #[serde(rename = "errorMessage")]
    error_message: Option<String>,
}

#[derive(Deserialize, Default)]
struct ListParams {
    limit: Option<i64>,
    offset: Option<i64>,
}
impl ListParams {
    fn limit(&self) -> i64 { self.limit.unwrap_or(50) }
    fn offset(&self) -> i64 { self.offset.unwrap_or(0) }
}

#[derive(Deserialize)]
struct MessageAddParams {
    id: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: String,
    role: String,
    content: String,
    model: Option<String>,
    #[serde(rename = "inputTokens")]
    input_tokens: Option<i64>,
    #[serde(rename = "outputTokens")]
    output_tokens: Option<i64>,
    #[serde(rename = "durationMs")]
    duration_ms: Option<i64>,
    #[serde(rename = "agentId")]
    agent_id: Option<String>,
    #[serde(rename = "agentName")]
    agent_name: Option<String>,
    #[serde(rename = "agentRole")]
    agent_role: Option<String>,
    tokens: Option<i64>,
    #[serde(rename = "isComplete")]
    is_complete: Option<bool>,
    #[serde(rename = "iterationNumber")]
    iteration_number: Option<i64>,
}

#[derive(Deserialize)]
struct MessageUpdateParams {
    id: String,
    content: Option<String>,
    #[serde(rename = "isComplete")]
    is_complete: Option<bool>,
    #[serde(rename = "isActive")]
    is_active: Option<bool>,
}

#[derive(Deserialize)]
struct MessageListParams {
    #[serde(rename = "sessionId")]
    session_id: String,
    limit: Option<i64>,
    offset: Option<i64>,
    after: Option<i64>,
}

#[derive(Deserialize)]
struct MessageSearchParams {
    query: String,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    limit: Option<i64>,
}

#[derive(Deserialize)]
struct IdParam {
    id: String,
}

#[derive(Deserialize)]
struct ToolCallAddParams {
    id: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "messageId")]
    message_id: Option<String>,
    #[serde(rename = "toolName")]
    tool_name: String,
    input: Value,
    #[serde(rename = "agentId")]
    agent_id: Option<String>,
    #[serde(rename = "agentName")]
    agent_name: Option<String>,
    #[serde(rename = "nodeExecutionId")]
    node_execution_id: Option<String>,
}

#[derive(Deserialize)]
struct ToolCallCompleteParams {
    id: String,
    output: Option<Value>,
    status: Option<String>,
    #[serde(rename = "errorMessage")]
    error_message: Option<String>,
}

#[derive(Deserialize)]
struct ToolCallListParams {
    #[serde(rename = "sessionId")]
    session_id: String,
    limit: Option<i64>,
}

#[derive(Deserialize)]
struct PermissionCheckParams {
    #[serde(rename = "toolName")]
    tool_name: String,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
}

#[derive(Deserialize)]
struct PermissionGrantParams {
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    #[serde(rename = "workflowId")]
    workflow_id: Option<String>,
    #[serde(rename = "toolName")]
    tool_name: String,
    scope: String,
    pattern: Option<String>,
    decision: Option<String>,
}

#[derive(Deserialize, Default)]
struct OptionalSessionIdParam {
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
}

#[derive(Deserialize)]
struct TodoUpsertParams {
    id: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    content: String,
    #[serde(rename = "activeForm")]
    active_form: Option<String>,
    status: Option<String>,
    #[serde(rename = "orderIndex")]
    order_index: Option<i64>,
    #[serde(rename = "documentId")]
    document_id: Option<String>,
    #[serde(rename = "agentId")]
    agent_id: Option<String>,
    #[serde(rename = "assignedAgentId")]
    assigned_agent_id: Option<String>,
}

#[derive(Deserialize, Default)]
struct TodoListParams {
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    #[serde(rename = "documentId")]
    document_id: Option<String>,
    limit: Option<i64>,
}

#[derive(Deserialize)]
struct TodoStatusParams {
    id: String,
    status: String,
}

#[derive(Deserialize)]
struct CompactionCreateParams {
    #[serde(rename = "sessionId")]
    session_id: String,
    summary: String,
    #[serde(rename = "startMessageId")]
    start_message_id: Option<String>,
    #[serde(rename = "endMessageId")]
    end_message_id: Option<String>,
    #[serde(rename = "messagesCompacted")]
    messages_compacted: Option<i64>,
    #[serde(rename = "originalTokenCount")]
    original_token_count: Option<i64>,
    #[serde(rename = "compressedTokenCount")]
    compressed_token_count: Option<i64>,
}

#[derive(Deserialize)]
struct DocumentCreateParams {
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    #[serde(rename = "agentId")]
    agent_id: Option<String>,
    title: String,
    #[serde(alias = "type", alias = "docType", rename = "docType")]
    doc_type: Option<String>,
    content: Option<String>,
    summary: Option<String>,
    status: Option<String>,
    severity: Option<String>,
    priority: Option<i64>,
    #[serde(rename = "parentId")]
    parent_id: Option<String>,
    #[serde(rename = "filePath")]
    file_path: Option<String>,
    #[serde(rename = "validationCriteria")]
    validation_criteria: Option<String>,
    metadata: Option<Value>,
}

#[derive(Deserialize, Default)]
struct DocumentListParams {
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    #[serde(rename = "agentId")]
    agent_id: Option<String>,
    #[serde(alias = "type", alias = "docType", rename = "docType")]
    doc_type: Option<String>,
    status: Option<String>,
    #[serde(rename = "parentId")]
    parent_id: Option<String>,
    severity: Option<String>,
    #[serde(rename = "reviewStatus")]
    review_status: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Deserialize)]
struct DocumentUpdateParams {
    id: String,
    title: Option<String>,
    content: Option<String>,
    summary: Option<String>,
    status: Option<String>,
    severity: Option<String>,
    priority: Option<i64>,
    #[serde(rename = "reviewedByAgentId")]
    reviewed_by_agent_id: Option<String>,
    #[serde(rename = "reviewStatus")]
    review_status: Option<String>,
    #[serde(rename = "filePath")]
    file_path: Option<String>,
    #[serde(rename = "validationCriteria")]
    validation_criteria: Option<String>,
    metadata: Option<Value>,
}

#[derive(Deserialize)]
struct DocumentSearchParams {
    query: String,
    #[serde(alias = "type", alias = "docType", rename = "docType")]
    doc_type: Option<String>,
    limit: Option<i64>,
}

#[derive(Deserialize, Default)]
struct ActivityQueryParams {
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    limit: Option<i64>,
}

#[derive(Deserialize)]
struct ActivitySinceParams {
    since: i64,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    limit: Option<i64>,
}

#[derive(Deserialize)]
struct TodoReplaceParams {
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    todos: Vec<Value>,
}

#[derive(Deserialize)]
struct SessionAgentListParams {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "includeLeft")]
    include_left: Option<bool>,
}

#[derive(Deserialize)]
struct SessionAgentAddParams {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "agentId")]
    agent_id: String,
    role: Option<String>,
    #[serde(rename = "agentName")]
    agent_name: Option<String>,
}

#[derive(Deserialize)]
struct SessionAgentRemoveParams {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "agentId")]
    agent_id: String,
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

fn parse_params<T: for<'de> Deserialize<'de>>(params: Option<Value>) -> Result<T, ECPError> {
    match params {
        Some(v) => serde_json::from_value(v)
            .map_err(|e| ECPError::invalid_params(format!("Invalid parameters: {e}"))),
        None => Err(ECPError::invalid_params("Parameters required")),
    }
}

fn parse_params_optional<T: for<'de> Deserialize<'de> + Default>(params: Option<Value>) -> T {
    params.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn uuid_v4() -> String {
    uuid::Uuid::new_v4().to_string()
}
