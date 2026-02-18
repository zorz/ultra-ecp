//! Service-level functional tests.
//!
//! Tests each service's core operations using the `Service::handle` trait method,
//! verifying JSON-RPC request/response behavior exactly as the Mac client experiences it.

use serde_json::json;
use tempfile::TempDir;

// ─────────────────────────────────────────────────────────────────────────────
// Document service tests
// ─────────────────────────────────────────────────────────────────────────────

mod document {
    use super::*;
    use ecp_services::document::DocumentService;
    use ecp_services::Service;

    fn svc() -> DocumentService { DocumentService::new() }

    #[tokio::test]
    async fn open_and_get_content() {
        let s = svc();
        let result = s.handle("document/open", Some(json!({
            "uri": "file:///tmp/test.rs",
            "content": "fn main() {}",
            "languageId": "rust",
        }))).await.unwrap();

        let doc_id = result["documentId"].as_str().unwrap().to_string();
        assert_eq!(result["languageId"], "rust");
        assert_eq!(result["lineCount"], 1);
        assert_eq!(result["version"], 1);

        // Get content back
        let content = s.handle("document/content", Some(json!({
            "documentId": doc_id,
        }))).await.unwrap();
        assert_eq!(content["content"], "fn main() {}");
    }

    #[tokio::test]
    async fn open_detects_language() {
        let s = svc();
        let result = s.handle("document/open", Some(json!({
            "uri": "file:///tmp/test.py",
            "content": "print('hi')",
        }))).await.unwrap();
        assert_eq!(result["languageId"], "python");
    }

    #[tokio::test]
    async fn insert_text() {
        let s = svc();
        let open = s.handle("document/open", Some(json!({
            "uri": "test://doc1",
            "content": "hello world",
        }))).await.unwrap();
        let doc_id = open["documentId"].as_str().unwrap();

        // Insert " cruel" after "hello"
        let result = s.handle("document/insert", Some(json!({
            "documentId": doc_id,
            "position": {"line": 0, "column": 5},
            "text": " cruel",
        }))).await.unwrap();
        assert_eq!(result["version"], 2);

        let content = s.handle("document/content", Some(json!({
            "documentId": doc_id,
        }))).await.unwrap();
        assert_eq!(content["content"], "hello cruel world");
    }

    #[tokio::test]
    async fn delete_text() {
        let s = svc();
        let open = s.handle("document/open", Some(json!({
            "uri": "test://doc2",
            "content": "abcdef",
        }))).await.unwrap();
        let doc_id = open["documentId"].as_str().unwrap();

        s.handle("document/delete", Some(json!({
            "documentId": doc_id,
            "range": {
                "start": {"line": 0, "column": 2},
                "end": {"line": 0, "column": 4},
            },
        }))).await.unwrap();

        let content = s.handle("document/content", Some(json!({
            "documentId": doc_id,
        }))).await.unwrap();
        assert_eq!(content["content"], "abef");
    }

    #[tokio::test]
    async fn undo_redo() {
        let s = svc();
        let open = s.handle("document/open", Some(json!({
            "uri": "test://doc3",
            "content": "original",
        }))).await.unwrap();
        let doc_id = open["documentId"].as_str().unwrap();

        // Modify
        s.handle("document/insert", Some(json!({
            "documentId": doc_id,
            "position": {"line": 0, "column": 8},
            "text": " modified",
        }))).await.unwrap();

        let content = s.handle("document/content", Some(json!({"documentId": doc_id}))).await.unwrap();
        assert_eq!(content["content"], "original modified");

        // Undo
        let undo = s.handle("document/undo", Some(json!({"documentId": doc_id}))).await.unwrap();
        assert_eq!(undo["success"], true);

        let content = s.handle("document/content", Some(json!({"documentId": doc_id}))).await.unwrap();
        assert_eq!(content["content"], "original");

        // Redo
        let redo = s.handle("document/redo", Some(json!({"documentId": doc_id}))).await.unwrap();
        assert_eq!(redo["success"], true);

        let content = s.handle("document/content", Some(json!({"documentId": doc_id}))).await.unwrap();
        assert_eq!(content["content"], "original modified");
    }

