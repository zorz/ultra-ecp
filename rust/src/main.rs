//! Ultra ECP — Editor Command Protocol Server (multi-workspace)
//!
//! A single-process server that exposes development environment services
//! over JSON-RPC 2.0 via WebSocket. Supports multiple workspaces
//! concurrently — each connection calls `workspace/open` to scope itself
//! to a project directory.
//!
//! Usage:
//!   ultra-ecp                                    # Default port 7070, no workspace
//!   ultra-ecp --port 8080                        # Custom port
//!   ultra-ecp --workspace /path/to/project       # Pre-open a default workspace
//!   ultra-ecp --token mysecret                   # Custom auth token

use std::path::PathBuf;
use std::sync::Arc;

use clap::Parser;
use ecp_ai_bridge::{AIBridge, AIBridgeConfig};
use ecp_protocol::auth::AuthConfig;
use ecp_server::{ECPServer, WorkspaceRegistry};
use ecp_services::{
    bridge_services::{AIService, AgentService, AuthService, SyntaxService, WorkflowService},
    chat::ChatDb,
    document::DocumentService,
    models::ModelsService,
    secret::SecretService,
};
use ecp_transport::server::{TransportConfig, TlsConfig, TransportServer};
use ecp_transport::RequestHandler;
use parking_lot::Mutex;
use tokio::sync::broadcast;
use tracing::{error, warn};
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(name = "ultra-ecp", about = "Ultra ECP Server — Editor Command Protocol")]
struct Cli {
    /// Port to listen on (0 for OS-assigned)
    #[arg(long, default_value = "7070")]
    port: u16,

    /// Hostname to bind to
    #[arg(long, default_value = "127.0.0.1")]
    hostname: String,

    /// Workspace root directory (pre-opens a default workspace for backward compat)
    #[arg(long)]
    workspace: Option<PathBuf>,

    /// Authentication token (random if not provided)
    #[arg(long)]
    token: Option<String>,

    /// Maximum concurrent connections
    #[arg(long, default_value = "32")]
    max_connections: usize,

    /// Enable verbose logging
    #[arg(long)]
    verbose: bool,

    /// Skip starting the AI bridge subprocess
    #[arg(long)]
    no_bridge: bool,

    /// Path to the bun runtime binary
    #[arg(long)]
    bun_path: Option<String>,

    /// Disable TLS (for development/debugging)
    #[arg(long)]
    no_tls: bool,

    /// Path to custom TLS certificate (PEM)
    #[arg(long)]
    tls_cert: Option<PathBuf>,

    /// Path to custom TLS private key (PEM)
    #[arg(long)]
    tls_key: Option<PathBuf>,

    /// Write logs to a file (defaults to ~/.ultra/logs/ecp.log if no path given)
    #[arg(long, default_missing_value = "DEFAULT", num_args = 0..=1)]
    log_file: Option<String>,
}

/// Resolve the bun binary path, checking common installation locations.
/// Mac apps don't inherit the user's shell PATH, so we need to find bun ourselves.
fn resolve_bun_path() -> String {
    // First check PATH (works when launched from a terminal)
    if let Ok(output) = std::process::Command::new("which").arg("bun").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return path;
            }
        }
    }

    let home = std::env::var("HOME").unwrap_or_else(|_| "/Users/unknown".into());

    // Common bun installation paths on macOS
    let candidates = [
        format!("{home}/.bun/bin/bun"),           // bun's default install location
        "/opt/homebrew/bin/bun".to_string(),       // Homebrew on Apple Silicon
        "/usr/local/bin/bun".to_string(),          // Homebrew on Intel / manual install
        format!("{home}/.local/bin/bun"),           // alternative install location
    ];

    for path in &candidates {
        if std::path::Path::new(path).exists() {
            return path.clone();
        }
    }

    // Fall back to bare "bun" and hope it's in PATH
    "bun".to_string()
}

/// Compute SHA-256 fingerprint from a PEM certificate file.
/// Returns `"sha256:<hex>"` or None if parsing fails.
fn compute_cert_fingerprint_from_pem(cert_path: &std::path::Path) -> Option<String> {
    use base64::Engine;
    use sha2::{Sha256, Digest};

    let pem_bytes = std::fs::read_to_string(cert_path).ok()?;
    let b64: String = pem_bytes
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect();
    let der = base64::engine::general_purpose::STANDARD.decode(&b64).ok()?;
    let hash = Sha256::digest(&der);
    Some(format!("sha256:{}", hex::encode(hash)))
}

