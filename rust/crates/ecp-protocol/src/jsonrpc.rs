//! JSON-RPC 2.0 base types for ECP.

use serde::{Deserialize, Serialize};

use crate::error::ECPError;

/// JSON-RPC 2.0 request ID — either a string or integer.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    String(String),
    Number(i64),
}

/// Caller identity — either a human user or an AI agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ECPCaller {
    #[serde(rename = "human")]
    Human,
    #[serde(rename = "agent")]
    Agent {
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(rename = "executionId", skip_serializing_if = "Option::is_none")]
        execution_id: Option<String>,
    },
}

/// JSON-RPC 2.0 request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ECPRequest {
    pub jsonrpc: String,
    pub id: RequestId,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

/// JSON-RPC 2.0 success response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ECPSuccessResponse {
    pub jsonrpc: String,
    pub id: RequestId,
    pub result: serde_json::Value,
}

/// JSON-RPC 2.0 error response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ECPErrorResponse {
    pub jsonrpc: String,
    pub id: Option<RequestId>,
    pub error: ECPError,
}

/// JSON-RPC 2.0 response (success or error).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ECPResponse {
    Success(ECPSuccessResponse),
    Error(ECPErrorResponse),
}

/// JSON-RPC 2.0 notification (no id, no response expected).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ECPNotification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

/// Result from a service adapter handler.
pub type HandlerResult = Result<serde_json::Value, ECPError>;

// ─────────────────────────────────────────────────────────────────────────────
// Helper constructors
// ─────────────────────────────────────────────────────────────────────────────

impl ECPRequest {
    /// Validate that this is a well-formed JSON-RPC 2.0 request.
    pub fn is_valid(&self) -> bool {
        self.jsonrpc == "2.0" && !self.method.is_empty()
    }
}

impl ECPSuccessResponse {
    pub fn new(id: RequestId, result: serde_json::Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            result,
        }
    }
}

impl ECPErrorResponse {
    pub fn new(id: Option<RequestId>, error: ECPError) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            error,
        }
    }
}

impl ECPNotification {
    pub fn new(method: impl Into<String>, params: Option<serde_json::Value>) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            method: method.into(),
            params,
        }
    }
}

impl ECPResponse {
    pub fn success(id: RequestId, result: serde_json::Value) -> Self {
        Self::Success(ECPSuccessResponse::new(id, result))
    }

    pub fn error(id: Option<RequestId>, error: ECPError) -> Self {
        Self::Error(ECPErrorResponse::new(id, error))
    }

    pub fn is_error(&self) -> bool {
        matches!(self, Self::Error(_))
    }

    pub fn is_success(&self) -> bool {
        matches!(self, Self::Success(_))
    }
}
