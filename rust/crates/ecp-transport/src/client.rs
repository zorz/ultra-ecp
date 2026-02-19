//! Client connection state tracking.

use ecp_protocol::auth::{AuthState, HandshakeClientInfo};
use std::time::Instant;

/// Represents a connected client with its authentication state.
#[derive(Debug)]
pub struct ClientConnection {
    /// Unique client ID
    pub id: String,
    /// When the client connected
    pub connected_at: Instant,
    /// Authentication state
    pub auth_state: AuthState,
    /// Session ID (set after successful handshake)
    pub session_id: Option<String>,
    /// Client info (set after successful handshake)
    pub client_info: Option<HandshakeClientInfo>,
    /// Last time we received any message from this client
    pub last_activity: Instant,
}

impl ClientConnection {
    pub fn new(id: String) -> Self {
        let now = Instant::now();
        Self {
            id,
            connected_at: now,
            auth_state: AuthState::Pending,
            session_id: None,
            client_info: None,
            last_activity: now,
        }
    }

    pub fn new_authenticated(id: String, session_id: String) -> Self {
        let mut conn = Self::new(id);
        conn.auth_state = AuthState::Authenticated;
        conn.session_id = Some(session_id);
        conn
    }

    pub fn is_authenticated(&self) -> bool {
        self.auth_state == AuthState::Authenticated
    }

    pub fn touch(&mut self) {
        self.last_activity = Instant::now();
    }
}
