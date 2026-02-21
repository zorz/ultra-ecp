//! End-to-end integration tests — WebSocket connection, auth handshake,
//! and full JSON-RPC request/response cycle through the running server.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::time::timeout;
use tokio_tungstenite::{connect_async, tungstenite::Message};

/// Start a test server on a random port with a pre-opened default workspace.
async fn start_test_server() -> (u16, String) {
    start_test_server_with_services().await
}

/// Start a test server with all services via the workspace registry.
async fn start_test_server_with_services() -> (u16, String) {
    use ecp_protocol::auth::AuthConfig;
    use ecp_server::{ECPServer, WorkspaceRegistry};
    use ecp_services::{
        chat::ChatDb,
        document::DocumentService,
    };
    use ecp_transport::server::{TransportConfig, TransportServer};

    let workspace = TempDir::new().unwrap();
    // Leak the TempDir so it persists for the test duration
    let workspace_path = Box::leak(Box::new(workspace)).path().to_path_buf();

    let auth_token = format!("test-token-{}", std::process::id());

    // Open global ChatDb for the registry
    let global_chat_path = workspace_path.join(".ultra-global/chat.db");
    let global_chat_db = Arc::new(Mutex::new(
        ChatDb::open(&global_chat_path).expect("Failed to open global chat database"),
    ));

    let registry = WorkspaceRegistry::new(global_chat_db);
    let mut ecp_server = ECPServer::new(registry);

    // Register global services
    ecp_server.register_service(DocumentService::new());

    // Initialize global services
    ecp_server.initialize().await.unwrap();

    // Pre-open a default workspace (backward compat behavior)
    let (ws_id, _rx) = ecp_server.workspace_registry()
        .open(&workspace_path, "__default__").await.unwrap();
    ecp_server.set_default_workspace(ws_id);

    let config = TransportConfig {
        port: 0, // OS-assigned
        hostname: "127.0.0.1".into(),
        auth: Some(AuthConfig {
            token: auth_token.clone(),
            handshake_timeout_ms: 5000,
            allow_legacy_auth: true,
            heartbeat_interval_ms: 30_000,
        }),
        enable_cors: false,
        max_connections: Some(16),
        workspace_root: Some(workspace_path.to_string_lossy().to_string()),
        verbose_logging: false,
        tls: None,
    };

    let transport = TransportServer::start(config, ecp_server).await.unwrap();
    let port = transport.port();

    // Leak the transport to keep it running for the test
    Box::leak(Box::new(transport));

    (port, auth_token)
}

/// Connect to the server and perform auth handshake, returning the connected WebSocket.
async fn connect_and_auth(
    port: u16,
    token: &str,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let url = format!("ws://127.0.0.1:{port}/ws");
    let (mut ws, _) = connect_async(&url).await.expect("Failed to connect");

    // Read auth/required notification
    let msg = timeout(Duration::from_secs(5), ws.next())
        .await
        .expect("Timeout waiting for auth/required")
        .expect("Stream ended")
        .expect("WebSocket error");

    let text = msg.into_text().unwrap();
    let parsed: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed["method"], "auth/required");
    assert_eq!(parsed["params"]["serverVersion"], "0.1.0");

    // Send handshake
    let handshake = json!({
        "jsonrpc": "2.0",
        "id": "auth-1",
        "method": "auth/handshake",
        "params": {
            "token": token,
            "client": { "name": "test-client", "version": "0.1.0" }
        }
    });
    ws.send(Message::Text(serde_json::to_string(&handshake).unwrap().into())).await.unwrap();

    // Read handshake response
    let msg = timeout(Duration::from_secs(5), ws.next())
        .await
        .expect("Timeout")
        .expect("Stream ended")
        .expect("WebSocket error");

    let text = msg.into_text().unwrap();
    let resp: Value = serde_json::from_str(&text).unwrap();
    assert!(resp.get("result").is_some(), "Handshake should succeed: {resp}");
    assert!(resp["result"]["clientId"].is_string());
    assert!(resp["result"]["sessionId"].is_string());

    // Read welcome notification
    let msg = timeout(Duration::from_secs(5), ws.next())
        .await
        .expect("Timeout")
        .expect("Stream ended")
        .expect("WebSocket error");

    let text = msg.into_text().unwrap();
    let welcome: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(welcome["method"], "server/connected");

    ws
}

