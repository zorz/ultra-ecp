//! LSP service — manages language server processes and proxies LSP operations.
//!
//! Spawns language servers as child processes (communicating via stdin/stdout JSON-RPC
//! with Content-Length framing) and exposes their capabilities through the ECP protocol.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

use ecp_protocol::{ECPError, HandlerResult};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot, Mutex as TokioMutex};
use tracing::{debug, info, warn};

use crate::Service;

// ─────────────────────────────────────────────────────────────────────────────
// Server configuration
// ─────────────────────────────────────────────────────────────────────────────

/// Default language server commands by language ID.
fn default_server_command(language_id: &str) -> Option<(&'static str, &'static [&'static str])> {
    match language_id {
        "typescript" | "typescriptreact" | "javascript" | "javascriptreact" => {
            Some(("typescript-language-server", &["--stdio"]))
        }
        "rust" => Some(("rust-analyzer", &[])),
        "python" => Some(("pylsp", &[])),
        "go" => Some(("gopls", &["serve"])),
        "ruby" => Some(("solargraph", &["stdio"])),
        "c" | "cpp" | "objc" | "objcpp" => Some(("clangd", &[])),
        "json" | "jsonc" => Some(("vscode-json-language-server", &["--stdio"])),
        "html" => Some(("vscode-html-language-server", &["--stdio"])),
        "css" | "scss" | "less" => Some(("vscode-css-language-server", &["--stdio"])),
        "sql" => Some(("postgres-language-server", &["lsp-proxy"])),
        "swift" => Some(("sourcekit-lsp", &[])),
        _ => None,
    }
}

/// Custom server configuration (user-provided).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub command: String,
    pub args: Vec<String>,
    #[serde(rename = "initializationOptions", skip_serializing_if = "Option::is_none")]
    pub initialization_options: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
}

// ─────────────────────────────────────────────────────────────────────────────
// LSP Client — manages a single language server process
// ─────────────────────────────────────────────────────────────────────────────

struct LSPClient {
    _language_id: String,
    stdin_tx: mpsc::Sender<Vec<u8>>,
    pending: Arc<RwLock<HashMap<i64, oneshot::Sender<Value>>>>,
    next_id: Arc<std::sync::atomic::AtomicI64>,
    capabilities: RwLock<Option<Value>>,
    diagnostics: Arc<RwLock<HashMap<String, Vec<Value>>>>,
    status: RwLock<String>,
}

impl LSPClient {
    /// Start a language server process and return an LSPClient.
    async fn start(
        language_id: &str,
        workspace_root: &str,
        server_config: Option<&ServerConfig>,
    ) -> Result<Self, ECPError> {
        let (command, args) = if let Some(cfg) = server_config {
            (cfg.command.as_str().to_string(), cfg.args.iter().map(|s| s.as_str().to_string()).collect::<Vec<_>>())
        } else {
            let (cmd, args) = default_server_command(language_id)
                .ok_or_else(|| ECPError::server_error(format!("No language server for: {language_id}")))?;
            (cmd.to_string(), args.iter().map(|s| s.to_string()).collect())
        };

        info!("Starting LSP server for {language_id}: {command} {}", args.join(" "));

        let mut child = Command::new(&command)
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| ECPError::server_error(format!("Failed to start {command}: {e}")))?;

        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let stderr = child.stderr.take().expect("stderr");

        // Channel for writing to stdin
        let (stdin_tx, mut stdin_rx) = mpsc::channel::<Vec<u8>>(256);

        let pending: Arc<RwLock<HashMap<i64, oneshot::Sender<Value>>>> = Arc::new(RwLock::new(HashMap::new()));
        let diagnostics: Arc<RwLock<HashMap<String, Vec<Value>>>> = Arc::new(RwLock::new(HashMap::new()));

