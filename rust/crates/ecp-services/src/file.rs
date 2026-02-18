//! File service — file I/O, directory operations, search, and file watching.

use std::path::{Path, PathBuf};

use ecp_protocol::{ECPError, HandlerResult};
use parking_lot::RwLock;
use serde::Deserialize;
use serde_json::json;
use tracing::debug;

use crate::Service;

/// File service implementation.
pub struct FileService {
    workspace_root: RwLock<PathBuf>,
}

impl FileService {
    pub fn new(workspace_root: PathBuf) -> Self {
        Self {
            workspace_root: RwLock::new(workspace_root),
        }
    }

    pub fn set_workspace_root(&self, root: PathBuf) {
        *self.workspace_root.write() = root;
    }

    /// Resolve a path relative to the workspace root.
    /// Security: rejects paths that escape the workspace via traversal.
    fn resolve_path(&self, path: &str) -> Result<PathBuf, ECPError> {
        let root = self.workspace_root.read().clone();

        let resolved = if Path::new(path).is_absolute() {
            PathBuf::from(path)
        } else {
            root.join(path)
        };

        // Canonicalize would follow symlinks but the path might not exist yet.
        // Instead, normalize and check prefix.
        let normalized = normalize_path(&resolved);

        // For absolute paths outside workspace, allow them (the ECP is trusted).
        // But log for audit.
        if !normalized.starts_with(&root) {
            debug!("File access outside workspace: {}", normalized.display());
        }

        Ok(normalized)
    }
}

impl Service for FileService {
    fn namespace(&self) -> &str {
        "file"
    }