/// Send a JSON-RPC request and read the response.
async fn send_request(
    ws: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    id: i64,
    method: &str,
    params: Option<Value>,
) -> Value {
    let mut req = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
    });
    if let Some(p) = params {
        req["params"] = p;
    }
    ws.send(Message::Text(serde_json::to_string(&req).unwrap().into())).await.unwrap();

    let msg = timeout(Duration::from_secs(10), ws.next())
        .await
        .expect("Timeout waiting for response")
        .expect("Stream ended")
        .expect("WebSocket error");

    let text = msg.into_text().unwrap();
    serde_json::from_str(&text).unwrap()
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn server_starts_and_accepts_connections() {
    let (port, token) = start_test_server().await;
    let _ws = connect_and_auth(port, &token).await;
    // If we get here, connection + auth succeeded
}

#[tokio::test]
async fn auth_rejects_bad_token() {
    let (port, _token) = start_test_server().await;
    let url = format!("ws://127.0.0.1:{port}/ws");
    let (mut ws, _) = connect_async(&url).await.unwrap();

    // Read auth/required
    let _ = timeout(Duration::from_secs(5), ws.next()).await.unwrap().unwrap().unwrap();

    // Send bad token
    let handshake = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "auth/handshake",
        "params": { "token": "wrong-token" }
    });
    ws.send(Message::Text(serde_json::to_string(&handshake).unwrap().into())).await.unwrap();

    let msg = timeout(Duration::from_secs(5), ws.next())
        .await.unwrap().unwrap().unwrap();
    let resp: Value = serde_json::from_str(&msg.into_text().unwrap()).unwrap();
    assert!(resp.get("error").is_some(), "Should be error response: {resp}");
    assert_eq!(resp["error"]["code"], -32011); // InvalidToken
}

#[tokio::test]
async fn unauthenticated_request_rejected() {
    let (port, _token) = start_test_server().await;
    let url = format!("ws://127.0.0.1:{port}/ws");
    let (mut ws, _) = connect_async(&url).await.unwrap();

    // Read auth/required
    let _ = timeout(Duration::from_secs(5), ws.next()).await.unwrap().unwrap().unwrap();

    // Send a regular request without authenticating first
    let req = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "file/read",
        "params": {"path": "/tmp/test.txt"}
    });
    ws.send(Message::Text(serde_json::to_string(&req).unwrap().into())).await.unwrap();

    let msg = timeout(Duration::from_secs(5), ws.next())
        .await.unwrap().unwrap().unwrap();
    let resp: Value = serde_json::from_str(&msg.into_text().unwrap()).unwrap();
    assert!(resp.get("error").is_some());
    assert_eq!(resp["error"]["code"], -32010); // NotAuthenticated
}

#[tokio::test]
async fn document_lifecycle_over_websocket() {
    let (port, token) = start_test_server().await;
    let mut ws = connect_and_auth(port, &token).await;

    // Open document
    let resp = send_request(&mut ws, 1, "document/open", Some(json!({
        "uri": "file:///tmp/integration_test.rs",
        "content": "fn hello() { println!(\"world\"); }",
        "languageId": "rust",
    }))).await;
    assert!(resp.get("result").is_some(), "Open should succeed: {resp}");
    let doc_id = resp["result"]["documentId"].as_str().unwrap().to_string();
    assert_eq!(resp["result"]["info"]["languageId"], "rust");
    assert_eq!(resp["result"]["info"]["version"], 1);

    // Get content
    let resp = send_request(&mut ws, 2, "document/content", Some(json!({
        "documentId": &doc_id,
    }))).await;
    assert_eq!(resp["result"]["content"], "fn hello() { println!(\"world\"); }");

    // Insert text
    let resp = send_request(&mut ws, 3, "document/insert", Some(json!({
        "documentId": &doc_id,
        "position": {"line": 0, "column": 0},
        "text": "// comment\n",
    }))).await;
    assert_eq!(resp["result"]["version"], 2);

    // Verify content after insert
    let resp = send_request(&mut ws, 4, "document/content", Some(json!({
        "documentId": &doc_id,
    }))).await;
    assert!(resp["result"]["content"].as_str().unwrap().starts_with("// comment\n"));

    // Undo
    let resp = send_request(&mut ws, 5, "document/undo", Some(json!({
        "documentId": &doc_id,
    }))).await;
    assert_eq!(resp["result"]["success"], true);

    // Content should be back to original
    let resp = send_request(&mut ws, 6, "document/content", Some(json!({
        "documentId": &doc_id,
    }))).await;
    assert_eq!(resp["result"]["content"], "fn hello() { println!(\"world\"); }");

    // Close
    let resp = send_request(&mut ws, 7, "document/close", Some(json!({
        "documentId": &doc_id,
    }))).await;
    assert_eq!(resp["result"]["success"], true);
}

