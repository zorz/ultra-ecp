//! AI Provider Bridge — manages a TypeScript subprocess for AI SDK interactions.
//!
//! The Rust ECP server handles all core services natively. For AI provider
//! interactions (Anthropic Agent SDK, OpenAI, etc.), it delegates to a
//! TypeScript subprocess connected via JSON-RPC over stdin/stdout.
//!
//! This architecture allows:
//! - Using the official TypeScript SDKs directly (no FFI or reimplementation)
//! - Hot-reloading the AI layer without restarting the Rust server
//! - Isolating AI provider dependencies from the core binary
//! - Adding new providers without modifying Rust code

use std::path::PathBuf;
use std::process::Stdio;

use ecp_protocol::{ECPError, HandlerResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};
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

/// Request sent to the TypeScript subprocess.
#[derive(Debug, Serialize)]
struct BridgeRequest {
    id: u64,
    method: String,
    params: Option<Value>,
}

/// Response from the TypeScript subprocess.
#[derive(Debug, Deserialize)]
struct BridgeResponse {
    id: u64,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<BridgeError>,
}

#[derive(Debug, Deserialize)]
struct BridgeError {
    code: i32,
    message: String,
}

/// The AI Bridge — manages communication with the TypeScript subprocess.
pub struct AIBridge {
    /// Channel to send requests to the subprocess writer task
    request_tx: Option<mpsc::Sender<(BridgeRequest, oneshot::Sender<Result<Value, ECPError>>)>>,
    /// Child process handle
    child: Option<Child>,
    /// Next request ID
    next_id: std::sync::atomic::AtomicU64,
    /// Whether the bridge is running
    running: std::sync::atomic::AtomicBool,
}

impl AIBridge {
    pub fn new() -> Self {
        Self {
            request_tx: None,
            child: None,
            next_id: std::sync::atomic::AtomicU64::new(1),
            running: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Start the TypeScript subprocess.
    pub async fn start(&mut self, config: AIBridgeConfig) -> Result<(), Box<dyn std::error::Error>> {
        info!("Starting AI bridge: {} {}", config.runtime, config.script_path.display());

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

        // Channel for sending requests
        let (tx, mut rx) = mpsc::channel::<(BridgeRequest, oneshot::Sender<Result<Value, ECPError>>)>(64);

        // Pending requests map
        let pending: std::sync::Arc<dashmap::DashMap<u64, oneshot::Sender<Result<Value, ECPError>>>> =
            std::sync::Arc::new(dashmap::DashMap::new());

        // Writer task — serializes requests to stdin
        let pending_clone = pending.clone();
        let mut stdin = stdin;
        tokio::spawn(async move {
            while let Some((req, response_tx)) = rx.recv().await {
                pending_clone.insert(req.id, response_tx);
                let mut line = serde_json::to_string(&req).unwrap();
                line.push('\n');
                if stdin.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
            }
        });

        // Reader task — reads responses from stdout
        let pending_clone = pending.clone();
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                match serde_json::from_str::<BridgeResponse>(&line) {
                    Ok(response) => {
                        if let Some((_, tx)) = pending_clone.remove(&response.id) {
                            let result = if let Some(err) = response.error {
                                Err(ECPError {
                                    code: err.code,
                                    message: err.message,
                                    data: None,
                                })
                            } else {
                                Ok(response.result.unwrap_or(Value::Null))
                            };
                            let _ = tx.send(result);
                        }
                    }
                    Err(_e) => {
                        // Might be a notification or log line — ignore
                        debug!("Non-JSON line from AI bridge: {line}");
                    }
                }
            }
            warn!("AI bridge stdout reader ended");
        });

        // Stderr logger
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                debug!("[ai-bridge] {line}");
            }
        });

        self.request_tx = Some(tx);
        self.child = Some(child);
        self.running.store(true, std::sync::atomic::Ordering::Relaxed);

        info!("AI bridge started");
        Ok(())
    }

    /// Send a request to the AI bridge and wait for a response.
    pub async fn request(&self, method: &str, params: Option<Value>) -> HandlerResult {
        let tx = self.request_tx.as_ref()
            .ok_or_else(|| ECPError::server_error("AI bridge not started"))?;

        let id = self.next_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (response_tx, response_rx) = oneshot::channel();

        let req = BridgeRequest {
            id,
            method: method.to_string(),
            params,
        };

        tx.send((req, response_tx)).await
            .map_err(|_| ECPError::server_error("AI bridge channel closed"))?;

        response_rx.await
            .map_err(|_| ECPError::server_error("AI bridge response channel dropped"))?
    }

    /// Check if the bridge is running.
    pub fn is_running(&self) -> bool {
        self.running.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Shutdown the bridge subprocess.
    pub async fn shutdown(&mut self) {
        self.running.store(false, std::sync::atomic::Ordering::Relaxed);
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
