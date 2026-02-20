//! Request context — per-connection state threaded through request handling.
//!
//! Each WebSocket connection maintains its own [`RequestContext`] in the
//! transport layer. After `auth/handshake`, the `client_id` is set. After
//! `workspace/open`, `workspace_id` is set. The context is passed to
//! [`RequestHandler::handle_request`] for every request, enabling the router
//! to scope workspace-level services to the correct workspace.

/// Context for a single request, carrying connection-level state.
///
/// Built per-message in the transport layer from the connection's local state.
/// The router uses `workspace_id` to resolve workspace-scoped services, and
/// `client_id` for connection tracking and disconnect cleanup.
#[derive(Debug, Clone, Default)]
pub struct RequestContext {
    /// Unique identifier for the client connection.
    pub client_id: String,
    /// Workspace this connection is scoped to (set after `workspace/open`).
    /// `None` until the client opens a workspace (or a default is configured).
    pub workspace_id: Option<String>,
}