#[tokio::test]
async fn file_operations_over_websocket() {
    let (port, token) = start_test_server().await;
    let mut ws = connect_and_auth(port, &token).await;

    let test_path = format!("integration_test_{}.txt", std::process::id());

    // Write file
    let resp = send_request(&mut ws, 1, "file/write", Some(json!({
        "path": &test_path,
        "content": "Integration test content",
    }))).await;
    assert_eq!(resp["result"]["success"], true);

    // Read file
    let resp = send_request(&mut ws, 2, "file/read", Some(json!({
        "path": &test_path,
    }))).await;
    assert_eq!(resp["result"]["content"], "Integration test content");

    // Check exists
    let resp = send_request(&mut ws, 3, "file/exists", Some(json!({
        "path": &test_path,
    }))).await;
    assert_eq!(resp["result"]["exists"], true);

    // Stat
    let resp = send_request(&mut ws, 4, "file/stat", Some(json!({
        "path": &test_path,
    }))).await;
    assert_eq!(resp["result"]["isFile"], true);

    // Delete
    let resp = send_request(&mut ws, 5, "file/delete", Some(json!({
        "path": &test_path,
    }))).await;
    assert_eq!(resp["result"]["success"], true);

    // Verify deleted
    let resp = send_request(&mut ws, 6, "file/exists", Some(json!({
        "path": &test_path,
    }))).await;
    assert_eq!(resp["result"]["exists"], false);
}

#[tokio::test]
async fn unknown_method_returns_error() {
    let (port, token) = start_test_server().await;
    let mut ws = connect_and_auth(port, &token).await;

    let resp = send_request(&mut ws, 1, "completely/nonexistent", None).await;
    assert!(resp.get("error").is_some());
    assert_eq!(resp["error"]["code"], -32601); // MethodNotFound
}

#[tokio::test]
async fn invalid_json_rpc_version() {
    let (port, token) = start_test_server().await;
    let mut ws = connect_and_auth(port, &token).await;

    let bad = json!({ "jsonrpc": "1.0", "id": 1, "method": "file/read" });
    ws.send(Message::Text(serde_json::to_string(&bad).unwrap().into())).await.unwrap();

    let msg = timeout(Duration::from_secs(5), ws.next())
        .await.unwrap().unwrap().unwrap();
    let resp: Value = serde_json::from_str(&msg.into_text().unwrap()).unwrap();
    assert!(resp.get("error").is_some());
    assert_eq!(resp["error"]["code"], -32600); // InvalidRequest
}

#[tokio::test]
async fn malformed_json_returns_parse_error() {
    let (port, token) = start_test_server().await;
    let mut ws = connect_and_auth(port, &token).await;

    ws.send(Message::Text("not valid json at all {{{".into())).await.unwrap();

    let msg = timeout(Duration::from_secs(5), ws.next())
        .await.unwrap().unwrap().unwrap();
    let resp: Value = serde_json::from_str(&msg.into_text().unwrap()).unwrap();
    assert!(resp.get("error").is_some());
    assert_eq!(resp["error"]["code"], -32700); // ParseError
}

