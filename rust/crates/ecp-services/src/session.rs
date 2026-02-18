//! Session service — save/load workspace state, settings management.

use std::collections::HashMap;
use std::path::PathBuf;

use ecp_protocol::{ECPError, HandlerResult};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tracing::{debug, info};

use crate::Service;

/// Serialized session state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionState {
    pub name: Option<String>,
    pub workspace_root: Option<String>,
    pub open_files: Vec<String>,
    pub active_file: Option<String>,
    pub settings: HashMap<String, Value>,
    pub created_at: u64,
    pub updated_at: u64,
}

/// Session service — settings and session persistence.
pub struct SessionService {
    workspace_root: RwLock<PathBuf>,
    sessions_dir: RwLock<PathBuf>,
    settings: RwLock<HashMap<String, Value>>,
    current_session: RwLock<Option<SessionState>>,
}

impl SessionService {
    pub fn new(workspace_root: PathBuf) -> Self {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        let sessions_dir = PathBuf::from(&home).join(".ultra/sessions");

        Self {
            workspace_root: RwLock::new(workspace_root),
            sessions_dir: RwLock::new(sessions_dir),
            settings: RwLock::new(default_settings()),
            current_session: RwLock::new(None),
        }
    }

    /// Create with a custom sessions directory (for testing).
    pub fn new_with_sessions_dir(workspace_root: PathBuf, sessions_dir: PathBuf) -> Self {
        Self {
            workspace_root: RwLock::new(workspace_root),
            sessions_dir: RwLock::new(sessions_dir),
            settings: RwLock::new(default_settings()),
            current_session: RwLock::new(None),
        }
    }

    /// Load settings from the user config file.
    async fn load_settings(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        let settings_path = PathBuf::from(&home).join(".ultra/settings.json");

        if let Ok(content) = tokio::fs::read_to_string(&settings_path).await {
            // Strip JSONC comments
            let stripped = strip_jsonc_comments(&content);
            if let Ok(parsed) = serde_json::from_str::<HashMap<String, Value>>(&stripped) {
                let mut settings = self.settings.write();
                for (key, value) in parsed {
                    settings.insert(key, value);
                }
                info!("Loaded settings from {}", settings_path.display());
            }
        }

        // Also check workspace-local settings
        let ws_settings = self.workspace_root.read().join(".ultra/settings.json");
        if let Ok(content) = tokio::fs::read_to_string(&ws_settings).await {
            let stripped = strip_jsonc_comments(&content);
            if let Ok(parsed) = serde_json::from_str::<HashMap<String, Value>>(&stripped) {
                let mut settings = self.settings.write();
                for (key, value) in parsed {
                    settings.insert(key, value);
                }
                debug!("Loaded workspace settings from {}", ws_settings.display());
            }
        }

        Ok(())
    }
}

impl Service for SessionService {
    fn namespace(&self) -> &str {
        "session"
    }

    async fn init(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.load_settings().await?;
        Ok(())
    }

