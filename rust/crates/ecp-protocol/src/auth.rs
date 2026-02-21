//! ECP authentication types for the WebSocket handshake protocol.
//!
//! Protocol flow:
//!   1. Client connects to ws://host:port/ws
//!   2. Server sends: { method: "auth/required", params: { serverVersion, timeout } }
//!   3. Client sends: { method: "auth/handshake", id: "...", params: { token, client } }
//!   4. Server validates token and responds
//!   5. Normal JSON-RPC traffic begins

use serde::{Deserialize, Serialize};

// ─────────────────────────────────────────────────────────────────────────────
// Client → Server
// ─────────────────────────────────────────────────────────────────────────────

/// Client information sent during handshake.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandshakeClientInfo {
    /// Client type identifier (e.g., "ultra-mac", "ultra-ios", "headless-cli")
    pub name: String,
    /// Client version
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// Parameters for the auth/handshake request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandshakeParams {
    /// The authentication token (shared secret)
    pub token: String,
    /// Optional client information
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<HandshakeClientInfo>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Server → Client
// ─────────────────────────────────────────────────────────────────────────────

/// Parameters for the auth/required notification (sent on connect).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthRequiredParams {
    /// Server version
    #[serde(rename = "serverVersion")]
    pub server_version: String,
    /// Milliseconds until unauthenticated connection is closed
    pub timeout: u64,
}

/// Successful handshake response result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandshakeResult {
    /// Unique client ID for this connection
    #[serde(rename = "clientId")]
    pub client_id: String,
    /// Session identifier (survives reconnection within expiry)
    #[serde(rename = "sessionId")]
    pub session_id: String,
    /// Server version
    #[serde(rename = "serverVersion")]
    pub server_version: String,
    /// Workspace root path
    #[serde(rename = "workspaceRoot", skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<String>,
    /// SHA-256 fingerprint of the TLS certificate ("sha256:<hex>")
    #[serde(rename = "certFingerprint", skip_serializing_if = "Option::is_none")]
    pub cert_fingerprint: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection State
// ─────────────────────────────────────────────────────────────────────────────

/// Authentication state for a client connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthState {
    Pending,
    Authenticated,
    Rejected,
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/// Authentication configuration for the server.
#[derive(Debug, Clone)]
pub struct AuthConfig {
    /// Static auth token (shared secret)
    pub token: String,
    /// Timeout for completing auth handshake in ms (default: 10000)
    pub handshake_timeout_ms: u64,
    /// Allow legacy query-param auth (?token=...)
    pub allow_legacy_auth: bool,
    /// Heartbeat interval in ms (default: 30000). 0 to disable.
    pub heartbeat_interval_ms: u64,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            token: String::new(),
            handshake_timeout_ms: 10_000,
            allow_legacy_auth: true,
            heartbeat_interval_ms: 30_000,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Codes
// ─────────────────────────────────────────────────────────────────────────────

/// Authentication-specific error codes (-32010 to -32019).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthErrorCode {
    /// Client is not authenticated
    NotAuthenticated,
    /// Invalid or missing auth token
    InvalidToken,
    /// Auth handshake timed out
    HandshakeTimeout,
    /// Connection rejected
    ConnectionRejected,
}

impl AuthErrorCode {
    pub fn code(&self) -> i32 {
        match self {
            Self::NotAuthenticated => -32010,
            Self::InvalidToken => -32011,
            Self::HandshakeTimeout => -32012,
            Self::ConnectionRejected => -32013,
        }
    }
}