#[tokio::test]
async fn health_endpoint_works() {
    let (port, _token) = start_test_server().await;
    let url = format!("http://127.0.0.1:{port}/health");
    let resp = reqwest::get(&url).await.unwrap();
    assert!(resp.status().is_success());
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["status"], "ok");
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat service integration tests
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn chat_session_lifecycle_over_websocket() {
    let (port, token) = start_test_server_with_services().await;
    let mut ws = connect_and_auth(port, &token).await;

    // Create a chat session
    let resp = send_request(&mut ws, 1, "chat/session/create", Some(json!({
        "title": "Integration test session"
    }))).await;
    assert!(resp.get("result").is_some(), "Create should succeed: {resp}");
    let session_id = resp["result"]["id"].as_str().unwrap().to_string();

    // Add a message (content is stored as a serialized JSON string)
    let content = serde_json::to_string(&json!([{ "type": "text", "text": "Hello from integration test" }])).unwrap();
    let resp = send_request(&mut ws, 2, "chat/message/add", Some(json!({
        "sessionId": &session_id,
        "role": "user",
        "content": content,
    }))).await;
    assert!(resp.get("result").is_some(), "Add message should succeed: {resp}");
    let msg_id = resp["result"]["messageId"].as_str().unwrap().to_string();

    // List messages
    let resp = send_request(&mut ws, 3, "chat/message/list", Some(json!({
        "sessionId": &session_id
    }))).await;
    let messages = resp["result"].as_array().unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["id"], msg_id);

    // Get session
    let resp = send_request(&mut ws, 4, "chat/session/get", Some(json!({
        "sessionId": &session_id
    }))).await;
    assert!(resp.get("result").is_some(), "Get should succeed: {resp}");
    assert_eq!(resp["result"]["session"]["title"], "Integration test session");

    // Update session
    let resp = send_request(&mut ws, 5, "chat/session/update", Some(json!({
        "sessionId": &session_id,
        "title": "Updated title"
    }))).await;
    assert_eq!(resp["result"]["success"], true);

    // Delete session
    let resp = send_request(&mut ws, 6, "chat/session/delete", Some(json!({
        "sessionId": &session_id
    }))).await;
    assert_eq!(resp["result"]["success"], true);
}

#[tokio::test]
async fn chat_document_lifecycle_over_websocket() {
    let (port, token) = start_test_server_with_services().await;
    let mut ws = connect_and_auth(port, &token).await;

    // Create a session first (documents need a session)
    let resp = send_request(&mut ws, 1, "chat/session/create", Some(json!({
        "title": "Doc test session"
    }))).await;
    let session_id = resp["result"]["id"].as_str().unwrap().to_string();

    // Create a document — returns full document
    let resp = send_request(&mut ws, 2, "chat/document/create", Some(json!({
        "sessionId": &session_id,
        "title": "Test Document",
        "docType": "spec",
        "content": "fn main() {}",
    }))).await;
    assert!(resp.get("result").is_some(), "Create doc should succeed: {resp}");
    let doc_id = resp["result"]["id"].as_str().unwrap().to_string();
    assert_eq!(resp["result"]["title"], "Test Document");

    // Get document — returns raw document (not wrapped)
    let resp = send_request(&mut ws, 3, "chat/document/get", Some(json!({
        "id": &doc_id
    }))).await;
    assert!(resp.get("result").is_some(), "Get doc should succeed: {resp}");
    assert_eq!(resp["result"]["content"], "fn main() {}");
    assert_eq!(resp["result"]["docType"], "spec");

    // Update document — returns full updated document
    let resp = send_request(&mut ws, 4, "chat/document/update", Some(json!({
        "id": &doc_id,
        "content": "fn main() { println!(\"hello\"); }"
    }))).await;
    assert_eq!(resp["result"]["title"], "Test Document");
    assert!(resp["result"]["content"].as_str().unwrap().contains("println"));

    // List documents
    let resp = send_request(&mut ws, 5, "chat/document/list", Some(json!({
        "sessionId": &session_id
    }))).await;
    let docs = resp["result"].as_array().unwrap();
    assert_eq!(docs.len(), 1);
    assert_eq!(docs[0]["title"], "Test Document");

    // Search documents
    let resp = send_request(&mut ws, 6, "chat/document/search", Some(json!({
        "query": "hello"
    }))).await;
    let results = resp["result"].as_array().unwrap();
    assert_eq!(results.len(), 1);

    // Delete document
    let resp = send_request(&mut ws, 7, "chat/document/delete", Some(json!({
        "id": &doc_id
    }))).await;
    assert_eq!(resp["result"]["success"], true);

    // Verify deleted
    let resp = send_request(&mut ws, 8, "chat/document/list", Some(json!({
        "sessionId": &session_id
    }))).await;
    let docs = resp["result"].as_array().unwrap();
    assert_eq!(docs.len(), 0);
}

