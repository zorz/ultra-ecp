//! ECP Server Router — dispatches JSON-RPC requests to services.
//!
//! The [`ECPServer`] owns global services and a [`WorkspaceRegistry`]. Request
//! routing works in three phases:
//!
//! 1. **Workspace lifecycle** — `workspace/open` and `workspace/close` are
//!    handled inline by the router.
//! 2. **Global services** — matched by namespace, then fallback try-all.
//!    Bridge-delegated services have `_workspaceId` injected into params.
//! 3. **Workspace services** — resolved via `context.workspace_id` (or the
//!    default workspace from `--workspace`). Returns `-32020` if no workspace
//!    is open.

use std::path::PathBuf;

use ecp_protocol::{ECPError, ECPErrorCode, ECPNotification, HandlerResult, RequestContext};
use ecp_services::{Service, ServiceScope};
use ecp_transport::server::RequestHandler;
use serde_json::{json, Value};
use tokio::sync::broadcast;
use tracing::info;

use crate::middleware::MiddlewareChain;
use crate::registry::WorkspaceRegistry;

/// The ECP Server — owns global services and a workspace registry.
pub struct ECPServer {
    /// Global services (shared across all workspaces)
    global_services: Vec<Box<dyn ServiceDyn>>,
    /// Per-workspace service instances
    workspace_registry: WorkspaceRegistry,
    /// Middleware chain
    middleware: MiddlewareChain,
    /// Server state
    state: ServerState,
    /// Global notification sender (theme changes, config, etc.)
    global_notification_tx: Option<broadcast::Sender<String>>,
    /// Default workspace ID — auto-opened via --workspace flag for backward compat
    default_workspace: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ServerState {
    Uninitialized,
    Running,
    Shutdown,
}

/// Object-safe wrapper for the Service trait.
pub(crate) trait ServiceDyn: Send + Sync {
    fn namespace_dyn(&self) -> &str;
    fn scope_dyn(&self) -> ServiceScope;
    fn is_bridge_delegated_dyn(&self) -> bool;
    fn handle_dyn<'a>(
        &'a self,
        method: &'a str,
        params: Option<Value>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = HandlerResult> + Send + 'a>>;
    fn init_dyn(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), Box<dyn std::error::Error + Send + Sync>>> + Send + '_>>;
    fn shutdown_dyn(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>>;
}

impl<T: Service> ServiceDyn for T {
    fn namespace_dyn(&self) -> &str {
        self.namespace()
    }
    fn scope_dyn(&self) -> ServiceScope {
        self.scope()
    }
    fn is_bridge_delegated_dyn(&self) -> bool {
        self.is_bridge_delegated()
    }
    fn handle_dyn<'a>(
        &'a self,
        method: &'a str,
        params: Option<Value>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = HandlerResult> + Send + 'a>> {
        Box::pin(self.handle(method, params))
    }
    fn init_dyn(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), Box<dyn std::error::Error + Send + Sync>>> + Send + '_>> {
        Box::pin(self.init())
    }
    fn shutdown_dyn(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(self.shutdown())
    }
}

impl ECPServer {
    pub fn new(workspace_registry: WorkspaceRegistry) -> Self {
        Self {
            global_services: Vec::new(),
            workspace_registry,
            middleware: MiddlewareChain::new(),
            state: ServerState::Uninitialized,
            global_notification_tx: None,
            default_workspace: None,
        }
    }

