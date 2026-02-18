//! ECP Service Implementations
//!
//! Each service implements the `Service` trait and handles a namespace of
//! JSON-RPC methods. Services are registered with the ECP server router
//! which dispatches requests by method prefix.

pub mod file;
pub mod git;
pub mod terminal;

use ecp_protocol::HandlerResult;

/// Trait implemented by all ECP services.
///
/// Each service handles a namespace of methods (e.g., "file/*", "git/*").
/// The router strips the namespace prefix before calling `handle`.
pub trait Service: Send + Sync {
    /// The namespace prefix this service handles (e.g., "file", "git").
    fn namespace(&self) -> &str;

    /// Handle a JSON-RPC request within this service's namespace.
    ///
    /// `method` is the full method string (e.g., "file/read").
    /// `params` is the optional JSON parameters.
    fn handle(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> impl std::future::Future<Output = HandlerResult> + Send;

    /// Initialize the service (called once at startup).
    fn init(&self) -> impl std::future::Future<Output = Result<(), Box<dyn std::error::Error + Send + Sync>>> + Send {
        async { Ok(()) }
    }

    /// Shutdown the service (called once at server shutdown).
    fn shutdown(&self) -> impl std::future::Future<Output = ()> + Send {
        async {}
    }
}
