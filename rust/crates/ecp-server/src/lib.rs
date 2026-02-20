//! ECP Server — routes JSON-RPC requests to service adapters.
//!
//! The server owns global services and a [`WorkspaceRegistry`] that manages
//! per-workspace service instances with ref-counting. A single server process
//! can serve multiple workspaces concurrently, with each WebSocket connection
//! scoped to at most one workspace at a time via `workspace/open`.
//!
//! The [`ECPServer`] implements the transport layer's `RequestHandler` trait,
//! threading [`RequestContext`](ecp_protocol::RequestContext) through the
//! middleware chain and routing logic.

pub mod router;
pub mod middleware;
pub mod workspace;
pub mod registry;

pub use router::ECPServer;
pub use workspace::WorkspaceContext;
pub use registry::WorkspaceRegistry;
