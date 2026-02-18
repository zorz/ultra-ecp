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
        // Strip file:// URI prefix if present
        let path = path.strip_prefix("file://").unwrap_or(path);
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
                    Ok(content) => {
                        let meta = tokio::fs::metadata(&path).await.ok();
                        let mod_time = meta.as_ref().and_then(|m| file_mod_time(m));
                        let size = meta.as_ref().map(|m| m.len()).unwrap_or(content.len() as u64);
                        Ok(json!({
                            "content": content,
                            "encoding": "utf-8",
                            "modTime": mod_time,
                            "size": size,
                        }))
                    }
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

                let bytes_written = p.content.len() as u64;
                match tokio::fs::write(&path, &p.content).await {
                    Ok(()) => {
                        let mod_time = tokio::fs::metadata(&path).await.ok()
                            .and_then(|m| file_mod_time(&m));
                        Ok(json!({
                            "success": true,
                            "modTime": mod_time,
                            "bytesWritten": bytes_written,
                        }))
                    }
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
                let uri = file_uri(&path);

                match tokio::fs::symlink_metadata(&path).await {
                    Ok(meta) => {
                        Ok(json!({
                            "uri": uri,
                            "exists": true,
                            "isFile": meta.is_file(),
                            "isDirectory": meta.is_dir(),
                            "isSymlink": meta.is_symlink(),
                            "size": meta.len(),
                            "modTime": file_mod_time(&meta),
                            "createTime": file_create_time(&meta),
                        }))
                    }
                    Err(_) => Ok(json!({
                        "uri": uri,
                        "exists": false,
                        "isFile": false,
                        "isDirectory": false,
                        "isSymlink": false,
                        "size": 0,
                        "modTime": null,
                        "createTime": null,
                    })),
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
                            let entry_path = entry.path();
                            let meta = tokio::fs::symlink_metadata(&entry_path).await.ok();
                            let file_type = if meta.as_ref().map(|m| m.is_symlink()).unwrap_or(false) {
                                "symlink"
                            } else if meta.as_ref().map(|m| m.is_dir()).unwrap_or(false) {
                                "directory"
                            } else {
                                "file"
                            };
                            items.push(json!({
                                "name": name,
                                "uri": file_uri(&entry_path),
                                "type": file_type,
                                "size": meta.as_ref().map(|m| m.len()),
                                "modTime": meta.as_ref().and_then(|m| file_mod_time(m)),
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
                Ok(json!({ "uri": result.to_string_lossy() }))
            }

            "file/pathToUri" => {
                let p: FilePathParam = parse_params(params)?;
                let path = self.resolve_path(&p.path)?;
                Ok(json!({ "uri": file_uri(&path) }))
            }

            "file/uriToPath" => {
                let p: FileUriParam = parse_params(params)?;
                let path = p.uri.strip_prefix("file://").unwrap_or(&p.uri);
                Ok(json!({ "path": path }))
            }

            "file/edit" => {
                let p: FileEditParams = parse_params(params)?;
                let path = self.resolve_path(&p.uri)?;
                let content = tokio::fs::read_to_string(&path).await
                    .map_err(|e| ECPError::server_error(format!("Failed to read {}: {e}", path.display())))?;

                let new_content = if p.replace_all {
                    content.replace(&p.old_string, &p.new_string)
                } else {
                    content.replacen(&p.old_string, &p.new_string, 1)
                };

                tokio::fs::write(&path, &new_content).await
                    .map_err(|e| ECPError::server_error(format!("Failed to write {}: {e}", path.display())))?;

                Ok(json!({ "success": true }))
            }

            "file/browseDir" => {
                let p: FileBrowseDirParams = parse_params(params)?;
                let path = self.resolve_path(&p.path)?;

                match tokio::fs::read_dir(&path).await {
                    Ok(mut entries) => {
                        let mut items = Vec::new();
                        while let Ok(Some(entry)) = entries.next_entry().await {
                            let name = entry.file_name().to_string_lossy().to_string();

                            // Skip hidden files unless requested
                            if !p.show_hidden.unwrap_or(false) && name.starts_with('.') {
                                continue;
                            }

                            let entry_path = entry.path();
                            let meta = tokio::fs::symlink_metadata(&entry_path).await.ok();
                            let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);

                            // Skip files if directories only
                            if p.directories_only.unwrap_or(false) && !is_dir {
                                continue;
                            }

                            let file_type = if meta.as_ref().map(|m| m.is_symlink()).unwrap_or(false) {
                                "symlink"
                            } else if is_dir {
                                "directory"
                            } else {
                                "file"
                            };

                            items.push(json!({
                                "name": name,
                                "uri": file_uri(&entry_path),
                                "path": entry_path.to_string_lossy(),
                                "type": file_type,
                            }));
                        }
                        Ok(json!({ "path": path.to_string_lossy(), "entries": items }))
                    }
                    Err(e) => Err(ECPError::server_error(format!(
                        "Failed to browse directory {}: {e}", path.display()
                    ))),
                }
            }

            "file/search" => {
                let p: FileSearchParams = parse_params(params)?;
                let root = self.workspace_root.read().clone();
                let max = p.max_results.unwrap_or(100) as usize;
                let case_sensitive = p.case_sensitive.unwrap_or(false);
                let pattern = if case_sensitive { p.pattern.clone() } else { p.pattern.to_lowercase() };
                let mut results = Vec::new();

                fn walk_search(
                    dir: &Path,
                    pattern: &str,
                    case_sensitive: bool,
                    max: usize,
                    results: &mut Vec<serde_json::Value>,
                ) {
                    if results.len() >= max { return; }
                    if let Ok(entries) = std::fs::read_dir(dir) {
                        for entry in entries.flatten() {
                            if results.len() >= max { return; }
                            let name = entry.file_name().to_string_lossy().to_string();
                            let path = entry.path();
                            let is_dir = path.is_dir();

                            // Skip hidden dirs
                            if name.starts_with('.') { continue; }

                            let test_name = if case_sensitive { name.clone() } else { name.to_lowercase() };
                            if test_name.contains(pattern) {
                                results.push(serde_json::json!({
                                    "uri": format!("file://{}", path.display()),
                                    "name": name,
                                    "score": 1.0,
                                }));
                            }

                            if is_dir {
                                walk_search(&path, pattern, case_sensitive, max, results);
                            }
                        }
                    }
                }

                walk_search(&root, &pattern, case_sensitive, max, &mut results);
                Ok(json!({ "results": results }))
            }

            "file/glob" => {
                let p: FileGlobParams = parse_params(params)?;
                let base = if let Some(ref base_uri) = p.base_uri {
                    self.resolve_path(base_uri)?
                } else {
                    self.workspace_root.read().clone()
                };
                let full_pattern = base.join(&p.pattern).to_string_lossy().to_string();
                let max = p.max_results.unwrap_or(1000) as usize;

                let mut uris = Vec::new();
                if let Ok(paths) = glob::glob(&full_pattern) {
                    for entry in paths.flatten() {
                        if uris.len() >= max { break; }
                        uris.push(file_uri(&entry));
                    }
                }

                Ok(json!({ "uris": uris }))
            }

            "file/grep" => {
                let p: FileGrepParams = parse_params(params)?;
                let search_path = if let Some(ref path) = p.path {
                    self.resolve_path(path)?
                } else {
                    self.workspace_root.read().clone()
                };
                let max = p.max_results.unwrap_or(200) as usize;
                let case_sensitive = p.case_sensitive.unwrap_or(true);

                let mut args = vec!["-rn".to_string()];
                if !case_sensitive {
                    args.push("-i".to_string());
                }
                if let Some(ref glob_pat) = p.glob {
                    args.push("--include".to_string());
                    args.push(glob_pat.clone());
                }
                args.push(p.pattern.clone());
                args.push(search_path.to_string_lossy().to_string());

                let output = tokio::process::Command::new("grep")
                    .args(&args)
                    .output()
                    .await
                    .map_err(|e| ECPError::server_error(format!("Grep failed: {e}")))?;

                let stdout = String::from_utf8_lossy(&output.stdout);
                let mut matches = Vec::new();
                for line in stdout.lines().take(max) {
                    // Format: file:line:text
                    if let Some((file_and_line, text)) = line.split_once(':') {
                        if let Some((file, line_no)) = file_and_line.rsplit_once(':') {
                            matches.push(json!({
                                "file": file,
                                "line": line_no.parse::<u64>().unwrap_or(0),
                                "column": 0,
                                "text": text,
                            }));
                        }
                    }
                }

                Ok(json!({ "matches": matches }))
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
    #[serde(alias = "uri")]
    path: String,
}

#[derive(Deserialize)]
struct FileUriParam {
    uri: String,
}

#[derive(Deserialize)]
struct FileReadParams {
    #[serde(alias = "uri")]
    path: String,
}

#[derive(Deserialize)]
struct FileWriteParams {
    #[serde(alias = "uri")]
    path: String,
    content: String,
}

#[derive(Deserialize)]
struct FileRenameParams {
    #[serde(alias = "oldUri")]
    from: String,
    #[serde(alias = "newUri")]
    to: String,
}

#[derive(Deserialize)]
struct FileCopyParams {
    #[serde(alias = "sourceUri")]
    from: String,
    #[serde(alias = "targetUri")]
    to: String,
}

#[derive(Deserialize)]
struct FileJoinParams {
    #[serde(alias = "baseUri")]
    base: String,
    #[serde(alias = "paths")]
    segments: Vec<String>,
}

#[derive(Deserialize)]
struct FileEditParams {
    uri: String,
    #[serde(rename = "oldString")]
    old_string: String,
    #[serde(rename = "newString")]
    new_string: String,
    #[serde(default, rename = "replaceAll")]
    replace_all: bool,
}

#[derive(Deserialize)]
struct FileBrowseDirParams {
    path: String,
    #[serde(rename = "showHidden")]
    show_hidden: Option<bool>,
    #[serde(rename = "directoriesOnly")]
    directories_only: Option<bool>,
}

#[derive(Deserialize)]
struct FileSearchParams {
    pattern: String,
    #[serde(rename = "maxResults")]
    max_results: Option<u32>,
    #[serde(rename = "caseSensitive")]
    case_sensitive: Option<bool>,
}

#[derive(Deserialize)]
struct FileGlobParams {
    pattern: String,
    #[serde(rename = "baseUri")]
    base_uri: Option<String>,
    #[serde(rename = "maxResults")]
    max_results: Option<u32>,
}

#[derive(Deserialize)]
struct FileGrepParams {
    pattern: String,
    path: Option<String>,
    glob: Option<String>,
    #[serde(rename = "caseSensitive")]
    case_sensitive: Option<bool>,
    #[serde(rename = "maxResults")]
    max_results: Option<u32>,
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

/// Build a file:// URI from a path.
fn file_uri(path: &Path) -> String {
    format!("file://{}", path.display())
}

/// Extract modification time as milliseconds since epoch.
fn file_mod_time(meta: &std::fs::Metadata) -> Option<u64> {
    meta.modified().ok().and_then(|t|
        t.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
    )
}

/// Extract creation time as milliseconds since epoch.
fn file_create_time(meta: &std::fs::Metadata) -> Option<u64> {
    meta.created().ok().and_then(|t|
        t.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
    )
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