    /// Register a global service with the server.
    pub fn register_service<S: Service + 'static>(&mut self, service: S) {
        info!("Registering global service: {}", service.namespace());
        self.global_services.push(Box::new(service));
    }

    /// Set the global notification sender for broadcasting.
    pub fn set_notification_sender(&mut self, tx: broadcast::Sender<String>) {
        self.global_notification_tx = Some(tx);
    }

    /// Set the default workspace ID (from --workspace flag).
    pub fn set_default_workspace(&mut self, ws_id: String) {
        self.default_workspace = Some(ws_id);
    }

    /// Get a reference to the workspace registry.
    pub fn workspace_registry(&self) -> &WorkspaceRegistry {
        &self.workspace_registry
    }

    /// Initialize all global services.
    pub async fn initialize(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        info!("Initializing ECP server");

        for service in &self.global_services {
            service.init_dyn().await?;
        }

        self.state = ServerState::Running;
        info!("ECP server initialized ({} global services)", self.global_services.len());
        Ok(())
    }

    /// Shutdown all services.
    pub async fn shutdown(&mut self) {
        if self.state == ServerState::Shutdown {
            return;
        }

        info!("Shutting down ECP server...");
        self.state = ServerState::Shutdown;

        for service in &self.global_services {
            service.shutdown_dyn().await;
        }

        self.workspace_registry.shutdown_all().await;

        info!("ECP server shutdown complete");
    }

    /// Broadcast a notification to all connected clients (global channel).
    pub fn emit_notification(&self, method: &str, params: Option<Value>) {
        if let Some(tx) = &self.global_notification_tx {
            let notification = ECPNotification::new(method, params);
            if let Ok(json) = serde_json::to_string(&notification) {
                let _ = tx.send(json);
            }
        }
    }

    /// Route a request to the appropriate service.
    async fn route_request(
        &self,
        method: &str,
        params: Option<Value>,
        context: &RequestContext,
    ) -> HandlerResult {
        // 1. Handle workspace/open inline
        if method == "workspace/open" {
            return self.handle_workspace_open(params, context).await;
        }

        // 2. Handle workspace/close inline
        if method == "workspace/close" {
            return self.handle_workspace_close(context).await;
        }

        let namespace = method.split('/').next().unwrap_or("");

        // 3. Try global services first — exact namespace match
        for service in &self.global_services {
            if service.namespace_dyn() == namespace {
                // For bridge-delegated services, inject _workspaceId if available
                let effective_params = if service.is_bridge_delegated_dyn() {
                    self.inject_workspace_id(params, context)
                } else {
                    params
                };
                return service.handle_dyn(method, effective_params).await;
            }
        }

        // 4. Try global services — fallback try-all (for multi-namespace like SessionService)
        // Note: SessionService is workspace-scoped but handles config/*, theme/* etc.
        // We'll check global services first in fallback too.
        for service in &self.global_services {
            let effective_params = if service.is_bridge_delegated_dyn() {
                self.inject_workspace_id(params.clone(), context)
            } else {
                params.clone()
            };
            match service.handle_dyn(method, effective_params).await {
                Err(e) if e.error_code() == ECPErrorCode::MethodNotFound => continue,
                result => return result,
            }
        }

        // 5. Resolve workspace for workspace-scoped services
        let effective_workspace_id = context.workspace_id.as_deref()
            .or(self.default_workspace.as_deref());

        let ws_id = match effective_workspace_id {
            Some(id) => id,
            None => return Err(ECPError::no_workspace()),
        };

        let ws = self.workspace_registry.get(ws_id)
            .ok_or_else(|| ECPError::workspace_not_found(ws_id))?;

        // 6. Route through workspace services
        ws.route(method, params).await
    }

    /// Handle workspace/open — delegates to registry.
    async fn handle_workspace_open(
        &self,
        params: Option<Value>,
        context: &RequestContext,
    ) -> HandlerResult {
        let params = params.ok_or_else(|| ECPError::invalid_params("Missing params"))?;
        let path_str = params.get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ECPError::invalid_params("Missing 'path' parameter"))?;

        let path = PathBuf::from(path_str);
        if !path.exists() {
            return Err(ECPError::invalid_params(format!("Path does not exist: {path_str}")));
        }

        let (ws_id, _rx) = self.workspace_registry.open(&path, &context.client_id).await?;

        Ok(json!({
            "workspaceId": ws_id,
            "path": path.canonicalize().unwrap_or(path).to_string_lossy(),
        }))
    }

    /// Handle workspace/close — delegates to registry.
    async fn handle_workspace_close(
        &self,
        context: &RequestContext,
    ) -> HandlerResult {
        self.workspace_registry.close(&context.client_id).await?;
        Ok(json!({ "workspaceClosed": true }))
    }

    /// Inject _workspaceId and _workspacePath into params for bridge-delegated services.
    fn inject_workspace_id(
        &self,
        params: Option<Value>,
        context: &RequestContext,
    ) -> Option<Value> {
        let effective_ws_id = context.workspace_id.as_deref()
            .or(self.default_workspace.as_deref());

        if let Some(ws_id) = effective_ws_id {
            let mut obj = match params {
                Some(Value::Object(map)) => map,
                Some(other) => return Some(other),
                None => serde_json::Map::new(),
            };
            obj.insert("_workspaceId".into(), json!(ws_id));
            // Also inject the filesystem path so the bridge knows the project directory
            if let Some(ws) = self.workspace_registry.get(ws_id) {
                obj.insert("_workspacePath".into(), json!(ws.path.to_string_lossy()));
            }
            Some(Value::Object(obj))
        } else {
            params
        }
    }
}

impl RequestHandler for ECPServer {
    async fn handle_request(
        &self,
        method: &str,
        params: Option<Value>,
        context: RequestContext,
    ) -> HandlerResult {
        // Check server state
        match self.state {
            ServerState::Shutdown => return Err(ECPError::shutting_down()),
            ServerState::Uninitialized => return Err(ECPError::not_initialized()),
            ServerState::Running => {}
        }

        // Run middleware before-chain
        let mw_result = self.middleware.run_before(method, params).await;
        if !mw_result.allowed {
            return Err(ECPError::server_error(
                mw_result.feedback.unwrap_or_else(|| "Request blocked by middleware".into()),
            ));
        }

        let final_params = mw_result.params;

        // Route to service
        let result = self.route_request(method, final_params.clone(), &context).await;

        // Run middleware after-chain on success
        if let Ok(ref value) = result {
            let params_value = final_params
                .as_ref()
                .cloned()
                .unwrap_or(Value::Null);
            self.middleware.run_after(method, &params_value, value).await;
        }

        result
    }

    async fn on_client_disconnected(&self, client_id: &str) {
        self.workspace_registry.client_disconnected(client_id).await;
    }

    fn workspace_notification_rx(
        &self,
        workspace_id: &str,
    ) -> Option<broadcast::Receiver<String>> {
        self.workspace_registry.get(workspace_id)
            .map(|ws| ws.notification_tx.subscribe())
    }

    fn default_workspace_id(&self) -> Option<String> {
        self.default_workspace.clone()
    }
}
