//! ECP Server Router — dispatches JSON-RPC requests to services.

use std::path::PathBuf;

use ecp_protocol::{ECPError, ECPErrorCode, ECPNotification, HandlerResult};
use ecp_services::Service;
use ecp_transport::server::RequestHandler;
use serde_json::Value;
use tokio::sync::broadcast;
use tracing::info;

use crate::middleware::MiddlewareChain;
use crate::workspace::WorkspaceContext;

/// The ECP Server — owns services and routes requests.
pub struct ECPServer {
    /// Workspace context
    context: WorkspaceContext,
    /// Registered services (boxed for object safety)
    services: Vec<Box<dyn ServiceDyn>>,
    /// Middleware chain
    middleware: MiddlewareChain,
    /// Server state
    state: ServerState,
    /// Notification sender (for broadcasting to clients)
    notification_tx: Option<broadcast::Sender<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ServerState {
    Uninitialized,
    Running,
    Shutdown,
}

/// Object-safe wrapper for the Service trait.
trait ServiceDyn: Send + Sync {
    fn namespace_dyn(&self) -> &str;
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
    pub fn new(workspace_root: PathBuf) -> Self {
        let context = WorkspaceContext::new(workspace_root);

        Self {
            context,
            services: Vec::new(),
            middleware: MiddlewareChain::new(),
            state: ServerState::Uninitialized,
            notification_tx: None,
        }
    }

    /// Register a service with the server.
    pub fn register_service<S: Service + 'static>(&mut self, service: S) {
        info!("Registering service: {}", service.namespace());
        self.services.push(Box::new(service));
    }

    /// Set the notification sender for broadcasting.
    pub fn set_notification_sender(&mut self, tx: broadcast::Sender<String>) {
        self.notification_tx = Some(tx);
    }

    /// Initialize all services.
    pub async fn initialize(&mut self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        info!("Initializing ECP server with workspace: {}", self.context.root.display());

        for service in &self.services {
            service.init_dyn().await?;
        }

        self.state = ServerState::Running;
        info!("ECP server initialized ({} services)", self.services.len());
        Ok(())
    }

    /// Shutdown all services.
    pub async fn shutdown(&mut self) {
        if self.state == ServerState::Shutdown {
            return;
        }

        info!("Shutting down ECP server...");
        self.state = ServerState::Shutdown;

        for service in &self.services {
            service.shutdown_dyn().await;
        }

        info!("ECP server shutdown complete");
    }

    /// Broadcast a notification to all connected clients.
    pub fn emit_notification(&self, method: &str, params: Option<Value>) {
        if let Some(tx) = &self.notification_tx {
            let notification = ECPNotification::new(method, params);
            if let Ok(json) = serde_json::to_string(&notification) {
                let _ = tx.send(json);
            }
        }
    }

    /// Get the workspace root.
    pub fn workspace_root(&self) -> &std::path::Path {
        &self.context.root
    }

    /// Route a request to the appropriate service.
    async fn route_request(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> HandlerResult {
        // Find the namespace prefix
        let namespace = method.split('/').next().unwrap_or("");

        // First: exact namespace match
        for service in &self.services {
            if service.namespace_dyn() == namespace {
                return service.handle_dyn(method, params).await;
            }
        }

        // Fallback: try all services for multi-namespace handlers
        // (e.g. SessionService handles config/*, theme/*, workspace/*, etc.)
        for service in &self.services {
            match service.handle_dyn(method, params.clone()).await {
                Err(e) if e.error_code() == ECPErrorCode::MethodNotFound => continue,
                result => return result,
            }
        }

        Err(ECPError::method_not_found(method))
    }
}

impl RequestHandler for ECPServer {
    async fn handle_request(
        &self,
        method: &str,
        params: Option<Value>,
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
        let result = self.route_request(method, final_params.clone()).await;

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
}