        // Stdin writer task
        let mut stdin_writer = tokio::io::BufWriter::new(stdin);
        tokio::spawn(async move {
            while let Some(data) = stdin_rx.recv().await {
                if let Err(e) = stdin_writer.write_all(&data).await {
                    warn!("LSP stdin write error: {e}");
                    break;
                }
                if let Err(e) = stdin_writer.flush().await {
                    warn!("LSP stdin flush error: {e}");
                    break;
                }
            }
        });

        // Stdout reader task — parse LSP Content-Length framed messages
        let pending_clone = pending.clone();
        let diagnostics_clone = diagnostics.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                // Read headers until empty line
                let mut content_length: usize = 0;
                loop {
                    let mut line = String::new();
                    match reader.read_line(&mut line).await {
                        Ok(0) => return, // EOF
                        Ok(_) => {
                            let trimmed = line.trim();
                            if trimmed.is_empty() {
                                break; // End of headers
                            }
                            if let Some(len_str) = trimmed.strip_prefix("Content-Length: ") {
                                content_length = len_str.parse().unwrap_or(0);
                            }
                        }
                        Err(e) => {
                            warn!("LSP stdout read error: {e}");
                            return;
                        }
                    }
                }

                if content_length == 0 { continue; }

                // Read body
                let mut body = vec![0u8; content_length];
                if let Err(e) = reader.read_exact(&mut body).await {
                    warn!("LSP body read error: {e}");
                    return;
                }

                let msg: Value = match serde_json::from_slice(&body) {
                    Ok(v) => v,
                    Err(e) => {
                        warn!("LSP JSON parse error: {e}");
                        continue;
                    }
                };

