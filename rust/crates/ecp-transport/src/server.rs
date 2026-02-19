//! WebSocket transport server using Axum.
//!
//! Handles HTTP upgrade to WebSocket, authentication handshake,
//! heartbeat pings, and message routing to the ECP server.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    Router,
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::StatusCode,
    response::{IntoResponse, Json},
    routing::get,
};
use ecp_protocol::{
    ECPNotification, ECPResponse, ECPError,
    auth::{
        AuthConfig, AuthErrorCode, AuthRequiredParams,
        HandshakeParams, HandshakeResult,
    },
    jsonrpc::RequestId,
};
use futures_util::{SinkExt, StreamExt, stream::SplitSink};
use serde_json::json;
use tokio::sync::{broadcast, mpsc};
use tracing::{debug, info, warn, error};

/// Trait implemented by the ECP server to handle incoming requests.
/// The transport layer calls this for every authenticated JSON-RPC request.
pub trait RequestHandler: Send + Sync + 'static {
    /// Handle a JSON-RPC request and return a response.
    fn handle_request(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> impl std::future::Future<Output = ecp_protocol::HandlerResult> + Send;
}

/// Transport server configuration.
#[derive(Debug, Clone)]
pub struct TransportConfig {
    /// Port to listen on (0 for OS-assigned)
    pub port: u16,
    /// Hostname to bind to
    pub hostname: String,
    /// Authentication configuration
    pub auth: Option<AuthConfig>,
    /// Enable CORS
    pub enable_cors: bool,
    /// Maximum concurrent connections
    pub max_connections: Option<usize>,
    /// Workspace root (sent in welcome message)
    pub workspace_root: Option<String>,
    /// Enable verbose connection logging
    pub verbose_logging: bool,
}

impl Default for TransportConfig {
    fn default() -> Self {
        Self {
            port: 7070,
            hostname: "127.0.0.1".into(),
            auth: None,
            enable_cors: false,
            max_connections: Some(32),
            workspace_root: None,
            verbose_logging: false,
        }
    }
}

/// Shared state for the transport server.
struct AppState<H: RequestHandler> {
    handler: Arc<H>,
    config: TransportConfig,
    /// Broadcast channel for notifications (server → all clients)
    notification_tx: broadcast::Sender<String>,
    /// Connected client count (for health check)
    client_count: Arc<std::sync::atomic::AtomicUsize>,
}

/// The transport server — manages WebSocket connections and routes messages.
pub struct TransportServer {
    /// Broadcast sender for notifications
    notification_tx: broadcast::Sender<String>,
    /// Shutdown signal
    shutdown_tx: Option<mpsc::Sender<()>>,
    /// Server task handle
    handle: Option<tokio::task::JoinHandle<()>>,
    /// Actual bound port
    port: u16,
}

impl TransportServer {
    /// Start the transport server with the given request handler.
    pub async fn start<H: RequestHandler>(
        config: TransportConfig,
        handler: H,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let (notification_tx, _) = broadcast::channel(1024);
        Self::start_with_sender(config, Arc::new(handler), notification_tx).await
    }

    /// Start the transport server with a pre-existing broadcast channel.
    /// Accepts `Arc<H>` so the handler can be shared with other subsystems
    /// (e.g., the AI bridge callback handler).
    pub async fn start_with_sender<H: RequestHandler>(
        config: TransportConfig,
        handler: Arc<H>,
        notification_tx: broadcast::Sender<String>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let (shutdown_tx, mut shutdown_rx) = mpsc::channel(1);

        let client_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let state = Arc::new(AppState {
            handler,
            config: config.clone(),
            notification_tx: notification_tx.clone(),
            client_count: client_count.clone(),
        });

        let app = Router::new()
            .route("/ws", get(ws_upgrade_handler::<H>))
            .route("/health", get(health_handler::<H>))
            .with_state(state);

        let addr: SocketAddr = format!("{}:{}", config.hostname, config.port).parse()?;
        let listener = tokio::net::TcpListener::bind(addr).await?;
        let actual_port = listener.local_addr()?.port();

        info!("ECP transport listening on ws://{}:{}/ws", config.hostname, actual_port);

        let handle = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.recv().await;
                })
                .await
                .ok();
        });

        Ok(Self {
            notification_tx,
            shutdown_tx: Some(shutdown_tx),
            handle: Some(handle),
            port: actual_port,
        })
    }

    /// Broadcast a notification to all connected, authenticated clients.
    pub fn broadcast(&self, notification: ECPNotification) {
        if let Ok(json) = serde_json::to_string(&notification) {
            // Ignore send errors (no receivers is fine)
            let _ = self.notification_tx.send(json);
        }
    }

    /// Get the notification sender for external use.
    pub fn notification_sender(&self) -> broadcast::Sender<String> {
        self.notification_tx.clone()
    }

    /// Get the actual bound port.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Gracefully stop the server.
    pub async fn stop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(()).await;
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.await;
        }
        info!("ECP transport server stopped");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Handlers
