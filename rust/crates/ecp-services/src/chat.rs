//! Chat service — SQLite-backed session/message storage with tool tracking, todos, and permissions.

use std::sync::Arc;

use ecp_protocol::{ECPError, HandlerResult};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::Service;

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
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
        let db = Self { conn };
        db.run_migrations()?;
        Ok(db)
    }

    fn run_migrations(&self) -> Result<(), rusqlite::Error> {
        self.conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS sessions (
                id          TEXT PRIMARY KEY,
                title       TEXT,
                provider    TEXT NOT NULL DEFAULT 'claude',
                model       TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
                system_prompt TEXT,
                status      TEXT NOT NULL DEFAULT 'active',
                created_at  INTEGER NOT NULL,
                updated_at  INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
                id          TEXT PRIMARY KEY,
                session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                role        TEXT NOT NULL,
                content     TEXT NOT NULL,
                model       TEXT,
                input_tokens  INTEGER,
                output_tokens INTEGER,
                duration_ms   INTEGER,
                agent_id    TEXT,
                agent_name  TEXT,
                turn_index  INTEGER,
                created_at  INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tool_calls (
                id          TEXT PRIMARY KEY,
                session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                message_id  TEXT,
                tool_name   TEXT NOT NULL,
                input       TEXT NOT NULL DEFAULT '{}',
                output      TEXT,
                status      TEXT NOT NULL DEFAULT 'pending',
                error_message TEXT,
                agent_id    TEXT,
                started_at  INTEGER NOT NULL,
                completed_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS todos (
                id          TEXT PRIMARY KEY,
                session_id  TEXT,
                content     TEXT NOT NULL,
                active_form TEXT,
                status      TEXT NOT NULL DEFAULT 'pending',
                order_index INTEGER NOT NULL DEFAULT 0,
                created_at  INTEGER NOT NULL,
                updated_at  INTEGER NOT NULL,
                completed_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS permissions (
                id          TEXT PRIMARY KEY,
                session_id  TEXT,
                tool_name   TEXT NOT NULL,
                scope       TEXT NOT NULL DEFAULT 'session',
                pattern     TEXT,
                decision    TEXT NOT NULL DEFAULT 'pending',
                granted_at  INTEGER NOT NULL,
                expires_at  INTEGER
            );

            CREATE TABLE IF NOT EXISTS compactions (
                id              TEXT PRIMARY KEY,
                session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                summary         TEXT NOT NULL,
                start_message_id TEXT NOT NULL,
                end_message_id   TEXT NOT NULL,
                message_count   INTEGER NOT NULL,
                tokens_before   INTEGER,
                tokens_after    INTEGER,
                is_active       INTEGER NOT NULL DEFAULT 1,
                created_at      INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
            CREATE INDEX IF NOT EXISTS idx_todos_session ON todos(session_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_permissions_tool ON permissions(tool_name);
            CREATE INDEX IF NOT EXISTS idx_compactions_session ON compactions(session_id);
            "
        )?;
        Ok(())
    }

    // ── Session CRUD ─────────────────────────────────────────────────────

    fn create_session(&self, id: &str, title: Option<&str>, provider: &str, model: &str, system_prompt: Option<&str>) -> Result<(), rusqlite::Error> {
        let now = now_ms() as i64;
        self.conn.execute(
            "INSERT INTO sessions (id, title, provider, model, system_prompt, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?6)",
            rusqlite::params![id, title, provider, model, system_prompt, now],
        )?;
        Ok(())
    }

    fn get_session(&self, id: &str) -> Result<Option<Value>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, provider, model, system_prompt, status, created_at, updated_at FROM sessions WHERE id = ?1"
        )?;
        let mut rows = stmt.query(rusqlite::params![id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(json!({
                "id": row.get::<_, String>(0)?,
                "title": row.get::<_, Option<String>>(1)?,
                "provider": row.get::<_, String>(2)?,
                "model": row.get::<_, String>(3)?,
                "systemPrompt": row.get::<_, Option<String>>(4)?,
                "status": row.get::<_, String>(5)?,
                "createdAt": row.get::<_, i64>(6)?,
                "updatedAt": row.get::<_, i64>(7)?,
            })))
        } else {
            Ok(None)
        }
    }

    fn update_session(&self, id: &str, title: Option<&str>, status: Option<&str>) -> Result<bool, rusqlite::Error> {
        let now = now_ms() as i64;
        let changed = match (title, status) {
            (Some(t), Some(s)) => self.conn.execute(
                "UPDATE sessions SET updated_at = ?1, title = ?2, status = ?3 WHERE id = ?4",
                rusqlite::params![now, t, s, id],
            )?,
            (Some(t), None) => self.conn.execute(
                "UPDATE sessions SET updated_at = ?1, title = ?2 WHERE id = ?3",
                rusqlite::params![now, t, id],
            )?,
            (None, Some(s)) => self.conn.execute(
                "UPDATE sessions SET updated_at = ?1, status = ?2 WHERE id = ?3",
                rusqlite::params![now, s, id],
            )?,
            (None, None) => self.conn.execute(
                "UPDATE sessions SET updated_at = ?1 WHERE id = ?2",
                rusqlite::params![now, id],
            )?,
        };
        Ok(changed > 0)
    }

    fn delete_session(&self, id: &str) -> Result<bool, rusqlite::Error> {
        let changed = self.conn.execute("DELETE FROM sessions WHERE id = ?1", rusqlite::params![id])?;
        Ok(changed > 0)
    }

    fn list_sessions(&self, limit: i64, offset: i64) -> Result<Vec<Value>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, provider, model, status, created_at, updated_at FROM sessions ORDER BY updated_at DESC LIMIT ?1 OFFSET ?2"
        )?;
        let rows = stmt.query_map(rusqlite::params![limit, offset], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "title": row.get::<_, Option<String>>(1)?,
                "provider": row.get::<_, String>(2)?,
                "model": row.get::<_, String>(3)?,
                "status": row.get::<_, String>(4)?,
                "createdAt": row.get::<_, i64>(5)?,
                "updatedAt": row.get::<_, i64>(6)?,
            }))
        })?;
        rows.collect()
    }

    // ── Message CRUD ─────────────────────────────────────────────────────

    fn add_message(&self, id: &str, session_id: &str, role: &str, content: &str, model: Option<&str>, input_tokens: Option<i64>, output_tokens: Option<i64>, duration_ms: Option<i64>, agent_id: Option<&str>, turn_index: Option<i64>) -> Result<(), rusqlite::Error> {
        let now = now_ms() as i64;
        self.conn.execute(
            "INSERT INTO messages (id, session_id, role, content, model, input_tokens, output_tokens, duration_ms, agent_id, turn_index, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            rusqlite::params![id, session_id, role, content, model, input_tokens, output_tokens, duration_ms, agent_id, turn_index, now],
        )?;
        // Touch session updated_at
        self.conn.execute("UPDATE sessions SET updated_at = ?1 WHERE id = ?2", rusqlite::params![now, session_id])?;
        Ok(())
    }

    fn list_messages(&self, session_id: &str, limit: i64, offset: i64) -> Result<Vec<Value>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, role, content, model, input_tokens, output_tokens, duration_ms, agent_id, agent_name, turn_index, created_at FROM messages WHERE session_id = ?1 ORDER BY created_at ASC LIMIT ?2 OFFSET ?3"
        )?;
        let rows = stmt.query_map(rusqlite::params![session_id, limit, offset], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "sessionId": row.get::<_, String>(1)?,
                "role": row.get::<_, String>(2)?,
                "content": row.get::<_, String>(3)?,
                "model": row.get::<_, Option<String>>(4)?,
                "inputTokens": row.get::<_, Option<i64>>(5)?,
                "outputTokens": row.get::<_, Option<i64>>(6)?,
                "durationMs": row.get::<_, Option<i64>>(7)?,
                "agentId": row.get::<_, Option<String>>(8)?,
                "agentName": row.get::<_, Option<String>>(9)?,
                "turnIndex": row.get::<_, Option<i64>>(10)?,
                "createdAt": row.get::<_, i64>(11)?,
            }))
        })?;
        rows.collect()
    }

    fn update_message(&self, id: &str, content: Option<&str>) -> Result<bool, rusqlite::Error> {
        if let Some(c) = content {
            let changed = self.conn.execute("UPDATE messages SET content = ?1 WHERE id = ?2", rusqlite::params![c, id])?;
            Ok(changed > 0)
        } else {
            Ok(false)
        }
    }

    fn delete_message(&self, id: &str) -> Result<bool, rusqlite::Error> {
        let changed = self.conn.execute("DELETE FROM messages WHERE id = ?1", rusqlite::params![id])?;
        Ok(changed > 0)
    }

    fn search_messages(&self, query: &str, session_id: Option<&str>, limit: i64) -> Result<Vec<Value>, rusqlite::Error> {
        let pattern = format!("%{query}%");
        if let Some(sid) = session_id {
            let mut stmt = self.conn.prepare(
                "SELECT id, session_id, role, content, created_at FROM messages WHERE session_id = ?1 AND content LIKE ?2 ORDER BY created_at DESC LIMIT ?3"
            )?;
            let rows = stmt.query_map(rusqlite::params![sid, pattern, limit], |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "sessionId": row.get::<_, String>(1)?,
                    "role": row.get::<_, String>(2)?,
                    "content": row.get::<_, String>(3)?,
                    "createdAt": row.get::<_, i64>(4)?,
                }))
            })?;
            rows.collect()
        } else {
            let mut stmt = self.conn.prepare(
                "SELECT id, session_id, role, content, created_at FROM messages WHERE content LIKE ?1 ORDER BY created_at DESC LIMIT ?2"
            )?;
            let rows = stmt.query_map(rusqlite::params![pattern, limit], |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "sessionId": row.get::<_, String>(1)?,
                    "role": row.get::<_, String>(2)?,
                    "content": row.get::<_, String>(3)?,
                    "createdAt": row.get::<_, i64>(4)?,
                }))
            })?;
            rows.collect()
        }
    }

    fn recent_messages(&self, limit: i64) -> Result<Vec<Value>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, role, content, model, created_at FROM messages ORDER BY created_at DESC LIMIT ?1"
        )?;
        let rows = stmt.query_map(rusqlite::params![limit], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "sessionId": row.get::<_, String>(1)?,
                "role": row.get::<_, String>(2)?,
                "content": row.get::<_, String>(3)?,
                "model": row.get::<_, Option<String>>(4)?,
                "createdAt": row.get::<_, i64>(5)?,
            }))
        })?;
        rows.collect()
    }

    // ── Tool calls ───────────────────────────────────────────────────────

    fn add_tool_call(&self, id: &str, session_id: &str, message_id: Option<&str>, tool_name: &str, input: &str, agent_id: Option<&str>) -> Result<(), rusqlite::Error> {
        let now = now_ms() as i64;
        self.conn.execute(
            "INSERT INTO tool_calls (id, session_id, message_id, tool_name, input, status, agent_id, started_at) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7)",
            rusqlite::params![id, session_id, message_id, tool_name, input, agent_id, now],
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

    fn list_tool_calls(&self, session_id: &str) -> Result<Vec<Value>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, message_id, tool_name, input, output, status, error_message, agent_id, started_at, completed_at FROM tool_calls WHERE session_id = ?1 ORDER BY started_at ASC"
        )?;
        let rows = stmt.query_map(rusqlite::params![session_id], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "sessionId": row.get::<_, String>(1)?,
                "messageId": row.get::<_, Option<String>>(2)?,
                "toolName": row.get::<_, String>(3)?,
                "input": row.get::<_, String>(4)?,
                "output": row.get::<_, Option<String>>(5)?,
                "status": row.get::<_, String>(6)?,
                "errorMessage": row.get::<_, Option<String>>(7)?,
                "agentId": row.get::<_, Option<String>>(8)?,
                "startedAt": row.get::<_, i64>(9)?,
                "completedAt": row.get::<_, Option<i64>>(10)?,
            }))
        })?;
        rows.collect()
    }

    // ── Todos ────────────────────────────────────────────────────────────

    fn upsert_todo(&self, id: &str, session_id: Option<&str>, content: &str, active_form: Option<&str>, status: &str, order_index: i64) -> Result<(), rusqlite::Error> {
        let now = now_ms() as i64;
        let completed_at: Option<i64> = if status == "completed" { Some(now) } else { None };
        self.conn.execute(
            "INSERT INTO todos (id, session_id, content, active_form, status, order_index, created_at, updated_at, completed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8) ON CONFLICT(id) DO UPDATE SET content = ?3, active_form = ?4, status = ?5, order_index = ?6, updated_at = ?7, completed_at = ?8",
            rusqlite::params![id, session_id, content, active_form, status, order_index, now, completed_at],
        )?;
        Ok(())
    }

    fn list_todos(&self, session_id: Option<&str>) -> Result<Vec<Value>, rusqlite::Error> {
        if let Some(sid) = session_id {
            let mut stmt = self.conn.prepare(
                "SELECT id, session_id, content, active_form, status, order_index, created_at, updated_at, completed_at FROM todos WHERE session_id = ?1 ORDER BY order_index ASC"
            )?;
            let rows = stmt.query_map(rusqlite::params![sid], |row| todo_row_to_json(row))?;
            rows.collect()
        } else {
            let mut stmt = self.conn.prepare(
                "SELECT id, session_id, content, active_form, status, order_index, created_at, updated_at, completed_at FROM todos ORDER BY order_index ASC"
            )?;
            let rows = stmt.query_map([], |row| todo_row_to_json(row))?;
            rows.collect()
        }
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
        // Check session-scoped first, then global
        let mut stmt = self.conn.prepare(
            "SELECT id, tool_name, scope, pattern, decision, granted_at, expires_at FROM permissions WHERE tool_name = ?1 AND (session_id = ?2 OR session_id IS NULL) AND decision = 'approved' ORDER BY granted_at DESC LIMIT 1"
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
            })))
        } else {
            Ok(None)
        }
    }

    fn grant_permission(&self, id: &str, session_id: Option<&str>, tool_name: &str, scope: &str, pattern: Option<&str>) -> Result<(), rusqlite::Error> {
        let now = now_ms() as i64;
        self.conn.execute(
            "INSERT INTO permissions (id, session_id, tool_name, scope, pattern, decision, granted_at) VALUES (?1, ?2, ?3, ?4, ?5, 'approved', ?6)",
            rusqlite::params![id, session_id, tool_name, scope, pattern, now],
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
                "SELECT id, session_id, tool_name, scope, pattern, decision, granted_at, expires_at FROM permissions WHERE session_id = ?1 ORDER BY granted_at DESC"
            )?;
            let rows = stmt.query_map(rusqlite::params![sid], |row| permission_row_to_json(row))?;
            rows.collect()
        } else {
            let mut stmt = self.conn.prepare(
                "SELECT id, session_id, tool_name, scope, pattern, decision, granted_at, expires_at FROM permissions ORDER BY granted_at DESC"
            )?;
            let rows = stmt.query_map([], |row| permission_row_to_json(row))?;
            rows.collect()
        }
    }

    // ── Compactions ──────────────────────────────────────────────────────

    fn create_compaction(&self, id: &str, session_id: &str, summary: &str, start_msg: &str, end_msg: &str, message_count: i64, tokens_before: Option<i64>, tokens_after: Option<i64>) -> Result<(), rusqlite::Error> {
        let now = now_ms() as i64;
        self.conn.execute(
            "INSERT INTO compactions (id, session_id, summary, start_message_id, end_message_id, message_count, tokens_before, tokens_after, is_active, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9)",
            rusqlite::params![id, session_id, summary, start_msg, end_msg, message_count, tokens_before, tokens_after, now],
        )?;
        Ok(())
    }

    fn list_compactions(&self, session_id: &str) -> Result<Vec<Value>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, summary, start_message_id, end_message_id, message_count, tokens_before, tokens_after, is_active, created_at FROM compactions WHERE session_id = ?1 ORDER BY created_at ASC"
        )?;
        let rows = stmt.query_map(rusqlite::params![session_id], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "sessionId": row.get::<_, String>(1)?,
                "summary": row.get::<_, String>(2)?,
                "startMessageId": row.get::<_, String>(3)?,
                "endMessageId": row.get::<_, String>(4)?,
                "messageCount": row.get::<_, i64>(5)?,
                "tokensBefore": row.get::<_, Option<i64>>(6)?,
                "tokensAfter": row.get::<_, Option<i64>>(7)?,
                "isActive": row.get::<_, bool>(8)?,
                "createdAt": row.get::<_, i64>(9)?,
            }))
        })?;
        rows.collect()
    }

    fn delete_compaction(&self, id: &str) -> Result<bool, rusqlite::Error> {
        let changed = self.conn.execute("DELETE FROM compactions WHERE id = ?1", rusqlite::params![id])?;
        Ok(changed > 0)
    }
}

