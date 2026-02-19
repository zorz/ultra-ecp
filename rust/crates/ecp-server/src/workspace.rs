//! Workspace context — holds per-workspace state.

use std::path::PathBuf;

/// Workspace context that holds all state for a single workspace.
///
/// In single-tenant mode, there is one WorkspaceContext for the server.
/// In multi-tenant mode, each tenant gets their own WorkspaceContext,
/// ensuring complete isolation of state.
#[derive(Debug)]
pub struct WorkspaceContext {
    /// Workspace root directory
    pub root: PathBuf,
    /// Sessions directory for persistence
    pub sessions_dir: PathBuf,
    /// Unique workspace identifier
    pub id: String,
}

impl WorkspaceContext {
    pub fn new(root: PathBuf) -> Self {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        let sessions_dir = PathBuf::from(&home).join(".ultra/sessions");
        let id = uuid::Uuid::new_v4().to_string();

        Self {
            root,
            sessions_dir,
            id,
        }
    }

    pub fn with_sessions_dir(mut self, dir: PathBuf) -> Self {
        self.sessions_dir = dir;
        self
    }
}
