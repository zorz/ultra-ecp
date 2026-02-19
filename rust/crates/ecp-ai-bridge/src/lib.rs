//! AI Provider Bridge — manages a TypeScript subprocess for AI SDK interactions.
//!
//! The Rust ECP server handles all core services natively. For AI provider
//! interactions (Anthropic Agent SDK, OpenAI, etc.), it delegates to a
//! TypeScript subprocess connected via JSON-RPC over stdin/stdout.
//!
//! ## Protocol
//!
//! Three message types on the stdin/stdout pipe (one JSON object per line):
//!
//! 1. **Request/Response** (Rust→Bridge): `{ id, method, params }` → `{ id, result/error }`
//! 2. **Notifications** (Bridge→Rust): `{ method, params }` (no `id`) — forwarded to broadcast channel
//! 3. **Callbacks** (Bridge→Rust→Bridge): `{ callbackId, method, params }` — Rust executes against
//!    its own router and returns `{ callbackId, result/error }`. This is how the Agent SDK calls
//!    ECP tools (file/read, git/status, etc.) during agentic execution.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{Arc, OnceLock};

use ecp_protocol::{ECPError, ECPNotification, HandlerResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, mpsc, oneshot};
use tracing::{debug, info, warn};

/// Configuration for the AI bridge subprocess.
#[derive(Debug, Clone)]
pub struct AIBridgeConfig {
    /// Path to the TypeScript AI bridge entry point
    pub script_path: PathBuf,
    /// Runtime to use (bun, node, deno)
    pub runtime: String,
    /// Workspace root to pass to the bridge
    pub workspace_root: PathBuf,
}

impl Default for AIBridgeConfig {
    fn default() -> Self {
        Self {
            script_path: PathBuf::from("ai-bridge/index.ts"),
            runtime: "bun".into(),
            workspace_root: PathBuf::from("."),
        }
    }
}

/// Callback handler type — executes a method against the ECP server's router.
pub type CallbackHandler = Arc<
    dyn Fn(&str, Option<Value>) -> Pin<Box<dyn Future<Output = HandlerResult> + Send>>
        + Send
        + Sync,
>;

// ─────────────────────────────────────────────────────────────────────────────
// Wire types
// ─────────────────────────────────────────────────────────────────────────────

/// Request sent from Rust to the TypeScript subprocess.
#[derive(Debug, Serialize)]
struct BridgeRequest {
    id: u64,
    method: String,
    params: Option<Value>,
}

// Note: BridgeResponse and BridgeNotification are parsed from raw Value
// in the reader task (explicit field checking), not via serde structs.

/// Callback request from the bridge — needs ECP router execution (has `callbackId`).
#[derive(Debug, Deserialize)]
struct BridgeCallback {
    #[serde(rename = "callbackId")]
    callback_id: String,
    method: String,
    #[serde(default)]
    params: Option<Value>,
}

/// Callback response sent back to the bridge.
#[derive(Debug, Serialize)]
struct BridgeCallbackResponse {
    #[serde(rename = "callbackId")]
    callback_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<BridgeError>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct BridgeError {
    code: i32,
    message: String,
}

// Messages are classified by checking raw JSON fields (callbackId, id, method)
// rather than using serde(untagged), which can't reliably discriminate.

// ─────────────────────────────────────────────────────────────────────────────
// AIBridge
// ─────────────────────────────────────────────────────────────────────────────

/// The AI Bridge — manages communication with the TypeScript subprocess.
pub struct AIBridge {
    /// Channel to send requests to the subprocess writer task
    request_tx: Option<mpsc::Sender<WriterMessage>>,
    /// Child process handle
    child: Option<Child>,
    /// Next request ID
    next_id: std::sync::atomic::AtomicU64,
    /// Whether the bridge is running
    running: std::sync::atomic::AtomicBool,
    /// Notification broadcast sender — bridge notifications go here
    notification_tx: Option<broadcast::Sender<String>>,
    /// Callback handler — executes methods against the ECP router.
    /// Uses OnceLock so it can be set after start() (when the ECPServer is ready).
    callback_handler: Arc<OnceLock<CallbackHandler>>,
}

/// Messages sent to the writer task (either requests or callback responses).
enum WriterMessage {
    Request(BridgeRequest, oneshot::Sender<Result<Value, ECPError>>),
    CallbackResponse(BridgeCallbackResponse),
}

impl AIBridge {
    pub fn new() -> Self {
        Self {
            request_tx: None,
            child: None,
            next_id: std::sync::atomic::AtomicU64::new(1),
            running: std::sync::atomic::AtomicBool::new(false),
            notification_tx: None,
            callback_handler: Arc::new(OnceLock::new()),
        }
    }

