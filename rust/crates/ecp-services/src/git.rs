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
}

impl Service for GitService {
    fn namespace(&self) -> &str {
        "git"
    }

    async fn handle(&self, method: &str, params: Option<serde_json::Value>) -> HandlerResult {
        match method {
            "git/isRepo" => {
                match self.git(&["rev-parse", "--is-inside-work-tree"]).await {
                    Ok(out) => Ok(json!({ "isRepo": out.trim() == "true" })),
                    Err(_) => Ok(json!({ "isRepo": false })),
                }
            }

            "git/getRoot" => {
                let root = self.git(&["rev-parse", "--show-toplevel"]).await?;
                Ok(json!({ "root": root.trim() }))
            }

            "git/status" => {
                let output = self.git(&["status", "--porcelain=v1", "-uall"]).await?;
                let files: Vec<serde_json::Value> = output
                    .lines()
                    .filter(|l| l.len() >= 4)
                    .map(|line| {
                        let index = &line[0..1];
                        let working = &line[1..2];
                        let path = line[3..].to_string();
                        json!({
                            "path": path,
                            "index": index.trim(),
                            "working": working.trim(),
                        })
                    })
                    .collect();

                let branch = self.git(&["branch", "--show-current"]).await
                    .unwrap_or_default();

                Ok(json!({
                    "branch": branch.trim(),
                    "files": files,
                    "clean": files.is_empty(),
                }))
            }

            "git/branch" => {
                let branch = self.git(&["branch", "--show-current"]).await?;
                Ok(json!({ "branch": branch.trim() }))
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
                Ok(json!({ "diff": diff }))
            }

            "git/commit" => {
                let p: GitCommitParams = parse_params(params)?;
                let args = vec!["commit", "-m", &p.message];
                let output = self.git(&args).await?;
                Ok(json!({ "success": true, "output": output.trim() }))
            }

            "git/log" => {
                let p: GitLogParams = parse_params_optional(params);
                let limit = p.limit.unwrap_or(20).to_string();
                let output = self.git(&[
                    "log",
                    &format!("-{}", limit),
                    "--format=%H%n%an%n%ae%n%at%n%s%n---",
                ]).await?;

                let commits: Vec<serde_json::Value> = output
                    .split("---\n")
                    .filter(|block| !block.trim().is_empty())
                    .filter_map(|block| {
                        let lines: Vec<&str> = block.trim().lines().collect();
                        if lines.len() >= 5 {
                            Some(json!({
                                "hash": lines[0],
                                "author": lines[1],
                                "email": lines[2],
                                "timestamp": lines[3].parse::<i64>().unwrap_or(0),
                                "message": lines[4],
                            }))
                        } else {
                            None
                        }
                    })
                    .collect();

                Ok(json!({ "commits": commits }))
            }

            "git/branches" => {
                let output = self.git(&["branch", "-a", "--format=%(refname:short)%09%(objectname:short)%09%(upstream:short)"]).await?;
                let branches: Vec<serde_json::Value> = output
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

                Ok(json!({ "branches": branches }))
            }

            "git/createBranch" => {
                let p: GitBranchParam = parse_params(params)?;
                self.git(&["checkout", "-b", &p.name]).await?;
                Ok(json!({ "success": true }))
            }

            "git/switchBranch" => {
                let p: GitBranchParam = parse_params(params)?;
                self.git(&["checkout", &p.name]).await?;
                Ok(json!({ "success": true }))
            }

            "git/push" => {
                let p: GitPushParams = parse_params_optional(params);
                let mut args = vec!["push"];
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
                let output = self.git(&["pull"]).await?;
                Ok(json!({ "success": true, "output": output.trim() }))
            }

            "git/fetch" => {
                let output = self.git(&["fetch", "--all"]).await?;
                Ok(json!({ "success": true, "output": output.trim() }))
            }

            "git/blame" => {
                let p: GitPathParam = parse_params(params)?;
                let output = self.git(&["blame", "--porcelain", &p.path]).await?;
                Ok(json!({ "blame": output }))
            }

            "git/stash" => {
                let output = self.git(&["stash"]).await?;
                Ok(json!({ "success": true, "output": output.trim() }))
            }

            "git/stashPop" => {
                let output = self.git(&["stash", "pop"]).await?;
                Ok(json!({ "success": true, "output": output.trim() }))
            }

            "git/stashList" => {
                let output = self.git(&["stash", "list"]).await?;
                let stashes: Vec<&str> = output.lines().collect();
                Ok(json!({ "stashes": stashes }))
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

            _ => Err(ECPError::method_not_found(method)),
        }
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
struct GitCommitParams {
    message: String,
}

#[derive(Deserialize, Default)]
struct GitLogParams {
    limit: Option<u32>,
}

#[derive(Deserialize)]
struct GitBranchParam {
    name: String,
}

#[derive(Deserialize, Default)]
struct GitPushParams {
    remote: Option<String>,
    branch: Option<String>,
    #[serde(default, rename = "setUpstream")]
    set_upstream: bool,
}

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
