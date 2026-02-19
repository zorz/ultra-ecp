//! ECP Server — routes JSON-RPC requests to service adapters.
//!
//! The server owns all services, manages the middleware chain,
//! and provides the `RequestHandler` implementation for the transport layer.

pub mod router;
pub mod middleware;
pub mod workspace;

pub use router::ECPServer;
pub use workspace::WorkspaceContext;
