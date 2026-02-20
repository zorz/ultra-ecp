//! WorkspaceRegistry — manages per-workspace service instances with ref-counting.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ecp_protocol::{ECPError, ECPErrorCode, ECPNotification, HandlerResult};
use ecp_services::{
    chat::{ChatDb, ChatService},
    database::DatabaseService,
    file::FileService,
    git::GitService,
    lsp::LSPService,
    session::SessionService,
    terminal::TerminalService,
    watch::WatchService,
};
use parking_lot::{Mutex, RwLock};
use serde_json::Value;
use tokio::sync::broadcast;
use tracing::{info, warn};

use crate::router::ServiceDyn;

/// Holds all per-workspace service instances and a notification channel.
pub struct WorkspaceServices {
    pub id: String,
    pub path: PathBuf,
    services: Vec<Box<dyn ServiceDyn>>,
    pub notification_tx: broadcast::Sender<String>,
}

impl WorkspaceServices {
    /// Route a request to a service within this workspace.
    pub async fn route(&self, method: &str, params: Option<Value>) -> HandlerResult {
        let namespace = method.split('/').next().unwrap_or("");

        // Exact namespace match
        for service in &self.services {
            if service.namespace_dyn() == namespace {
                return service.handle_dyn(method, params).await;
            }
        }

        // Fallback: try all services
        for service in &self.services {
            match service.handle_dyn(method, params.clone()).await {
                Err(e) if e.error_code() == ECPErrorCode::MethodNotFound => continue,
                result => return result,
            }
        }

        Err(ECPError::method_not_found(method))
    }

    /// Initialize all services in this workspace.
    pub async fn init(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        for service in &self.services {
            service.init_dyn().await?;
        }
        Ok(())
    }

    /// Shutdown all services in this workspace.
    pub async fn shutdown(&self) {
        for service in &self.services {
            service.shutdown_dyn().await;
        }
    }

    /// Emit a notification on this workspace's channel.
    pub fn emit_notification(&self, method: &str, params: Option<Value>) {
        let notification = ECPNotification::new(method, params);
        if let Ok(json) = serde_json::to_string(&notification) {
            let _ = self.notification_tx.send(json);
        }
    }
}

/// Internal entry in the registry — tracks refcount.
struct WorkspaceEntry {
    services: Arc<WorkspaceServices>,
    refcount: usize,
}

/// Manages per-workspace service instances with ref-counting.
///
/// Multiple connections can share a workspace. Services are created when
/// the first connection opens a workspace and shut down when the last
/// connection closes it.
///
/// Uses parking_lot::RwLock (sync) for the maps so `get()` can be called
/// from both sync and async contexts. Async operations (init, shutdown)
/// are performed outside the lock.
pub struct WorkspaceRegistry {
    workspaces: RwLock<HashMap<String, WorkspaceEntry>>,
    path_to_id: RwLock<HashMap<PathBuf, String>>,
    client_workspaces: RwLock<HashMap<String, String>>,
    global_chat_db: Arc<Mutex<ChatDb>>,
}

impl WorkspaceRegistry {
    pub fn new(global_chat_db: Arc<Mutex<ChatDb>>) -> Self {
        Self {
            workspaces: RwLock::new(HashMap::new()),
            path_to_id: RwLock::new(HashMap::new()),
            client_workspaces: RwLock::new(HashMap::new()),
            global_chat_db,
        }
    }

    /// Open a workspace for a client connection. Returns (workspace_id, notification receiver).
    ///
    /// If the workspace path is already open, reuses the existing instance and
    /// bumps its refcount.
    pub async fn open(
        &self,
        path: &Path,
        client_id: &str,
    ) -> Result<(String, broadcast::Receiver<String>), ECPError> {
        let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());

        // Check if this client already has a workspace open
        if self.client_workspaces.read().contains_key(client_id) {
            return Err(ECPError::invalid_request(
                "Client already has a workspace open. Send workspace/close first.",
            ));
        }

        // Check if this path is already open — reuse existing workspace
        {
            let path_map = self.path_to_id.read();
            if let Some(ws_id) = path_map.get(&canonical) {
                let mut workspaces = self.workspaces.write();
                if let Some(entry) = workspaces.get_mut(ws_id) {
                    entry.refcount += 1;
                    let rx = entry.services.notification_tx.subscribe();
                    let ws_id = ws_id.clone();

                    // Track client → workspace mapping
                    self.client_workspaces.write().insert(client_id.to_string(), ws_id.clone());

                    info!("Workspace reused: {} (refcount: {})", canonical.display(), entry.refcount);
                    return Ok((ws_id, rx));
                }
            }
        }

        // Create new workspace (async — init services outside the lock)
        let ws_id = uuid::Uuid::new_v4().to_string();
        let ws_services = self.create_workspace_services(&ws_id, &canonical);

