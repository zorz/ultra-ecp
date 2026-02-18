//! ECP error types and standard JSON-RPC 2.0 error codes.

use serde::{Deserialize, Serialize};

/// Standard JSON-RPC 2.0 error codes plus ECP server errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ECPErrorCode {
    // JSON-RPC 2.0 standard errors
    ParseError,
    InvalidRequest,
    MethodNotFound,
    InvalidParams,
    InternalError,

    // Server errors
    ServerError,
    ServerNotInitialized,
    ServerShuttingDown,

    // Custom code
    Custom(i32),
}

impl ECPErrorCode {
    pub fn code(&self) -> i32 {
        match self {
            Self::ParseError => -32700,
            Self::InvalidRequest => -32600,
            Self::MethodNotFound => -32601,
            Self::InvalidParams => -32602,
            Self::InternalError => -32603,
            Self::ServerError => -32000,
            Self::ServerNotInitialized => -32001,
            Self::ServerShuttingDown => -32002,
            Self::Custom(c) => *c,
        }
    }

    pub fn from_code(code: i32) -> Self {
        match code {
            -32700 => Self::ParseError,
            -32600 => Self::InvalidRequest,
            -32601 => Self::MethodNotFound,
            -32602 => Self::InvalidParams,
            -32603 => Self::InternalError,
            -32000 => Self::ServerError,
            -32001 => Self::ServerNotInitialized,
            -32002 => Self::ServerShuttingDown,
            c => Self::Custom(c),
        }
    }
}

/// JSON-RPC 2.0 error object.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ECPError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl ECPError {
    pub fn new(code: ECPErrorCode, message: impl Into<String>) -> Self {
        Self {
            code: code.code(),
            message: message.into(),
            data: None,
        }
    }

    pub fn with_data(mut self, data: serde_json::Value) -> Self {
        self.data = Some(data);
        self
    }

    pub fn parse_error(message: impl Into<String>) -> Self {
        Self::new(ECPErrorCode::ParseError, message)
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(ECPErrorCode::InvalidRequest, message)
    }

    pub fn method_not_found(method: &str) -> Self {
        Self::new(ECPErrorCode::MethodNotFound, format!("Method not found: {method}"))
    }

    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self::new(ECPErrorCode::InvalidParams, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ECPErrorCode::InternalError, message)
    }

    pub fn server_error(message: impl Into<String>) -> Self {
        Self::new(ECPErrorCode::ServerError, message)
    }

    pub fn not_initialized() -> Self {
        Self::new(ECPErrorCode::ServerNotInitialized, "Server is not initialized")
    }

    pub fn shutting_down() -> Self {
        Self::new(ECPErrorCode::ServerShuttingDown, "Server is shutting down")
    }

    pub fn error_code(&self) -> ECPErrorCode {
        ECPErrorCode::from_code(self.code)
    }
}

impl std::fmt::Display for ECPError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ECP Error [{}]: {}", self.code, self.message)
    }
}

impl std::error::Error for ECPError {}