                // Check if this is a response (has id) or notification
                if let Some(id) = msg.get("id").and_then(|v| v.as_i64()) {
                    // Response to a pending request
                    let sender = pending_clone.write().remove(&id);
                    if let Some(tx) = sender {
                        let _ = tx.send(msg);
                    }
                } else if let Some(method) = msg.get("method").and_then(|v| v.as_str()) {
                    // Server notification
                    if method == "textDocument/publishDiagnostics" {
                        if let Some(params) = msg.get("params") {
                            if let Some(uri) = params.get("uri").and_then(|v| v.as_str()) {
                                let diags = params.get("diagnostics")
                                    .and_then(|v| v.as_array())
                                    .cloned()
                                    .unwrap_or_default();
                                diagnostics_clone.write().insert(uri.to_string(), diags);
                            }
                        }
                    }
                }
            }
        });

        // Stderr reader (just log it)
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                debug!("LSP stderr: {}", line.trim());
                line.clear();
            }
        });

        let client = Self {
            _language_id: language_id.to_string(),
            stdin_tx,
            pending,
            next_id: Arc::new(std::sync::atomic::AtomicI64::new(1)),
            capabilities: RwLock::new(None),
            diagnostics,
            status: RwLock::new("starting".into()),
        };

        // Send initialize request
        let init_result = client.send_request("initialize", json!({
            "processId": std::process::id(),
            "rootUri": format!("file://{workspace_root}"),
            "capabilities": {
                "textDocument": {
                    "completion": { "completionItem": { "snippetSupport": true } },
                    "hover": { "contentFormat": ["markdown", "plaintext"] },
                    "signatureHelp": { "signatureInformation": { "documentationFormat": ["markdown", "plaintext"] } },
                    "definition": {},
                    "references": {},
                    "documentSymbol": {},
                    "rename": { "prepareSupport": true },
                    "publishDiagnostics": { "relatedInformation": true },
                    "synchronization": { "didSave": true },
                },
                "workspace": {
                    "workspaceFolders": true,
                }
            },
            "workspaceFolders": [{ "uri": format!("file://{workspace_root}"), "name": "workspace" }],
        })).await?;

        // Store capabilities
        if let Some(caps) = init_result.get("result").and_then(|r| r.get("capabilities")) {
            *client.capabilities.write() = Some(caps.clone());
        }

        // Send initialized notification
        client.send_notification("initialized", json!({})).await?;

        *client.status.write() = "running".into();
        info!("LSP server for {language_id} initialized");

        Ok(client)
    }

    /// Send a JSON-RPC request and wait for the response.
    async fn send_request(&self, method: &str, params: Value) -> Result<Value, ECPError> {
        let id = self.next_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();

        self.pending.write().insert(id, tx);

        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });

        self.send_raw(&msg).await?;

        // Wait for response with timeout
        tokio::time::timeout(std::time::Duration::from_secs(30), rx)
            .await
            .map_err(|_| ECPError::server_error(format!("LSP request timeout: {method}")))?
            .map_err(|_| ECPError::server_error(format!("LSP response channel closed: {method}")))
    }

    /// Send a JSON-RPC notification (no response expected).
    async fn send_notification(&self, method: &str, params: Value) -> Result<(), ECPError> {
        let msg = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        self.send_raw(&msg).await
    }

    /// Send a raw JSON-RPC message with Content-Length framing.
    async fn send_raw(&self, msg: &Value) -> Result<(), ECPError> {
        let body = serde_json::to_string(msg)
            .map_err(|e| ECPError::server_error(format!("JSON serialize error: {e}")))?;
        let framed = format!("Content-Length: {}\r\n\r\n{}", body.len(), body);
        self.stdin_tx.send(framed.into_bytes()).await
            .map_err(|_| ECPError::server_error("LSP process stdin closed"))
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// LSP service
// ─────────────────────────────────────────────────────────────────────────────

pub struct LSPService {
    workspace_root: String,
    /// Active language server clients by language ID
    clients: Arc<TokioMutex<HashMap<String, LSPClient>>>,
    /// Custom server configurations
    server_configs: RwLock<HashMap<String, ServerConfig>>,
    /// Open documents tracked for synchronization
    open_docs: RwLock<HashMap<String, DocState>>,
}

struct DocState {
    language_id: String,
    version: i64,
}

impl LSPService {
    pub fn new(workspace_root: std::path::PathBuf) -> Self {
        Self {
            workspace_root: workspace_root.to_string_lossy().to_string(),
            clients: Arc::new(TokioMutex::new(HashMap::new())),
            server_configs: RwLock::new(HashMap::new()),
            open_docs: RwLock::new(HashMap::new()),
        }
    }

    /// Get or start a language server for the given language.
    async fn get_client(&self, language_id: &str) -> Result<(), ECPError> {
        let mut clients = self.clients.lock().await;
        if clients.contains_key(language_id) {
            return Ok(());
        }

        let custom_config = self.server_configs.read().get(language_id).cloned();
        let client = LSPClient::start(language_id, &self.workspace_root, custom_config.as_ref()).await?;
        clients.insert(language_id.to_string(), client);
        Ok(())
    }
}

impl Service for LSPService {
    fn namespace(&self) -> &str {
        "lsp"
    }

    async fn handle(&self, method: &str, params: Option<Value>) -> HandlerResult {
        match method {
            // ── Server lifecycle ──────────────────────────────────────

            "lsp/start" => {
                let p: LanguageIdParam = parse_params(params)?;
                self.get_client(&p.language_id).await?;
                Ok(json!({ "success": true, "languageId": p.language_id }))
            }

            "lsp/stop" => {
                let p: LanguageIdParam = parse_params(params)?;
                let removed = self.clients.lock().await.remove(&p.language_id).is_some();
                Ok(json!({ "success": removed }))
            }

            "lsp/status" => {
                let clients = self.clients.lock().await;
                let statuses: Vec<Value> = clients.iter().map(|(lang, client)| {
                    json!({
                        "languageId": lang,
                        "status": *client.status.read(),
                        "hasCapabilities": client.capabilities.read().is_some(),
                    })
                }).collect();
                Ok(json!({ "servers": statuses }))
            }

            // ── Document synchronization ─────────────────────────────

            "lsp/documentOpen" => {
                let p: DocOpenParams = parse_params(params)?;
                let language_id = p.language_id.clone().unwrap_or_else(|| detect_language(&p.uri));

                // Ensure server is running
                self.get_client(&language_id).await?;

                let clients = self.clients.lock().await;
                let client = clients.get(&language_id)
                    .ok_or_else(|| ECPError::server_error("Server not running"))?;

                client.send_notification("textDocument/didOpen", json!({
                    "textDocument": {
                        "uri": p.uri,
                        "languageId": language_id,
                        "version": 1,
                        "text": p.text.unwrap_or_default(),
                    }
                })).await?;

                self.open_docs.write().insert(p.uri.clone(), DocState {
                    language_id: language_id.clone(),
                    version: 1,
                });

                Ok(json!({ "success": true }))
            }

            "lsp/documentChange" => {
                let p: DocChangeParams = parse_params(params)?;

                let language_id = {
                    let docs = self.open_docs.read();
                    docs.get(&p.uri).map(|d| d.language_id.clone())
                        .ok_or_else(|| ECPError::server_error(format!("Document not open: {}", p.uri)))?
                };

                let version = {
                    let mut docs = self.open_docs.write();
                    if let Some(doc) = docs.get_mut(&p.uri) {
                        doc.version += 1;
                        doc.version
                    } else { 1 }
                };

                let clients = self.clients.lock().await;
                let client = clients.get(&language_id)
                    .ok_or_else(|| ECPError::server_error("Server not running"))?;

                client.send_notification("textDocument/didChange", json!({
                    "textDocument": { "uri": p.uri, "version": version },
                    "contentChanges": [{ "text": p.text }],
                })).await?;

                Ok(json!({ "success": true, "version": version }))
            }

            "lsp/documentSave" => {
                let p: DocUriParam = parse_params(params)?;
                let language_id = {
                    let docs = self.open_docs.read();
                    docs.get(&p.uri).map(|d| d.language_id.clone())
                        .ok_or_else(|| ECPError::server_error(format!("Document not open: {}", p.uri)))?
                };

                let clients = self.clients.lock().await;
                if let Some(client) = clients.get(&language_id) {
                    client.send_notification("textDocument/didSave", json!({
                        "textDocument": { "uri": p.uri },
                    })).await?;
                }

                Ok(json!({ "success": true }))
            }

            "lsp/documentClose" => {
                let p: DocUriParam = parse_params(params)?;
                let language_id = {
                    self.open_docs.write().remove(&p.uri)
                        .map(|d| d.language_id)
                };

                if let Some(lang) = language_id {
                    let clients = self.clients.lock().await;
                    if let Some(client) = clients.get(&lang) {
                        client.send_notification("textDocument/didClose", json!({
                            "textDocument": { "uri": p.uri },
                        })).await?;
                    }
                }

                Ok(json!({ "success": true }))
            }

            // ── Code intelligence ────────────────────────────────────

            "lsp/completion" => {
                let p: PositionParams = parse_params(params)?;
                let client = self.client_for_uri(&p.uri).await?;
                let clients = self.clients.lock().await;
                let lsp = clients.get(&client).ok_or_else(|| ECPError::server_error("No server"))?;

                let result = lsp.send_request("textDocument/completion", json!({
                    "textDocument": { "uri": p.uri },
                    "position": { "line": p.line, "character": p.character },
                })).await?;

                let items = result.get("result")
                    .map(|r| if r.is_array() { r.clone() } else { r.get("items").cloned().unwrap_or(json!([])) })
                    .unwrap_or(json!([]));

                Ok(json!({ "items": items }))
            }

            "lsp/hover" => {
                let p: PositionParams = parse_params(params)?;
                let client = self.client_for_uri(&p.uri).await?;
                let clients = self.clients.lock().await;
                let lsp = clients.get(&client).ok_or_else(|| ECPError::server_error("No server"))?;

                let result = lsp.send_request("textDocument/hover", json!({
                    "textDocument": { "uri": p.uri },
                    "position": { "line": p.line, "character": p.character },
                })).await?;

                Ok(json!({ "hover": result.get("result").cloned().unwrap_or(Value::Null) }))
            }

            "lsp/signatureHelp" => {
                let p: PositionParams = parse_params(params)?;
                let client = self.client_for_uri(&p.uri).await?;
                let clients = self.clients.lock().await;
                let lsp = clients.get(&client).ok_or_else(|| ECPError::server_error("No server"))?;

                let result = lsp.send_request("textDocument/signatureHelp", json!({
                    "textDocument": { "uri": p.uri },
                    "position": { "line": p.line, "character": p.character },
                })).await?;

                Ok(json!({ "signatureHelp": result.get("result").cloned().unwrap_or(Value::Null) }))
            }

            "lsp/definition" => {
                let p: PositionParams = parse_params(params)?;
                let client = self.client_for_uri(&p.uri).await?;
                let clients = self.clients.lock().await;
                let lsp = clients.get(&client).ok_or_else(|| ECPError::server_error("No server"))?;

                let result = lsp.send_request("textDocument/definition", json!({
                    "textDocument": { "uri": p.uri },
                    "position": { "line": p.line, "character": p.character },
                })).await?;

                Ok(json!({ "definition": result.get("result").cloned().unwrap_or(Value::Null) }))
            }

            "lsp/references" => {
                let p: PositionParams = parse_params(params)?;
                let client = self.client_for_uri(&p.uri).await?;
                let clients = self.clients.lock().await;
                let lsp = clients.get(&client).ok_or_else(|| ECPError::server_error("No server"))?;

                let result = lsp.send_request("textDocument/references", json!({
                    "textDocument": { "uri": p.uri },
                    "position": { "line": p.line, "character": p.character },
                    "context": { "includeDeclaration": true },
                })).await?;

                Ok(json!({ "references": result.get("result").cloned().unwrap_or(json!([])) }))
            }

            "lsp/documentSymbol" => {
                let p: DocUriParam = parse_params(params)?;
                let client = self.client_for_uri(&p.uri).await?;
                let clients = self.clients.lock().await;
                let lsp = clients.get(&client).ok_or_else(|| ECPError::server_error("No server"))?;

                let result = lsp.send_request("textDocument/documentSymbol", json!({
                    "textDocument": { "uri": p.uri },
                })).await?;

                Ok(json!({ "symbols": result.get("result").cloned().unwrap_or(json!([])) }))
            }

            "lsp/rename" => {
                let p: RenameParams = parse_params(params)?;
                let client = self.client_for_uri(&p.uri).await?;
                let clients = self.clients.lock().await;
                let lsp = clients.get(&client).ok_or_else(|| ECPError::server_error("No server"))?;

                let result = lsp.send_request("textDocument/rename", json!({
                    "textDocument": { "uri": p.uri },
                    "position": { "line": p.line, "character": p.character },
                    "newName": p.new_name,
                })).await?;

                Ok(json!({ "workspaceEdit": result.get("result").cloned().unwrap_or(Value::Null) }))
            }

            // ── Diagnostics ──────────────────────────────────────────

            "lsp/diagnostics" => {
                let p: DocUriParam = parse_params(params)?;
                let client = self.client_for_uri(&p.uri).await?;
                let clients = self.clients.lock().await;
                let lsp = clients.get(&client).ok_or_else(|| ECPError::server_error("No server"))?;

                let diags = lsp.diagnostics.read().get(&p.uri).cloned().unwrap_or_default();
                Ok(json!({ "diagnostics": diags }))
            }

            "lsp/allDiagnostics" => {
                let clients = self.clients.lock().await;
                let mut all_diags: HashMap<String, Vec<Value>> = HashMap::new();
                for client in clients.values() {
                    for (uri, diags) in client.diagnostics.read().iter() {
                        all_diags.entry(uri.clone()).or_default().extend(diags.iter().cloned());
                    }
                }
                Ok(json!({ "diagnostics": all_diags }))
            }

            "lsp/diagnosticsSummary" => {
                let clients = self.clients.lock().await;
                let mut errors = 0u64;
                let mut warnings = 0u64;
                let mut infos = 0u64;
                let mut hints = 0u64;
                for client in clients.values() {
                    for diags in client.diagnostics.read().values() {
                        for diag in diags {
                            match diag.get("severity").and_then(|v| v.as_u64()) {
                                Some(1) => errors += 1,
                                Some(2) => warnings += 1,
                                Some(3) => infos += 1,
                                Some(4) => hints += 1,
                                _ => {}
                            }
                        }
                    }
                }
                Ok(json!({ "errors": errors, "warnings": warnings, "infos": infos, "hints": hints }))
            }

            // ── Configuration ────────────────────────────────────────

            "lsp/setServerConfig" => {
                let p: SetConfigParams = parse_params(params)?;
                self.server_configs.write().insert(p.language_id.clone(), p.config);
                Ok(json!({ "success": true }))
            }

            "lsp/getServerConfig" => {
                let p: LanguageIdParam = parse_params(params)?;
                let config = self.server_configs.read().get(&p.language_id).cloned();
                Ok(json!({ "config": config }))
            }

            "lsp/getLanguageId" => {
                let p: FilePathParam = parse_params(params)?;
                let lang = detect_language(&p.path);
                Ok(json!({ "languageId": lang }))
            }

            "lsp/hasServerFor" => {
                let p: LanguageIdParam = parse_params(params)?;
                let has_custom = self.server_configs.read().contains_key(&p.language_id);
                let has_default = default_server_command(&p.language_id).is_some();
                Ok(json!({ "available": has_custom || has_default }))
            }

            _ => Err(ECPError::method_not_found(method)),
        }
    }

    async fn shutdown(&self) {
        // Stop all language servers
        let mut clients = self.clients.lock().await;
        for (lang, client) in clients.drain() {
            info!("Stopping LSP server for {lang}");
            let _ = client.send_request("shutdown", Value::Null).await;
            let _ = client.send_notification("exit", Value::Null).await;
        }
        info!("All LSP servers stopped");
    }
}

impl LSPService {
    /// Find the language ID for a given URI from open documents.
    async fn client_for_uri(&self, uri: &str) -> Result<String, ECPError> {
        let docs = self.open_docs.read();
        let doc = docs.get(uri)
            .ok_or_else(|| ECPError::server_error(format!("Document not open in LSP: {uri}")))?;
        Ok(doc.language_id.clone())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct LanguageIdParam {
    #[serde(rename = "languageId")]
    language_id: String,
}

#[derive(Deserialize)]
struct DocOpenParams {
    uri: String,
    #[serde(rename = "languageId")]
    language_id: Option<String>,
    text: Option<String>,
}

#[derive(Deserialize)]
struct DocChangeParams {
    uri: String,
    text: String,
}

#[derive(Deserialize)]
struct DocUriParam {
    uri: String,
}

#[derive(Deserialize)]
struct PositionParams {
    uri: String,
    line: u32,
    character: u32,
}

#[derive(Deserialize)]
struct RenameParams {
    uri: String,
    line: u32,
    character: u32,
    #[serde(rename = "newName")]
    new_name: String,
}

#[derive(Deserialize)]
struct SetConfigParams {
    #[serde(rename = "languageId")]
    language_id: String,
    config: ServerConfig,
}

#[derive(Deserialize)]
struct FilePathParam {
    path: String,
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

/// Detect language from file URI or path.
fn detect_language(uri: &str) -> String {
    let ext = uri.rsplit('.').next().unwrap_or("");
    match ext {
        "ts" => "typescript",
        "tsx" => "typescriptreact",
        "js" => "javascript",
        "jsx" => "javascriptreact",
        "rs" => "rust",
        "py" => "python",
        "rb" => "ruby",
        "go" => "go",
        "java" => "java",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" => "cpp",
        "swift" => "swift",
        "kt" | "kts" => "kotlin",
        "json" => "json",
        "jsonc" => "jsonc",
        "html" | "htm" => "html",
        "css" => "css",
        "scss" => "scss",
        "less" => "less",
        "sql" => "sql",
        "md" => "markdown",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "sh" | "bash" | "zsh" => "shellscript",
        _ => "plaintext",
    }.to_string()
}