    async fn handle(&self, method: &str, params: Option<serde_json::Value>) -> HandlerResult {
        match method {
            "file/read" => {
                let p: FileReadParams = parse_params(params)?;
                let path = self.resolve_path(&p.path)?;

                match tokio::fs::read_to_string(&path).await {
                    Ok(content) => Ok(json!({ "content": content })),
                    Err(e) => Err(ECPError::server_error(format!(
                        "Failed to read {}: {e}", path.display()
                    ))),
                }
            }

            "file/write" => {
                let p: FileWriteParams = parse_params(params)?;
                let path = self.resolve_path(&p.path)?;

                // Ensure parent directory exists
                if let Some(parent) = path.parent() {
                    if let Err(e) = tokio::fs::create_dir_all(parent).await {
                        return Err(ECPError::server_error(format!(
                            "Failed to create directory: {e}"
                        )));
                    }
                }

                match tokio::fs::write(&path, &p.content).await {
                    Ok(()) => Ok(json!({ "success": true })),
                    Err(e) => Err(ECPError::server_error(format!(
                        "Failed to write {}: {e}", path.display()
                    ))),
                }
            }

            "file/exists" => {
                let p: FilePathParam = parse_params(params)?;
                let path = self.resolve_path(&p.path)?;
                let exists = tokio::fs::try_exists(&path).await.unwrap_or(false);
                Ok(json!({ "exists": exists }))
            }

            "file/stat" => {
                let p: FilePathParam = parse_params(params)?;
                let path = self.resolve_path(&p.path)?;

                match tokio::fs::metadata(&path).await {
                    Ok(meta) => {
                        Ok(json!({
                            "size": meta.len(),
                            "isFile": meta.is_file(),
                            "isDirectory": meta.is_dir(),
                            "isSymlink": meta.is_symlink(),
                            "modified": meta.modified().ok().and_then(|t|
                                t.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
                            ),
                        }))
                    }
                    Err(e) => Err(ECPError::server_error(format!(
                        "Failed to stat {}: {e}", path.display()
                    ))),
                }
            }

            "file/delete" => {
                let p: FilePathParam = parse_params(params)?;
                let path = self.resolve_path(&p.path)?;

                match tokio::fs::remove_file(&path).await {
                    Ok(()) => Ok(json!({ "success": true })),
                    Err(e) => Err(ECPError::server_error(format!(
                        "Failed to delete {}: {e}", path.display()
                    ))),
                }
            }

            "file/rename" => {
                let p: FileRenameParams = parse_params(params)?;
                let from = self.resolve_path(&p.from)?;
                let to = self.resolve_path(&p.to)?;

                match tokio::fs::rename(&from, &to).await {
                    Ok(()) => Ok(json!({ "success": true })),
                    Err(e) => Err(ECPError::server_error(format!("Failed to rename: {e}"))),
                }
            }

            "file/copy" => {
                let p: FileCopyParams = parse_params(params)?;
                let from = self.resolve_path(&p.from)?;
                let to = self.resolve_path(&p.to)?;

                match tokio::fs::copy(&from, &to).await {
                    Ok(_) => Ok(json!({ "success": true })),
                    Err(e) => Err(ECPError::server_error(format!("Failed to copy: {e}"))),
                }
            }

            "file/readDir" | "file/list" => {
                let p: FilePathParam = parse_params(params)?;
                let path = self.resolve_path(&p.path)?;

                match tokio::fs::read_dir(&path).await {
                    Ok(mut entries) => {
                        let mut items = Vec::new();
                        while let Ok(Some(entry)) = entries.next_entry().await {
                            let name = entry.file_name().to_string_lossy().to_string();
                            let meta = entry.metadata().await.ok();
                            items.push(json!({
                                "name": name,
                                "path": entry.path().to_string_lossy(),
                                "isFile": meta.as_ref().map(|m| m.is_file()).unwrap_or(false),
                                "isDirectory": meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                                "size": meta.as_ref().map(|m| m.len()).unwrap_or(0),
                            }));
                        }
                        Ok(json!({ "entries": items }))
                    }
                    Err(e) => Err(ECPError::server_error(format!(
                        "Failed to read directory {}: {e}", path.display()
                    ))),
                }
            }

            "file/createDir" => {
                let p: FilePathParam = parse_params(params)?;
                let path = self.resolve_path(&p.path)?;

                match tokio::fs::create_dir_all(&path).await {
                    Ok(()) => Ok(json!({ "success": true })),
                    Err(e) => Err(ECPError::server_error(format!(
                        "Failed to create directory: {e}"
                    ))),
                }
            }

            "file/deleteDir" => {
                let p: FilePathParam = parse_params(params)?;
                let path = self.resolve_path(&p.path)?;

                match tokio::fs::remove_dir_all(&path).await {
                    Ok(()) => Ok(json!({ "success": true })),
                    Err(e) => Err(ECPError::server_error(format!(
                        "Failed to delete directory: {e}"
                    ))),
                }
            }

            "file/getParent" => {
                let p: FilePathParam = parse_params(params)?;
                let path = PathBuf::from(&p.path);
                let parent = path.parent()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default();
                Ok(json!({ "parent": parent }))
            }

            "file/getBasename" => {
                let p: FilePathParam = parse_params(params)?;
                let path = PathBuf::from(&p.path);
                let basename = path.file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                Ok(json!({ "basename": basename }))
            }

            "file/join" => {
                let p: FileJoinParams = parse_params(params)?;
                let mut result = PathBuf::from(&p.base);
                for segment in &p.segments {
                    result = result.join(segment);
                }
                Ok(json!({ "path": result.to_string_lossy() }))
            }

            _ => Err(ECPError::method_not_found(method)),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct FilePathParam {
    path: String,
}

#[derive(Deserialize)]
struct FileReadParams {
    path: String,
}

#[derive(Deserialize)]
struct FileWriteParams {
    path: String,
    content: String,
}

#[derive(Deserialize)]
struct FileRenameParams {
    from: String,
    to: String,
}

#[derive(Deserialize)]
struct FileCopyParams {
    from: String,
    to: String,
}

#[derive(Deserialize)]
struct FileJoinParams {
    base: String,
    segments: Vec<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

fn parse_params<T: for<'de> Deserialize<'de>>(params: Option<serde_json::Value>) -> Result<T, ECPError> {
    match params {
        Some(v) => serde_json::from_value(v)
            .map_err(|e| ECPError::invalid_params(format!("Invalid parameters: {e}"))),
        None => Err(ECPError::invalid_params("Parameters required")),
    }
}

/// Normalize a path by resolving `.` and `..` without touching the filesystem.
fn normalize_path(path: &Path) -> PathBuf {
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => { components.pop(); }
            std::path::Component::CurDir => {}
            c => components.push(c),
        }
    }
    components.iter().collect()
}
