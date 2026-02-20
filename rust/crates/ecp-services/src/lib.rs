//! ECP Service Implementations
//!
//! Each service implements the [`Service`] trait and handles a namespace of
//! JSON-RPC methods. Services declare a [`ServiceScope`] — either `Global`
//! (shared across all workspaces) or `Workspace` (instantiated per workspace
//! by the [`WorkspaceRegistry`](ecp_server::WorkspaceRegistry)).
//!
//! Global services: [`SecretService`](secret::SecretService),
//! [`ModelsService`](models::ModelsService),
//! [`DocumentService`](document::DocumentService), and all bridge-delegated
//! services (AI, Auth, Agent, Workflow, Syntax).
//!
//! Workspace services: File, Git, Watch, Terminal, Session, Chat, Database, LSP.

pub mod bridge_services;
pub mod chat;
pub mod database;
pub mod document;
pub mod file;
pub mod git;
pub mod lsp;
pub mod models;
pub mod secret;
pub mod session;
pub mod terminal;
pub mod watch;

use ecp_protocol::HandlerResult;

/// Whether a service is global (shared across workspaces) or per-workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceScope {
    /// Shared across all workspaces (e.g., secrets, models, bridge-delegated).
    Global,
    /// Instantiated per workspace (e.g., file, git, terminal, chat).
    Workspace,
}

/// Trait implemented by all ECP services.
///
/// Each service handles a namespace of methods (e.g., "file/*", "git/*").
/// The router strips the namespace prefix before calling `handle`.
pub trait Service: Send + Sync {
    /// The namespace prefix this service handles (e.g., "file", "git").
    fn namespace(&self) -> &str;

    /// Whether this service is global or per-workspace.
    fn scope(&self) -> ServiceScope {
        ServiceScope::Workspace
    }

    /// Whether this service delegates to the AI bridge subprocess.
    fn is_bridge_delegated(&self) -> bool {
        false
    }

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