/// Ensure TLS certificate and key exist at `~/.ultra/tls/`, generating if needed.
/// Returns (cert_path, key_path, fingerprint).
fn ensure_tls_certs() -> Result<(PathBuf, PathBuf, String), Box<dyn std::error::Error>> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let tls_dir = PathBuf::from(&home).join(".ultra/tls");
    let cert_path = tls_dir.join("cert.pem");
    let key_path = tls_dir.join("key.pem");

    // Reuse existing certs if they exist
    if cert_path.exists() && key_path.exists() {
        let fingerprint = compute_cert_fingerprint_from_pem(&cert_path)
            .unwrap_or_default();
        return Ok((cert_path, key_path, fingerprint));
    }

    std::fs::create_dir_all(&tls_dir)?;

    // Build SANs: localhost, 127.0.0.1, ::1, and the machine hostname
    let mut sans = vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "::1".to_string(),
    ];
    if let Ok(hostname) = hostname::get() {
        let hostname = hostname.to_string_lossy().to_string();
        if !sans.contains(&hostname) {
            sans.push(hostname);
        }
    }

    let subject_alt_names: Vec<rcgen::SanType> = sans.iter().map(|s| {
        if let Ok(ip) = s.parse::<std::net::IpAddr>() {
            rcgen::SanType::IpAddress(ip)
        } else {
            rcgen::SanType::DnsName(s.clone().try_into().unwrap())
        }
    }).collect();

    let mut params = rcgen::CertificateParams::new(Vec::<String>::new())?;
    params.subject_alt_names = subject_alt_names;

    let key_pair = rcgen::KeyPair::generate()?;
    let cert = params.self_signed(&key_pair)?;

    // Compute fingerprint from DER directly (more reliable than re-parsing PEM)
    let fingerprint = {
        use sha2::{Sha256, Digest};
        let hash = Sha256::digest(cert.der());
        format!("sha256:{}", hex::encode(hash))
    };

    std::fs::write(&cert_path, cert.pem())?;
    std::fs::write(&key_path, key_pair.serialize_pem())?;

    Ok((cert_path, key_path, fingerprint))
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    // Initialize tracing
    let filter = if cli.verbose {
        EnvFilter::new("debug")
    } else {
        EnvFilter::new("info")
    };

    if let Some(ref log_file_arg) = cli.log_file {
        // Resolve log file path
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        let log_path = if log_file_arg == "DEFAULT" {
            PathBuf::from(&home).join(".ultra/logs/ecp.log")
        } else {
            PathBuf::from(log_file_arg)
        };

        if let Some(parent) = log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .unwrap_or_else(|e| panic!("Failed to open log file {}: {e}", log_path.display()));

        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_writer(std::sync::Mutex::new(file))
            .with_ansi(false)
            .init();

        eprintln!("Logging to {}", log_path.display());
    } else {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .init();
    };

    // Resolve workspace root if provided
    let workspace_root = cli.workspace.map(|w| {
        let w = w.canonicalize().unwrap_or(w);
        w
    });

    // Resolve auth token — reuse persisted token, or generate and persist a new one.
    // The --token CLI flag overrides (and does NOT update the persisted file).
    let token_was_explicit = cli.token.is_some();
    let auth_token = cli.token.unwrap_or_else(|| {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        let token_path = PathBuf::from(&home).join(".ultra/auth-token");

        // Reuse existing token if valid
        if let Ok(existing) = std::fs::read_to_string(&token_path) {
            let trimmed = existing.trim().to_string();
            if trimmed.len() >= 32 {
                return trimmed;
            }
        }

        // Generate new persistent token
        use rand::Rng;
        let mut rng = rand::rng();
        let bytes: [u8; 32] = rng.random();
        let token = hex::encode(bytes);

        // Persist it
        let ultra_dir = PathBuf::from(&home).join(".ultra");
        let _ = std::fs::create_dir_all(&ultra_dir);
        let _ = std::fs::write(&token_path, &token);

        // Restrict file permissions (owner-only read/write)
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(
                &token_path,
                std::fs::Permissions::from_mode(0o600),
            );
        }

        token
    });

    // Resolve TLS configuration and cert fingerprint
    let (tls_config, cert_fingerprint) = if cli.no_tls {
        (None, None)
    } else if let (Some(cert), Some(key)) = (&cli.tls_cert, &cli.tls_key) {
        let fp = compute_cert_fingerprint_from_pem(cert);
        (Some(TlsConfig {
            cert_path: cert.clone(),
            key_path: key.clone(),
        }), fp)
    } else {
        match ensure_tls_certs() {
            Ok((cert_path, key_path, fingerprint)) => (
                Some(TlsConfig { cert_path, key_path }),
                if fingerprint.is_empty() { None } else { Some(fingerprint) },
            ),
            Err(e) => {
                warn!("Failed to generate TLS certs, falling back to plain TCP: {e}");
                (None, None)
            }
        }
    };

    println!();
    println!("╔══════════════════════════════════════════════════════════════╗");
    println!("║                     Ultra ECP Server                        ║");
    println!("║                   (Rust, multi-workspace)                   ║");
    println!("╚══════════════════════════════════════════════════════════════╝");
    println!();
    if let Some(ref ws) = workspace_root {
        println!("  Workspace:  {} (default)", ws.display());
    } else {
        println!("  Workspace:  (none — clients must call workspace/open)");
    }
    println!("  Port:       {}", cli.port);
    println!("  Binding:    {} (localhost only)", cli.hostname);
    match &tls_config {
        Some(tls) => println!("  TLS:        enabled (cert: {})", tls.cert_path.display()),
        None => println!("  TLS:        disabled (--no-tls)"),
    }
    println!();

    // Open global ChatDb — shared across all workspaces
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let global_chat_path = PathBuf::from(&home).join(".ultra/chat.db");
    let global_chat_db = Arc::new(Mutex::new(
        ChatDb::open(&global_chat_path).expect("Failed to open global chat database"),
    ));

    // Create shared notification channel — global notifications (theme, config)
    let (notification_tx, _) = broadcast::channel::<String>(1024);

    // Create workspace registry and ECP server
    let registry = WorkspaceRegistry::new(global_chat_db);
    let mut ecp_server = ECPServer::new(registry);
    ecp_server.set_notification_sender(notification_tx.clone());

    // Register global services
    ecp_server.register_service(SecretService::new());
    ecp_server.register_service(DocumentService::new());

    // ── AI Bridge — TypeScript subprocess for AI SDK services ────────────
    let bridge_arc: Option<Arc<AIBridge>> = if !cli.no_bridge {
        let mut bridge = AIBridge::new();
        bridge.set_notification_sender(notification_tx.clone());

        // Resolve the bridge binary/script path relative to the executable
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .unwrap_or_else(|| PathBuf::from("."));

        // Check for compiled ai-bridge binary next to ultra-ecp (app bundle case)
        let compiled_binary = {
            let candidate = exe_dir.join("ai-bridge");
            if candidate.exists() && candidate.is_file() {
                Some(candidate)
            } else {
                None
            }
        };

        // Look for ai-bridge/index.ts — binary is at rust/target/{debug,release}/ultra-ecp
        // so we need to go up 3 levels to reach the project root
        let script_path = [
            exe_dir.join("../../../ai-bridge/index.ts"),  // exe → project root
            exe_dir.join("../../ai-bridge/index.ts"),     // exe → rust/
            PathBuf::from("ai-bridge/index.ts"),          // CWD
        ]
        .into_iter()
        .find(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from("ai-bridge/index.ts"));

        // Resolve bun runtime — only needed when running TS source (not compiled binary)
        let bun_runtime = if compiled_binary.is_none() {
            cli.bun_path.clone().unwrap_or_else(resolve_bun_path)
        } else {
            String::new()
        };

        // Use the workspace root for bridge if provided, else cwd
        let bridge_workspace = workspace_root.clone()
            .unwrap_or_else(|| std::env::current_dir().expect("Failed to get cwd"));

        let config = AIBridgeConfig {
            compiled_binary: compiled_binary.clone(),
            script_path: script_path.clone(),
            runtime: bun_runtime.clone(),
            workspace_root: bridge_workspace,
        };

        if let Some(ref bin) = compiled_binary {
            println!("  AI Bridge:  compiled binary = {}", bin.display());
        } else {
            println!("  AI Bridge:  runtime = {bun_runtime}");
            println!("              script  = {}", script_path.display());
        }

        match bridge.start(config).await {
            Ok(()) => {
                let bridge = Arc::new(bridge);

                // Register bridge-delegated services (global)
                ecp_server.register_service(AIService::new(bridge.clone()));
                ecp_server.register_service(AuthService::new(bridge.clone()));
                ecp_server.register_service(AgentService::new(bridge.clone()));
                ecp_server.register_service(WorkflowService::new(bridge.clone()));
                ecp_server.register_service(SyntaxService::new(bridge.clone()));

                println!("  AI Bridge:  started (5 services delegated)");
                Some(bridge)
            }
            Err(e) => {
                warn!("AI bridge failed to start: {e}");
                println!("  AI Bridge:  FAILED ({e})");
                println!("              AI/auth/agent/workflow/syntax services unavailable");
                None
            }
        }
    } else {
        println!("  AI Bridge:  disabled (--no-bridge)");
        None
    };
    // Register ModelsService — delegates to bridge when available, falls back to file read
    ecp_server.register_service(ModelsService::new(bridge_arc.clone()));
    println!();

    // Initialize global services
    if let Err(e) = ecp_server.initialize().await {
        error!("Failed to initialize ECP server: {e}");
        std::process::exit(1);
    }

    // Pre-open default workspace if --workspace was provided
    if let Some(ref ws_root) = workspace_root {
        match ecp_server.workspace_registry().open(ws_root, "__default__").await {
            Ok((ws_id, _rx)) => {
                ecp_server.set_default_workspace(ws_id.clone());
                println!("  Default workspace opened: {}", ws_root.display());
            }
            Err(e) => {
                error!("Failed to open default workspace: {e}");
                std::process::exit(1);
            }
        }
    }

    // Wrap ECPServer in Arc — shared between transport and bridge callback handler
    let ecp_server = Arc::new(ecp_server);

    // Wire the bridge callback handler now that the ECPServer is in an Arc.
    if let Some(ref bridge) = bridge_arc {
        let server = ecp_server.clone();
        bridge.set_callback_handler(Arc::new(move |method, params, context| {
            let server = server.clone();
            let method = method.to_string();
            Box::pin(async move { server.handle_request(&method, params, context).await })
        }));
    }

    // Configure transport
    let transport_config = TransportConfig {
        port: cli.port,
        hostname: cli.hostname.clone(),
        auth: Some(AuthConfig {
            token: auth_token.clone(),
            handshake_timeout_ms: 10_000,
            allow_legacy_auth: true,
            heartbeat_interval_ms: 30_000,
        }),
        enable_cors: false,
        max_connections: Some(cli.max_connections),
        workspace_root: workspace_root.as_ref().map(|w| w.to_string_lossy().to_string()),
        verbose_logging: cli.verbose,
        tls: tls_config,
        cert_fingerprint: cert_fingerprint.clone(),
    };

    // Start transport server with the shared notification channel and Arc<ECPServer>
    let mut transport = match TransportServer::start_with_sender(transport_config, ecp_server, notification_tx).await {
        Ok(t) => t,
        Err(e) => {
            error!("Failed to start transport: {e}");
            std::process::exit(1);
        }
    };

    let actual_port = transport.port();
    let scheme = if transport.is_tls() { "wss" } else { "ws" };
    let ws_url = format!("{scheme}://{}:{}/ws", cli.hostname, actual_port);

    // Write connection info file for client discovery
    let server_json_path = PathBuf::from(&home).join(".ultra/server.json");
    {
        let server_info = serde_json::json!({
            "host": cli.hostname,
            "port": actual_port,
            "scheme": scheme,
            "token": auth_token,
            "certFingerprint": cert_fingerprint,
            "serverVersion": env!("CARGO_PKG_VERSION"),
            "startedAt": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            "pid": std::process::id(),
        });
        if let Ok(json_str) = serde_json::to_string_pretty(&server_info) {
            let _ = std::fs::write(&server_json_path, &json_str);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(
                    &server_json_path,
                    std::fs::Permissions::from_mode(0o600),
                );
            }
        }
    }

    println!("────────────────────────────────────────────────────────────────");
    println!();
    println!("  Server running!");
    println!();
    println!("  WebSocket endpoint:");
    println!("    {ws_url}");
    println!();
    println!("  Auth token:");
    if auth_token.len() > 16 {
        println!("    {}...{}", &auth_token[..8], &auth_token[auth_token.len()-8..]);
    } else {
        println!("    {}", &auth_token);
    }
    if !token_was_explicit {
        println!("    (persisted to ~/.ultra/auth-token)");
    }
    println!();
    println!("  Connection info:");
    println!("    ~/.ultra/server.json");
    println!();
    println!("────────────────────────────────────────────────────────────────");
    println!();
    println!("  Press Ctrl+C to stop.");
    println!();

    // Wait for shutdown signal: Ctrl+C or stdin EOF (parent process died).
    // The Mac app passes a Pipe() as stdin — when the GUI is killed, the pipe
    // closes and we detect EOF here, preventing orphaned server processes.
    let shutdown_notify = Arc::new(tokio::sync::Notify::new());
    {
        let notify = shutdown_notify.clone();
        std::thread::spawn(move || {
            use std::io::Read;
            let mut buf = [0u8; 1];
            loop {
                match std::io::stdin().read(&mut buf) {
                    Ok(0) | Err(_) => {
                        // EOF — parent process is gone
                        notify.notify_one();
                        return;
                    }
                    Ok(_) => continue,
                }
            }
        });
    }

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = shutdown_notify.notified() => {
            eprintln!("stdin closed (parent process gone) — shutting down");
        }
    }

    println!();
    println!("  Shutting down...");
    transport.stop().await;

    // Clean up server.json on graceful shutdown
    let _ = std::fs::remove_file(&server_json_path);

    println!("  Server stopped.");
}