#[tokio::test]
async fn bridge_services_return_not_started_without_bridge() {
    // Without the bridge running, AI/auth/agent/workflow/syntax namespace methods
    // should return MethodNotFound since no bridge services are registered
    let (port, token) = start_test_server().await;
    let mut ws = connect_and_auth(port, &token).await;

    let resp = send_request(&mut ws, 1, "ai/models/list", None).await;
    assert!(resp.get("error").is_some(), "Should be error: {resp}");
    assert_eq!(resp["error"]["code"], -32601); // MethodNotFound

    let resp = send_request(&mut ws, 2, "auth/status", None).await;
    assert!(resp.get("error").is_some());
    assert_eq!(resp["error"]["code"], -32601);

    let resp = send_request(&mut ws, 3, "agent/list", None).await;
    assert!(resp.get("error").is_some());
    assert_eq!(resp["error"]["code"], -32601);

    let resp = send_request(&mut ws, 4, "syntax/highlight", None).await;
    assert!(resp.get("error").is_some());
    assert_eq!(resp["error"]["code"], -32601);
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-workspace integration tests
// ─────────────────────────────────────────────────────────────────────────────

/// Start a test server WITHOUT a default workspace.
async fn start_test_server_no_workspace() -> (u16, String) {
    use ecp_protocol::auth::AuthConfig;
    use ecp_server::{ECPServer, WorkspaceRegistry};
    use ecp_services::{
        chat::ChatDb,
        document::DocumentService,
    };
    use ecp_transport::server::{TransportConfig, TransportServer};

    let tmp = TempDir::new().unwrap();
    let tmp_path = Box::leak(Box::new(tmp)).path().to_path_buf();

    let auth_token = format!("test-token-{}", std::process::id());

    let global_chat_path = tmp_path.join(".ultra-global/chat.db");
    let global_chat_db = Arc::new(Mutex::new(
        ChatDb::open(&global_chat_path).expect("Failed to open global chat database"),
    ));

    let registry = WorkspaceRegistry::new(global_chat_db);
    let mut ecp_server = ECPServer::new(registry);
    ecp_server.register_service(DocumentService::new());
    ecp_server.initialize().await.unwrap();

    let config = TransportConfig {
        port: 0,
        hostname: "127.0.0.1".into(),
        auth: Some(AuthConfig {
            token: auth_token.clone(),
            handshake_timeout_ms: 5000,
            allow_legacy_auth: true,
            heartbeat_interval_ms: 30_000,
        }),
        enable_cors: false,
        max_connections: Some(16),
        workspace_root: None,
        verbose_logging: false,
        tls: None,
    };

    let transport = TransportServer::start(config, ecp_server).await.unwrap();
    let port = transport.port();
    Box::leak(Box::new(transport));

    (port, auth_token)
}

#[tokio::test]
async fn workspace_open_then_file_read() {
    let (port, token) = start_test_server_no_workspace().await;
    let mut ws = connect_and_auth(port, &token).await;

    // Without workspace/open, file/read should fail with no_workspace
    let resp = send_request(&mut ws, 1, "file/read", Some(json!({
        "path": "/tmp/test.txt"
    }))).await;
    assert!(resp.get("error").is_some());
    assert_eq!(resp["error"]["code"], -32020); // No workspace

    // Create a temp workspace directory
    let workspace = TempDir::new().unwrap();
    let workspace_path = workspace.path().to_string_lossy().to_string();

    // Open workspace
    let resp = send_request(&mut ws, 2, "workspace/open", Some(json!({
        "path": &workspace_path,
    }))).await;
    assert!(resp.get("result").is_some(), "workspace/open should succeed: {resp}");
    assert!(resp["result"]["workspaceId"].is_string());

    // Now file/write should work
    let resp = send_request(&mut ws, 3, "file/write", Some(json!({
        "path": "test.txt",
        "content": "hello from multi-workspace",
    }))).await;
    assert_eq!(resp["result"]["success"], true, "file/write should succeed: {resp}");

    // And file/read should work
    let resp = send_request(&mut ws, 4, "file/read", Some(json!({
        "path": "test.txt",
    }))).await;
    assert_eq!(resp["result"]["content"], "hello from multi-workspace");

    // Close workspace
    let resp = send_request(&mut ws, 5, "workspace/close", None).await;
    assert_eq!(resp["result"]["workspaceClosed"], true);

    // After close, file/read should fail again
    let resp = send_request(&mut ws, 6, "file/read", Some(json!({
        "path": "test.txt",
    }))).await;
    assert!(resp.get("error").is_some());
    assert_eq!(resp["error"]["code"], -32020); // No workspace
}

#[tokio::test]
async fn global_services_work_without_workspace() {
    let (port, token) = start_test_server_no_workspace().await;
    let mut ws = connect_and_auth(port, &token).await;

    // Global document service should work without a workspace
    let resp = send_request(&mut ws, 1, "document/open", Some(json!({
        "uri": "file:///tmp/test.rs",
        "content": "hello",
        "languageId": "rust",
    }))).await;
    assert!(resp.get("result").is_some(), "Global document/open should work: {resp}");
}