// ─────────────────────────────────────────────────────────────────────────────

async fn ws_upgrade_handler<H: RequestHandler>(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState<H>>>,
) -> impl IntoResponse {
    // Check connection limit
    if let Some(max) = state.config.max_connections {
        let current = state.client_count.load(std::sync::atomic::Ordering::Relaxed);
        if current >= max {
            warn!("Connection rejected: max connections reached ({max})");
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
    }

    ws.on_upgrade(move |socket| handle_ws_connection(socket, state))
        .into_response()
}

async fn health_handler<H: RequestHandler>(
    State(state): State<Arc<AppState<H>>>,
) -> impl IntoResponse {
    Json(json!({
        "status": "ok",
        "clients": state.client_count.load(std::sync::atomic::Ordering::Relaxed),
    }))
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Connection Handler
// ─────────────────────────────────────────────────────────────────────────────

async fn handle_ws_connection<H: RequestHandler>(
    socket: WebSocket,
    state: Arc<AppState<H>>,
) {
    state.client_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    let client_id = uuid::Uuid::new_v4().to_string();
    info!("Client connected: {client_id}");

    let (mut ws_tx, mut ws_rx) = socket.split();

    // Subscribe to broadcast notifications
    let mut notification_rx = state.notification_tx.subscribe();

    // Determine initial auth state
    let requires_auth = state.config.auth.is_some();
    let mut authenticated = !requires_auth;

    // Send auth/required or welcome
    if requires_auth {
        let auth_config = state.config.auth.as_ref().unwrap();
        let auth_required = ECPNotification::new(
            "auth/required",
            Some(serde_json::to_value(AuthRequiredParams {
                server_version: "0.1.0".into(),
                timeout: auth_config.handshake_timeout_ms,
            }).unwrap()),
        );
        if let Err(e) = ws_tx.send(Message::Text(serde_json::to_string(&auth_required).unwrap().into())).await {
            error!("Failed to send auth/required: {e}");
            state.client_count.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
            return;
        }
    } else {
        send_welcome(&mut ws_tx, &client_id, &state.config).await;
    }

    // Auth timeout — use a concrete sleep that we pin
    let timeout_ms = state.config.auth.as_ref()
        .map(|a| a.handshake_timeout_ms)
        .unwrap_or(10_000);
    let auth_deadline = if requires_auth {
        Some(tokio::time::Instant::now() + Duration::from_millis(timeout_ms))
    } else {
        None
    };

    loop {
        // Build the auth timeout future for this iteration
        let auth_sleep = async {
            match auth_deadline {
                Some(deadline) => tokio::time::sleep_until(deadline).await,
                None => std::future::pending::<()>().await,
            }
        };

        tokio::select! {
            // Incoming WebSocket message
            msg = ws_rx.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        if !authenticated {
                            // Try to handle as handshake
                            match handle_handshake(&text, &state.config, &client_id) {
                                HandshakeOutcome::Authenticated(response) => {
                                    authenticated = true;
                                    let _ = ws_tx.send(Message::Text(response.into())).await;
                                    send_welcome(&mut ws_tx, &client_id, &state.config).await;
                                    debug!("Client authenticated: {client_id}");
                                }
                                HandshakeOutcome::Rejected(response) => {
                                    let _ = ws_tx.send(Message::Text(response.into())).await;
                                    warn!("Client auth failed: {client_id}");
                                    break;
                                }
                                HandshakeOutcome::NotHandshake(response) => {
                                    let _ = ws_tx.send(Message::Text(response.into())).await;
                                }
                            }
                            continue;
                        }

                        // Parse and route authenticated message
                        let response = handle_message(&text, &state.handler).await;
                        if let Err(e) = ws_tx.send(Message::Text(response.into())).await {
                            error!("Failed to send response to {client_id}: {e}");
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(data))) => {
                        let _ = ws_tx.send(Message::Pong(data)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        debug!("Client disconnected: {client_id}");
                        break;
                    }
                    Some(Err(e)) => {
                        warn!("WebSocket error for {client_id}: {e}");
                        break;
                    }
                    _ => {}
                }
            }

            // Broadcast notifications to this client
            notification = notification_rx.recv() => {
                if authenticated {
                    if let Ok(msg) = notification {
                        if let Err(e) = ws_tx.send(Message::Text(msg.into())).await {
                            error!("Failed to broadcast to {client_id}: {e}");
                            break;
                        }
                    }
                }
            }

            // Auth timeout
            _ = auth_sleep, if !authenticated => {
                warn!("Auth timeout for client {client_id}");
                let err = ECPResponse::error(
                    None,
                    ECPError::new(
                        ecp_protocol::ECPErrorCode::Custom(AuthErrorCode::HandshakeTimeout.code()),
                        "Authentication timeout",
                    ),
                );
                let _ = ws_tx.send(Message::Text(serde_json::to_string(&err).unwrap().into())).await;
                break;
            }
        }
    }

    state.client_count.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    info!("Client disconnected: {client_id} (total: {})",
        state.client_count.load(std::sync::atomic::Ordering::Relaxed));
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async fn send_welcome(
    ws_tx: &mut SplitSink<WebSocket, Message>,
    client_id: &str,
    config: &TransportConfig,
) {
    let welcome = ECPNotification::new(
        "server/connected",
        Some(json!({
            "clientId": client_id,
            "serverVersion": "0.1.0",
            "workspaceRoot": config.workspace_root,
        })),
    );
    let _ = ws_tx.send(Message::Text(serde_json::to_string(&welcome).unwrap().into())).await;
}

enum HandshakeOutcome {
    Authenticated(String),
    Rejected(String),
    NotHandshake(String),
}

fn handle_handshake(
    text: &str,
    config: &TransportConfig,
    client_id: &str,
) -> HandshakeOutcome {
    let parsed: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => {
            let err = ECPResponse::error(None, ECPError::parse_error("Invalid JSON"));
            return HandshakeOutcome::NotHandshake(serde_json::to_string(&err).unwrap());
        }
    };

    // Check if this is a handshake request
    let method = parsed.get("method").and_then(|m| m.as_str());
    if method != Some("auth/handshake") {
        let id = parsed.get("id").cloned().and_then(|v| serde_json::from_value(v).ok());
        let err = ECPResponse::error(
            id,
            ECPError::new(
                ecp_protocol::ECPErrorCode::Custom(AuthErrorCode::NotAuthenticated.code()),
                "Not authenticated. Send auth/handshake first.",
            ),
        );
        return HandshakeOutcome::NotHandshake(serde_json::to_string(&err).unwrap());
    }

    let id: Option<RequestId> = parsed.get("id").cloned().and_then(|v| serde_json::from_value(v).ok());

    // Extract and validate token
    let params: Option<HandshakeParams> = parsed.get("params")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok());

    let auth_config = match &config.auth {
        Some(c) => c,
        None => {
            // No auth configured — accept anything
            let result = HandshakeResult {
                client_id: client_id.to_string(),
                session_id: uuid::Uuid::new_v4().to_string(),
                server_version: "0.1.0".into(),
                workspace_root: config.workspace_root.clone(),
            };
            let resp = ECPResponse::success(
                id.unwrap_or(RequestId::Number(0)),
                serde_json::to_value(result).unwrap(),
            );
            return HandshakeOutcome::Authenticated(serde_json::to_string(&resp).unwrap());
        }
    };

    match params {
        Some(p) if p.token == auth_config.token => {
            let result = HandshakeResult {
                client_id: client_id.to_string(),
                session_id: uuid::Uuid::new_v4().to_string(),
                server_version: "0.1.0".into(),
                workspace_root: config.workspace_root.clone(),
            };
            let resp = ECPResponse::success(
                id.unwrap_or(RequestId::Number(0)),
                serde_json::to_value(result).unwrap(),
            );
            HandshakeOutcome::Authenticated(serde_json::to_string(&resp).unwrap())
        }
        _ => {
            let err = ECPResponse::error(
                id,
                ECPError::new(
                    ecp_protocol::ECPErrorCode::Custom(AuthErrorCode::InvalidToken.code()),
                    "Invalid authentication token",
                ),
            );
            HandshakeOutcome::Rejected(serde_json::to_string(&err).unwrap())
        }
    }
}

