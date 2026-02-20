//! File watcher service — monitors filesystem for changes using the `notify` crate.
//!
//! Exposes `file/watch` and `file/unwatch` methods and emits
//! `file/didChange`, `file/didCreate`, `file/didDelete` notifications.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use ecp_protocol::{ECPError, HandlerResult};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::RwLock;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::Service;

/// Callback for emitting notifications to connected clients.
pub type NotifySender = Arc<dyn Fn(&str, Value) + Send + Sync>;

pub struct WatchService {
    workspace_root: PathBuf,
    watcher: RwLock<Option<RecommendedWatcher>>,
    watched_paths: RwLock<HashMap<String, WatchEntry>>,
    notify_tx: RwLock<Option<NotifySender>>,
    event_tx: RwLock<Option<mpsc::UnboundedSender<Event>>>,
}

struct WatchEntry {
    path: PathBuf,
    recursive: bool,
}

impl WatchService {
    pub fn new(workspace_root: PathBuf) -> Self {
        Self {
            workspace_root,
            watcher: RwLock::new(None),
            watched_paths: RwLock::new(HashMap::new()),
            notify_tx: RwLock::new(None),
            event_tx: RwLock::new(None),
        }
    }

    /// Set the notification callback for emitting events to clients.
    pub fn set_notify_sender(&self, sender: NotifySender) {
        *self.notify_tx.write() = Some(sender);
    }

    fn resolve_path(&self, path: &str) -> PathBuf {
        // Strip file:// prefix if present (clients may send file:// URIs)
        let stripped = path.strip_prefix("file://").unwrap_or(path);
        let p = std::path::Path::new(stripped);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.workspace_root.join(stripped)
        }
    }

    fn start_watcher(&self) -> Result<(), ECPError> {
        if self.watcher.read().is_some() {
            return Ok(());
        }

        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<Event>();
        *self.event_tx.write() = Some(event_tx.clone());

        let notify_tx = self.notify_tx.read().clone();
        // Spawn event processor
        tokio::spawn(async move {
            while let Some(event) = event_rx.recv().await {
                if let Some(ref tx) = notify_tx {
                    for path in &event.paths {
                        let uri = format!("file://{}", path.display());
                        // Match TypeScript ECP: didCreate/didDelete send { uri },
                        // didChange sends full event { uri, type, timestamp }
                        match event.kind {
                            EventKind::Create(_) => {
                                tx("file/didCreate", json!({ "uri": uri }));
                            }
                            EventKind::Remove(_) => {
                                tx("file/didDelete", json!({ "uri": uri }));
                            }
                            EventKind::Modify(_) => {
                                tx("file/didChange", json!({
                                    "uri": uri,
                                    "type": "changed",
                                    "timestamp": now_ms(),
                                }));
                            }
                            _ => continue,
                        };
                    }
                }
            }
        });

        let tx_clone = event_tx;
        let watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            match res {
                Ok(event) => { let _ = tx_clone.send(event); }
                Err(e) => warn!("File watcher error: {e}"),
            }
        }).map_err(|e| ECPError::server_error(format!("Failed to create watcher: {e}")))?;

        *self.watcher.write() = Some(watcher);
        info!("File watcher started");
        Ok(())
    }
}

impl Service for WatchService {
    fn namespace(&self) -> &str {
        // This handles the "file" namespace methods related to watching.
        // It should be registered alongside FileService — the router will
        // dispatch to whichever service's namespace matches.
        // We use a separate namespace "watch" to avoid conflicts.
        "watch"
    }

    async fn handle(&self, method: &str, params: Option<Value>) -> HandlerResult {
        match method {
            "watch/start" | "file/watch" => {
                let p: WatchParams = parse_params(params)?;
                let path = self.resolve_path(&p.path);
                let recursive = p.recursive.unwrap_or(true);

                self.start_watcher()?;

                let mode = if recursive { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive };
                if let Some(ref mut w) = *self.watcher.write() {
                    w.watch(&path, mode)
                        .map_err(|e| ECPError::server_error(format!("Failed to watch {}: {e}", path.display())))?;
                }

                let id = format!("w-{}", now_ms());
                self.watched_paths.write().insert(id.clone(), WatchEntry {
                    path: path.clone(),
                    recursive,
                });

                debug!("Watching: {}", path.display());
                Ok(json!({ "watchId": id, "path": path.to_string_lossy() }))
            }

            "watch/stop" | "file/unwatch" => {
                let p: UnwatchParams = parse_params(params)?;
                let mut paths = self.watched_paths.write();

                if let Some(entry) = paths.remove(&p.watch_id) {
                    if let Some(ref mut w) = *self.watcher.write() {
                        let _ = w.unwatch(&entry.path);
                    }
                    debug!("Unwatched: {}", entry.path.display());
                    Ok(json!({ "success": true }))
                } else {
                    Ok(json!({ "success": false, "error": "Watch ID not found" }))
                }
            }

            "watch/list" => {
                let paths = self.watched_paths.read();
                let watches: Vec<Value> = paths.iter().map(|(id, entry)| {
                    json!({
                        "watchId": id,
                        "path": entry.path.to_string_lossy(),
                        "recursive": entry.recursive,
                    })
                }).collect();
                Ok(json!({ "watches": watches }))
            }

            _ => Err(ECPError::method_not_found(method)),
        }
    }

    async fn shutdown(&self) {
        // Drop the watcher to stop all watches
        *self.watcher.write() = None;
        self.watched_paths.write().clear();
        info!("File watcher stopped");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Params
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct WatchParams {
    /// Accepts both "uri" (TypeScript ECP) and "path" (legacy)
    #[serde(alias = "uri")]
    path: String,
    recursive: Option<bool>,
}

#[derive(Deserialize)]
struct UnwatchParams {
    #[serde(rename = "watchId")]
    watch_id: String,
}

fn parse_params<T: for<'de> Deserialize<'de>>(params: Option<Value>) -> Result<T, ECPError> {
    match params {
        Some(v) => serde_json::from_value(v)
            .map_err(|e| ECPError::invalid_params(format!("Invalid parameters: {e}"))),
        None => Err(ECPError::invalid_params("Parameters required")),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