    async fn handle(&self, method: &str, params: Option<Value>) -> HandlerResult {
        match method {
            // ── Config methods ──────────────────────────────────────────
            "config/get" => {
                let p: ConfigGetParam = parse_params(params)?;
                let settings = self.settings.read();
                let value = settings.get(&p.key).cloned().unwrap_or(Value::Null);
                Ok(json!({ "key": p.key, "value": value }))
            }

            "config/set" => {
                let p: ConfigSetParam = parse_params(params)?;
                self.settings.write().insert(p.key.clone(), p.value.clone());
                Ok(json!({ "success": true }))
            }

            "config/getAll" => {
                let settings = self.settings.read();
                Ok(json!({ "settings": *settings }))
            }

            "config/reset" => {
                let p: ConfigGetParam = parse_params(params)?;
                let defaults = default_settings();
                let value = defaults.get(&p.key).cloned().unwrap_or(Value::Null);
                self.settings.write().insert(p.key.clone(), value.clone());
                Ok(json!({ "key": p.key, "value": value }))
            }

            // ── Session methods ─────────────────────────────────────────
            "session/save" => {
                let p: SessionSaveParams = parse_params_optional(params);
                let state = SessionState {
                    name: p.name,
                    workspace_root: Some(self.workspace_root.read().to_string_lossy().to_string()),
                    open_files: Vec::new(),
                    active_file: None,
                    settings: self.settings.read().clone(),
                    created_at: now_ms(),
                    updated_at: now_ms(),
                };

                let sessions_dir = self.sessions_dir.read().clone();
                let _ = tokio::fs::create_dir_all(&sessions_dir).await;

                let id = format!("session-{}", now_ms());
                let path = sessions_dir.join(format!("{id}.json"));
                let json = serde_json::to_string_pretty(&state)
                    .map_err(|e| ECPError::server_error(format!("Serialize error: {e}")))?;
                tokio::fs::write(&path, json).await
                    .map_err(|e| ECPError::server_error(format!("Write error: {e}")))?;

                *self.current_session.write() = Some(state);
                Ok(json!({ "sessionId": id }))
            }

            "session/load" => {
                let p: SessionLoadParam = parse_params(params)?;
                let sessions_dir = self.sessions_dir.read().clone();
                let path = sessions_dir.join(format!("{}.json", p.session_id));

                let content = tokio::fs::read_to_string(&path).await
                    .map_err(|e| ECPError::server_error(format!("Session not found: {e}")))?;
                let state: SessionState = serde_json::from_str(&content)
                    .map_err(|e| ECPError::server_error(format!("Parse error: {e}")))?;

                // Restore settings
                {
                    let mut settings = self.settings.write();
                    for (key, value) in &state.settings {
                        settings.insert(key.clone(), value.clone());
                    }
                }

                *self.current_session.write() = Some(state.clone());
                Ok(json!({
                    "session": state,
                }))
            }

            "session/list" => {
                let sessions_dir = self.sessions_dir.read().clone();
                let mut sessions = Vec::new();

                if let Ok(mut entries) = tokio::fs::read_dir(&sessions_dir).await {
                    while let Ok(Some(entry)) = entries.next_entry().await {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if name.ends_with(".json") {
                            let id = name.trim_end_matches(".json").to_string();
                            sessions.push(json!({ "id": id, "name": name }));
                        }
                    }
                }

                Ok(json!({ "sessions": sessions }))
            }

            "session/delete" => {
                let p: SessionLoadParam = parse_params(params)?;
                let sessions_dir = self.sessions_dir.read().clone();
                let path = sessions_dir.join(format!("{}.json", p.session_id));
                let _ = tokio::fs::remove_file(&path).await;
                Ok(json!({ "success": true }))
            }

            "session/current" => {
                let current = self.current_session.read().clone();
                Ok(json!({ "session": current }))
            }

            // ── Theme methods ───────────────────────────────────────────
            "theme/current" | "theme/get" => {
                let theme = self.settings.read()
                    .get("workbench.colorTheme")
                    .cloned()
                    .unwrap_or(Value::String("catppuccin-mocha".into()));
                Ok(json!({ "theme": theme }))
            }

            "theme/set" => {
                let p: ThemeSetParam = parse_params(params)?;
                self.settings.write().insert(
                    "workbench.colorTheme".into(),
                    Value::String(p.theme_id.clone()),
                );
                Ok(json!({ "success": true, "themeId": p.theme_id }))
            }

            "theme/list" => {
                Ok(json!({ "themes": [
                    { "id": "catppuccin-mocha", "name": "Catppuccin Mocha", "type": "dark" },
                    { "id": "catppuccin-macchiato", "name": "Catppuccin Macchiato", "type": "dark" },
                    { "id": "catppuccin-frappe", "name": "Catppuccin Frappé", "type": "dark" },
                    { "id": "catppuccin-latte", "name": "Catppuccin Latte", "type": "light" },
                ]}))
            }

            // ── Workspace methods ───────────────────────────────────────
            "workspace/getRoot" => {
                let root = self.workspace_root.read().to_string_lossy().to_string();
                Ok(json!({ "root": root }))
            }

            "workspace/setRoot" => {
                let p: WorkspaceSetRoot = parse_params(params)?;
                *self.workspace_root.write() = PathBuf::from(&p.path);
                Ok(json!({ "success": true }))
            }

            // ── Keybindings ─────────────────────────────────────────────
            "keybindings/get" => {
                let bindings = self.settings.read()
                    .get("keybindings")
                    .cloned()
                    .unwrap_or(Value::Array(Vec::new()));
                Ok(json!({ "keybindings": bindings }))
            }

            // ── Commands ────────────────────────────────────────────────
            "commands/list" => {
                Ok(json!({ "commands": [] }))
            }

            // ── System prompt ───────────────────────────────────────────
            "systemPrompt/get" => {
                let prompt = self.settings.read()
                    .get("systemPrompt")
                    .cloned()
                    .unwrap_or(Value::Null);
                Ok(json!({ "systemPrompt": prompt }))
            }

            "systemPrompt/set" => {
                let p: SystemPromptParam = parse_params(params)?;
                self.settings.write().insert("systemPrompt".into(), Value::String(p.prompt));
                Ok(json!({ "success": true }))
            }

            _ => Err(ECPError::method_not_found(method)),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Params
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ConfigGetParam { key: String }

#[derive(Deserialize)]
struct ConfigSetParam { key: String, value: Value }

#[derive(Deserialize, Default)]
struct SessionSaveParams { name: Option<String> }

#[derive(Deserialize)]
struct SessionLoadParam {
    #[serde(rename = "sessionId")]
    session_id: String,
}

#[derive(Deserialize)]
struct ThemeSetParam {
    #[serde(rename = "themeId")]
    theme_id: String,
}

#[derive(Deserialize)]
struct WorkspaceSetRoot { path: String }

#[derive(Deserialize)]
struct SystemPromptParam { prompt: String }

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

fn default_settings() -> HashMap<String, Value> {
    let mut s = HashMap::new();
    s.insert("editor.fontSize".into(), json!(14));
    s.insert("editor.fontFamily".into(), json!("SF Mono"));
    s.insert("editor.tabSize".into(), json!(4));
    s.insert("editor.insertSpaces".into(), json!(true));
    s.insert("editor.wordWrap".into(), json!("off"));
    s.insert("editor.lineNumbers".into(), json!(true));
    s.insert("editor.minimap".into(), json!(false));
    s.insert("workbench.colorTheme".into(), json!("catppuccin-mocha"));
    s.insert("files.autoSave".into(), json!("afterDelay"));
    s.insert("files.autoSaveDelay".into(), json!(30000));
    s.insert("ultra.ai.model".into(), json!("claude-sonnet-4-20250514"));
    s.insert("terminal.shell".into(), json!(""));
    s.insert("terminal.fontSize".into(), json!(13));
    s.insert("git.statusPollInterval".into(), json!(3000));
    s
}

/// Strip C-style comments from JSONC content.
fn strip_jsonc_comments(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut in_string = false;

    while let Some(ch) = chars.next() {
        if in_string {
            result.push(ch);
            if ch == '\\' {
                if let Some(&next) = chars.peek() {
                    result.push(next);
                    chars.next();
                }
            } else if ch == '"' {
                in_string = false;
            }
        } else if ch == '"' {
            in_string = true;
            result.push(ch);
        } else if ch == '/' {
            match chars.peek() {
                Some(&'/') => {
                    // Line comment — skip to end of line
                    for c in chars.by_ref() {
                        if c == '\n' {
                            result.push('\n');
                            break;
                        }
                    }
                }
                Some(&'*') => {
                    // Block comment — skip until */
                    chars.next(); // consume *
                    while let Some(c) = chars.next() {
                        if c == '*' {
                            if chars.peek() == Some(&'/') {
                                chars.next();
                                break;
                            }
                        }
                    }
                }
                _ => result.push(ch),
            }
        } else {
            result.push(ch);
        }
    }

    result
}