        // Initialize services (async)
        ws_services.init().await.map_err(|e| {
            ECPError::server_error(format!("Failed to initialize workspace services: {e}"))
        })?;

        let rx = ws_services.notification_tx.subscribe();
        let entry = WorkspaceEntry {
            services: Arc::new(ws_services),
            refcount: 1,
        };

        // Insert into all maps (sync lock)
        {
            self.workspaces.write().insert(ws_id.clone(), entry);
            self.path_to_id.write().insert(canonical.clone(), ws_id.clone());
            self.client_workspaces.write().insert(client_id.to_string(), ws_id.clone());
        }

        info!("Workspace opened: {} (id: {})", canonical.display(), ws_id);
        Ok((ws_id, rx))
    }

    /// Close the workspace for a client connection.
    /// Decrements refcount; shuts down services when it reaches 0.
    pub async fn close(&self, client_id: &str) -> Result<(), ECPError> {
        let ws_id = self.client_workspaces.write().remove(client_id)
            .ok_or_else(|| ECPError::invalid_request("Client has no workspace open."))?;

        self.decrement_workspace(&ws_id).await;
        Ok(())
    }

    /// Called when a client disconnects without explicit workspace/close.
    pub async fn client_disconnected(&self, client_id: &str) {
        let ws_id = self.client_workspaces.write().remove(client_id);

        if let Some(ws_id) = ws_id {
            self.decrement_workspace(&ws_id).await;
        }
    }

    /// Get the workspace services for a given workspace ID. (sync — no await needed)
    pub fn get(&self, workspace_id: &str) -> Option<Arc<WorkspaceServices>> {
        self.workspaces.read().get(workspace_id).map(|e| e.services.clone())
    }

    /// Shutdown all workspaces (called during server shutdown).
    pub async fn shutdown_all(&self) {
        // Drain all entries while holding the lock briefly
        let entries: Vec<_> = {
            let mut workspaces = self.workspaces.write();
            workspaces.drain().collect()
        };
        self.path_to_id.write().clear();
        self.client_workspaces.write().clear();

        // Shutdown services outside the lock (async)
        for (id, entry) in entries {
            info!("Shutting down workspace: {}", id);
            entry.services.shutdown().await;
        }
    }

    // ── Internal ──────────────────────────────────────────────────────────

    async fn decrement_workspace(&self, ws_id: &str) {
        // Remove from map if refcount hits 0 (sync lock)
        let to_shutdown = {
            let mut workspaces = self.workspaces.write();
            if let Some(entry) = workspaces.get_mut(ws_id) {
                entry.refcount -= 1;
                if entry.refcount == 0 {
                    let entry = workspaces.remove(ws_id).unwrap();
                    let path = entry.services.path.clone();
                    self.path_to_id.write().remove(&path);
                    info!("Workspace closed: {} (id: {})", path.display(), ws_id);
                    Some(entry.services)
                } else {
                    info!("Workspace refcount decremented: {} (refcount: {})", ws_id, entry.refcount);
                    None
                }
            } else {
                warn!("Workspace not found for decrement: {}", ws_id);
                None
            }
        };

        // Shutdown outside the lock (async)
        if let Some(services) = to_shutdown {
            services.shutdown().await;
        }
    }

    fn create_workspace_services(&self, id: &str, path: &Path) -> WorkspaceServices {
        let (notification_tx, _) = broadcast::channel::<String>(256);

        // Build a notification callback for workspace-scoped services
        let ws_notify_tx = notification_tx.clone();
        let notify_sender: Arc<dyn Fn(&str, serde_json::Value) + Send + Sync> =
            Arc::new(move |method, params| {
                let notification = ECPNotification::new(method, Some(params));
                if let Ok(json) = serde_json::to_string(&notification) {
                    let _ = ws_notify_tx.send(json);
                }
            });

        let watch_service = WatchService::new(path.to_path_buf());
        watch_service.set_notify_sender(notify_sender);

        let mut services: Vec<Box<dyn ServiceDyn>> = Vec::new();
        services.push(Box::new(FileService::new(path.to_path_buf())));
        services.push(Box::new(GitService::new(path.to_path_buf())));
        services.push(Box::new(TerminalService::new(path.to_path_buf())));
        services.push(Box::new(SessionService::new(path.to_path_buf())));
        services.push(Box::new(ChatService::new_with_global_db(path, self.global_chat_db.clone())));
        services.push(Box::new(DatabaseService::new(path.to_path_buf())));
        services.push(Box::new(LSPService::new(path.to_path_buf())));
        services.push(Box::new(watch_service));

        WorkspaceServices {
            id: id.to_string(),
            path: path.to_path_buf(),
            services,
            notification_tx,
        }
    }
}
