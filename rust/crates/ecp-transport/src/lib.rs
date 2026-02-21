//! ECP Transport Layer
//!
//! Provides WebSocket and Unix socket transport for the ECP server.
//! The transport layer handles:
//! - Connection lifecycle (open, message, close)
//! - Authentication handshake
//! - Heartbeat / stale connection detection
//! - Notification broadcasting to authenticated clients
//!
//! The transport is decoupled from the server logic via the `RequestHandler` trait.

pub mod client;
pub mod server;

pub use client::ClientConnection;
pub use server::{TransportServer, TransportConfig, TlsConfig, RequestHandler};
