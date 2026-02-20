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
    fn priority(&self) -> u32;
    fn is_writable(&self) -> bool;
    fn get(&self, key: &str) -> Option<String>;
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
    fn delete(&self, key: &str) -> Result<bool, String>;
    fn list(&self) -> Vec<String>;
}

/// Environment variable provider (read-only).
struct EnvProvider;

impl SecretProvider for EnvProvider {
    fn id(&self) -> &str { "env" }
    fn name(&self) -> &str { "Environment Variables" }
    fn priority(&self) -> u32 { 20 }
    fn is_writable(&self) -> bool { false }
    fn get(&self, key: &str) -> Option<String> {
        // Map common secret keys to env vars
        let env_key = match key {
            "anthropic-api-key" => "ANTHROPIC_API_KEY",
            "openai-api-key" => "OPENAI_API_KEY",
            "gemini-api-key" => "GEMINI_API_KEY",
            _ => {
                // Try direct env var name (uppercase, dashes/dots to underscores)
                let upper = key.replace('-', "_").replace('.', "_").to_uppercase();
                return std::env::var(&upper).ok();
            }
        };
        std::env::var(env_key).ok()
    }
    fn set(&self, _key: &str, _value: &str) -> Result<(), String> {
        Err("Environment provider is read-only".into())
    }
    fn delete(&self, _key: &str) -> Result<bool, String> {
        Err("Environment provider is read-only".into())
    }
    fn list(&self) -> Vec<String> {
        let mut keys = Vec::new();
        for key in &["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"] {
            if std::env::var(key).is_ok() {
                keys.push(key.to_string());
            }
        }
        keys
    }
}

/// File-based provider — stores secrets in a JSON file at ~/.ultra/secrets.json.
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
    fn name(&self) -> &str { "File" }
    fn priority(&self) -> u32 { 30 }
    fn is_writable(&self) -> bool { true }
    fn get(&self, key: &str) -> Option<String> {
        self.cache.read().get(key).cloned()
    }
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.cache.write().insert(key.to_string(), value.to_string());
        self.save();
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<bool, String> {
        let removed = self.cache.write().remove(key).is_some();
        if removed { self.save(); }
        Ok(removed)
    }
    fn list(&self) -> Vec<String> {
        let mut keys: Vec<String> = self.cache.read().keys().cloned().collect();
        keys.sort();
        keys
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

    /// Create with a custom file provider path (for testing).
    pub fn new_with_file_path(secrets_path: PathBuf) -> Self {
        Self {
            providers: vec![
                Box::new(EnvProvider),
                Box::new(FileProvider {
                    path: secrets_path,
                    cache: RwLock::new(HashMap::new()),
                }),
            ],
        }
    }
}

impl Service for SecretService {
    fn namespace(&self) -> &str {
        "secret"
    }

    fn scope(&self) -> crate::ServiceScope {
        crate::ServiceScope::Global
    }

    async fn handle(&self, method: &str, params: Option<Value>) -> HandlerResult {
        match method {
            // TS wire format: { value: string | null }
            "secret/get" => {
                let p: SecretKeyParam = parse_params(params)?;
                for provider in &self.providers {
                    if let Some(value) = provider.get(&p.key) {
                        return Ok(json!({ "value": value }));
                    }
                }
                Ok(json!({ "value": null }))
            }

            // TS wire format: { success: boolean }
            "secret/set" => {
                let p: SecretSetParam = parse_params(params)?;
                for provider in &self.providers {
                    if provider.is_writable() {
                        provider.set(&p.key, &p.value)
                            .map_err(|e| ECPError::server_error(e))?;
                        return Ok(json!({ "success": true }));
                    }
                }
                Err(ECPError::server_error("No writable secret provider available"))
            }

            // TS wire format: { deleted: boolean }
            "secret/delete" => {
                let p: SecretKeyParam = parse_params(params)?;
                let mut deleted = false;
                for provider in &self.providers {
                    if provider.is_writable() {
                        if let Ok(true) = provider.delete(&p.key) {
                            deleted = true;
                        }
                    }
                }
                Ok(json!({ "deleted": deleted }))
            }

            // TS wire format: { keys: string[] }
            "secret/list" => {
                let mut all_keys = Vec::new();
                for provider in &self.providers {
                    for key in provider.list() {
                        if !all_keys.contains(&key) {
                            all_keys.push(key);
                        }
                    }
                }
                all_keys.sort();
                Ok(json!({ "keys": all_keys }))
            }

            // TS wire format: { exists: boolean }
            "secret/has" => {
                let p: SecretKeyParam = parse_params(params)?;
                let exists = self.providers.iter().any(|prov| prov.get(&p.key).is_some());
                Ok(json!({ "exists": exists }))
            }

            // TS wire format: { info: { key, provider, ... } | null }
            "secret/info" => {
                let p: SecretKeyParam = parse_params(params)?;
                for provider in &self.providers {
                    if provider.get(&p.key).is_some() {
                        return Ok(json!({
                            "info": {
                                "key": p.key,
                                "provider": provider.id(),
                            }
                        }));
                    }
                }
                Ok(json!({ "info": null }))
            }

            // TS wire format: { providers: [{ id, name, priority, isReadOnly }] }
            "secret/providers" => {
                let providers: Vec<Value> = self.providers.iter().map(|p| {
                    json!({
                        "id": p.id(),
                        "name": p.name(),
                        "priority": p.priority(),
                        "isReadOnly": !p.is_writable(),
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