fn todo_row_to_json(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "sessionId": row.get::<_, Option<String>>(1)?,
        "content": row.get::<_, String>(2)?,
        "activeForm": row.get::<_, Option<String>>(3)?,
        "status": row.get::<_, String>(4)?,
        "orderIndex": row.get::<_, i64>(5)?,
        "createdAt": row.get::<_, i64>(6)?,
        "updatedAt": row.get::<_, i64>(7)?,
        "completedAt": row.get::<_, Option<i64>>(8)?,
    }))
}

fn permission_row_to_json(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "sessionId": row.get::<_, Option<String>>(1)?,
        "toolName": row.get::<_, String>(2)?,
        "scope": row.get::<_, String>(3)?,
        "pattern": row.get::<_, Option<String>>(4)?,
        "decision": row.get::<_, String>(5)?,
        "grantedAt": row.get::<_, i64>(6)?,
        "expiresAt": row.get::<_, Option<i64>>(7)?,
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
                let id_clone = id.clone();

                self.with_db(move |db| {
                    db.create_session(&id_clone, title_clone.as_deref(), &provider, &model, sp_clone.as_deref())
                }).await?;

                Ok(json!({ "sessionId": id }))
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
                    db.update_session(&p.session_id, p.title.as_deref(), p.status.as_deref())
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
                Ok(json!({ "sessions": sessions }))
            }

            // ── Messages ─────────────────────────────────────────────
            "chat/message/add" => {
                let p: MessageAddParams = parse_params(params)?;
                let id = format!("msg-{}", uuid_v4());
                let id_clone = id.clone();

                self.with_db(move |db| {
                    db.add_message(
                        &id_clone, &p.session_id, &p.role, &p.content,
                        p.model.as_deref(), p.input_tokens, p.output_tokens,
                        p.duration_ms, p.agent_id.as_deref(), p.turn_index,
                    )
                }).await?;

                Ok(json!({ "messageId": id }))
            }

            "chat/message/update" => {
                let p: MessageUpdateParams = parse_params(params)?;
                let updated = self.with_db(move |db| db.update_message(&p.id, p.content.as_deref())).await?;
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
                let messages = self.with_db(move |db| db.list_messages(&p.session_id, limit, offset)).await?;
                Ok(json!({ "messages": messages }))
            }

            "chat/message/search" => {
                let p: MessageSearchParams = parse_params(params)?;
                let limit = p.limit.unwrap_or(50);
                let messages = self.with_db(move |db| db.search_messages(&p.query, p.session_id.as_deref(), limit)).await?;
                Ok(json!({ "messages": messages }))
            }

            "chat/message/recent" => {
                let p: ListParams = parse_params_optional(params);
                let messages = self.with_db(move |db| db.recent_messages(p.limit())).await?;
                Ok(json!({ "messages": messages }))
            }

            // ── Tool calls ───────────────────────────────────────────
            "chat/toolCall/add" => {
                let p: ToolCallAddParams = parse_params(params)?;
                let id = format!("tc-{}", uuid_v4());
                let id_clone = id.clone();
                let input_str = serde_json::to_string(&p.input).unwrap_or_else(|_| "{}".into());

                self.with_db(move |db| {
                    db.add_tool_call(&id_clone, &p.session_id, p.message_id.as_deref(), &p.tool_name, &input_str, p.agent_id.as_deref())
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
                let p: SessionIdParam = parse_params(params)?;
                let calls = self.with_db(move |db| db.list_tool_calls(&p.session_id)).await?;
                Ok(json!({ "toolCalls": calls }))
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

                self.with_db(move |db| {
                    db.grant_permission(&id_clone, p.session_id.as_deref(), &p.tool_name, &p.scope, p.pattern.as_deref())
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
                Ok(json!({ "permissions": perms }))
            }

            // ── Todos ────────────────────────────────────────────────
            "chat/todo/upsert" => {
                let p: TodoUpsertParams = parse_params(params)?;
                let id = p.id.unwrap_or_else(|| format!("todo-{}", uuid_v4()));
                let id_clone = id.clone();
                let status = p.status.unwrap_or_else(|| "pending".into());

                self.with_db(move |db| {
                    db.upsert_todo(&id_clone, p.session_id.as_deref(), &p.content, p.active_form.as_deref(), &status, p.order_index.unwrap_or(0))
                }).await?;

                Ok(json!({ "todoId": id }))
            }

            "chat/todo/list" => {
                let p: OptionalSessionIdParam = parse_params_optional(params);
                let todos = self.with_db(move |db| db.list_todos(p.session_id.as_deref())).await?;
                Ok(json!({ "todos": todos }))
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
                        &p.start_message_id, &p.end_message_id,
                        p.message_count, p.tokens_before, p.tokens_after,
                    )
                }).await?;

                Ok(json!({ "compactionId": id }))
            }

            "chat/compaction/list" => {
                let p: SessionIdParam = parse_params(params)?;
                let compactions = self.with_db(move |db| db.list_compactions(&p.session_id)).await?;
                Ok(json!({ "compactions": compactions }))
            }

            "chat/compaction/delete" => {
                let p: IdParam = parse_params(params)?;
                let deleted = self.with_db(move |db| db.delete_compaction(&p.id)).await?;
                Ok(json!({ "success": deleted }))
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
    #[serde(rename = "turnIndex")]
    turn_index: Option<i64>,
}

#[derive(Deserialize)]
struct MessageUpdateParams {
    id: String,
    content: Option<String>,
}

#[derive(Deserialize)]
struct MessageListParams {
    #[serde(rename = "sessionId")]
    session_id: String,
    limit: Option<i64>,
    offset: Option<i64>,
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
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "messageId")]
    message_id: Option<String>,
    #[serde(rename = "toolName")]
    tool_name: String,
    input: Value,
    #[serde(rename = "agentId")]
    agent_id: Option<String>,
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
    #[serde(rename = "toolName")]
    tool_name: String,
    scope: String,
    pattern: Option<String>,
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
    start_message_id: String,
    #[serde(rename = "endMessageId")]
    end_message_id: String,
    #[serde(rename = "messageCount")]
    message_count: i64,
    #[serde(rename = "tokensBefore")]
    tokens_before: Option<i64>,
    #[serde(rename = "tokensAfter")]
    tokens_after: Option<i64>,
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
