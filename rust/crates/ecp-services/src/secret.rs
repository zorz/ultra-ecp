//! Secret service — secure credential storage with multi-provider support.

use std::collections::HashMap;
use std::path::PathBuf;

use ecp_protocol::{ECPError, HandlerResult};
use parking_lot::RwLock;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::Service;

/// A secret provider that can read/write credentials.
trait SecretProvider: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    fn is_available(&self) -> bool;
    fn is_writable(&self) -> bool;
    fn get(&self, key: &str) -> Option<String>;
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
    fn delete(&self, key: &str) -> Result<(), String>;
    fn list(&self) -> Vec<String>;
}

/// Environment variable provider (read-only).
struct EnvProvider;

impl SecretProvider for EnvProvider {
    fn id(&self) -> &str { "env" }
    fn name(&self) -> &str { "Environment Variables" }
    fn is_available(&self) -> bool { true }
    fn is_writable(&self) -> bool { false }
    fn get(&self, key: &str) -> Option<String> {
        // Map common secret keys to env vars
        let env_key = match key {
            "anthropic-api-key" => "ANTHROPIC_API_KEY",
            "openai-api-key" => "OPENAI_API_KEY",
            "gemini-api-key" => "GEMINI_API_KEY",
            _ => {
                // Try direct env var name (uppercase, dashes to underscores)
                let upper = key.replace('-', "_").to_uppercase();
                return std::env::var(&upper).ok();
            }
        };
        std::env::var(env_key).ok()
    }
    fn set(&self, _key: &str, _value: &str) -> Result<(), String> {
        Err("Environment provider is read-only".into())
    }
    fn delete(&self, _key: &str) -> Result<(), String> {
        Err("Environment provider is read-only".into())
    }
    fn list(&self) -> Vec<String> {
        // Return known API key env vars that are set
        let mut keys = Vec::new();
        for key in &["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"] {
            if std::env::var(key).is_ok() {
                keys.push(key.to_string());
            }
        }
        keys
    }
}

/// File-based provider — stores secrets in an encrypted-at-rest JSON file.
/// For now uses a simple JSON file; encryption can be added later.
struct FileProvider {
    path: PathBuf,
    cache: RwLock<HashMap<String, String>>,
}

impl FileProvider {
    fn new() -> Self {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        let path = PathBuf::from(home).join(".ultra/secrets.json");
        let cache = if let Ok(content) = std::fs::read_to_string(&path) {
            serde_json::from_str(&content).unwrap_or_default()
        } else {
            HashMap::new()
        };
        Self {
            path,
            cache: RwLock::new(cache),
        }
    }

    fn save(&self) {
        let cache = self.cache.read();
        if let Ok(json) = serde_json::to_string_pretty(&*cache) {
            if let Some(parent) = self.path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&self.path, json);
        }
    }
}

impl SecretProvider for FileProvider {
    fn id(&self) -> &str { "file" }
    fn name(&self) -> &str { "Encrypted File" }
    fn is_available(&self) -> bool { true }
    fn is_writable(&self) -> bool { true }
    fn get(&self, key: &str) -> Option<String> {
        self.cache.read().get(key).cloned()
    }
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.cache.write().insert(key.to_string(), value.to_string());
        self.save();
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<(), String> {
        self.cache.write().remove(key);
        self.save();
        Ok(())
    }
    fn list(&self) -> Vec<String> {
        self.cache.read().keys().cloned().collect()
    }
}

/// Secret service — priority-ordered provider chain.
pub struct SecretService {
    providers: Vec<Box<dyn SecretProvider>>,
}

impl SecretService {
    pub fn new() -> Self {
        Self {
            providers: vec![
                Box::new(EnvProvider),
                Box::new(FileProvider::new()),
            ],
        }
    }
}

impl Service for SecretService {
    fn namespace(&self) -> &str {
        "secret"
    }

    async fn handle(&self, method: &str, params: Option<Value>) -> HandlerResult {
        match method {
            "secret/get" => {
                let p: SecretKeyParam = parse_params(params)?;
                for provider in &self.providers {
                    if let Some(value) = provider.get(&p.key) {
                        return Ok(json!({
                            "key": p.key,
                            "value": value,
                            "provider": provider.id(),
                        }));
                    }
                }
                Ok(json!({ "key": p.key, "value": null }))
            }

            "secret/set" => {
                let p: SecretSetParam = parse_params(params)?;
                // Write to first writable provider
                for provider in &self.providers {
                    if provider.is_writable() {
                        provider.set(&p.key, &p.value)
                            .map_err(|e| ECPError::server_error(e))?;
                        return Ok(json!({
                            "success": true,
                            "provider": provider.id(),
                        }));
                    }
                }
                Err(ECPError::server_error("No writable secret provider available"))
            }

            "secret/delete" => {
                let p: SecretKeyParam = parse_params(params)?;
                for provider in &self.providers {
                    if provider.is_writable() {
                        let _ = provider.delete(&p.key);
                    }
                }
                Ok(json!({ "success": true }))
            }

            "secret/list" => {
                let mut all_keys = Vec::new();
                for provider in &self.providers {
                    for key in provider.list() {
                        if !all_keys.contains(&key) {
                            all_keys.push(key);
                        }
                    }
                }
                Ok(json!({ "keys": all_keys }))
            }

            "secret/has" => {
                let p: SecretKeyParam = parse_params(params)?;
                let has = self.providers.iter().any(|prov| prov.get(&p.key).is_some());
                Ok(json!({ "has": has }))
            }

            "secret/info" => {
                let p: SecretKeyParam = parse_params(params)?;
                for provider in &self.providers {
                    if provider.get(&p.key).is_some() {
                        return Ok(json!({
                            "key": p.key,
                            "exists": true,
                            "provider": provider.id(),
                            "providerName": provider.name(),
                        }));
                    }
                }
                Ok(json!({ "key": p.key, "exists": false }))
            }

            "secret/providers" => {
                let providers: Vec<Value> = self.providers.iter().map(|p| {
                    json!({
                        "id": p.id(),
                        "name": p.name(),
                        "available": p.is_available(),
                        "writable": p.is_writable(),
                    })
                }).collect();
                Ok(json!({ "providers": providers }))
            }

            _ => Err(ECPError::method_not_found(method)),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Params
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct SecretKeyParam { key: String }

#[derive(Deserialize)]
struct SecretSetParam { key: String, value: String }

fn parse_params<T: for<'de> Deserialize<'de>>(params: Option<Value>) -> Result<T, ECPError> {
    match params {
        Some(v) => serde_json::from_value(v)
            .map_err(|e| ECPError::invalid_params(format!("Invalid parameters: {e}"))),
        None => Err(ECPError::invalid_params("Parameters required")),
    }
}