    #[tokio::test]
    async fn multi_line_insert() {
        let s = svc();
        let open = s.handle("document/open", Some(json!({
            "uri": "test://ml",
            "content": "line1\nline2\nline3",
        }))).await.unwrap();
        let doc_id = open["documentId"].as_str().unwrap();

        assert_eq!(open["lineCount"], 3);

        // Insert new lines after line1
        s.handle("document/insert", Some(json!({
            "documentId": doc_id,
            "position": {"line": 0, "column": 5},
            "text": "\nnewA\nnewB",
        }))).await.unwrap();

        let content = s.handle("document/content", Some(json!({"documentId": doc_id}))).await.unwrap();
        assert_eq!(content["content"], "line1\nnewA\nnewB\nline2\nline3");
        assert_eq!(content["lineCount"], 5);
    }

    #[tokio::test]
    async fn dirty_tracking() {
        let s = svc();
        let open = s.handle("document/open", Some(json!({
            "uri": "test://dirty",
            "content": "clean",
        }))).await.unwrap();
        let doc_id = open["documentId"].as_str().unwrap();

        // Initially not dirty
        let dirty = s.handle("document/isDirty", Some(json!({"documentId": doc_id}))).await.unwrap();
        assert_eq!(dirty["isDirty"], false);

        // Make edit
        s.handle("document/insert", Some(json!({
            "documentId": doc_id,
            "position": {"line": 0, "column": 5},
            "text": "!",
        }))).await.unwrap();

        let dirty = s.handle("document/isDirty", Some(json!({"documentId": doc_id}))).await.unwrap();
        assert_eq!(dirty["isDirty"], true);

        // Mark clean
        s.handle("document/markClean", Some(json!({"documentId": doc_id}))).await.unwrap();
        let dirty = s.handle("document/isDirty", Some(json!({"documentId": doc_id}))).await.unwrap();
        assert_eq!(dirty["isDirty"], false);
    }

    #[tokio::test]
    async fn list_documents() {
        let s = svc();
        s.handle("document/open", Some(json!({"uri": "test://a", "content": "a"}))).await.unwrap();
        s.handle("document/open", Some(json!({"uri": "test://b", "content": "b"}))).await.unwrap();

        let list = s.handle("document/list", None).await.unwrap();
        let docs = list["documents"].as_array().unwrap();
        assert_eq!(docs.len(), 2);
    }

