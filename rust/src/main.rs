//! Ultra ECP — Editor Command Protocol Server
//!
//! A standalone server that exposes development environment services
//! over JSON-RPC 2.0 via WebSocket.
//!
//! Usage:
//!   ultra-ecp                                    # Default port 7070, cwd as workspace
//!   ultra-ecp --port 8080                        # Custom port
//!   ultra-ecp --workspace /path/to/project       # Custom workspace
//!   ultra-ecp --token mysecret                   # Custom auth token

use std::path::PathBuf;
use std::sync::Arc;

use clap::Parser;
use ecp_protocol::auth::AuthConfig;
use ecp_protocol::ECPNotification;
use ecp_server::ECPServer;
use ecp_services::{
    chat::ChatService,
    database::DatabaseService,
    document::DocumentService,
    file::FileService,
    git::GitService,
    lsp::LSPService,
    secret::SecretService,
    session::SessionService,
    terminal::TerminalService,
    watch::WatchService,
};
use ecp_transport::server::{TransportConfig, TransportServer};
use tokio::sync::broadcast;
use tracing::error;
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

    /// Workspace root directory
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

    let workspace_root = cli.workspace
        .unwrap_or_else(|| std::env::current_dir().expect("Failed to get cwd"));

    let workspace_root = workspace_root.canonicalize()
        .unwrap_or(workspace_root);

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
    println!("║                        (Rust)                               ║");
    println!("╚══════════════════════════════════════════════════════════════╝");
    println!();
    println!("  Workspace:  {}", workspace_root.display());
    println!("  Port:       {}", cli.port);
    println!("  Binding:    {} (localhost only)", cli.hostname);
    println!();

    // Create shared notification channel — services and transport share this
    let (notification_tx, _) = broadcast::channel::<String>(1024);

    // Create the ECP server
    let mut ecp_server = ECPServer::new(workspace_root.clone());
    ecp_server.set_notification_sender(notification_tx.clone());

    // Build a notification callback for services that emit events
    let notify_tx = notification_tx.clone();
    let notify_sender: Arc<dyn Fn(&str, serde_json::Value) + Send + Sync> = Arc::new(move |method, params| {
        let notification = ECPNotification::new(method, Some(params));
        if let Ok(json) = serde_json::to_string(&notification) {
            let _ = notify_tx.send(json);
        }
    });

    // Create watch service with notification wiring
    let watch_service = WatchService::new(workspace_root.clone());
    watch_service.set_notify_sender(notify_sender);

    // Register core services
    ecp_server.register_service(FileService::new(workspace_root.clone()));
    ecp_server.register_service(GitService::new(workspace_root.clone()));
    ecp_server.register_service(TerminalService::new(workspace_root.clone()));
    ecp_server.register_service(DocumentService::new());
    ecp_server.register_service(SessionService::new(workspace_root.clone()));
    ecp_server.register_service(SecretService::new());
    ecp_server.register_service(ChatService::new(&workspace_root));
    ecp_server.register_service(DatabaseService::new(workspace_root.clone()));
    ecp_server.register_service(LSPService::new(workspace_root.clone()));
    ecp_server.register_service(watch_service);

    // Initialize all services
    if let Err(e) = ecp_server.initialize().await {
        error!("Failed to initialize ECP server: {e}");
        std::process::exit(1);
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
        workspace_root: Some(workspace_root.to_string_lossy().to_string()),
        verbose_logging: cli.verbose,
    };

    // Start transport server with the shared notification channel
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