    /// Set the notification broadcast sender.
    pub fn set_notification_sender(&mut self, tx: broadcast::Sender<String>) {
        self.notification_tx = Some(tx);
    }

    /// Set the callback handler for ECP tool execution.
    /// Can be called after start() since it uses OnceLock internally.
    pub fn set_callback_handler(&self, handler: CallbackHandler) {
        let _ = self.callback_handler.set(handler);
    }

    /// Start the TypeScript subprocess.
    pub async fn start(&mut self, config: AIBridgeConfig) -> Result<(), Box<dyn std::error::Error>> {
        info!(
            "Starting AI bridge: {} {}",
            config.runtime,
            config.script_path.display()
        );

        let mut child = Command::new(&config.runtime)
            .arg("run")
            .arg(&config.script_path)
            .arg("--workspace")
            .arg(&config.workspace_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start AI bridge: {e}"))?;

        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let stderr = child.stderr.take().expect("stderr");

        // Pending request map
        let pending: Arc<dashmap::DashMap<u64, oneshot::Sender<Result<Value, ECPError>>>> =
            Arc::new(dashmap::DashMap::new());

        // Channel for sending messages (requests + callback responses) to the writer task
        let (writer_tx, mut writer_rx) = mpsc::channel::<WriterMessage>(64);

        // ── Writer task — serializes outgoing messages to stdin ──────────
        let pending_clone = pending.clone();
        let mut stdin_writer = stdin;
        tokio::spawn(async move {
            while let Some(msg) = writer_rx.recv().await {
                let line = match msg {
                    WriterMessage::Request(req, response_tx) => {
                        let serialized = serde_json::to_string(&req).unwrap();
                        pending_clone.insert(req.id, response_tx);
                        serialized
                    }
                    WriterMessage::CallbackResponse(resp) => {
                        serde_json::to_string(&resp).unwrap()
                    }
                };

                let mut data = line.into_bytes();
                data.push(b'\n');
                if stdin_writer.write_all(&data).await.is_err() {
                    break;
                }
            }
        });

        // ── Reader task — reads and classifies messages from stdout ──────
        let pending_reader = pending.clone();
        let notify_tx = self.notification_tx.clone();
        let callback_handler = self.callback_handler.clone();
        let callback_writer = writer_tx.clone();

        // Health check channel — reader signals when bridge emits ai/bridge/ready
        let (ready_tx, ready_rx) = oneshot::channel::<()>();
        let ready_tx = std::sync::Mutex::new(Some(ready_tx));

        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();

            while let Ok(Some(line)) = lines.next_line().await {
                // Classify the message by inspecting raw JSON
                let parsed: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => {
                        debug!("Non-JSON line from AI bridge: {line}");
                        continue;
                    }
                };

                // Check for ready signal
                if let Some(method) = parsed.get("method").and_then(|m| m.as_str()) {
                    if method == "ai/bridge/ready" {
                        if let Some(tx) = ready_tx.lock().unwrap().take() {
                            let _ = tx.send(());
                        }
                    }
                }

                if parsed.get("callbackId").is_some() {
                    // ── Callback: bridge wants to call an ECP tool ───────
                    match serde_json::from_value::<BridgeCallback>(parsed) {
                        Ok(cb) => {
                            let handler = callback_handler.clone();
                            let writer = callback_writer.clone();
                            tokio::spawn(async move {
                                let resp = if let Some(handler) = handler.get() {
                                    match handler(&cb.method, cb.params).await {
                                        Ok(result) => BridgeCallbackResponse {
                                            callback_id: cb.callback_id,
                                            result: Some(result),
                                            error: None,
                                        },
                                        Err(e) => BridgeCallbackResponse {
                                            callback_id: cb.callback_id,
                                            result: None,
                                            error: Some(BridgeError {
                                                code: e.code,
                                                message: e.message.clone(),
                                            }),
                                        },
                                    }
                                } else {
                                    BridgeCallbackResponse {
                                        callback_id: cb.callback_id,
                                        result: None,
                                        error: Some(BridgeError {
                                            code: -32000,
                                            message: "No callback handler registered".into(),
                                        }),
                                    }
                                };
                                let _ = writer
                                    .send(WriterMessage::CallbackResponse(resp))
                                    .await;
                            });
                        }
                        Err(e) => {
                            warn!("Failed to parse bridge callback: {e}");
                        }
                    }
                } else if let Some(id_val) = parsed.get("id") {
                    // ── Response: answer to a pending request ────────────
                    if let Some(id) = id_val.as_u64() {
                        if let Some((_, tx)) = pending_reader.remove(&id) {
                            let result = if let Some(err) = parsed.get("error") {
                                let code = err
                                    .get("code")
                                    .and_then(|c| c.as_i64())
                                    .unwrap_or(-32000)
                                    as i32;
                                let message = err
                                    .get("message")
                                    .and_then(|m| m.as_str())
                                    .unwrap_or("Unknown error")
                                    .to_string();
                                Err(ECPError {
                                    code,
                                    message,
                                    data: None,
                                })
                            } else {
                                Ok(parsed
                                    .get("result")
                                    .cloned()
                                    .unwrap_or(Value::Null))
                            };
                            let _ = tx.send(result);
                        } else {
                            debug!("Response for unknown request id: {id}");
                        }
                    }
                } else if parsed.get("method").is_some() {
                    // ── Notification: forward to broadcast channel ───────
                    if let Some(ref ntx) = notify_tx {
                        // Wrap as an ECPNotification for the transport layer
                        let method = parsed["method"].as_str().unwrap_or("");
                        let params = parsed.get("params").cloned();
                        let notification = ECPNotification::new(method, params);
                        if let Ok(json) = serde_json::to_string(&notification) {
                            let _ = ntx.send(json);
                        }
                    }
                } else {
                    debug!("Unclassified message from AI bridge: {line}");
                }
            }
            warn!("AI bridge stdout reader ended");
        });

