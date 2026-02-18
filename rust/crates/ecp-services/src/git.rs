//! Git service — wraps the git CLI for repository operations.

use std::path::PathBuf;
use std::process::Stdio;

use ecp_protocol::{ECPError, HandlerResult};
use parking_lot::RwLock;
use serde::Deserialize;
use serde_json::json;
use tracing::debug;

use crate::Service;

/// Git service implementation — shells out to `git` CLI.
pub struct GitService {
    workspace_root: RwLock<PathBuf>,
}

impl GitService {
    pub fn new(workspace_root: PathBuf) -> Self {
        Self {
            workspace_root: RwLock::new(workspace_root),
        }
    }

    pub fn set_workspace_root(&self, root: PathBuf) {
        *self.workspace_root.write() = root;
    }

    /// Run a git command and return stdout.
    async fn git(&self, args: &[&str]) -> Result<String, ECPError> {
        let cwd = self.workspace_root.read().clone();
        debug!("git {}", args.join(" "));

        let output = tokio::process::Command::new("git")
            .args(args)
            .current_dir(&cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await
            .map_err(|e| ECPError::server_error(format!("Failed to run git: {e}")))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(ECPError::server_error(format!("git error: {stderr}")));
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    /// Run a git command and return stdout even on non-zero exit (for merge conflicts etc).
    async fn git_allow_failure(&self, args: &[&str]) -> Result<(String, String, bool), ECPError> {
        let cwd = self.workspace_root.read().clone();
        debug!("git {}", args.join(" "));

        let output = tokio::process::Command::new("git")
            .args(args)
            .current_dir(&cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await
            .map_err(|e| ECPError::server_error(format!("Failed to run git: {e}")))?;

        Ok((
            String::from_utf8_lossy(&output.stdout).to_string(),
            String::from_utf8_lossy(&output.stderr).to_string(),
            output.status.success(),
        ))
    }

    /// Get ahead/behind counts relative to upstream.
    async fn ahead_behind(&self) -> (u32, u32) {
        match self.git(&["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]).await {
            Ok(output) => {
                let parts: Vec<&str> = output.trim().split('\t').collect();
                (
                    parts.first().and_then(|s| s.parse().ok()).unwrap_or(0),
                    parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0),
                )
            }
            Err(_) => (0, 0),
        }
    }
}

impl Service for GitService {
    fn namespace(&self) -> &str {
        "git"
    }

    async fn handle(&self, method: &str, params: Option<serde_json::Value>) -> HandlerResult {
        match method {
            "git/isRepo" => {
                match self.git(&["rev-parse", "--is-inside-work-tree"]).await {
                    Ok(out) => {
                        let root = self.git(&["rev-parse", "--show-toplevel"]).await.ok()
                            .map(|s| s.trim().to_string());
                        Ok(json!({ "isRepo": out.trim() == "true", "rootUri": root }))
                    }
                    Err(_) => Ok(json!({ "isRepo": false })),
                }
            }

            "git/getRoot" => {
                let root = self.git(&["rev-parse", "--show-toplevel"]).await?;
                Ok(json!({ "root": root.trim() }))
            }

            "git/status" => {
                let output = self.git(&["status", "--porcelain=v1", "-uall"]).await?;
                let branch = self.git(&["branch", "--show-current"]).await
                    .unwrap_or_default();
                let (ahead, behind) = self.ahead_behind().await;

                let mut staged = Vec::new();
                let mut unstaged = Vec::new();
                let mut untracked = Vec::new();

                for line in output.lines() {
                    if line.len() < 3 { continue; }
                    let bytes = line.as_bytes();
                    let index_status = bytes[0] as char;
                    let work_status = bytes[1] as char;
                    let path = line[3..].to_string();

                    if index_status == '?' && work_status == '?' {
                        untracked.push(path);
                        continue;
                    }
                    if index_status != ' ' && index_status != '?' {
                        staged.push(json!({ "path": path, "status": index_status.to_string() }));
                    }
                    if work_status != ' ' && work_status != '?' {
                        unstaged.push(json!({ "path": path, "status": work_status.to_string() }));
                    }
                }

                Ok(json!({
                    "branch": branch.trim(),
                    "ahead": ahead,
                    "behind": behind,
                    "staged": staged,
                    "unstaged": unstaged,
                    "untracked": untracked,
                }))
            }

            "git/branch" => {
                let branch = self.git(&["branch", "--show-current"]).await?;
                let tracking = self.git(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
                    .await.ok().map(|s| s.trim().to_string());
                let (ahead, behind) = self.ahead_behind().await;

                Ok(json!({
                    "branch": branch.trim(),
                    "tracking": tracking,
                    "ahead": ahead,
                    "behind": behind,
                }))
            }

            "git/stage" => {
                let p: GitPathsParam = parse_params(params)?;
                let paths: Vec<&str> = p.paths.iter().map(|s| s.as_str()).collect();
                let mut args = vec!["add"];
                args.extend_from_slice(&paths);
                self.git(&args).await?;
                Ok(json!({ "success": true }))
            }

            "git/stageAll" => {
                self.git(&["add", "-A"]).await?;
                Ok(json!({ "success": true }))
            }

            "git/unstage" => {
                let p: GitPathsParam = parse_params(params)?;
                let paths: Vec<&str> = p.paths.iter().map(|s| s.as_str()).collect();
                let mut args = vec!["restore", "--staged"];
                args.extend_from_slice(&paths);
                self.git(&args).await?;
                Ok(json!({ "success": true }))
            }

            "git/discard" => {
                let p: GitPathsParam = parse_params(params)?;
                let paths: Vec<&str> = p.paths.iter().map(|s| s.as_str()).collect();
                let mut args = vec!["checkout", "--"];
                args.extend_from_slice(&paths);
                self.git(&args).await?;
                Ok(json!({ "success": true }))
            }

            "git/diff" => {
                let p: GitDiffParams = parse_params_optional(params);
                let mut args = vec!["diff"];
                if p.staged {
                    args.push("--cached");
                }
                if let Some(ref path) = p.path {
                    args.push("--");
                    args.push(path);
                }
                let diff = self.git(&args).await?;
                let hunks = parse_diff(&diff);
                Ok(json!({ "hunks": hunks }))
            }

            "git/diffLines" => {
                let p: GitPathParam = parse_params(params)?;
                let diff = self.git(&["diff", "--unified=0", "--", &p.path]).await?;
                let changes = parse_diff_lines(&diff);
                Ok(json!({ "changes": changes }))
            }

            "git/diffBuffer" => {
                let p: GitDiffBufferParams = parse_params(params)?;
                // Get HEAD content
                let head_content = self.git(&["show", &format!("HEAD:{}", p.path)]).await
                    .unwrap_or_default();

                let changes = compute_line_diff(&head_content, &p.content);
                Ok(json!({ "changes": changes }))
            }

            "git/commit" => {
                let p: GitCommitParams = parse_params(params)?;
                self.git(&["commit", "-m", &p.message]).await?;

                let log_output = self.git(&["log", "-1", "--format=%H%n%s%n%at"]).await?;
                let lines: Vec<&str> = log_output.trim().lines().collect();

                Ok(json!({
                    "hash": lines.first().unwrap_or(&""),
                    "message": lines.get(1).unwrap_or(&""),
                    "timestamp": lines.get(2).and_then(|s| s.parse::<i64>().ok()).unwrap_or(0),
                }))
            }

            "git/amend" => {
                let p: GitAmendParams = parse_params_optional(params);
                let mut args = vec!["commit", "--amend"];
                let msg_owned;
                if let Some(ref message) = p.message {
                    msg_owned = message.clone();
                    args.push("-m");
                    args.push(&msg_owned);
                } else {
                    args.push("--no-edit");
                }
                self.git(&args).await?;

                let log_output = self.git(&["log", "-1", "--format=%H%n%s"]).await?;
                let lines: Vec<&str> = log_output.trim().lines().collect();
                Ok(json!({
                    "hash": lines.first().unwrap_or(&""),
                    "message": lines.get(1).unwrap_or(&""),
                }))
            }

            "git/log" => {
                let p: GitLogParams = parse_params_optional(params);
                let limit = p.limit.unwrap_or(20);
                let commits = self.parse_log(&[
                    "log",
                    &format!("-{}", limit),
                    "--format=%H%x00%s%x00%an%x00%ae%x00%at",
                ]).await?;

                Ok(json!({ "commits": commits }))
            }

            "git/fileLog" => {
                let p: GitFileLogParams = parse_params(params)?;
                let limit = p.count.unwrap_or(20);
                let commits = self.parse_log(&[
                    "log",
                    &format!("-{}", limit),
                    "--follow",
                    "--format=%H%x00%s%x00%an%x00%ae%x00%at",
                    "--",
                    &p.path,
                ]).await?;

                Ok(json!({ "commits": commits }))
            }

            "git/branches" => {
                let current = self.git(&["branch", "--show-current"]).await
                    .unwrap_or_default().trim().to_string();

                let local_output = self.git(&["branch", "--format=%(refname:short)%09%(objectname:short)%09%(upstream:short)"]).await?;
                let local: Vec<serde_json::Value> = local_output
                    .lines()
                    .filter(|l| !l.is_empty())
                    .map(|line| {
                        let parts: Vec<&str> = line.splitn(3, '\t').collect();
                        json!({
                            "name": parts.first().unwrap_or(&""),
                            "hash": parts.get(1).unwrap_or(&""),
                            "upstream": parts.get(2).unwrap_or(&""),
                        })
                    })
                    .collect();

                let remote_output = self.git(&["branch", "-r", "--format=%(refname:short)%09%(objectname:short)"]).await
                    .unwrap_or_default();
                let remote: Vec<serde_json::Value> = remote_output
                    .lines()
                    .filter(|l| !l.is_empty())
                    .map(|line| {
                        let parts: Vec<&str> = line.splitn(2, '\t').collect();
                        json!({
                            "name": parts.first().unwrap_or(&""),
                            "hash": parts.get(1).unwrap_or(&""),
                        })
                    })
                    .collect();

                Ok(json!({
                    "branches": local,
                    "remote": remote,
                    "current": current,
                }))
            }

            "git/createBranch" => {
                let p: GitCreateBranchParam = parse_params(params)?;
                if p.checkout.unwrap_or(false) {
                    self.git(&["checkout", "-b", &p.name]).await?;
                } else {
                    self.git(&["branch", &p.name]).await?;
                }
                Ok(json!({ "success": true }))
            }

            "git/switchBranch" => {
                let p: GitBranchParam = parse_params(params)?;
                self.git(&["checkout", &p.name]).await?;
                Ok(json!({ "success": true }))
            }

            "git/deleteBranch" => {
                let p: GitDeleteBranchParam = parse_params(params)?;
                let flag = if p.force.unwrap_or(false) { "-D" } else { "-d" };
                self.git(&["branch", flag, &p.name]).await?;
                Ok(json!({ "success": true }))
            }

            "git/renameBranch" => {
                let p: GitRenameBranchParam = parse_params(params)?;
                self.git(&["branch", "-m", &p.new_name]).await?;
                Ok(json!({ "success": true }))
            }

            "git/push" => {
                let p: GitPushParams = parse_params_optional(params);
                let mut args = vec!["push"];
                if p.force.unwrap_or(false) {
                    args.push("--force");
                }
                if p.set_upstream {
                    args.push("-u");
                }
                if let Some(ref remote) = p.remote {
                    args.push(remote);
                }
                if let Some(ref branch) = p.branch {
                    args.push(branch);
                }
                let output = self.git(&args).await?;
                Ok(json!({ "success": true, "output": output.trim() }))
            }

            "git/pull" => {
                let p: GitRemoteParam = parse_params_optional(params);
                let mut args = vec!["pull"];
                if let Some(ref remote) = p.remote {
                    args.push(remote);
                }
                let output = self.git(&args).await?;
                Ok(json!({ "success": true, "output": output.trim() }))
            }

            "git/fetch" => {
                let p: GitRemoteParam = parse_params_optional(params);
                let mut args = vec!["fetch"];
                if let Some(ref remote) = p.remote {
                    args.push(remote);
                } else {
                    args.push("--all");
                }
                let _output = self.git(&args).await?;
                Ok(json!({ "success": true }))
            }

            "git/remotes" => {
                let output = self.git(&["remote", "-v"]).await?;
                let remotes: Vec<serde_json::Value> = output
                    .lines()
                    .filter(|l| l.contains("(fetch)"))
                    .map(|line| {
                        let parts: Vec<&str> = line.split_whitespace().collect();
                        json!({
                            "name": parts.first().unwrap_or(&""),
                            "url": parts.get(1).unwrap_or(&""),
                        })
                    })
                    .collect();
                Ok(json!({ "remotes": remotes }))
            }

            "git/setUpstream" => {
                let p: GitSetUpstreamParam = parse_params(params)?;
                let upstream = format!("{}/{}", p.remote, p.branch);
                self.git(&["branch", "--set-upstream-to", &upstream]).await?;
                Ok(json!({ "success": true }))
            }

            "git/blame" => {
                let p: GitPathParam = parse_params(params)?;
                let output = self.git(&["blame", "--porcelain", &p.path]).await?;
                let lines = parse_blame_porcelain(&output);
                Ok(json!({ "lines": lines }))
            }

            "git/show" => {
                let p: GitShowParam = parse_params(params)?;
                let content = self.git(&["show", &format!("{}:{}", p.git_ref, p.path)]).await?;
                Ok(json!({ "content": content }))
            }

            "git/stash" => {
                let p: GitStashParam = parse_params_optional(params);
                let mut args = vec!["stash"];
                let msg_owned;
                if let Some(ref message) = p.message {
                    msg_owned = message.clone();
                    args.push("push");
                    args.push("-m");
                    args.push(&msg_owned);
                }
                self.git(&args).await?;
                Ok(json!({ "success": true, "stashId": "stash@{0}" }))
            }

            "git/stashPop" => {
                let p: GitStashIdParam = parse_params_optional(params);
                let mut args = vec!["stash", "pop"];
                let id_owned;
                if let Some(ref id) = p.stash_id {
                    id_owned = id.clone();
                    args.push(&id_owned);
                }
                self.git(&args).await?;
                Ok(json!({ "success": true }))
            }

            "git/stashApply" => {
                let p: GitStashIdParam = parse_params_optional(params);
                let mut args = vec!["stash", "apply"];
                let id_owned;
                if let Some(ref id) = p.stash_id {
                    id_owned = id.clone();
                    args.push(&id_owned);
                }
                self.git(&args).await?;
                Ok(json!({ "success": true }))
            }

            "git/stashDrop" => {
                let p: GitStashDropParam = parse_params(params)?;
                self.git(&["stash", "drop", &p.stash_id]).await?;
                Ok(json!({ "success": true }))
            }

            "git/stashList" => {
                let output = self.git(&["stash", "list", "--format=%gd%x00%gs"]).await
                    .unwrap_or_default();
                let stashes: Vec<serde_json::Value> = output
                    .lines()
                    .filter(|l| !l.is_empty())
                    .enumerate()
                    .map(|(idx, line)| {
                        let parts: Vec<&str> = line.splitn(2, '\0').collect();
                        json!({
                            "id": parts.first().unwrap_or(&""),
                            "index": idx,
                            "message": parts.get(1).unwrap_or(&""),
                        })
                    })
                    .collect();
                Ok(json!({ "stashes": stashes }))
            }

            "git/merge" => {
                let p: GitMergeParam = parse_params(params)?;
                let (_stdout, _stderr, success) = self.git_allow_failure(&["merge", &p.branch]).await?;
                if success {
                    Ok(json!({ "success": true }))
                } else {
                    // Check for conflicts
                    let conflicts_output = self.git(&["diff", "--name-only", "--diff-filter=U"]).await
                        .unwrap_or_default();
                    let conflicts: Vec<&str> = conflicts_output.lines()
                        .filter(|l| !l.is_empty()).collect();
                    Ok(json!({ "success": false, "conflicts": conflicts }))
                }
            }

            "git/mergeAbort" => {
                self.git(&["merge", "--abort"]).await?;
                Ok(json!({ "success": true }))
            }

            "git/conflicts" => {
                let output = self.git(&["diff", "--name-only", "--diff-filter=U"]).await
                    .unwrap_or_default();
                let files: Vec<&str> = output.lines().filter(|l| !l.is_empty()).collect();
                Ok(json!({ "files": files }))
            }

            "git/isMerging" => {
                let cwd = self.workspace_root.read().clone();
                let merge_head = cwd.join(".git/MERGE_HEAD");
                let is_merging = tokio::fs::try_exists(&merge_head).await.unwrap_or(false);
                Ok(json!({ "isMerging": is_merging }))
            }

            _ => Err(ECPError::method_not_found(method)),
        }
    }
}

impl GitService {
    /// Parse git log output into commit objects.
    async fn parse_log(&self, args: &[&str]) -> Result<Vec<serde_json::Value>, ECPError> {
        let output = self.git(args).await?;
        Ok(output
            .lines()
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| {
                let parts: Vec<&str> = line.splitn(5, '\0').collect();
                if parts.len() >= 5 {
                    let hash = parts[0];
                    Some(json!({
                        "hash": hash,
                        "shortHash": &hash[..8.min(hash.len())],
                        "message": parts[1],
                        "author": parts[2],
                        "email": parts[3],
                        "date": parts[4].parse::<i64>().unwrap_or(0),
                    }))
                } else {
                    None
                }
            })
            .collect())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter types
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct GitPathParam {
    path: String,
}

#[derive(Deserialize)]
struct GitPathsParam {
    paths: Vec<String>,
}

#[derive(Deserialize, Default)]
struct GitDiffParams {
    #[serde(default)]
    staged: bool,
    path: Option<String>,
}

#[derive(Deserialize)]
struct GitDiffBufferParams {
    path: String,
    content: String,
}

#[derive(Deserialize)]
struct GitCommitParams {
    message: String,
}

#[derive(Deserialize, Default)]
struct GitAmendParams {
    message: Option<String>,
}

#[derive(Deserialize, Default)]
struct GitLogParams {
    limit: Option<u32>,
    #[serde(alias = "count")]
    _count: Option<u32>,
}

#[derive(Deserialize)]
struct GitFileLogParams {
    path: String,
    count: Option<u32>,
}

#[derive(Deserialize)]
struct GitBranchParam {
    name: String,
}

#[derive(Deserialize)]
struct GitCreateBranchParam {
    name: String,
    checkout: Option<bool>,
}

#[derive(Deserialize)]
struct GitDeleteBranchParam {
    name: String,
    force: Option<bool>,
}

#[derive(Deserialize)]
struct GitRenameBranchParam {
    #[serde(rename = "newName")]
    new_name: String,
}

#[derive(Deserialize, Default)]
struct GitPushParams {
    remote: Option<String>,
    branch: Option<String>,
    force: Option<bool>,
    #[serde(default, rename = "setUpstream")]
    set_upstream: bool,
}

#[derive(Deserialize, Default)]
struct GitRemoteParam {
    remote: Option<String>,
}

#[derive(Deserialize)]
struct GitSetUpstreamParam {
    remote: String,
    branch: String,
}

#[derive(Deserialize)]
struct GitShowParam {
    path: String,
    #[serde(rename = "ref")]
    git_ref: String,
}

#[derive(Deserialize, Default)]
struct GitStashParam {
    message: Option<String>,
}

#[derive(Deserialize, Default)]
struct GitStashIdParam {
    #[serde(rename = "stashId")]
    stash_id: Option<String>,
}

#[derive(Deserialize)]
struct GitStashDropParam {
    #[serde(rename = "stashId")]
    stash_id: String,
}

#[derive(Deserialize)]
struct GitMergeParam {
    branch: String,
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

fn parse_params_optional<T: for<'de> Deserialize<'de> + Default>(params: Option<serde_json::Value>) -> T {
    params
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// Parse a unified diff into structured hunks.
fn parse_diff(diff_text: &str) -> Vec<serde_json::Value> {
    let mut hunks = Vec::new();
    let mut current_lines: Vec<serde_json::Value> = Vec::new();
    let mut old_start = 0u32;
    let mut old_count = 0u32;
    let mut new_start = 0u32;
    let mut new_count = 0u32;
    let mut in_hunk = false;

    for line in diff_text.lines() {
        if line.starts_with("@@") {
            // Save previous hunk
            if in_hunk {
                hunks.push(json!({
                    "oldStart": old_start,
                    "oldCount": old_count,
                    "newStart": new_start,
                    "newCount": new_count,
                    "lines": current_lines,
                }));
                current_lines = Vec::new();
            }

            // Parse @@ -old_start,old_count +new_start,new_count @@
            if let Some(header) = line.strip_prefix("@@ ") {
                let header = header.split("@@").next().unwrap_or("").trim();
                let parts: Vec<&str> = header.split_whitespace().collect();
                if parts.len() >= 2 {
                    let old_parts: Vec<&str> = parts[0].trim_start_matches('-').split(',').collect();
                    let new_parts: Vec<&str> = parts[1].trim_start_matches('+').split(',').collect();
                    old_start = old_parts.first().and_then(|s| s.parse().ok()).unwrap_or(0);
                    old_count = old_parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(1);
                    new_start = new_parts.first().and_then(|s| s.parse().ok()).unwrap_or(0);
                    new_count = new_parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(1);
                }
            }
            in_hunk = true;
        } else if in_hunk {
            if line.starts_with('+') {
                current_lines.push(json!({ "type": "+", "content": &line[1..] }));
            } else if line.starts_with('-') {
                current_lines.push(json!({ "type": "-", "content": &line[1..] }));
            } else if line.starts_with(' ') {
                current_lines.push(json!({ "type": " ", "content": &line[1..] }));
            }
        }
    }

    // Save last hunk
    if in_hunk {
        hunks.push(json!({
            "oldStart": old_start,
            "oldCount": old_count,
            "newStart": new_start,
            "newCount": new_count,
            "lines": current_lines,
        }));
    }

    hunks
}

/// Parse diff output into simple line changes.
fn parse_diff_lines(diff_text: &str) -> Vec<serde_json::Value> {
    let mut changes = Vec::new();
    let mut in_hunk = false;

    for line in diff_text.lines() {
        if line.starts_with("@@") {
            in_hunk = true;
            continue;
        }
        if !in_hunk { continue; }

        if line.starts_with('+') {
            changes.push(json!({ "type": "+", "line": &line[1..] }));
        } else if line.starts_with('-') {
            changes.push(json!({ "type": "-", "line": &line[1..] }));
        } else if line.starts_with(' ') {
            changes.push(json!({ "type": " ", "line": &line[1..] }));
        }
    }

    changes
}

/// Simple line-by-line diff between two strings.
fn compute_line_diff(old: &str, new: &str) -> Vec<serde_json::Value> {
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();
    let mut changes = Vec::new();

    let max = old_lines.len().max(new_lines.len());
    for i in 0..max {
        match (old_lines.get(i), new_lines.get(i)) {
            (Some(o), Some(n)) if o == n => {
                changes.push(json!({ "type": " ", "line": *o }));
            }
            (Some(o), Some(n)) => {
                changes.push(json!({ "type": "-", "line": *o }));
                changes.push(json!({ "type": "+", "line": *n }));
            }
            (Some(o), None) => {
                changes.push(json!({ "type": "-", "line": *o }));
            }
            (None, Some(n)) => {
                changes.push(json!({ "type": "+", "line": *n }));
            }
            _ => {}
        }
    }

    changes
}

/// Parse `git blame --porcelain` output into structured data.
fn parse_blame_porcelain(output: &str) -> Vec<serde_json::Value> {
    let mut lines = Vec::new();
    let mut current_commit = String::new();
    let mut current_author = String::new();
    let mut current_date = 0i64;
    let mut line_number = 0u32;

    for line in output.lines() {
        if line.starts_with('\t') {
            // Content line
            lines.push(json!({
                "commit": &current_commit[..8.min(current_commit.len())],
                "author": current_author,
                "date": current_date,
                "line": line_number,
                "content": &line[1..],
            }));
        } else if line.len() >= 40 && line.chars().take(40).all(|c| c.is_ascii_hexdigit()) {
            // Commit header: hash orig_line final_line [group_lines]
            let parts: Vec<&str> = line.split_whitespace().collect();
            current_commit = parts.first().unwrap_or(&"").to_string();
            line_number = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
        } else if let Some(author) = line.strip_prefix("author ") {
            current_author = author.to_string();
        } else if let Some(time) = line.strip_prefix("author-time ") {
            current_date = time.parse().unwrap_or(0);
        }
    }

    lines
}
