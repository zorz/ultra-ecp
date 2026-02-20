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
use ecp_transport::server::{TransportConfig, TransportServer};
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

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    // Initialize tracing
    let filter = if cli.verbose {
        EnvFilter::new("debug")
    } else {
        EnvFilter::new("info")
    };
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .init();

    // Resolve workspace root if provided
    let workspace_root = cli.workspace.map(|w| {
        let w = w.canonicalize().unwrap_or(w);
        w
    });

    // Generate auth token
    let auth_token = cli.token.unwrap_or_else(|| {
        use rand::Rng;
        let mut rng = rand::rng();
        let bytes: [u8; 32] = rng.random();
        hex::encode(bytes)
    });

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
    let ws_url = format!("ws://{}:{}/ws", cli.hostname, actual_port);

    println!("────────────────────────────────────────────────────────────────");
    println!();
    println!("  Server running!");
    println!();
    println!("  WebSocket endpoint:");
    println!("    {ws_url}");
    println!();
    println!("  Auth token:");
    println!("    {}...{}", &auth_token[..8], &auth_token[auth_token.len()-8..]);
    println!();
    println!("────────────────────────────────────────────────────────────────");
    println!();
    println!("  Press Ctrl+C to stop.");
    println!();

    // Wait for shutdown signal
    tokio::signal::ctrl_c().await.expect("Failed to listen for ctrl+c");

    println!();
    println!("  Shutting down...");
    transport.stop().await;
    println!("  Server stopped.");
}
