//! ECP (Editor Command Protocol) - Protocol Types
//!
//! JSON-RPC 2.0 compatible types for the Editor Command Protocol.
//! This crate is the single source of truth for all protocol types,
//! method names, notification names, and error codes.

pub mod error;
pub mod jsonrpc;
pub mod methods;
pub mod notifications;
pub mod auth;

pub use error::{ECPError, ECPErrorCode};
pub use jsonrpc::{
    ECPRequest, ECPResponse, ECPSuccessResponse, ECPErrorResponse,
    ECPNotification, ECPCaller, HandlerResult,
};
pub use methods::{Methods, MethodName};
pub use notifications::{Notifications, NotificationName};
pub use auth::{
    AuthState, AuthConfig, AuthErrorCode,
    HandshakeParams, HandshakeResult, AuthRequiredParams,
};
