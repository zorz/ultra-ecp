//! Models service — model listing and refresh.
//!
//! When the AI bridge is available, delegates to the TypeScript model registry
//! which dynamically adds agent-sdk models. Falls back to reading
//! ~/.ultra/models.json directly when the bridge is not running.

use std::path::PathBuf;
use std::sync::Arc;

use ecp_ai_bridge::AIBridge;
use ecp_protocol::{ECPError, HandlerResult};
use serde_json::{json, Value};
use tracing::info;

use crate::Service;

/// Models service — handles `models/list` and `models/refresh`.
pub struct ModelsService {
    bridge: Option<Arc<AIBridge>>,
}

impl ModelsService {
    pub fn new(bridge: Option<Arc<AIBridge>>) -> Self {
        Self { bridge }
    }

    /// Read models config from ~/.ultra/models.json with a minimal fallback.
    async fn read_models_file() -> Value {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        let models_path = PathBuf::from(&home).join(".ultra/models.json");

        match tokio::fs::read_to_string(&models_path).await {
            Ok(content) => {
                serde_json::from_str(&content).unwrap_or_else(|_| Self::fallback_config())
            }
            Err(_) => Self::fallback_config(),
        }
    }

    fn fallback_config() -> Value {
        json!({
            "version": 1,
            "lastUpdated": "2025-01-15T00:00:00.000Z",
            "defaults": {
                "fast": "claude-haiku-4-5-20251001",
                "smart": "claude-opus-4-5-20251101",
                "code": "claude-sonnet-4-5-20250929",
                "balanced": "claude-sonnet-4-5-20250929",
                "cheap": "gemini-2.0-flash-lite",
                "vision": "gpt-4o"
            },
            "providerDefaults": {
                "anthropic": "claude-opus-4-5-20251101",
                "openai": "gpt-4o",
                "google": "gemini-2.0-flash",
                "ollama": "",
                "custom": ""
            },
            "models": []
        })
    }
}

impl Service for ModelsService {
    fn namespace(&self) -> &str {
        "models"
    }

    fn scope(&self) -> crate::ServiceScope {
        crate::ServiceScope::Global
    }

    async fn handle(&self, method: &str, params: Option<Value>) -> HandlerResult {
        match method {
            "models/list" => {
                // Prefer bridge (adds agent-sdk models dynamically)
                if let Some(ref bridge) = self.bridge {
                    if bridge.is_running() {
                        return bridge.request("models/list", params).await;
                    }
                }
                // Fallback: read directly from file
                let config = Self::read_models_file().await;
                Ok(config)
            }

            "models/refresh" => {
                if let Some(ref bridge) = self.bridge {
                    if bridge.is_running() {
                        let result = bridge.request("models/refresh", params).await?;
                        info!("Models refreshed via bridge");
                        return Ok(result);
                    }
                }
                Err(ECPError::server_error(
                    "models/refresh requires the AI bridge subprocess".to_string(),
                ))
            }

            _ => Err(ECPError::method_not_found(method)),
        }
    }
}