    #[tokio::test]
    async fn close_document() {
        let s = svc();
        let open = s.handle("document/open", Some(json!({"uri": "test://close", "content": "x"}))).await.unwrap();
        let doc_id = open["documentId"].as_str().unwrap();

        let result = s.handle("document/close", Some(json!({"documentId": doc_id}))).await.unwrap();
        assert_eq!(result["success"], true);

        // Info should fail after close
        let err = s.handle("document/info", Some(json!({"documentId": doc_id}))).await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn unknown_method_returns_error() {
        let s = svc();
        let err = s.handle("document/nonexistent", None).await;
        assert!(err.is_err());
        let e = err.unwrap_err();
        assert_eq!(e.code, -32601);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// File service tests
// ─────────────────────────────────────────────────────────────────────────────

mod file {
    use super::*;
    use ecp_services::file::FileService;
    use ecp_services::Service;

    #[tokio::test]
    async fn write_and_read_file() {
        let tmp = TempDir::new().unwrap();
        let s = FileService::new(tmp.path().to_path_buf());

        s.handle("file/write", Some(json!({
            "path": "test.txt",
            "content": "hello world",
        }))).await.unwrap();

        let result = s.handle("file/read", Some(json!({"path": "test.txt"}))).await.unwrap();
        assert_eq!(result["content"], "hello world");
    }

    #[tokio::test]
    async fn file_exists() {
        let tmp = TempDir::new().unwrap();
        let s = FileService::new(tmp.path().to_path_buf());

        let result = s.handle("file/exists", Some(json!({"path": "nope.txt"}))).await.unwrap();
        assert_eq!(result["exists"], false);

        s.handle("file/write", Some(json!({"path": "yes.txt", "content": "x"}))).await.unwrap();
        let result = s.handle("file/exists", Some(json!({"path": "yes.txt"}))).await.unwrap();
        assert_eq!(result["exists"], true);
    }

    #[tokio::test]
    async fn file_stat() {
        let tmp = TempDir::new().unwrap();
        let s = FileService::new(tmp.path().to_path_buf());

        s.handle("file/write", Some(json!({"path": "stat.txt", "content": "12345"}))).await.unwrap();
        let result = s.handle("file/stat", Some(json!({"path": "stat.txt"}))).await.unwrap();
        assert_eq!(result["isFile"], true);
        assert_eq!(result["isDirectory"], false);
        assert_eq!(result["size"], 5);
    }

    #[tokio::test]
    async fn directory_operations() {
        let tmp = TempDir::new().unwrap();
        let s = FileService::new(tmp.path().to_path_buf());

        s.handle("file/createDir", Some(json!({"path": "mydir"}))).await.unwrap();
        let stat = s.handle("file/stat", Some(json!({"path": "mydir"}))).await.unwrap();
        assert_eq!(stat["isDirectory"], true);

        // Write a file into it
        s.handle("file/write", Some(json!({"path": "mydir/file.txt", "content": "hi"}))).await.unwrap();

        // List directory
        let list = s.handle("file/readDir", Some(json!({"path": "mydir"}))).await.unwrap();
        let entries = list["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["name"], "file.txt");
    }

    #[tokio::test]
    async fn file_rename() {
        let tmp = TempDir::new().unwrap();
        let s = FileService::new(tmp.path().to_path_buf());

        s.handle("file/write", Some(json!({"path": "old.txt", "content": "data"}))).await.unwrap();
        s.handle("file/rename", Some(json!({"from": "old.txt", "to": "new.txt"}))).await.unwrap();

        let exists_old = s.handle("file/exists", Some(json!({"path": "old.txt"}))).await.unwrap();
        assert_eq!(exists_old["exists"], false);

        let result = s.handle("file/read", Some(json!({"path": "new.txt"}))).await.unwrap();
        assert_eq!(result["content"], "data");
    }

    #[tokio::test]
    async fn file_copy() {
        let tmp = TempDir::new().unwrap();
        let s = FileService::new(tmp.path().to_path_buf());

        s.handle("file/write", Some(json!({"path": "src.txt", "content": "copy me"}))).await.unwrap();
        s.handle("file/copy", Some(json!({"from": "src.txt", "to": "dst.txt"}))).await.unwrap();

        let result = s.handle("file/read", Some(json!({"path": "dst.txt"}))).await.unwrap();
        assert_eq!(result["content"], "copy me");
    }

    #[tokio::test]
    async fn file_delete() {
        let tmp = TempDir::new().unwrap();
        let s = FileService::new(tmp.path().to_path_buf());

        s.handle("file/write", Some(json!({"path": "del.txt", "content": "bye"}))).await.unwrap();
        s.handle("file/delete", Some(json!({"path": "del.txt"}))).await.unwrap();

        let exists = s.handle("file/exists", Some(json!({"path": "del.txt"}))).await.unwrap();
        assert_eq!(exists["exists"], false);
    }

    #[tokio::test]
    async fn path_helpers() {
        let tmp = TempDir::new().unwrap();
        let s = FileService::new(tmp.path().to_path_buf());

        let result = s.handle("file/getParent", Some(json!({"path": "/foo/bar/baz.txt"}))).await.unwrap();
        assert_eq!(result["parent"], "/foo/bar");

        let result = s.handle("file/getBasename", Some(json!({"path": "/foo/bar/baz.txt"}))).await.unwrap();
        assert_eq!(result["basename"], "baz.txt");

        let result = s.handle("file/join", Some(json!({"base": "/foo", "segments": ["bar", "baz.txt"]}))).await.unwrap();
        assert_eq!(result["path"], "/foo/bar/baz.txt");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat service tests (SQLite-backed)
// ─────────────────────────────────────────────────────────────────────────────

mod chat {
    use super::*;
    use ecp_services::chat::ChatService;
    use ecp_services::Service;

    fn svc() -> (TempDir, ChatService) {
        let tmp = TempDir::new().unwrap();
        let s = ChatService::new(tmp.path());
        (tmp, s)
    }

    #[tokio::test]
    async fn session_crud() {
        let (_tmp, s) = svc();

        // Create
        let result = s.handle("chat/session/create", Some(json!({
            "title": "Test Chat",
            "provider": "claude",
            "model": "claude-sonnet-4-20250514",
        }))).await.unwrap();
        let sid = result["sessionId"].as_str().unwrap().to_string();
        assert!(sid.starts_with("sess-"));

        // Get
        let result = s.handle("chat/session/get", Some(json!({"sessionId": &sid}))).await.unwrap();
        assert_eq!(result["session"]["title"], "Test Chat");
        assert_eq!(result["session"]["provider"], "claude");
        assert_eq!(result["session"]["status"], "active");

        // Update
        s.handle("chat/session/update", Some(json!({
            "sessionId": &sid,
            "title": "Updated Title",
            "status": "completed",
        }))).await.unwrap();

        let result = s.handle("chat/session/get", Some(json!({"sessionId": &sid}))).await.unwrap();
        assert_eq!(result["session"]["title"], "Updated Title");
        assert_eq!(result["session"]["status"], "completed");

        // List
        let result = s.handle("chat/session/list", None).await.unwrap();
        assert_eq!(result["sessions"].as_array().unwrap().len(), 1);

        // Delete
        s.handle("chat/session/delete", Some(json!({"sessionId": &sid}))).await.unwrap();
        let result = s.handle("chat/session/list", None).await.unwrap();
        assert_eq!(result["sessions"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn message_crud() {
        let (_tmp, s) = svc();

        let sess = s.handle("chat/session/create", Some(json!({"title": "Msg Test"}))).await.unwrap();
        let sid = sess["sessionId"].as_str().unwrap();

        // Add messages
        let m1 = s.handle("chat/message/add", Some(json!({
            "sessionId": sid,
            "role": "user",
            "content": "Hello!",
        }))).await.unwrap();
        let msg_id = m1["messageId"].as_str().unwrap().to_string();

        s.handle("chat/message/add", Some(json!({
            "sessionId": sid,
            "role": "assistant",
            "content": "Hi there!",
            "model": "claude-sonnet-4-20250514",
            "inputTokens": 10,
            "outputTokens": 5,
        }))).await.unwrap();

        // List
        let result = s.handle("chat/message/list", Some(json!({"sessionId": sid}))).await.unwrap();
        let messages = result["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[1]["role"], "assistant");

        // Search
        let result = s.handle("chat/message/search", Some(json!({
            "query": "Hello",
        }))).await.unwrap();
        assert!(result["messages"].as_array().unwrap().len() >= 1);

        // Delete
        s.handle("chat/message/delete", Some(json!({"id": &msg_id}))).await.unwrap();
        let result = s.handle("chat/message/list", Some(json!({"sessionId": sid}))).await.unwrap();
        assert_eq!(result["messages"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn tool_calls() {
        let (_tmp, s) = svc();

        let sess = s.handle("chat/session/create", Some(json!({"title": "TC"}))).await.unwrap();
        let sid = sess["sessionId"].as_str().unwrap();

        let tc = s.handle("chat/toolCall/add", Some(json!({
            "sessionId": sid,
            "toolName": "file/read",
            "input": {"path": "/tmp/test.txt"},
        }))).await.unwrap();
        let tc_id = tc["toolCallId"].as_str().unwrap().to_string();

        // Complete
        s.handle("chat/toolCall/complete", Some(json!({
            "id": &tc_id,
            "output": {"content": "file contents"},
            "status": "success",
        }))).await.unwrap();

        // List
        let result = s.handle("chat/toolCall/list", Some(json!({"sessionId": sid}))).await.unwrap();
        let calls = result["toolCalls"].as_array().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["toolName"], "file/read");
        assert_eq!(calls[0]["status"], "success");
    }

    #[tokio::test]
    async fn todos() {
        let (_tmp, s) = svc();

        let sess = s.handle("chat/session/create", Some(json!({"title": "Todos"}))).await.unwrap();
        let sid = sess["sessionId"].as_str().unwrap();

        s.handle("chat/todo/upsert", Some(json!({
            "sessionId": sid,
            "content": "Write tests",
            "activeForm": "Writing tests",
            "status": "in_progress",
            "orderIndex": 0,
        }))).await.unwrap();

        s.handle("chat/todo/upsert", Some(json!({
            "sessionId": sid,
            "content": "Run tests",
            "activeForm": "Running tests",
            "status": "pending",
            "orderIndex": 1,
        }))).await.unwrap();

        let result = s.handle("chat/todo/list", Some(json!({"sessionId": sid}))).await.unwrap();
        let todos = result["todos"].as_array().unwrap();
        assert_eq!(todos.len(), 2);
        assert_eq!(todos[0]["content"], "Write tests");
        assert_eq!(todos[0]["status"], "in_progress");
    }

    #[tokio::test]
    async fn permissions() {
        let (_tmp, s) = svc();

        let sess = s.handle("chat/session/create", Some(json!({"title": "Perms"}))).await.unwrap();
        let sid = sess["sessionId"].as_str().unwrap();

        // No permission initially
        let check = s.handle("chat/permission/check", Some(json!({
            "toolName": "file/write",
            "sessionId": sid,
        }))).await.unwrap();
        assert_eq!(check["allowed"], false);

        // Grant
        s.handle("chat/permission/grant", Some(json!({
            "sessionId": sid,
            "toolName": "file/write",
            "scope": "session",
        }))).await.unwrap();

        // Now allowed
        let check = s.handle("chat/permission/check", Some(json!({
            "toolName": "file/write",
            "sessionId": sid,
        }))).await.unwrap();
        assert_eq!(check["allowed"], true);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Secret service tests
// ─────────────────────────────────────────────────────────────────────────────

mod secret {
    use super::*;
    use ecp_services::secret::SecretService;
    use ecp_services::Service;

    #[tokio::test]
    async fn providers_list() {
        let s = SecretService::new();
        let result = s.handle("secret/providers", None).await.unwrap();
        let providers = result["providers"].as_array().unwrap();
        assert!(providers.len() >= 2); // env + file at minimum
    }

    #[tokio::test]
    async fn env_provider_reads_env_var() {
        // Set an env var that the env provider knows about
        // SAFETY: This test is single-threaded for this env var usage
        unsafe { std::env::set_var("ANTHROPIC_API_KEY", "test-key-12345") };
        let s = SecretService::new();

        let result = s.handle("secret/get", Some(json!({"key": "ANTHROPIC_API_KEY"}))).await.unwrap();
        assert_eq!(result["value"], "test-key-12345");
        assert_eq!(result["provider"], "env");

        let has = s.handle("secret/has", Some(json!({"key": "ANTHROPIC_API_KEY"}))).await.unwrap();
        assert_eq!(has["has"], true);

        unsafe { std::env::remove_var("ANTHROPIC_API_KEY") };
    }

    #[tokio::test]
    async fn nonexistent_key() {
        let s = SecretService::new();
        let result = s.handle("secret/get", Some(json!({"key": "TOTALLY_FAKE_KEY_XYZ"}))).await.unwrap();
        assert!(result["value"].is_null());
    }

    #[tokio::test]
    async fn unknown_method() {
        let s = SecretService::new();
        let err = s.handle("secret/nonexistent", None).await;
        assert!(err.is_err());
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Database service tests
// ─────────────────────────────────────────────────────────────────────────────

mod database {
    use super::*;
    use ecp_services::database::DatabaseService;
    use ecp_services::Service;

    #[tokio::test]
    async fn connection_config_crud() {
        let tmp = TempDir::new().unwrap();
        let s = DatabaseService::new(tmp.path().to_path_buf());

        // Create
        let result = s.handle("database/createConnection", Some(json!({
            "name": "Test DB",
            "host": "localhost",
            "port": 5432,
            "database": "testdb",
            "username": "user",
            "password": "pass",
        }))).await.unwrap();
        let conn_id = result["connectionId"].as_str().unwrap().to_string();
        assert!(conn_id.starts_with("conn-"));

        // List
        let result = s.handle("database/listConnections", None).await.unwrap();
        let conns = result["connections"].as_array().unwrap();
        assert_eq!(conns.len(), 1);
        assert_eq!(conns[0]["name"], "Test DB");
        assert_eq!(conns[0]["host"], "localhost");
        assert_eq!(conns[0]["status"], "disconnected");

        // Get
        let result = s.handle("database/getConnection", Some(json!({"connectionId": &conn_id}))).await.unwrap();
        assert_eq!(result["name"], "Test DB");
        assert_eq!(result["database"], "testdb");

        // Update
        s.handle("database/updateConnection", Some(json!({
            "connectionId": &conn_id,
            "name": "Updated DB",
        }))).await.unwrap();

        let result = s.handle("database/getConnection", Some(json!({"connectionId": &conn_id}))).await.unwrap();
        assert_eq!(result["name"], "Updated DB");

        // Delete
        s.handle("database/deleteConnection", Some(json!({"connectionId": &conn_id}))).await.unwrap();
        let result = s.handle("database/listConnections", None).await.unwrap();
        assert_eq!(result["connections"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn favorites() {
        let tmp = TempDir::new().unwrap();
        let s = DatabaseService::new(tmp.path().to_path_buf());

        s.handle("database/favoriteQuery", Some(json!({
            "name": "All users",
            "sql": "SELECT * FROM users",
        }))).await.unwrap();

        let result = s.handle("database/getFavorites", None).await.unwrap();
        let favs = result["favorites"].as_array().unwrap();
        assert_eq!(favs.len(), 1);
        assert_eq!(favs[0]["name"], "All users");
        assert_eq!(favs[0]["sql"], "SELECT * FROM users");
    }

    #[tokio::test]
    async fn history_management() {
        let tmp = TempDir::new().unwrap();
        let s = DatabaseService::new(tmp.path().to_path_buf());

        let result = s.handle("database/history", None).await.unwrap();
        assert_eq!(result["total"], 0);

        s.handle("database/clearHistory", None).await.unwrap();
    }

    #[tokio::test]
    async fn connect_nonexistent_fails() {
        let tmp = TempDir::new().unwrap();
        let s = DatabaseService::new(tmp.path().to_path_buf());

        let err = s.handle("database/connect", Some(json!({"connectionId": "nonexistent"}))).await;
        assert!(err.is_err());
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Watch service tests
// ─────────────────────────────────────────────────────────────────────────────

mod watch {
    use super::*;
    use ecp_services::watch::WatchService;
    use ecp_services::Service;

    #[tokio::test]
    async fn watch_and_list() {
        let tmp = TempDir::new().unwrap();
        let s = WatchService::new(tmp.path().to_path_buf());

        let result = s.handle("watch/start", Some(json!({
            "path": ".",
            "recursive": true,
        }))).await.unwrap();
        let watch_id = result["watchId"].as_str().unwrap().to_string();

        let list = s.handle("watch/list", None).await.unwrap();
        assert_eq!(list["watches"].as_array().unwrap().len(), 1);

        let result = s.handle("watch/stop", Some(json!({"watchId": &watch_id}))).await.unwrap();
        assert_eq!(result["success"], true);

        let list = s.handle("watch/list", None).await.unwrap();
        assert_eq!(list["watches"].as_array().unwrap().len(), 0);
    }
}
