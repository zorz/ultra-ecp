//! Terminal service — PTY management for shell sessions.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use ecp_protocol::{ECPError, HandlerResult};
use parking_lot::RwLock;
use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::mpsc;
use tracing::{debug, info};

use crate::Service;

/// Terminal service — manages multiple shell sessions.
pub struct TerminalService {
    workspace_root: RwLock<PathBuf>,
    sessions: RwLock<HashMap<String, Arc<RwLock<TerminalSessionInfo>>>>,
    /// Notification callback for terminal output/exit events
    notification_tx: Option<mpsc::UnboundedSender<TerminalNotification>>,
}

/// Lightweight session info (the actual process is managed by spawned tasks).
struct TerminalSessionInfo {
    id: String,
    shell: String,
    cwd: String,
    running: bool,
    buffer: Arc<RwLock<String>>,
    input_tx: mpsc::Sender<Vec<u8>>,
}

/// Terminal notifications sent to the transport layer.
#[derive(Debug)]
pub enum TerminalNotification {
    Output { terminal_id: String, data: String },
    Exit { terminal_id: String, code: Option<i32> },
}

impl TerminalService {
    pub fn new(workspace_root: PathBuf) -> Self {
        Self {
            workspace_root: RwLock::new(workspace_root),
            sessions: RwLock::new(HashMap::new()),
            notification_tx: None,
        }
    }

    pub fn set_workspace_root(&self, root: PathBuf) {
        *self.workspace_root.write() = root;
    }

    pub fn set_notification_sender(&mut self, tx: mpsc::UnboundedSender<TerminalNotification>) {
        self.notification_tx = Some(tx);
    }
}

impl Service for TerminalService {
    fn namespace(&self) -> &str {
        "terminal"
    }

