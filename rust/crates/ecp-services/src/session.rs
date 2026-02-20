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
///
/// The Swift client sends additional fields (e.g. `flexGuiState` with sidebar
/// pinned/unpinned state, content tabs, etc.) that must survive round-tripping
/// through setCurrent → markDirty → loadLast. The `#[serde(flatten)]` catch-all
/// preserves all unknown fields without needing to enumerate them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub name: Option<String>,
    #[serde(alias = "workspace_root")]
    pub workspace_root: Option<String>,
    #[serde(default, alias = "open_files")]
    pub open_files: Vec<String>,
    #[serde(alias = "active_file")]
    pub active_file: Option<String>,
    #[serde(default)]
    pub settings: HashMap<String, Value>,
    #[serde(default = "now_ms", alias = "created_at")]
    pub created_at: u64,
    #[serde(default = "now_ms", alias = "updated_at")]
    pub updated_at: u64,
    /// Catch-all for extra fields (flexGuiState, layout, ui, documents, etc.)
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
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
    /// Tries `.jsonc` first (JSONC with comments), then `.json`.
    async fn load_settings(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        let ultra_dir = PathBuf::from(&home).join(".ultra");

        // Try settings.jsonc first, then settings.json
        let user_settings = [
            ultra_dir.join("settings.jsonc"),
            ultra_dir.join("settings.json"),
        ];
        for path in &user_settings {
            if let Ok(content) = tokio::fs::read_to_string(path).await {
                let stripped = strip_jsonc_comments(&content);
                if let Ok(parsed) = serde_json::from_str::<HashMap<String, Value>>(&stripped) {
                    let mut settings = self.settings.write();
                    for (key, value) in parsed {
                        settings.insert(key, value);
                    }
                    info!("Loaded settings from {}", path.display());
                }
                break;
            }
        }

        // Also check workspace-local settings
        let ws_root = self.workspace_root.read().clone();
        let ws_settings = [
            ws_root.join(".ultra/settings.jsonc"),
            ws_root.join(".ultra/settings.json"),
        ];
        for path in &ws_settings {
            if let Ok(content) = tokio::fs::read_to_string(path).await {
                let stripped = strip_jsonc_comments(&content);
                if let Ok(parsed) = serde_json::from_str::<HashMap<String, Value>>(&stripped) {
                    let mut settings = self.settings.write();
                    for (key, value) in parsed {
                        settings.insert(key, value);
                    }
                    debug!("Loaded workspace settings from {}", path.display());
                }
                break;
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
                Ok(json!({ "value": value }))
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
                let p: ConfigResetParam = parse_params_optional(params);
                if let Some(key) = p.key {
                    let defaults = default_settings();
                    let value = defaults.get(&key).cloned().unwrap_or(Value::Null);
                    self.settings.write().insert(key, value);
                } else {
                    *self.settings.write() = default_settings();
                }
                Ok(json!({ "success": true }))
            }

            "config/schema" => {
                Ok(json!({ "schema": config_schema() }))
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
                    extra: HashMap::new(),
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

            "session/setCurrent" => {
                let p: SessionSetCurrentParam = parse_params(params)?;
                *self.current_session.write() = Some(p.state);
                Ok(json!({ "success": true }))
            }

            "session/markDirty" => {
                let state_to_save = {
                    let mut guard = self.current_session.write();
                    if let Some(ref mut session) = *guard {
                        session.updated_at = now_ms();
                        Some(session.clone())
                    } else {
                        None
                    }
                };
                // Persist to disk so flexGuiState survives server restarts
                if let Some(state) = state_to_save {
                    let sessions_dir = self.sessions_dir.read().clone();
                    let _ = tokio::fs::create_dir_all(&sessions_dir).await;
                    // Use workspace root hash as stable session filename
                    let ws = state.workspace_root.as_deref().unwrap_or("default");
                    let id = format!("workspace-{:x}", simple_hash(ws));
                    let path = sessions_dir.join(format!("{id}.json"));
                    if let Ok(json) = serde_json::to_string_pretty(&state) {
                        let _ = tokio::fs::write(&path, json).await;
                    }
                }
                Ok(json!({ "success": true }))
            }

            "session/loadLast" => {
                let sessions_dir = self.sessions_dir.read().clone();
                let mut newest: Option<(u64, String)> = None;

                if let Ok(mut entries) = tokio::fs::read_dir(&sessions_dir).await {
                    while let Ok(Some(entry)) = entries.next_entry().await {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if name.ends_with(".json") {
                            if let Ok(meta) = entry.metadata().await {
                                let mtime = meta.modified().ok()
                                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                    .map(|d| d.as_millis() as u64)
                                    .unwrap_or(0);
                                if newest.as_ref().map_or(true, |(t, _)| mtime > *t) {
                                    let id = name.trim_end_matches(".json").to_string();
                                    newest = Some((mtime, id));
                                }
                            }
                        }
                    }
                }

                if let Some((_, id)) = newest {
                    let path = sessions_dir.join(format!("{id}.json"));
                    let content = tokio::fs::read_to_string(&path).await
                        .map_err(|e| ECPError::server_error(format!("Load failed: {e}")))?;
                    let state: SessionState = serde_json::from_str(&content)
                        .map_err(|e| ECPError::server_error(format!("Parse error: {e}")))?;
                    *self.current_session.write() = Some(state.clone());
                    Ok(serde_json::to_value(&state).unwrap_or(Value::Null))
                } else {
                    Ok(Value::Null)
                }
            }

            // ── Theme methods ───────────────────────────────────────────
            "theme/current" | "theme/get" => {
                let theme_id = self.settings.read()
                    .get("workbench.colorTheme")
                    .and_then(|v| v.as_str().map(|s| s.to_string()))
                    .unwrap_or_else(|| "catppuccin-mocha".to_string());
                let theme = load_theme(&theme_id).await;
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
                let mut themes = Vec::new();
                // Scan config/themes/ directory for theme files
                let theme_dirs = ["config/themes", "../config/themes"];
                let mut found_dir = false;
                for dir in &theme_dirs {
                    if let Ok(mut entries) = tokio::fs::read_dir(dir).await {
                        found_dir = true;
                        while let Ok(Some(entry)) = entries.next_entry().await {
                            let name = entry.file_name().to_string_lossy().to_string();
                            if name.ends_with(".json") {
                                let id = name.trim_end_matches(".json");
                                let theme = load_theme(id).await;
                                themes.push(theme);
                            }
                        }
                        break;
                    }
                }
                if !found_dir {
                    // Fallback: return known theme metadata
                    for (id, name, ttype) in [
                        ("catppuccin-mocha", "Catppuccin Mocha", "dark"),
                        ("catppuccin-macchiato", "Catppuccin Macchiato", "dark"),
                        ("catppuccin-frappe", "Catppuccin Frappé", "dark"),
                        ("catppuccin-latte", "Catppuccin Latte", "light"),
                    ] {
                        themes.push(json!({ "id": id, "name": name, "type": ttype }));
                    }
                }
                Ok(json!({ "themes": themes }))
            }

            // ── Workspace methods ───────────────────────────────────────
            "workspace/getRoot" => {
                let root = self.workspace_root.read().to_string_lossy().to_string();
                Ok(json!({ "path": root }))
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
                Ok(json!({ "bindings": bindings }))
            }

            "keybindings/set" => {
                let p: KeybindingsSetParam = parse_params(params)?;
                self.settings.write().insert("keybindings".into(), Value::Array(p.bindings));
                Ok(json!({ "success": true }))
            }

            "keybindings/add" => {
                let p: KeybindingAddParam = parse_params(params)?;
                let mut settings = self.settings.write();
                let bindings = settings.entry("keybindings".to_string())
                    .or_insert_with(|| Value::Array(Vec::new()));
                if let Value::Array(arr) = bindings {
                    arr.push(p.binding);
                }
                Ok(json!({ "success": true }))
            }

            "keybindings/remove" => {
                let p: KeybindingRemoveParam = parse_params(params)?;
                let mut settings = self.settings.write();
                if let Some(Value::Array(arr)) = settings.get_mut("keybindings") {
                    arr.retain(|b| {
                        b.get("key").and_then(|v| v.as_str()) != Some(&p.key)
                    });
                }
                Ok(json!({ "success": true }))
            }

            "keybindings/resolve" => {
                let p: KeybindingResolveParam = parse_params(params)?;
                let settings = self.settings.read();
                let command = settings.get("keybindings")
                    .and_then(|v| v.as_array())
                    .and_then(|arr| {
                        arr.iter().find(|b| {
                            b.get("key").and_then(|v| v.as_str()) == Some(&p.key)
                        })
                    })
                    .and_then(|b| b.get("command").and_then(|v| v.as_str()))
                    .map(|s| Value::String(s.to_string()))
                    .unwrap_or(Value::Null);
                Ok(json!({ "command": command }))
            }

            // ── Commands ────────────────────────────────────────────────
            "commands/list" => {
                Ok(json!({ "commands": [] }))
            }

            // ── System prompt ───────────────────────────────────────────
            "systemPrompt/get" => {
                let settings = self.settings.read();
                let prompt = settings.get("systemPrompt").cloned().unwrap_or(Value::Null);
                let is_default = prompt.is_null();
                let content = if is_default {
                    Value::String(String::new())
                } else {
                    prompt
                };
                Ok(json!({ "content": content, "isDefault": is_default }))
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
struct ConfigResetParam { key: Option<String> }

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
struct SystemPromptParam {
    #[serde(alias = "content")]
    prompt: String,
}

#[derive(Deserialize)]
struct SessionSetCurrentParam {
    state: SessionState,
}

#[derive(Deserialize)]
struct KeybindingsSetParam {
    bindings: Vec<Value>,
}

#[derive(Deserialize)]
struct KeybindingAddParam {
    binding: Value,
}

#[derive(Deserialize)]
struct KeybindingRemoveParam {
    key: String,
}

#[derive(Deserialize)]
struct KeybindingResolveParam {
    key: String,
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

/// Simple non-crypto hash for stable session filenames.
fn simple_hash(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut hasher);
    hasher.finish()
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

/// Load a full theme from config/themes/{id}.json, falling back to catppuccin-mocha.
async fn load_theme(id: &str) -> Value {
    let filename = format!("{id}.json");

    // Search paths: CWD/config/themes/, ../config/themes/ (for running from rust/ subdir)
    let candidates = [
        PathBuf::from("config/themes").join(&filename),
        PathBuf::from("../config/themes").join(&filename),
    ];

    let try_read = |paths: &[PathBuf]| {
        let paths = paths.to_vec();
        async move {
            for p in &paths {
                if let Ok(content) = tokio::fs::read_to_string(p).await {
                    return Some(content);
                }
            }
            None
        }
    };

    let content = match try_read(&candidates).await {
        Some(c) => c,
        None if id != "catppuccin-mocha" => {
            // Fall back to default theme
            let fallback = [
                PathBuf::from("config/themes/catppuccin-mocha.json"),
                PathBuf::from("../config/themes/catppuccin-mocha.json"),
            ];
            match try_read(&fallback).await {
                Some(c) => c,
                None => return json!({ "id": id, "name": id, "type": "dark", "colors": {}, "tokenColors": [] }),
            }
        }
        None => {
            return json!({ "id": id, "name": id, "type": "dark", "colors": {}, "tokenColors": [] });
        }
    };

    match serde_json::from_str::<Value>(&content) {
        Ok(mut theme) => {
            if let Some(obj) = theme.as_object_mut() {
                obj.insert("id".to_string(), json!(id));
            }
            theme
        }
        Err(_) => json!({ "id": id, "name": id, "type": "dark", "colors": {}, "tokenColors": [] }),
    }
}

fn config_schema() -> Value {
    json!({
        "editor.fontSize": { "type": "number", "default": 14, "description": "Editor font size" },
        "editor.fontFamily": { "type": "string", "default": "SF Mono", "description": "Editor font family" },
        "editor.tabSize": { "type": "number", "default": 4, "description": "Tab size in spaces" },
        "editor.insertSpaces": { "type": "boolean", "default": true, "description": "Insert spaces when pressing Tab" },
        "editor.wordWrap": { "type": "string", "default": "off", "description": "Word wrap mode" },
        "editor.lineNumbers": { "type": "boolean", "default": true, "description": "Show line numbers" },
        "editor.minimap": { "type": "boolean", "default": false, "description": "Show minimap" },
        "workbench.colorTheme": { "type": "string", "default": "catppuccin-mocha", "description": "Color theme" },
        "files.autoSave": { "type": "string", "default": "afterDelay", "description": "Auto-save mode" },
        "files.autoSaveDelay": { "type": "number", "default": 30000, "description": "Auto-save delay in ms" },
        "ultra.ai.model": { "type": "string", "default": "claude-sonnet-4-20250514", "description": "AI model" },
        "terminal.shell": { "type": "string", "default": "", "description": "Terminal shell path" },
        "terminal.fontSize": { "type": "number", "default": 13, "description": "Terminal font size" },
        "git.statusPollInterval": { "type": "number", "default": 3000, "description": "Git status poll interval in ms" },
    })
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