        // ── Stderr logger ────────────────────────────────────────────────
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                debug!("[ai-bridge] {line}");
            }
        });

        self.request_tx = Some(writer_tx);
        self.child = Some(child);

        // Wait for the bridge to signal readiness (ai/bridge/ready notification)
        match tokio::time::timeout(std::time::Duration::from_secs(10), ready_rx).await {
            Ok(Ok(())) => {
                self.running
                    .store(true, std::sync::atomic::Ordering::Relaxed);
                info!("AI bridge started and ready");
                Ok(())
            }
            Ok(Err(_)) => {
                // Channel dropped — bridge process exited before sending ready
                warn!("AI bridge process exited before signaling ready");
                self.request_tx = None;
                Err("AI bridge process exited before signaling ready".into())
            }
            Err(_) => {
                // Timeout — bridge didn't signal ready in time
                warn!("AI bridge startup timed out (10s)");
                self.running
                    .store(true, std::sync::atomic::Ordering::Relaxed);
                info!("AI bridge started (ready signal not received, continuing anyway)");
                Ok(())
            }
        }
    }

    /// Send a request to the AI bridge and wait for a response.
    pub async fn request(&self, method: &str, params: Option<Value>) -> HandlerResult {
        let tx = self
            .request_tx
            .as_ref()
            .ok_or_else(|| ECPError::server_error("AI bridge not started"))?;

        let id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (response_tx, response_rx) = oneshot::channel();

        let req = BridgeRequest {
            id,
            method: method.to_string(),
            params,
        };

        tx.send(WriterMessage::Request(req, response_tx))
            .await
            .map_err(|_| ECPError::server_error("AI bridge channel closed"))?;

        response_rx
            .await
            .map_err(|_| ECPError::server_error("AI bridge response channel dropped"))?
    }

    /// Check if the bridge is running.
    pub fn is_running(&self) -> bool {
        self.running.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Shutdown the bridge subprocess.
    pub async fn shutdown(&mut self) {
        self.running
            .store(false, std::sync::atomic::Ordering::Relaxed);
        self.request_tx = None;

        if let Some(mut child) = self.child.take() {
            let _ = child.kill().await;
            info!("AI bridge subprocess terminated");
        }
    }
}

impl Default for AIBridge {
    fn default() -> Self {
        Self::new()
    }
}