    async fn handle(&self, method: &str, params: Option<serde_json::Value>) -> HandlerResult {
        match method {
            "terminal/create" => {
                let p: TerminalCreateParams = parse_params_optional(params);
                let cwd = p.cwd.unwrap_or_else(|| {
                    self.workspace_root.read().to_string_lossy().to_string()
                });
                let shell = p.shell.unwrap_or_else(|| {
                    std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
                });

                let id = format!("term-{}", uuid::Uuid::new_v4());

                let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(256);
                let buffer = Arc::new(RwLock::new(String::new()));

                // Spawn the shell process
                let mut child = Command::new(&shell)
                    .current_dir(&cwd)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                    .map_err(|e| ECPError::server_error(format!("Failed to spawn terminal: {e}")))?;

                let child_stdin = child.stdin.take();
                let child_stdout = child.stdout.take();

                // Spawn input forwarding task
                let input_id = id.clone();
                tokio::spawn(async move {
                    let mut stdin = match child_stdin {
                        Some(s) => s,
                        None => return,
                    };
                    while let Some(data) = input_rx.recv().await {
                        if stdin.write_all(&data).await.is_err() {
                            break;
                        }
                    }
                    debug!("Input task ended for {input_id}");
                });

                // Spawn output reading task
                let output_buffer = buffer.clone();
                let output_id = id.clone();
                tokio::spawn(async move {
                    let mut stdout = match child_stdout {
                        Some(s) => s,
                        None => return,
                    };
                    let mut buf = vec![0u8; 4096];
                    loop {
                        match stdout.read(&mut buf).await {
                            Ok(0) => break,
                            Ok(n) => {
                                let text = String::from_utf8_lossy(&buf[..n]).to_string();
                                output_buffer.write().push_str(&text);
                            }
                            Err(_) => break,
                        }
                    }
                    debug!("Output task ended for {output_id}");
                });

                let info = TerminalSessionInfo {
                    id: id.clone(),
                    shell: shell.clone(),
                    cwd: cwd.clone(),
                    running: true,
                    buffer: buffer.clone(),
                    input_tx,
                };

                self.sessions.write().insert(id.clone(), Arc::new(RwLock::new(info)));

                Ok(json!({
                    "id": id,
                    "shell": shell,
                    "cwd": cwd,
                }))
            }

            "terminal/write" => {
                let p: TerminalWriteParams = parse_params(params)?;
                let tx = {
                    let sessions = self.sessions.read();
                    let session = sessions.get(&p.id)
                        .ok_or_else(|| ECPError::server_error(format!("Terminal not found: {}", p.id)))?;
                    session.read().input_tx.clone()
                };
                tx.send(p.data.into_bytes()).await
                    .map_err(|_| ECPError::server_error("Terminal input channel closed"))?;

                Ok(json!({ "success": true }))
            }

            "terminal/getBuffer" => {
                let p: TerminalIdParam = parse_params(params)?;
                let sessions = self.sessions.read();
                let session = sessions.get(&p.id)
                    .ok_or_else(|| ECPError::server_error(format!("Terminal not found: {}", p.id)))?;

                let buffer = session.read().buffer.read().clone();
                Ok(json!({ "buffer": buffer }))
            }

            "terminal/close" => {
                let p: TerminalIdParam = parse_params(params)?;
                let mut sessions = self.sessions.write();
                if sessions.remove(&p.id).is_some() {
                    Ok(json!({ "success": true }))
                } else {
                    Err(ECPError::server_error(format!("Terminal not found: {}", p.id)))
                }
            }

            "terminal/closeAll" => {
                let mut sessions = self.sessions.write();
                let count = sessions.len();
                sessions.clear();
                Ok(json!({ "success": true, "closed": count }))
            }

            "terminal/list" => {
                let sessions = self.sessions.read();
                let terminals: Vec<serde_json::Value> = sessions.values()
                    .map(|s| {
                        let info = s.read();
                        json!({
                            "id": info.id,
                            "shell": info.shell,
                            "cwd": info.cwd,
                            "running": info.running,
                        })
                    })
                    .collect();

                Ok(json!({ "terminals": terminals }))
            }

            "terminal/exists" => {
                let p: TerminalIdParam = parse_params(params)?;
                let exists = self.sessions.read().contains_key(&p.id);
                Ok(json!({ "exists": exists }))
            }

            "terminal/execute" => {
                let p: TerminalExecuteParams = parse_params(params)?;
                let cwd = p.cwd.unwrap_or_else(|| {
                    self.workspace_root.read().to_string_lossy().to_string()
                });

                let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
                let output = Command::new(&shell)
                    .args(["-c", &p.command])
                    .current_dir(&cwd)
                    .output()
                    .await
                    .map_err(|e| ECPError::server_error(format!("Failed to execute: {e}")))?;

                Ok(json!({
                    "stdout": String::from_utf8_lossy(&output.stdout),
                    "stderr": String::from_utf8_lossy(&output.stderr),
                    "exitCode": output.status.code(),
                    "success": output.status.success(),
                }))
            }

            _ => Err(ECPError::method_not_found(method)),
        }
    }

    async fn shutdown(&self) {
        let mut sessions = self.sessions.write();
        sessions.clear();
        info!("Terminal service shutdown: all sessions closed");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize, Default)]
struct TerminalCreateParams {
    shell: Option<String>,
    cwd: Option<String>,
}

#[derive(Deserialize)]
struct TerminalIdParam {
    id: String,
}

#[derive(Deserialize)]
struct TerminalWriteParams {
    id: String,
    data: String,
}

#[derive(Deserialize)]
struct TerminalExecuteParams {
    command: String,
    cwd: Option<String>,
}

fn parse_params<T: for<'de> Deserialize<'de>>(params: Option<serde_json::Value>) -> Result<T, ECPError> {
    match params {
        Some(v) => serde_json::from_value(v)
            .map_err(|e| ECPError::invalid_params(format!("Invalid parameters: {e}"))),
        None => Err(ECPError::invalid_params("Parameters required")),
    }
}

fn parse_params_optional<T: for<'de> Deserialize<'de> + Default>(params: Option<serde_json::Value>) -> T {
    params
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}