async fn handle_message<H: RequestHandler>(
    text: &str,
    handler: &Arc<H>,
) -> String {
    let parsed: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => {
            let err = ECPResponse::error(None, ECPError::parse_error("Failed to parse JSON"));
            return serde_json::to_string(&err).unwrap();
        }
    };

    // Validate JSON-RPC shape
    let jsonrpc = parsed.get("jsonrpc").and_then(|v| v.as_str());
    let method = parsed.get("method").and_then(|v| v.as_str());
    let id: Option<RequestId> = parsed.get("id").cloned().and_then(|v| serde_json::from_value(v).ok());

    if jsonrpc != Some("2.0") || method.is_none() {
        let err = ECPResponse::error(id, ECPError::invalid_request("Invalid JSON-RPC 2.0 request"));
        return serde_json::to_string(&err).unwrap();
    }

    let method = method.unwrap();
    let params = parsed.get("params").cloned();

    // Route to handler
    match handler.handle_request(method, params).await {
        Ok(result) => {
            let resp = ECPResponse::success(
                id.unwrap_or(RequestId::Number(0)),
                result,
            );
            serde_json::to_string(&resp).unwrap()
        }
        Err(ecp_err) => {
            let resp = ECPResponse::error(id, ecp_err);
            serde_json::to_string(&resp).unwrap()
        }
    }
}
