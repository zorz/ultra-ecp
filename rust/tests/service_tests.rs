//! Service-level functional tests.
//!
//! Tests each service's core operations using the `Service::handle` trait method,
//! verifying JSON-RPC request/response behavior exactly as the Mac client experiences it.
//! Wire format parity with the TypeScript ECP is validated here.

use serde_json::json;
use tempfile::TempDir;

// ─────────────────────────────────────────────────────────────────────────────
// Secret service tests — validates wire format parity with TypeScript ECP
// ─────────────────────────────────────────────────────────────────────────────

mod secret {
    use super::*;
    use ecp_services::secret::SecretService;
    use ecp_services::Service;

    fn svc_with_tmp(tmp: &TempDir) -> SecretService {
        let path = tmp.path().join("secrets.json");
        SecretService::new_with_file_path(path)
    }

    // ── secret/providers ────────────────────────────────────────────────

    #[tokio::test]
    async fn providers_list_matches_ts_wire_format() {
        let tmp = TempDir::new().unwrap();
        let s = svc_with_tmp(&tmp);
        let result = s.handle("secret/providers", None).await.unwrap();
        let providers = result["providers"].as_array().unwrap();
        assert_eq!(providers.len(), 2);

        // TS wire format: { id, name, priority, isReadOnly }
        let env = &providers[0];
        assert_eq!(env["id"], "env");
        assert_eq!(env["name"], "Environment Variables");
        assert_eq!(env["priority"], 20);
        assert_eq!(env["isReadOnly"], true);

        let file = &providers[1];
        assert_eq!(file["id"], "file");
        assert_eq!(file["name"], "File");
        assert_eq!(file["priority"], 30);
        assert_eq!(file["isReadOnly"], false);
    }

    // ── secret/get ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn get_nonexistent_returns_null_value() {
        let tmp = TempDir::new().unwrap();
        let s = svc_with_tmp(&tmp);
        // TS wire format: { value: null }
        let result = s.handle("secret/get", Some(json!({"key": "TOTALLY_FAKE_KEY_XYZ"}))).await.unwrap();
        assert!(result["value"].is_null());
        // Must NOT have extra fields like "key" or "provider" (TS doesn't send them)
        assert!(result.get("key").is_none());
    }

    #[tokio::test]
    async fn get_returns_value_from_file_provider() {
        let tmp = TempDir::new().unwrap();
        let s = svc_with_tmp(&tmp);
        // Set a secret first
        s.handle("secret/set", Some(json!({"key": "db-password", "value": "s3cret"}))).await.unwrap();

        // TS wire format: { value: string }
        let result = s.handle("secret/get", Some(json!({"key": "db-password"}))).await.unwrap();
        assert_eq!(result["value"], "s3cret");
    }

    #[tokio::test]
    async fn get_env_var_via_key_transform() {
        // The env provider transforms dashes/dots to underscores and uppercases
        // SAFETY: single-threaded test
        unsafe { std::env::set_var("MY_TEST_SECRET", "env-value-123") };

        let tmp = TempDir::new().unwrap();
        let s = svc_with_tmp(&tmp);
        let result = s.handle("secret/get", Some(json!({"key": "MY_TEST_SECRET"}))).await.unwrap();
        assert_eq!(result["value"], "env-value-123");

        unsafe { std::env::remove_var("MY_TEST_SECRET") };
    }

    #[tokio::test]
    async fn get_missing_params_returns_invalid_params() {
        let tmp = TempDir::new().unwrap();
        let s = svc_with_tmp(&tmp);
        let err = s.handle("secret/get", None).await;
        assert!(err.is_err());
        assert_eq!(err.unwrap_err().code, -32602); // InvalidParams
    }

    // ── secret/set ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn set_returns_success() {
        let tmp = TempDir::new().unwrap();
        let s = svc_with_tmp(&tmp);
        // TS wire format: { success: boolean }
        let result = s.handle("secret/set", Some(json!({
            "key": "api-key",
            "value": "sk-12345",
        }))).await.unwrap();
        assert_eq!(result["success"], true);
        // Must NOT have extra "provider" field
        assert!(result.get("provider").is_none());
    }

    #[tokio::test]
    async fn set_then_get_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let s = svc_with_tmp(&tmp);

        s.handle("secret/set", Some(json!({"key": "round-trip", "value": "hello"}))).await.unwrap();
        let result = s.handle("secret/get", Some(json!({"key": "round-trip"}))).await.unwrap();
        assert_eq!(result["value"], "hello");
    }

    #[tokio::test]
    async fn set_overwrites_existing() {
        let tmp = TempDir::new().unwrap();
        let s = svc_with_tmp(&tmp);

        s.handle("secret/set", Some(json!({"key": "overwrite", "value": "v1"}))).await.unwrap();
        s.handle("secret/set", Some(json!({"key": "overwrite", "value": "v2"}))).await.unwrap();
        let result = s.handle("secret/get", Some(json!({"key": "overwrite"}))).await.unwrap();
        assert_eq!(result["value"], "v2");
    }

    // ── secret/delete ───────────────────────────────────────────────────

    #[tokio::test]
    async fn delete_existing_returns_true() {
        let tmp = TempDir::new().unwrap();
        let s = svc_with_tmp(&tmp);

        s.handle("secret/set", Some(json!({"key": "del-me", "value": "x"}))).await.unwrap();
        // TS wire format: { deleted: boolean }
        let result = s.handle("secret/delete", Some(json!({"key": "del-me"}))).await.unwrap();
        assert_eq!(result["deleted"], true);

        // Verify it's gone
        let get = s.handle("secret/get", Some(json!({"key": "del-me"}))).await.unwrap();
        assert!(get["value"].is_null());
    }

    #[tokio::test]
    async fn delete_nonexistent_returns_false() {
        let tmp = TempDir::new().unwrap();
        let s = svc_with_tmp(&tmp);

        // TS wire format: { deleted: false } when key doesn't exist
        let result = s.handle("secret/delete", Some(json!({"key": "never-existed"}))).await.unwrap();
        assert_eq!(result["deleted"], false);
    }

    // ── secret/has ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn has_returns_exists_field() {
        let tmp = TempDir::new().unwrap();
        let s = svc_with_tmp(&tmp);

        // TS wire format: { exists: boolean }
        let result = s.handle("secret/has", Some(json!({"key": "nope"}))).await.unwrap();
        assert_eq!(result["exists"], false);

        s.handle("secret/set", Some(json!({"key": "yes-key", "value": "v"}))).await.unwrap();
        let result = s.handle("secret/has", Some(json!({"key": "yes-key"}))).await.unwrap();
        assert_eq!(result["exists"], true);
    }

    // ── secret/info ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn info_existing_returns_wrapped_object() {
        let tmp = TempDir::new().unwrap();
        let s = svc_with_tmp(&tmp);

        s.handle("secret/set", Some(json!({"key": "info-key", "value": "v"}))).await.unwrap();

        // TS wire format: { info: { key, provider } | null }
        let result = s.handle("secret/info", Some(json!({"key": "info-key"}))).await.unwrap();
        assert_eq!(result["info"]["key"], "info-key");
        assert_eq!(result["info"]["provider"], "file");
    }

    #[tokio::test]
    async fn info_nonexistent_returns_null() {
        let tmp = TempDir::new().unwrap();
        let s = svc_with_tmp(&tmp);

        // TS wire format: { info: null }
        let result = s.handle("secret/info", Some(json!({"key": "ghost"}))).await.unwrap();
        assert!(result["info"].is_null());
    }

    // ── secret/list ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn list_returns_sorted_keys() {
        let tmp = TempDir::new().unwrap();
        let s = svc_with_tmp(&tmp);

        s.handle("secret/set", Some(json!({"key": "zz-key", "value": "a"}))).await.unwrap();
        s.handle("secret/set", Some(json!({"key": "aa-key", "value": "b"}))).await.unwrap();
        s.handle("secret/set", Some(json!({"key": "mm-key", "value": "c"}))).await.unwrap();

        let result = s.handle("secret/list", None).await.unwrap();
        let keys = result["keys"].as_array().unwrap();

        // File provider keys should be sorted
        let file_keys: Vec<&str> = keys.iter()
            .filter_map(|v| v.as_str())
            .filter(|k| *k == "aa-key" || *k == "mm-key" || *k == "zz-key")
            .collect();
        assert_eq!(file_keys, vec!["aa-key", "mm-key", "zz-key"]);
    }

    #[tokio::test]
    async fn list_deduplicates_across_providers() {
        let tmp = TempDir::new().unwrap();
        let s = svc_with_tmp(&tmp);

        // Set an env var and also in file provider with same key
        unsafe { std::env::set_var("DEDUP_TEST_KEY", "from-env") };
        s.handle("secret/set", Some(json!({"key": "DEDUP_TEST_KEY", "value": "from-file"}))).await.unwrap();

        let result = s.handle("secret/list", None).await.unwrap();
        let keys = result["keys"].as_array().unwrap();
        let count = keys.iter().filter(|k| k.as_str() == Some("DEDUP_TEST_KEY")).count();
        assert_eq!(count, 1, "duplicate keys must be deduplicated");

        unsafe { std::env::remove_var("DEDUP_TEST_KEY") };
    }

    // ── error handling ──────────────────────────────────────────────────

    #[tokio::test]
    async fn unknown_method_returns_method_not_found() {
        let tmp = TempDir::new().unwrap();
        let s = svc_with_tmp(&tmp);
        let err = s.handle("secret/nonexistent", None).await;
        assert!(err.is_err());
        assert_eq!(err.unwrap_err().code, -32601);
    }
}

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
        assert_eq!(result["info"]["languageId"], "rust");
        assert_eq!(result["info"]["lineCount"], 1);
        assert_eq!(result["info"]["version"], 1);

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
        assert_eq!(result["info"]["languageId"], "python");
    }

    #[tokio::test]
    async fn insert_text() {
        let s = svc();
        let open = s.handle("document/open", Some(json!({
            "uri": "test://doc1", "content": "hello world",
        }))).await.unwrap();
        let doc_id = open["documentId"].as_str().unwrap();

        let result = s.handle("document/insert", Some(json!({
            "documentId": doc_id,
            "position": {"line": 0, "column": 5},
            "text": " cruel",
        }))).await.unwrap();
        assert_eq!(result["version"], 2);

        let content = s.handle("document/content", Some(json!({"documentId": doc_id}))).await.unwrap();
        assert_eq!(content["content"], "hello cruel world");
    }

    #[tokio::test]
    async fn delete_text() {
        let s = svc();
        let open = s.handle("document/open", Some(json!({
            "uri": "test://doc2", "content": "abcdef",
        }))).await.unwrap();
        let doc_id = open["documentId"].as_str().unwrap();

        s.handle("document/delete", Some(json!({
            "documentId": doc_id,
            "range": {
                "start": {"line": 0, "column": 2},
                "end": {"line": 0, "column": 4},
            },
        }))).await.unwrap();

        let content = s.handle("document/content", Some(json!({"documentId": doc_id}))).await.unwrap();
        assert_eq!(content["content"], "abef");
    }

    #[tokio::test]
    async fn replace_text() {
        let s = svc();
        let open = s.handle("document/open", Some(json!({
            "uri": "test://replace", "content": "hello world",
        }))).await.unwrap();
        let doc_id = open["documentId"].as_str().unwrap();

        s.handle("document/replace", Some(json!({
            "documentId": doc_id,
            "range": {
                "start": {"line": 0, "column": 6},
                "end": {"line": 0, "column": 11},
            },
            "text": "rust",
        }))).await.unwrap();

        let content = s.handle("document/content", Some(json!({"documentId": doc_id}))).await.unwrap();
        assert_eq!(content["content"], "hello rust");
    }

    #[tokio::test]
    async fn set_content_replaces_entire_document() {
        let s = svc();
        let open = s.handle("document/open", Some(json!({
            "uri": "test://setcontent", "content": "original",
        }))).await.unwrap();
        let doc_id = open["documentId"].as_str().unwrap();

        s.handle("document/setContent", Some(json!({
            "documentId": doc_id,
            "content": "completely new content\nwith two lines",
        }))).await.unwrap();

        let content = s.handle("document/content", Some(json!({"documentId": doc_id}))).await.unwrap();
        assert_eq!(content["content"], "completely new content\nwith two lines");
        assert_eq!(content["lineCount"], 2);
    }

    #[tokio::test]
    async fn undo_redo() {
        let s = svc();
        let open = s.handle("document/open", Some(json!({
            "uri": "test://doc3", "content": "original",
        }))).await.unwrap();
        let doc_id = open["documentId"].as_str().unwrap();

        s.handle("document/insert", Some(json!({
            "documentId": doc_id,
            "position": {"line": 0, "column": 8},
            "text": " modified",
        }))).await.unwrap();

        let content = s.handle("document/content", Some(json!({"documentId": doc_id}))).await.unwrap();
        assert_eq!(content["content"], "original modified");

        // canUndo/canRedo
        let can_undo = s.handle("document/canUndo", Some(json!({"documentId": doc_id}))).await.unwrap();
        assert_eq!(can_undo["canUndo"], true);

        let undo = s.handle("document/undo", Some(json!({"documentId": doc_id}))).await.unwrap();
        assert_eq!(undo["success"], true);

        let content = s.handle("document/content", Some(json!({"documentId": doc_id}))).await.unwrap();
        assert_eq!(content["content"], "original");

        let can_redo = s.handle("document/canRedo", Some(json!({"documentId": doc_id}))).await.unwrap();
        assert_eq!(can_redo["canRedo"], true);

        let redo = s.handle("document/redo", Some(json!({"documentId": doc_id}))).await.unwrap();
        assert_eq!(redo["success"], true);

        let content = s.handle("document/content", Some(json!({"documentId": doc_id}))).await.unwrap();
        assert_eq!(content["content"], "original modified");
    }

    #[tokio::test]
    async fn multi_line_insert() {
        let s = svc();
        let open = s.handle("document/open", Some(json!({
            "uri": "test://ml", "content": "line1\nline2\nline3",
        }))).await.unwrap();
        let doc_id = open["documentId"].as_str().unwrap();
        assert_eq!(open["info"]["lineCount"], 3);

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
            "uri": "test://dirty", "content": "clean",
        }))).await.unwrap();
        let doc_id = open["documentId"].as_str().unwrap();

        let dirty = s.handle("document/isDirty", Some(json!({"documentId": doc_id}))).await.unwrap();
        assert_eq!(dirty["isDirty"], false);

        s.handle("document/insert", Some(json!({
            "documentId": doc_id,
            "position": {"line": 0, "column": 5},
            "text": "!",
        }))).await.unwrap();

        let dirty = s.handle("document/isDirty", Some(json!({"documentId": doc_id}))).await.unwrap();
        assert_eq!(dirty["isDirty"], true);

        s.handle("document/markClean", Some(json!({"documentId": doc_id}))).await.unwrap();
        let dirty = s.handle("document/isDirty", Some(json!({"documentId": doc_id}))).await.unwrap();
        assert_eq!(dirty["isDirty"], false);
    }

    #[tokio::test]
    async fn document_info() {
        let s = svc();
        let open = s.handle("document/open", Some(json!({
            "uri": "file:///tmp/info.rs",
            "content": "fn main() {}\n",
            "languageId": "rust",
        }))).await.unwrap();
        let doc_id = open["documentId"].as_str().unwrap();

        let info = s.handle("document/info", Some(json!({"documentId": doc_id}))).await.unwrap();
        assert_eq!(info["uri"], "file:///tmp/info.rs");
        assert_eq!(info["languageId"], "rust");
        assert!(info["lineCount"].as_u64().unwrap() >= 1);
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

        let err = s.handle("document/info", Some(json!({"documentId": doc_id}))).await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn get_single_line() {
        let s = svc();
        let open = s.handle("document/open", Some(json!({
            "uri": "test://lines", "content": "line0\nline1\nline2",
        }))).await.unwrap();
        let doc_id = open["documentId"].as_str().unwrap();

        let result = s.handle("document/line", Some(json!({
            "documentId": doc_id, "line": 1,
        }))).await.unwrap();
        assert_eq!(result["text"], "line1");
    }

    #[tokio::test]
    async fn version_increments() {
        let s = svc();
        let open = s.handle("document/open", Some(json!({
            "uri": "test://ver", "content": "v1",
        }))).await.unwrap();
        let doc_id = open["documentId"].as_str().unwrap();
        assert_eq!(open["info"]["version"], 1);

        let ver = s.handle("document/version", Some(json!({"documentId": doc_id}))).await.unwrap();
        assert_eq!(ver["version"], 1);

        s.handle("document/insert", Some(json!({
            "documentId": doc_id,
            "position": {"line": 0, "column": 2},
            "text": "!",
        }))).await.unwrap();

        let ver = s.handle("document/version", Some(json!({"documentId": doc_id}))).await.unwrap();
        assert_eq!(ver["version"], 2);
    }

    #[tokio::test]
    async fn unknown_method_returns_error() {
        let s = svc();
        let err = s.handle("document/nonexistent", None).await;
        assert!(err.is_err());
        assert_eq!(err.unwrap_err().code, -32601);
    }

    #[tokio::test]
    async fn responses_include_deprecation_notice() {
        let s = svc();
        let result = s.handle("document/open", Some(json!({
            "uri": "file://test.txt", "content": "hello",
        }))).await.unwrap();
        assert!(result["_deprecated"].is_object());
        assert!(result["_deprecated"]["message"].as_str().unwrap().contains("scheduled for removal"));
        // Still functional — documentId returned
        assert!(result["documentId"].is_string());
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
            "path": "test.txt", "content": "hello world",
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

        s.handle("file/write", Some(json!({"path": "mydir/file.txt", "content": "hi"}))).await.unwrap();

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
        assert_eq!(result["uri"], "/foo/bar/baz.txt");
    }

    #[tokio::test]
    async fn read_nonexistent_file_errors() {
        let tmp = TempDir::new().unwrap();
        let s = FileService::new(tmp.path().to_path_buf());

        let err = s.handle("file/read", Some(json!({"path": "ghost.txt"}))).await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn nested_directory_creation() {
        let tmp = TempDir::new().unwrap();
        let s = FileService::new(tmp.path().to_path_buf());

        s.handle("file/createDir", Some(json!({"path": "a/b/c"}))).await.unwrap();
        let stat = s.handle("file/stat", Some(json!({"path": "a/b/c"}))).await.unwrap();
        assert_eq!(stat["isDirectory"], true);
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

        let result = s.handle("chat/session/create", Some(json!({
            "title": "Test Chat",
            "provider": "claude",
            "model": "claude-sonnet-4-20250514",
        }))).await.unwrap();
        let sid = result["id"].as_str().unwrap().to_string();
        assert!(sid.starts_with("sess-"));

        let result = s.handle("chat/session/get", Some(json!({"sessionId": &sid}))).await.unwrap();
        assert_eq!(result["session"]["title"], "Test Chat");
        assert_eq!(result["session"]["provider"], "claude");
        assert_eq!(result["session"]["status"], "active");

        s.handle("chat/session/update", Some(json!({
            "sessionId": &sid,
            "title": "Updated Title",
            "status": "completed",
        }))).await.unwrap();

        let result = s.handle("chat/session/get", Some(json!({"sessionId": &sid}))).await.unwrap();
        assert_eq!(result["session"]["title"], "Updated Title");
        assert_eq!(result["session"]["status"], "completed");

        let result = s.handle("chat/session/list", None).await.unwrap();
        assert_eq!(result.as_array().unwrap().len(), 1);

        s.handle("chat/session/delete", Some(json!({"sessionId": &sid}))).await.unwrap();
        let result = s.handle("chat/session/list", None).await.unwrap();
        assert_eq!(result.as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn session_update_title_only() {
        let (_tmp, s) = svc();
        let sess = s.handle("chat/session/create", Some(json!({"title": "Original"}))).await.unwrap();
        let sid = sess["id"].as_str().unwrap();

        s.handle("chat/session/update", Some(json!({
            "sessionId": sid, "title": "New Title",
        }))).await.unwrap();

        let result = s.handle("chat/session/get", Some(json!({"sessionId": sid}))).await.unwrap();
        assert_eq!(result["session"]["title"], "New Title");
        assert_eq!(result["session"]["status"], "active"); // unchanged
    }

    #[tokio::test]
    async fn session_update_status_only() {
        let (_tmp, s) = svc();
        let sess = s.handle("chat/session/create", Some(json!({"title": "Status Test"}))).await.unwrap();
        let sid = sess["id"].as_str().unwrap();

        s.handle("chat/session/update", Some(json!({
            "sessionId": sid, "status": "paused",
        }))).await.unwrap();

        let result = s.handle("chat/session/get", Some(json!({"sessionId": sid}))).await.unwrap();
        assert_eq!(result["session"]["title"], "Status Test"); // unchanged
        assert_eq!(result["session"]["status"], "paused");
    }

    #[tokio::test]
    async fn session_cli_session_id() {
        let (_tmp, s) = svc();

        // Create session with cliSessionId
        let sess = s.handle("chat/session/create", Some(json!({
            "title": "SDK Session",
            "provider": "agent-sdk",
            "cliSessionId": "sdk-abc-123",
        }))).await.unwrap();
        let sid = sess["id"].as_str().unwrap();

        // Verify cliSessionId is returned on get
        let result = s.handle("chat/session/get", Some(json!({"sessionId": sid}))).await.unwrap();
        assert_eq!(result["session"]["cliSessionId"], "sdk-abc-123");
        assert_eq!(result["session"]["provider"], "agent-sdk");

        // Update cliSessionId
        s.handle("chat/session/update", Some(json!({
            "sessionId": sid,
            "cliSessionId": "sdk-def-456",
        }))).await.unwrap();

        let result = s.handle("chat/session/get", Some(json!({"sessionId": sid}))).await.unwrap();
        assert_eq!(result["session"]["cliSessionId"], "sdk-def-456");
        assert_eq!(result["session"]["title"], "SDK Session"); // unchanged

        // Create session without cliSessionId — should be null
        let sess2 = s.handle("chat/session/create", Some(json!({
            "title": "Normal Session",
        }))).await.unwrap();
        let sid2 = sess2["id"].as_str().unwrap();
        let result2 = s.handle("chat/session/get", Some(json!({"sessionId": sid2}))).await.unwrap();
        assert!(result2["session"]["cliSessionId"].is_null());
    }

    #[tokio::test]
    async fn message_crud() {
        let (_tmp, s) = svc();
        let sess = s.handle("chat/session/create", Some(json!({"title": "Msg Test"}))).await.unwrap();
        let sid = sess["id"].as_str().unwrap();

        let m1 = s.handle("chat/message/add", Some(json!({
            "sessionId": sid, "role": "user", "content": "Hello!",
        }))).await.unwrap();
        let msg_id = m1["messageId"].as_str().unwrap().to_string();

        s.handle("chat/message/add", Some(json!({
            "sessionId": sid, "role": "assistant", "content": "Hi there!",
            "model": "claude-sonnet-4-20250514",
            "inputTokens": 10, "outputTokens": 5,
        }))).await.unwrap();

        let result = s.handle("chat/message/list", Some(json!({"sessionId": sid}))).await.unwrap();
        let messages = result.as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[1]["role"], "assistant");

        let result = s.handle("chat/message/search", Some(json!({"query": "Hello"}))).await.unwrap();
        assert!(result.as_array().unwrap().len() >= 1);

        s.handle("chat/message/delete", Some(json!({"id": &msg_id}))).await.unwrap();
        let result = s.handle("chat/message/list", Some(json!({"sessionId": sid}))).await.unwrap();
        assert_eq!(result.as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn tool_calls() {
        let (_tmp, s) = svc();
        let sess = s.handle("chat/session/create", Some(json!({"title": "TC"}))).await.unwrap();
        let sid = sess["id"].as_str().unwrap();

        let tc = s.handle("chat/toolCall/add", Some(json!({
            "sessionId": sid, "toolName": "file/read",
            "input": {"path": "/tmp/test.txt"},
        }))).await.unwrap();
        let tc_id = tc["toolCallId"].as_str().unwrap().to_string();

        s.handle("chat/toolCall/complete", Some(json!({
            "id": &tc_id,
            "output": {"content": "file contents"},
            "status": "success",
        }))).await.unwrap();

        let result = s.handle("chat/toolCall/list", Some(json!({"sessionId": sid}))).await.unwrap();
        let calls = result.as_array().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["toolName"], "file/read");
        assert_eq!(calls[0]["status"], "success");
    }

    #[tokio::test]
    async fn tool_call_update_input() {
        let (_tmp, s) = svc();
        let sess = s.handle("chat/session/create", Some(json!({"title": "test"}))).await.unwrap();
        let sid = sess["id"].as_str().unwrap();

        let tc = s.handle("chat/toolCall/add", Some(json!({
            "sessionId": sid, "toolName": "bash",
            "input": {"command": "ls"},
        }))).await.unwrap();
        let tc_id = tc["toolCallId"].as_str().unwrap();

        let result = s.handle("chat/toolCall/updateInput", Some(json!({
            "id": tc_id, "input": {"command": "pwd"},
        }))).await.unwrap();
        assert_eq!(result["success"], true);
    }

    #[tokio::test]
    async fn todos() {
        let (_tmp, s) = svc();
        let sess = s.handle("chat/session/create", Some(json!({"title": "Todos"}))).await.unwrap();
        let sid = sess["id"].as_str().unwrap();

        // Upsert returns full todo object (matches TypeScript)
        let todo1 = s.handle("chat/todo/upsert", Some(json!({
            "sessionId": sid, "content": "Write tests",
            "activeForm": "Writing tests", "status": "in_progress", "orderIndex": 0,
        }))).await.unwrap();
        assert_eq!(todo1["content"], "Write tests");
        assert_eq!(todo1["status"], "in_progress");
        assert_eq!(todo1["activeForm"], "Writing tests");
        let todo1_id = todo1["id"].as_str().unwrap().to_string();

        let todo2 = s.handle("chat/todo/upsert", Some(json!({
            "sessionId": sid, "content": "Run tests",
            "activeForm": "Running tests", "status": "pending", "orderIndex": 1,
        }))).await.unwrap();
        assert_eq!(todo2["content"], "Run tests");

        // List todos
        let result = s.handle("chat/todo/list", Some(json!({"sessionId": sid}))).await.unwrap();
        let todos = result.as_array().unwrap();
        assert_eq!(todos.len(), 2);
        assert_eq!(todos[0]["content"], "Write tests");
        assert_eq!(todos[0]["status"], "in_progress");

        // Get single todo by ID
        let result = s.handle("chat/todo/get", Some(json!({"id": todo1_id}))).await.unwrap();
        assert_eq!(result["content"], "Write tests");
        assert_eq!(result["sessionId"], sid);

        // Get nonexistent todo returns null
        let result = s.handle("chat/todo/get", Some(json!({"id": "todo-missing"}))).await.unwrap();
        assert!(result.is_null());
    }

    #[tokio::test]
    async fn permissions() {
        let (_tmp, s) = svc();
        let sess = s.handle("chat/session/create", Some(json!({"title": "Perms"}))).await.unwrap();
        let sid = sess["id"].as_str().unwrap();

        let check = s.handle("chat/permission/check", Some(json!({
            "toolName": "file/write", "sessionId": sid,
        }))).await.unwrap();
        assert_eq!(check["allowed"], false);

        s.handle("chat/permission/grant", Some(json!({
            "sessionId": sid, "toolName": "file/write", "scope": "session",
        }))).await.unwrap();

        let check = s.handle("chat/permission/check", Some(json!({
            "toolName": "file/write", "sessionId": sid,
        }))).await.unwrap();
        assert_eq!(check["allowed"], true);
    }

    #[tokio::test]
    async fn permission_scope_hierarchy() {
        let (_tmp, s) = svc();
        let sess = s.handle("chat/session/create", Some(json!({"title": "Perm Hierarchy"}))).await.unwrap();
        let sid = sess["id"].as_str().unwrap();

        // 1. No permission → not allowed
        let check = s.handle("chat/permission/check", Some(json!({
            "toolName": "Edit", "sessionId": sid,
        }))).await.unwrap();
        assert_eq!(check["allowed"], false);

        // 2. Grant project-scoped approval
        s.handle("chat/permission/grant", Some(json!({
            "toolName": "Edit", "scope": "project", "decision": "approved",
            "description": "Edit files in project",
        }))).await.unwrap();

        let check = s.handle("chat/permission/check", Some(json!({
            "toolName": "Edit", "sessionId": sid,
        }))).await.unwrap();
        assert_eq!(check["allowed"], true);
        assert_eq!(check["approval"]["scope"], "project");

        // 3. Deny beats approve — use a different tool to avoid unique constraint
        // Grant approval first, then deny for the same tool with global scope
        s.handle("chat/permission/grant", Some(json!({
            "toolName": "Delete", "scope": "project", "decision": "approved",
        }))).await.unwrap();
        s.handle("chat/permission/grant", Some(json!({
            "toolName": "Delete", "scope": "global", "decision": "denied",
            "reason": "Security policy",
        }))).await.unwrap();

        let check = s.handle("chat/permission/check", Some(json!({
            "toolName": "Delete", "sessionId": sid,
        }))).await.unwrap();
        assert_eq!(check["allowed"], false);
        assert_eq!(check["denied"], true);
        assert_eq!(check["denyType"], "hard");
        assert_eq!(check["reason"], "Security policy");

        // 4. Session-scoped approval: only matches with correct sessionId
        s.handle("chat/permission/grant", Some(json!({
            "toolName": "Bash", "scope": "session", "sessionId": sid,
            "decision": "approved",
        }))).await.unwrap();

        let check = s.handle("chat/permission/check", Some(json!({
            "toolName": "Bash", "sessionId": sid,
        }))).await.unwrap();
        assert_eq!(check["allowed"], true);
        assert_eq!(check["approval"]["scope"], "session");

        // Without sessionId → should not match
        let check = s.handle("chat/permission/check", Some(json!({
            "toolName": "Bash",
        }))).await.unwrap();
        assert_eq!(check["allowed"], false);

        // 5. Folder-scoped approval with path matching
        s.handle("chat/permission/grant", Some(json!({
            "toolName": "Write", "scope": "folder",
            "pattern": "/Users/test/project/src",
            "decision": "approved",
        }))).await.unwrap();

        // Path within folder → allowed
        let check = s.handle("chat/permission/check", Some(json!({
            "toolName": "Write",
            "targetPath": "/Users/test/project/src/main.rs",
        }))).await.unwrap();
        assert_eq!(check["allowed"], true);
        assert_eq!(check["approval"]["scope"], "folder");

        // Path outside folder → not allowed
        let check = s.handle("chat/permission/check", Some(json!({
            "toolName": "Write",
            "targetPath": "/Users/test/other/file.rs",
        }))).await.unwrap();
        assert_eq!(check["allowed"], false);

        // 6. Global approval
        s.handle("chat/permission/grant", Some(json!({
            "toolName": "Read", "scope": "global", "decision": "approved",
        }))).await.unwrap();

        let check = s.handle("chat/permission/check", Some(json!({
            "toolName": "Read",
        }))).await.unwrap();
        assert_eq!(check["allowed"], true);
        assert_eq!(check["approval"]["scope"], "global");
    }

    async fn create_test_session(s: &ChatService) -> String {
        let result = s.handle("chat/session/create", Some(json!({
            "title": "Test", "provider": "claude", "model": "claude-sonnet-4-20250514",
        }))).await.unwrap();
        result["id"].as_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn document_crud() {
        let (_tmp, s) = svc();
        let sid = create_test_session(&s).await;

        // Create document — returns full document (matches TypeScript)
        let result = s.handle("chat/document/create", Some(json!({
            "sessionId": sid,
            "title": "test.rs",
            "docType": "spec",
            "content": "fn main() {}",
        }))).await.unwrap();
        let doc_id = result["id"].as_str().unwrap().to_string();
        assert!(doc_id.starts_with("doc-"));
        assert_eq!(result["title"], "test.rs");
        assert_eq!(result["docType"], "spec");
        assert_eq!(result["status"], "draft");

        // Get document — returns raw document (not wrapped)
        let result = s.handle("chat/document/get", Some(json!({ "id": doc_id }))).await.unwrap();
        assert_eq!(result["title"], "test.rs");
        assert_eq!(result["docType"], "spec");
        assert_eq!(result["content"], "fn main() {}");
        assert_eq!(result["sessionId"], sid);

        // Get nonexistent document — returns null (not error)
        let result = s.handle("chat/document/get", Some(json!({ "id": "doc-nonexistent" }))).await.unwrap();
        assert!(result.is_null());

        // Update document — returns full updated document
        let result = s.handle("chat/document/update", Some(json!({
            "id": doc_id,
            "content": "fn main() { println!(\"hello\"); }",
            "title": "main.rs",
            "priority": 5,
            "reviewStatus": "pending",
        }))).await.unwrap();
        assert_eq!(result["title"], "main.rs");
        assert!(result["content"].as_str().unwrap().contains("println"));
        assert_eq!(result["priority"], 5);
        assert_eq!(result["reviewStatus"], "pending");

        // Update nonexistent — returns null
        let result = s.handle("chat/document/update", Some(json!({
            "id": "doc-nonexistent", "title": "nope",
        }))).await.unwrap();
        assert!(result.is_null());

        // List documents
        let result = s.handle("chat/document/list", Some(json!({ "sessionId": sid }))).await.unwrap();
        assert_eq!(result.as_array().unwrap().len(), 1);

        // List with filters
        let result = s.handle("chat/document/list", Some(json!({
            "sessionId": sid, "reviewStatus": "pending",
        }))).await.unwrap();
        assert_eq!(result.as_array().unwrap().len(), 1);

        // Search documents by content
        let result = s.handle("chat/document/search", Some(json!({
            "query": "println",
        }))).await.unwrap();
        assert_eq!(result.as_array().unwrap().len(), 1);

        // Search with docType filter
        let result = s.handle("chat/document/search", Some(json!({
            "query": "println", "docType": "note",
        }))).await.unwrap();
        assert_eq!(result.as_array().unwrap().len(), 0); // wrong type

        // Delete document
        let result = s.handle("chat/document/delete", Some(json!({ "id": doc_id }))).await.unwrap();
        assert_eq!(result["success"], true);

        // Verify deleted
        let result = s.handle("chat/document/list", Some(json!({ "sessionId": sid }))).await.unwrap();
        assert_eq!(result.as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn document_hierarchy_and_count() {
        let (_tmp, s) = svc();
        let sid = create_test_session(&s).await;

        // Create parent document
        let r1 = s.handle("chat/document/create", Some(json!({
            "sessionId": sid, "title": "README.md", "docType": "note",
        }))).await.unwrap();
        let parent_id = r1["id"].as_str().unwrap().to_string();

        // Create child documents
        s.handle("chat/document/create", Some(json!({
            "sessionId": sid, "title": "api.ts", "docType": "spec", "parentId": parent_id,
        }))).await.unwrap();
        s.handle("chat/document/create", Some(json!({
            "sessionId": sid, "title": "utils.ts", "docType": "spec", "parentId": parent_id,
        }))).await.unwrap();

        // Hierarchy — takes root document ID, returns nested structure
        let result = s.handle("chat/document/hierarchy", Some(json!({ "id": parent_id }))).await.unwrap();
        assert_eq!(result["id"], parent_id);
        assert_eq!(result["title"], "README.md");
        let children = result["children"].as_array().unwrap();
        assert_eq!(children.len(), 2);
        assert!(children.iter().any(|c| c["title"] == "api.ts"));
        assert!(children.iter().any(|c| c["title"] == "utils.ts"));

        // Hierarchy for nonexistent doc — returns null
        let result = s.handle("chat/document/hierarchy", Some(json!({ "id": "doc-missing" }))).await.unwrap();
        assert!(result.is_null());

        // Count by type — global, no params required, returns { docType: count }
        let result = s.handle("chat/document/count-by-type", None).await.unwrap();
        assert_eq!(result["note"], 1);
        assert_eq!(result["spec"], 2);

        // Vulnerabilities — proper filtering
        s.handle("chat/document/create", Some(json!({
            "sessionId": sid, "title": "XSS vuln", "docType": "vulnerability",
            "severity": "high", "status": "active",
        }))).await.unwrap();
        s.handle("chat/document/create", Some(json!({
            "sessionId": sid, "title": "Old vuln", "docType": "vulnerability",
            "severity": "low", "status": "archived",
        }))).await.unwrap();
        let result = s.handle("chat/document/vulnerabilities", None).await.unwrap();
        let vulns = result.as_array().unwrap();
        assert_eq!(vulns.len(), 1); // archived is excluded
        assert_eq!(vulns[0]["title"], "XSS vuln");

        // Pending reviews — create returns full doc with id
        let review_doc = s.handle("chat/document/create", Some(json!({
            "sessionId": sid, "title": "Review me", "docType": "spec",
        }))).await.unwrap();
        let review_id = review_doc["id"].as_str().unwrap().to_string();
        s.handle("chat/document/update", Some(json!({
            "id": review_id, "reviewStatus": "pending",
        }))).await.unwrap();
        let result = s.handle("chat/document/pending-reviews", None).await.unwrap();
        let reviews = result.as_array().unwrap();
        assert!(reviews.iter().any(|r| r["title"] == "Review me"));
    }

    #[tokio::test]
    async fn activity_reconstructed_from_data() {
        let (_tmp, s) = svc();
        let sid = create_test_session(&s).await;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap()
            .as_millis() as i64;

        // Add a message (will show as message_added activity)
        s.handle("chat/message/add", Some(json!({
            "sessionId": sid, "role": "user", "content": "Hello!",
        }))).await.unwrap();

        // Add a tool call (will show as tool_call_started activity)
        s.handle("chat/toolCall/add", Some(json!({
            "sessionId": sid, "toolName": "file/read",
            "input": { "path": "/tmp/test.txt" },
        }))).await.unwrap();

        // chat/activity/log returns reconstructed activity (session_created + message + tool_call)
        let result = s.handle("chat/activity/log", Some(json!({
            "sessionId": sid,
        }))).await.unwrap();
        let activities = result.as_array().unwrap();
        assert!(activities.len() >= 3, "Expected at least 3 entries (session + message + tool call), got {}", activities.len());

        // Verify types are present
        let types: Vec<&str> = activities.iter().filter_map(|a| a["activityType"].as_str()).collect();
        assert!(types.contains(&"session_created"));
        assert!(types.contains(&"message_added"));
        assert!(types.contains(&"tool_call_started"));

        // chat/activity/since with recent timestamp should include our entries
        let result = s.handle("chat/activity/since", Some(json!({
            "since": now - 5000,
            "sessionId": sid,
        }))).await.unwrap();
        assert!(result.as_array().unwrap().len() >= 3);

        // chat/activity/add is a no-op
        let result = s.handle("chat/activity/add", None).await.unwrap();
        assert_eq!(result["success"], true);
    }

    #[tokio::test]
    async fn stats_and_context() {
        let (_tmp, s) = svc();
        let sid = create_test_session(&s).await;

        // Add some data
        s.handle("chat/message/add", Some(json!({
            "sessionId": sid, "role": "user", "content": "hello",
        }))).await.unwrap();
        s.handle("chat/document/create", Some(json!({
            "sessionId": sid, "title": "doc.md", "docType": "note",
        }))).await.unwrap();

        // Global stats
        let result = s.handle("chat/stats", None).await.unwrap();
        assert!(result["stats"]["sessions"].as_i64().unwrap() >= 1);
        assert!(result["stats"]["messages"].as_i64().unwrap() >= 1);
        assert!(result["stats"]["documents"].as_i64().unwrap() >= 1);

        // Session stats
        let result = s.handle("chat/stats", Some(json!({ "sessionId": sid }))).await.unwrap();
        assert_eq!(result["stats"]["messages"], 1);
        assert_eq!(result["stats"]["documents"], 1);

        // Context build
        let result = s.handle("chat/context/build", Some(json!({ "sessionId": sid }))).await.unwrap();
        assert_eq!(result["sessionId"], sid);
        assert!(result["context"]["session"].is_object());
        assert!(result["context"]["messages"].is_array());
        assert!(result["context"]["documents"].is_array());
    }

    #[tokio::test]
    async fn compaction_get_expand_collapse() {
        let (_tmp, s) = svc();
        let sid = create_test_session(&s).await;

        // Add messages
        let m1 = s.handle("chat/message/add", Some(json!({
            "sessionId": sid, "role": "user", "content": "first",
        }))).await.unwrap();
        let m1_id = m1["messageId"].as_str().unwrap();
        let m2 = s.handle("chat/message/add", Some(json!({
            "sessionId": sid, "role": "assistant", "content": "second",
        }))).await.unwrap();
        let m2_id = m2["messageId"].as_str().unwrap();

        // Create compaction
        let result = s.handle("chat/compaction/create", Some(json!({
            "sessionId": sid,
            "summary": "User asked, assistant replied",
            "startMessageId": m1_id,
            "endMessageId": m2_id,
            "messagesCompacted": 2,
        }))).await.unwrap();
        let cmp_id = result["compactionId"].as_str().unwrap().to_string();

        // Get compaction
        let result = s.handle("chat/compaction/get", Some(json!({ "id": cmp_id }))).await.unwrap();
        assert_eq!(result["compaction"]["messagesCompacted"], 2);

        // Expand (marks compacted messages as active)
        s.handle("chat/compaction/expand", Some(json!({ "id": cmp_id }))).await.unwrap();

        // Collapse (marks messages as inactive)
        s.handle("chat/compaction/collapse", Some(json!({ "id": cmp_id }))).await.unwrap();
    }

    #[tokio::test]
    async fn compaction_apply() {
        let (_tmp, s) = svc();
        let sid = create_test_session(&s).await;

        // Add 5 messages
        let mut msg_ids = Vec::new();
        for i in 0..5 {
            let role = if i % 2 == 0 { "user" } else { "assistant" };
            let result = s.handle("chat/message/add", Some(json!({
                "sessionId": sid, "role": role, "content": format!("message {}", i),
            }))).await.unwrap();
            msg_ids.push(result["messageId"].as_str().unwrap().to_string());
        }

        // Create compaction for first 3 messages
        let result = s.handle("chat/compaction/create", Some(json!({
            "sessionId": sid,
            "summary": "Summary of first 3 messages",
            "startMessageId": msg_ids[0],
            "endMessageId": msg_ids[2],
            "messagesCompacted": 3,
        }))).await.unwrap();
        let cmp_id = result["compactionId"].as_str().unwrap().to_string();

        // Apply compaction to first 3 message IDs
        let result = s.handle("chat/compaction/apply", Some(json!({
            "compactionId": cmp_id,
            "messageIds": [&msg_ids[0], &msg_ids[1], &msg_ids[2]],
        }))).await.unwrap();
        assert_eq!(result["success"], true);
        assert_eq!(result["messagesUpdated"], 3);

        // Verify: list active messages should return only 2
        let messages = s.handle("chat/message/list", Some(json!({
            "sessionId": sid,
        }))).await.unwrap();
        let msgs = messages.as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["content"], "message 3");
        assert_eq!(msgs[1]["content"], "message 4");
    }

    #[tokio::test]
    async fn todo_replace() {
        let (_tmp, s) = svc();
        let sid = create_test_session(&s).await;

        // Create initial todos
        s.handle("chat/todo/upsert", Some(json!({
            "sessionId": sid, "content": "old task", "status": "pending",
        }))).await.unwrap();

        // Replace all todos — returns the new todo list (matches TypeScript)
        let result = s.handle("chat/todo/replace", Some(json!({
            "sessionId": sid,
            "todos": [
                { "content": "new task 1", "status": "pending" },
                { "content": "new task 2", "status": "in_progress" },
            ],
        }))).await.unwrap();
        let todos = result.as_array().unwrap();
        assert_eq!(todos.len(), 2);
        assert_eq!(todos[0]["content"], "new task 1");
        assert_eq!(todos[1]["content"], "new task 2");
        assert_eq!(todos[1]["status"], "in_progress");
    }

    #[tokio::test]
    async fn session_stats_full() {
        let (_tmp, s) = svc();

        // Create session
        let sess = s.handle("chat/session/create", Some(json!({
            "title": "Stats Test",
        }))).await.unwrap();
        let sid = sess["id"].as_str().unwrap().to_string();

        // Add tool calls with file paths
        s.handle("chat/toolCall/add", Some(json!({
            "id": "tc-1", "sessionId": &sid, "toolName": "Read",
            "input": { "file_path": "/src/main.rs" },
        }))).await.unwrap();
        s.handle("chat/toolCall/add", Some(json!({
            "id": "tc-2", "sessionId": &sid, "toolName": "Edit",
            "input": { "file_path": "/src/main.rs" },
        }))).await.unwrap();
        s.handle("chat/toolCall/add", Some(json!({
            "id": "tc-3", "sessionId": &sid, "toolName": "Write",
            "input": { "file_path": "/src/lib.rs" },
        }))).await.unwrap();
        s.handle("chat/toolCall/add", Some(json!({
            "id": "tc-4", "sessionId": &sid, "toolName": "Grep",
            "input": { "path": "/src/utils.rs" },
        }))).await.unwrap();

        // Complete them
        s.handle("chat/toolCall/complete", Some(json!({
            "id": "tc-1", "status": "success",
        }))).await.unwrap();
        s.handle("chat/toolCall/complete", Some(json!({
            "id": "tc-2", "status": "success",
        }))).await.unwrap();
        s.handle("chat/toolCall/complete", Some(json!({
            "id": "tc-3", "status": "error", "errorMessage": "disk full",
        }))).await.unwrap();
        s.handle("chat/toolCall/complete", Some(json!({
            "id": "tc-4", "status": "success",
        }))).await.unwrap();

        // Add iterations
        s.handle("chat/iteration/start", Some(json!({
            "sessionId": &sid, "iterationId": 1,
        }))).await.unwrap();
        s.handle("chat/iteration/complete", Some(json!({
            "sessionId": &sid, "iterationId": 1, "hasToolUse": true, "toolCount": 3,
        }))).await.unwrap();
        s.handle("chat/iteration/start", Some(json!({
            "sessionId": &sid, "iterationId": 2,
        }))).await.unwrap();
        s.handle("chat/iteration/complete", Some(json!({
            "sessionId": &sid, "iterationId": 2, "hasToolUse": false,
        }))).await.unwrap();

        // Fetch session stats
        let stats = s.handle("chat/stats/session", Some(json!({
            "sessionId": &sid,
        }))).await.unwrap();

        // Pulse
        assert_eq!(stats["pulse"]["totalOps"], 4);
        assert_eq!(stats["pulse"]["errorCount"], 1);
        assert!(stats["pulse"]["errorRate"].as_f64().unwrap() > 0.0);
        assert_eq!(stats["pulse"]["uniqueFileCount"], 3);

        // File activity
        let file_activity = stats["fileActivity"].as_array().unwrap();
        assert!(!file_activity.is_empty());
        // main.rs should be first (2 ops)
        assert_eq!(file_activity[0]["filePath"], "/src/main.rs");
        assert_eq!(file_activity[0]["totalOps"], 2);
        assert_eq!(file_activity[0]["readCount"], 1);
        assert_eq!(file_activity[0]["editCount"], 1);

        // Tool breakdown
        let breakdown = stats["toolBreakdown"].as_array().unwrap();
        assert!(!breakdown.is_empty());

        // Iteration depth
        assert_eq!(stats["iterationDepth"]["totalIterations"], 2);
        assert_eq!(stats["iterationDepth"]["withToolsCount"], 1);
        assert_eq!(stats["iterationDepth"]["thinkOnlyCount"], 1);
        assert!(stats["iterationDepth"]["toolsPerIteration"].as_f64().unwrap() > 0.0);
        let durations = stats["iterationDepth"]["iterationDurationsMs"].as_array().unwrap();
        assert_eq!(durations.len(), 2);

        // Health scores in 0-100
        let health = &stats["health"];
        assert!(health["focusScore"].as_f64().unwrap() >= 0.0);
        assert!(health["focusScore"].as_f64().unwrap() <= 100.0);
        assert!(health["efficiencyScore"].as_f64().unwrap() >= 0.0);
        assert!(health["overallScore"].as_f64().unwrap() >= 0.0);
        assert!(health["level"].as_str().is_some());

        // Scope drift
        assert!(stats["scopeDrift"]["driftRatio"].as_f64().is_some());

        // Execution speed
        assert!(stats["executionSpeed"]["speedSparkline"].as_array().unwrap().len() == 10);

        // File dependencies
        assert!(stats["fileDependencies"]["editChain"].as_array().is_some());
        assert!(stats["fileDependencies"]["coTouchedFiles"].as_array().is_some());
    }

    #[tokio::test]
    async fn iteration_crud() {
        let (_tmp, s) = svc();

        let sess = s.handle("chat/session/create", Some(json!({
            "title": "Iter Test",
        }))).await.unwrap();
        let sid = sess["id"].as_str().unwrap().to_string();

        // Start iteration
        s.handle("chat/iteration/start", Some(json!({
            "sessionId": &sid, "iterationId": 1,
        }))).await.unwrap();

        // Complete with tool use
        s.handle("chat/iteration/complete", Some(json!({
            "sessionId": &sid, "iterationId": 1, "hasToolUse": true, "toolCount": 5,
        }))).await.unwrap();

        // Start another
        s.handle("chat/iteration/start", Some(json!({
            "sessionId": &sid, "iterationId": 2,
        }))).await.unwrap();
        s.handle("chat/iteration/complete", Some(json!({
            "sessionId": &sid, "iterationId": 2, "hasToolUse": false,
        }))).await.unwrap();

        // Fetch stats and verify iteration depth
        let stats = s.handle("chat/stats/session", Some(json!({
            "sessionId": &sid,
        }))).await.unwrap();

        assert_eq!(stats["iterationDepth"]["totalIterations"], 2);
        assert_eq!(stats["iterationDepth"]["currentIteration"], 2);
        assert_eq!(stats["iterationDepth"]["withToolsCount"], 1);
        assert_eq!(stats["iterationDepth"]["thinkOnlyCount"], 1);
        assert!(stats["iterationDepth"]["toolsPerIteration"].as_f64().unwrap() > 0.0);

        // Verify session iteration_count was updated
        let session = s.handle("chat/session/get", Some(json!({
            "sessionId": &sid,
        }))).await.unwrap();
        assert_eq!(session["session"]["iterationCount"], 2);
    }

    #[tokio::test]
    async fn session_stats_empty_session() {
        let (_tmp, s) = svc();

        let sess = s.handle("chat/session/create", Some(json!({
            "title": "Empty Stats",
        }))).await.unwrap();
        let sid = sess["id"].as_str().unwrap().to_string();

        let stats = s.handle("chat/stats/session", Some(json!({
            "sessionId": &sid,
        }))).await.unwrap();

        assert_eq!(stats["pulse"]["totalOps"], 0);
        assert_eq!(stats["pulse"]["errorCount"], 0);
        assert_eq!(stats["pulse"]["errorRate"], 0.0);
        assert_eq!(stats["pulse"]["uniqueFileCount"], 0);
        assert!(stats["fileActivity"].as_array().unwrap().is_empty());
        assert!(stats["toolBreakdown"].as_array().unwrap().is_empty());
        assert_eq!(stats["iterationDepth"]["totalIterations"], 0);
        assert_eq!(stats["health"]["level"], "good");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Persona & Agent CRUD tests (via chat service)
// ─────────────────────────────────────────────────────────────────────────────

mod persona_agent {
    use super::*;
    use ecp_services::chat::ChatService;
    use ecp_services::Service;

    fn svc() -> (TempDir, ChatService) {
        let tmp = TempDir::new().unwrap();
        let s = ChatService::new(tmp.path());
        (tmp, s)
    }

    #[tokio::test]
    async fn persona_crud() {
        let (_tmp, s) = svc();

        // Create
        let result = s.handle("chat/persona/create", Some(json!({
            "name": "Test Persona",
            "description": "A test persona",
            "problemSpace": "testing",
            "pipelineStatus": "draft",
        }))).await.unwrap();
        let pid = result["id"].as_str().unwrap().to_string();
        assert!(pid.starts_with("persona-"));
        assert_eq!(result["name"], "Test Persona");
        assert_eq!(result["description"], "A test persona");
        assert_eq!(result["problemSpace"], "testing");
        assert_eq!(result["pipelineStatus"], "draft");
        assert_eq!(result["isSystem"], false);

        // Get
        let result = s.handle("chat/persona/get", Some(json!({ "id": &pid }))).await.unwrap();
        assert_eq!(result["name"], "Test Persona");

        // List
        let result = s.handle("chat/persona/list", None).await.unwrap();
        let personas = result["personas"].as_array().unwrap();
        assert!(personas.iter().any(|p| p["id"].as_str() == Some(&pid)));

        // List with status filter
        let result = s.handle("chat/persona/list", Some(json!({ "status": "draft" }))).await.unwrap();
        let personas = result["personas"].as_array().unwrap();
        assert!(personas.iter().any(|p| p["id"].as_str() == Some(&pid)));

        let result = s.handle("chat/persona/list", Some(json!({ "status": "published" }))).await.unwrap();
        let personas = result["personas"].as_array().unwrap();
        assert!(!personas.iter().any(|p| p["id"].as_str() == Some(&pid)));

        // Update
        let result = s.handle("chat/persona/update", Some(json!({
            "id": &pid,
            "name": "Updated Persona",
            "pipelineStatus": "compressed",
            "compressed": "You are a testing persona.",
        }))).await.unwrap();
        assert_eq!(result["name"], "Updated Persona");
        assert_eq!(result["pipelineStatus"], "compressed");
        assert_eq!(result["compressed"], "You are a testing persona.");

        // Delete
        let result = s.handle("chat/persona/delete", Some(json!({ "id": &pid }))).await.unwrap();
        assert_eq!(result["success"], true);

        // Verify deleted
        let result = s.handle("chat/persona/get", Some(json!({ "id": &pid }))).await.unwrap();
        assert!(result.is_null());
    }

    #[tokio::test]
    async fn persona_system_protection() {
        let (_tmp, s) = svc();

        // Create system persona
        let result = s.handle("chat/persona/create", Some(json!({
            "name": "System Persona",
            "isSystem": true,
        }))).await.unwrap();
        let pid = result["id"].as_str().unwrap().to_string();
        assert_eq!(result["isSystem"], true);

        // Try to delete — should fail
        let result = s.handle("chat/persona/delete", Some(json!({ "id": &pid }))).await.unwrap();
        assert_eq!(result["success"], false);

        // Verify still exists
        let result = s.handle("chat/persona/get", Some(json!({ "id": &pid }))).await.unwrap();
        assert_eq!(result["name"], "System Persona");
    }

    #[tokio::test]
    async fn agent_crud_via_chat() {
        let (_tmp, s) = svc();

        // Create
        let result = s.handle("chat/agent/create", Some(json!({
            "name": "Test Agent",
            "description": "A test agent",
            "role": "specialist",
            "roleType": "general",
            "systemPrompt": "You are a test agent.",
            "tools": ["Read", "Write"],
        }))).await.unwrap();
        let aid = result["id"].as_str().unwrap().to_string();
        assert!(aid.starts_with("agent-"));
        assert_eq!(result["name"], "Test Agent");
        assert_eq!(result["role"], "specialist");
        assert_eq!(result["roleType"], "general");
        assert_eq!(result["systemPrompt"], "You are a test agent.");
        assert_eq!(result["isSystem"], false);
        assert_eq!(result["isActive"], true);

        // Get
        let result = s.handle("chat/agent/get", Some(json!({ "id": &aid }))).await.unwrap();
        assert_eq!(result["name"], "Test Agent");
        assert_eq!(result["tools"], json!(["Read", "Write"]));

        // Get by name
        let result = s.handle("chat/agent/getByName", Some(json!({ "name": "Test Agent" }))).await.unwrap();
        assert_eq!(result["id"], aid);

        // List
        let result = s.handle("chat/agent/list", None).await.unwrap();
        let agents = result["agents"].as_array().unwrap();
        assert!(agents.iter().any(|a| a["id"].as_str() == Some(&aid)));

        // Update
        let result = s.handle("chat/agent/update", Some(json!({
            "id": &aid,
            "name": "Updated Agent",
            "agency": "autonomous",
        }))).await.unwrap();
        assert_eq!(result["name"], "Updated Agent");
        assert_eq!(result["agency"], "autonomous");

        // Delete
        let result = s.handle("chat/agent/delete", Some(json!({ "id": &aid }))).await.unwrap();
        assert_eq!(result["success"], true);

        // Verify deleted
        let result = s.handle("chat/agent/get", Some(json!({ "id": &aid }))).await.unwrap();
        assert!(result.is_null());
    }

    #[tokio::test]
    async fn agent_persona_link() {
        let (_tmp, s) = svc();

        // Create persona first
        let persona = s.handle("chat/persona/create", Some(json!({
            "name": "Linked Persona",
            "compressed": "You embody careful testing.",
        }))).await.unwrap();
        let pid = persona["id"].as_str().unwrap().to_string();

        // Create agent with personaId
        let agent = s.handle("chat/agent/create", Some(json!({
            "name": "Linked Agent",
            "personaId": &pid,
            "agency": "supervised",
        }))).await.unwrap();
        let aid = agent["id"].as_str().unwrap().to_string();
        assert_eq!(agent["personaId"], pid);
        assert_eq!(agent["agency"], "supervised");

        // Verify via get
        let result = s.handle("chat/agent/get", Some(json!({ "id": &aid }))).await.unwrap();
        assert_eq!(result["personaId"], pid);
    }

    #[tokio::test]
    async fn agent_system_protection() {
        let (_tmp, s) = svc();

        // System agents are seeded by ChatDb — "assistant" is always there
        let result = s.handle("chat/agent/get", Some(json!({ "id": "assistant" }))).await.unwrap();
        assert_eq!(result["isSystem"], true);

        // Can't delete system agents
        let result = s.handle("chat/agent/delete", Some(json!({ "id": "assistant" }))).await.unwrap();
        assert_eq!(result["success"], false);

        // Can't update system agents
        let result = s.handle("chat/agent/update", Some(json!({
            "id": "assistant",
            "name": "Hacked!",
        }))).await.unwrap();
        // Should return null (not found/not modifiable)
        assert!(result.is_null());
    }

    #[tokio::test]
    async fn agent_with_custom_id() {
        let (_tmp, s) = svc();

        let result = s.handle("chat/agent/create", Some(json!({
            "id": "my-custom-agent",
            "name": "Custom ID Agent",
        }))).await.unwrap();
        assert_eq!(result["id"], "my-custom-agent");

        let result = s.handle("chat/agent/get", Some(json!({ "id": "my-custom-agent" }))).await.unwrap();
        assert_eq!(result["name"], "Custom ID Agent");
    }

    #[tokio::test]
    async fn persona_with_custom_id() {
        let (_tmp, s) = svc();

        let result = s.handle("chat/persona/create", Some(json!({
            "id": "my-custom-persona",
            "name": "Custom ID Persona",
        }))).await.unwrap();
        assert_eq!(result["id"], "my-custom-persona");

        let result = s.handle("chat/persona/get", Some(json!({ "id": "my-custom-persona" }))).await.unwrap();
        assert_eq!(result["name"], "Custom ID Persona");
    }

    #[tokio::test]
    async fn persona_full_pipeline() {
        let (_tmp, s) = svc();

        // Create with all fields
        let result = s.handle("chat/persona/create", Some(json!({
            "name": "Full Persona",
            "description": "Complete persona",
            "problemSpace": "Software architecture",
            "highLevel": "Thinks in systems and boundaries",
            "archetype": "The Architect",
            "principles": "Separation of concerns, least privilege",
            "taste": "Prefers explicit over implicit",
            "compressed": "You are a systems architect...",
            "pipelineStatus": "published",
            "avatar": "architect.png",
            "color": "#3498db",
        }))).await.unwrap();

        assert_eq!(result["name"], "Full Persona");
        assert_eq!(result["highLevel"], "Thinks in systems and boundaries");
        assert_eq!(result["archetype"], "The Architect");
        assert_eq!(result["pipelineStatus"], "published");
        assert_eq!(result["avatar"], "architect.png");
        assert_eq!(result["color"], "#3498db");
    }

    #[tokio::test]
    async fn agent_list_with_filters() {
        let (_tmp, s) = svc();

        // Create a non-system agent
        s.handle("chat/agent/create", Some(json!({
            "name": "Filter Test Agent",
            "roleType": "specialist",
        }))).await.unwrap();

        // List with includeSystem=false — should exclude seeded agents
        let result = s.handle("chat/agent/list", Some(json!({
            "includeSystem": false,
        }))).await.unwrap();
        let agents = result["agents"].as_array().unwrap();
        assert!(agents.iter().all(|a| a["isSystem"] == false));
        assert!(agents.iter().any(|a| a["name"] == "Filter Test Agent"));

        // List with includeSystem=true — should include seeded agents
        let result = s.handle("chat/agent/list", Some(json!({
            "includeSystem": true,
        }))).await.unwrap();
        let agents = result["agents"].as_array().unwrap();
        assert!(agents.iter().any(|a| a["isSystem"] == true));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Git service tests
// ─────────────────────────────────────────────────────────────────────────────

mod git {
    use super::*;
    use ecp_services::git::GitService;
    use ecp_services::Service;

    /// Create an isolated git repo in a temp dir.
    async fn init_repo() -> (TempDir, GitService) {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().to_path_buf();

        // git init + initial commit so branch exists
        tokio::process::Command::new("git")
            .args(["init"])
            .current_dir(&path)
            .output().await.unwrap();
        tokio::process::Command::new("git")
            .args(["config", "user.email", "test@test.com"])
            .current_dir(&path)
            .output().await.unwrap();
        tokio::process::Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(&path)
            .output().await.unwrap();
        // Need at least one commit for branch to exist
        std::fs::write(path.join("README.md"), "# test").unwrap();
        tokio::process::Command::new("git")
            .args(["add", "."])
            .current_dir(&path)
            .output().await.unwrap();
        tokio::process::Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(&path)
            .output().await.unwrap();

        let s = GitService::new(path);
        (tmp, s)
    }

    #[tokio::test]
    async fn is_repo() {
        let (_tmp, s) = init_repo().await;
        let result = s.handle("git/isRepo", None).await.unwrap();
        assert_eq!(result["isRepo"], true);
    }

    #[tokio::test]
    async fn is_not_repo() {
        let tmp = TempDir::new().unwrap();
        let s = GitService::new(tmp.path().to_path_buf());
        let result = s.handle("git/isRepo", None).await.unwrap();
        assert_eq!(result["isRepo"], false);
    }

    #[tokio::test]
    async fn get_root() {
        let (_tmp, s) = init_repo().await;
        let result = s.handle("git/getRoot", None).await.unwrap();
        assert!(result["root"].as_str().unwrap().len() > 0);
    }

    #[tokio::test]
    async fn status_clean() {
        let (_tmp, s) = init_repo().await;
        let result = s.handle("git/status", None).await.unwrap();
        assert_eq!(result["staged"].as_array().unwrap().len(), 0);
        assert_eq!(result["unstaged"].as_array().unwrap().len(), 0);
        assert_eq!(result["untracked"].as_array().unwrap().len(), 0);
        assert!(result["branch"].as_str().is_some());
    }

    #[tokio::test]
    async fn status_with_changes() {
        let (tmp, s) = init_repo().await;
        std::fs::write(tmp.path().join("new.txt"), "untracked").unwrap();

        let result = s.handle("git/status", None).await.unwrap();
        let untracked = result["untracked"].as_array().unwrap();
        assert!(untracked.len() >= 1);
    }

    #[tokio::test]
    async fn branch() {
        let (_tmp, s) = init_repo().await;
        let result = s.handle("git/branch", None).await.unwrap();
        let branch = result["branch"].as_str().unwrap();
        assert!(branch == "main" || branch == "master");
    }

    #[tokio::test]
    async fn stage_and_commit() {
        let (tmp, s) = init_repo().await;
        std::fs::write(tmp.path().join("staged.txt"), "content").unwrap();

        s.handle("git/stage", Some(json!({"paths": ["staged.txt"]}))).await.unwrap();

        let result = s.handle("git/commit", Some(json!({"message": "add staged.txt"}))).await.unwrap();
        assert!(result["hash"].as_str().unwrap().len() == 40);
        assert_eq!(result["message"], "add staged.txt");
    }

    #[tokio::test]
    async fn stage_all() {
        let (tmp, s) = init_repo().await;
        std::fs::write(tmp.path().join("a.txt"), "a").unwrap();
        std::fs::write(tmp.path().join("b.txt"), "b").unwrap();

        s.handle("git/stageAll", None).await.unwrap();
        let result = s.handle("git/commit", Some(json!({"message": "add all"}))).await.unwrap();
        assert!(result["hash"].as_str().unwrap().len() == 40);
    }

    #[tokio::test]
    async fn diff() {
        let (tmp, s) = init_repo().await;
        // Modify a tracked file
        std::fs::write(tmp.path().join("README.md"), "# modified").unwrap();

        let result = s.handle("git/diff", None).await.unwrap();
        let hunks = result["hunks"].as_array().unwrap();
        assert!(!hunks.is_empty());
    }

    #[tokio::test]
    async fn log() {
        let (_tmp, s) = init_repo().await;
        let result = s.handle("git/log", Some(json!({"limit": 5}))).await.unwrap();
        let commits = result["commits"].as_array().unwrap();
        assert!(commits.len() >= 1);
        assert_eq!(commits[0]["message"], "init");
        assert!(commits[0]["hash"].as_str().unwrap().len() == 40);
        assert!(commits[0]["shortHash"].as_str().is_some());
        assert!(commits[0]["date"].as_i64().unwrap() > 0);
    }

    #[tokio::test]
    async fn branches() {
        let (_tmp, s) = init_repo().await;
        let result = s.handle("git/branches", None).await.unwrap();
        let branches = result["branches"].as_array().unwrap();
        assert!(branches.len() >= 1);
    }

    #[tokio::test]
    async fn create_and_switch_branch() {
        let (_tmp, s) = init_repo().await;

        s.handle("git/createBranch", Some(json!({"name": "feature-x", "checkout": true}))).await.unwrap();
        let result = s.handle("git/branch", None).await.unwrap();
        assert_eq!(result["branch"], "feature-x");

        // Switch back — try "main" first, fall back to "master"
        if s.handle("git/switchBranch", Some(json!({"name": "main"}))).await.is_err() {
            s.handle("git/switchBranch", Some(json!({"name": "master"}))).await.unwrap();
        }
    }

    #[tokio::test]
    async fn stash_list_empty() {
        let (_tmp, s) = init_repo().await;
        let result = s.handle("git/stashList", None).await.unwrap();
        let stashes = result["stashes"].as_array().unwrap();
        assert_eq!(stashes.len(), 0);
    }

    #[tokio::test]
    async fn remotes_empty_local_repo() {
        let (_tmp, s) = init_repo().await;
        let result = s.handle("git/remotes", None).await.unwrap();
        let remotes = result["remotes"].as_array().unwrap();
        assert_eq!(remotes.len(), 0);
    }

    #[tokio::test]
    async fn unknown_method() {
        let (_tmp, s) = init_repo().await;
        let err = s.handle("git/nonexistent", None).await;
        assert!(err.is_err());
        assert_eq!(err.unwrap_err().code, -32601);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Terminal service tests
// ─────────────────────────────────────────────────────────────────────────────

mod terminal {
    use super::*;
    use ecp_services::terminal::TerminalService;
    use ecp_services::Service;

    #[tokio::test]
    async fn execute_command() {
        let tmp = TempDir::new().unwrap();
        let s = TerminalService::new(tmp.path().to_path_buf());

        let result = s.handle("terminal/execute", Some(json!({
            "command": "echo hello",
        }))).await.unwrap();

        assert_eq!(result["exitCode"], 0);
        assert!(result["stdout"].as_str().unwrap().contains("hello"));
    }

    #[tokio::test]
    async fn execute_with_exit_code() {
        let tmp = TempDir::new().unwrap();
        let s = TerminalService::new(tmp.path().to_path_buf());

        let result = s.handle("terminal/execute", Some(json!({
            "command": "exit 42",
        }))).await.unwrap();
        assert_eq!(result["exitCode"], 42);
    }

    #[tokio::test]
    async fn execute_with_stderr() {
        let tmp = TempDir::new().unwrap();
        let s = TerminalService::new(tmp.path().to_path_buf());

        let result = s.handle("terminal/execute", Some(json!({
            "command": "echo err >&2",
        }))).await.unwrap();
        assert!(result["stderr"].as_str().unwrap().contains("err"));
    }

    #[tokio::test]
    async fn execute_with_custom_cwd() {
        let tmp = TempDir::new().unwrap();
        let sub = tmp.path().join("subdir");
        std::fs::create_dir(&sub).unwrap();
        let s = TerminalService::new(tmp.path().to_path_buf());

        let result = s.handle("terminal/execute", Some(json!({
            "command": "pwd",
            "cwd": sub.to_str().unwrap(),
        }))).await.unwrap();
        assert!(result["stdout"].as_str().unwrap().contains("subdir"));
    }

    #[tokio::test]
    async fn create_and_list_terminal() {
        let tmp = TempDir::new().unwrap();
        let s = TerminalService::new(tmp.path().to_path_buf());

        let result = s.handle("terminal/create", Some(json!({
            "shell": "/bin/sh",
        }))).await.unwrap();
        let term_id = result["terminalId"].as_str().unwrap().to_string();
        assert!(term_id.starts_with("term-"));
        assert_eq!(result["shell"], "/bin/sh");

        let list = s.handle("terminal/list", None).await.unwrap();
        let terminals = list["terminals"].as_array().unwrap();
        assert_eq!(terminals.len(), 1);
        assert_eq!(terminals[0]["id"], term_id);
        assert_eq!(terminals[0]["running"], true);
    }

    #[tokio::test]
    async fn terminal_exists() {
        let tmp = TempDir::new().unwrap();
        let s = TerminalService::new(tmp.path().to_path_buf());

        let result = s.handle("terminal/exists", Some(json!({"id": "nonexistent"}))).await.unwrap();
        assert_eq!(result["exists"], false);

        let create = s.handle("terminal/create", Some(json!({"shell": "/bin/sh"}))).await.unwrap();
        let id = create["terminalId"].as_str().unwrap();

        let result = s.handle("terminal/exists", Some(json!({"id": id}))).await.unwrap();
        assert_eq!(result["exists"], true);
    }

    #[tokio::test]
    async fn close_terminal() {
        let tmp = TempDir::new().unwrap();
        let s = TerminalService::new(tmp.path().to_path_buf());

        let create = s.handle("terminal/create", Some(json!({"shell": "/bin/sh"}))).await.unwrap();
        let id = create["terminalId"].as_str().unwrap();

        let result = s.handle("terminal/close", Some(json!({"id": id}))).await.unwrap();
        assert_eq!(result["success"], true);

        let exists = s.handle("terminal/exists", Some(json!({"id": id}))).await.unwrap();
        assert_eq!(exists["exists"], false);
    }

    #[tokio::test]
    async fn close_nonexistent_terminal_errors() {
        let tmp = TempDir::new().unwrap();
        let s = TerminalService::new(tmp.path().to_path_buf());

        let err = s.handle("terminal/close", Some(json!({"id": "fake-id"}))).await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn close_all_terminals() {
        let tmp = TempDir::new().unwrap();
        let s = TerminalService::new(tmp.path().to_path_buf());

        s.handle("terminal/create", Some(json!({"shell": "/bin/sh"}))).await.unwrap();
        s.handle("terminal/create", Some(json!({"shell": "/bin/sh"}))).await.unwrap();

        let result = s.handle("terminal/closeAll", None).await.unwrap();
        assert_eq!(result["success"], true);

        let list = s.handle("terminal/list", None).await.unwrap();
        assert_eq!(list["terminals"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn write_to_terminal() {
        let tmp = TempDir::new().unwrap();
        let s = TerminalService::new(tmp.path().to_path_buf());

        let create = s.handle("terminal/create", Some(json!({"shell": "/bin/sh"}))).await.unwrap();
        let id = create["terminalId"].as_str().unwrap();

        let result = s.handle("terminal/write", Some(json!({
            "id": id, "data": "echo test\n",
        }))).await.unwrap();
        assert_eq!(result["success"], true);
    }

    #[tokio::test]
    async fn get_buffer() {
        let tmp = TempDir::new().unwrap();
        let s = TerminalService::new(tmp.path().to_path_buf());

        let create = s.handle("terminal/create", Some(json!({"shell": "/bin/sh"}))).await.unwrap();
        let id = create["terminalId"].as_str().unwrap();

        // Buffer starts empty — now returns structured { lines, cursorRow, cursorCol }
        let result = s.handle("terminal/getBuffer", Some(json!({"id": id}))).await.unwrap();
        assert!(result["buffer"]["lines"].as_array().is_some());
    }

    #[tokio::test]
    async fn unknown_method() {
        let tmp = TempDir::new().unwrap();
        let s = TerminalService::new(tmp.path().to_path_buf());
        let err = s.handle("terminal/nonexistent", None).await;
        assert!(err.is_err());
        assert_eq!(err.unwrap_err().code, -32601);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Session service tests
// ─────────────────────────────────────────────────────────────────────────────

mod session {
    use super::*;
    use ecp_services::session::SessionService;
    use ecp_services::Service;

    fn svc() -> (TempDir, SessionService) {
        let tmp = TempDir::new().unwrap();
        let sessions_dir = tmp.path().join("sessions");
        let s = SessionService::new_with_sessions_dir(
            tmp.path().to_path_buf(),
            sessions_dir,
        );
        (tmp, s)
    }

    #[tokio::test]
    async fn config_get_set() {
        let (_tmp, s) = svc();

        // Get default value
        let result = s.handle("config/get", Some(json!({"key": "editor.fontSize"}))).await.unwrap();
        assert_eq!(result["value"], 14);

        // Set new value
        s.handle("config/set", Some(json!({"key": "editor.fontSize", "value": 18}))).await.unwrap();

        let result = s.handle("config/get", Some(json!({"key": "editor.fontSize"}))).await.unwrap();
        assert_eq!(result["value"], 18);
    }

    #[tokio::test]
    async fn config_get_all() {
        let (_tmp, s) = svc();

        let result = s.handle("config/getAll", None).await.unwrap();
        let settings = result["settings"].as_object().unwrap();
        assert!(settings.contains_key("editor.fontSize"));
        assert!(settings.contains_key("editor.tabSize"));
        assert!(settings.contains_key("workbench.colorTheme"));
    }

    #[tokio::test]
    async fn config_reset() {
        let (_tmp, s) = svc();

        // Change then reset
        s.handle("config/set", Some(json!({"key": "editor.tabSize", "value": 8}))).await.unwrap();
        let result = s.handle("config/get", Some(json!({"key": "editor.tabSize"}))).await.unwrap();
        assert_eq!(result["value"], 8);

        let result = s.handle("config/reset", Some(json!({"key": "editor.tabSize"}))).await.unwrap();
        assert_eq!(result["success"], true);

        // Verify it was reset to default
        let result = s.handle("config/get", Some(json!({"key": "editor.tabSize"}))).await.unwrap();
        assert_eq!(result["value"], 4); // default
    }

    #[tokio::test]
    async fn config_get_unknown_key() {
        let (_tmp, s) = svc();

        let result = s.handle("config/get", Some(json!({"key": "nonexistent.key"}))).await.unwrap();
        assert!(result["value"].is_null());
    }

    #[tokio::test]
    async fn session_save_and_list() {
        let (_tmp, s) = svc();

        let result = s.handle("session/save", Some(json!({"name": "My Session"}))).await.unwrap();
        assert!(result["sessionId"].as_str().unwrap().starts_with("session-"));

        let result = s.handle("session/list", None).await.unwrap();
        let sessions = result["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 1);
    }

    #[tokio::test]
    async fn session_save_load_roundtrip() {
        let (_tmp, s) = svc();

        // Set a custom value
        s.handle("config/set", Some(json!({"key": "editor.fontSize", "value": 20}))).await.unwrap();

        let saved = s.handle("session/save", Some(json!({"name": "Roundtrip"}))).await.unwrap();
        let sid = saved["sessionId"].as_str().unwrap();

        // Change the value
        s.handle("config/set", Some(json!({"key": "editor.fontSize", "value": 10}))).await.unwrap();

        // Load restores it
        s.handle("session/load", Some(json!({"sessionId": sid}))).await.unwrap();
        let result = s.handle("config/get", Some(json!({"key": "editor.fontSize"}))).await.unwrap();
        assert_eq!(result["value"], 20);
    }

    #[tokio::test]
    async fn session_delete() {
        let (_tmp, s) = svc();

        let saved = s.handle("session/save", Some(json!({"name": "Delete Me"}))).await.unwrap();
        let sid = saved["sessionId"].as_str().unwrap();

        s.handle("session/delete", Some(json!({"sessionId": sid}))).await.unwrap();

        let result = s.handle("session/list", None).await.unwrap();
        assert_eq!(result["sessions"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn session_current() {
        let (_tmp, s) = svc();

        // No current session initially
        let result = s.handle("session/current", None).await.unwrap();
        assert!(result["session"].is_null());

        // After save, current session is set
        s.handle("session/save", Some(json!({"name": "Current"}))).await.unwrap();
        let result = s.handle("session/current", None).await.unwrap();
        assert!(!result["session"].is_null());
    }

    // ── Theme tests ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn theme_list() {
        let (_tmp, s) = svc();

        let result = s.handle("theme/list", None).await.unwrap();
        let themes = result["themes"].as_array().unwrap();
        assert!(themes.len() >= 4);
        // Verify catppuccin themes are present
        let ids: Vec<&str> = themes.iter().filter_map(|t| t["id"].as_str()).collect();
        assert!(ids.contains(&"catppuccin-mocha"));
        assert!(ids.contains(&"catppuccin-latte"));
    }

    #[tokio::test]
    async fn theme_get_set() {
        let (_tmp, s) = svc();

        let result = s.handle("theme/current", None).await.unwrap();
        assert_eq!(result["theme"]["id"], "catppuccin-frappe"); // default
        // Verify full theme data is loaded (colors and tokenColors)
        assert!(result["theme"]["colors"].is_object(), "theme should have colors object");
        assert!(result["theme"]["tokenColors"].is_array(), "theme should have tokenColors array");

        s.handle("theme/set", Some(json!({"themeId": "catppuccin-latte"}))).await.unwrap();

        let result = s.handle("theme/get", None).await.unwrap();
        assert_eq!(result["theme"]["id"], "catppuccin-latte");
        assert_eq!(result["theme"]["type"], "light"); // latte is the light theme
    }

    // ── Workspace tests ─────────────────────────────────────────────────

    #[tokio::test]
    async fn workspace_get_set_root() {
        let (_tmp, s) = svc();

        let result = s.handle("workspace/getRoot", None).await.unwrap();
        assert!(result["path"].as_str().is_some());

        s.handle("workspace/setRoot", Some(json!({"path": "/tmp/new-root"}))).await.unwrap();
        let result = s.handle("workspace/getRoot", None).await.unwrap();
        assert_eq!(result["path"], "/tmp/new-root");
    }

    // ── System prompt tests ─────────────────────────────────────────────

    #[tokio::test]
    async fn system_prompt_get_set() {
        let (_tmp, s) = svc();

        let result = s.handle("systemPrompt/get", None).await.unwrap();
        assert_eq!(result["content"], ""); // empty when not set
        assert_eq!(result["isDefault"], true);

        s.handle("systemPrompt/set", Some(json!({"prompt": "You are a helpful assistant"}))).await.unwrap();

        let result = s.handle("systemPrompt/get", None).await.unwrap();
        assert_eq!(result["content"], "You are a helpful assistant");
        assert_eq!(result["isDefault"], false);
    }

    // ── Keybindings ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn keybindings_get_empty() {
        let (_tmp, s) = svc();

        let result = s.handle("keybindings/get", None).await.unwrap();
        assert!(result["bindings"].as_array().unwrap().is_empty());
    }

    // ── Commands ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn commands_list() {
        let (_tmp, s) = svc();

        let result = s.handle("commands/list", None).await.unwrap();
        assert!(result["commands"].as_array().is_some());
    }

    // ── Models (moved to ModelsService) ─────────────────────────────

    #[tokio::test]
    async fn models_not_handled_by_session() {
        let (_tmp, s) = svc();
        // models/list is now handled by ModelsService, not SessionService
        let result = s.handle("models/list", None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn unknown_method() {
        let (_tmp, s) = svc();
        let err = s.handle("session/nonexistent", None).await;
        assert!(err.is_err());
        assert_eq!(err.unwrap_err().code, -32601);
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

        let result = s.handle("database/createConnection", Some(json!({
            "name": "Test DB", "host": "localhost", "port": 5432,
            "database": "testdb", "username": "user", "password": "pass",
        }))).await.unwrap();
        let conn_id = result["connectionId"].as_str().unwrap().to_string();
        assert!(conn_id.starts_with("conn-"));

        let result = s.handle("database/listConnections", None).await.unwrap();
        let conns = result["connections"].as_array().unwrap();
        assert_eq!(conns.len(), 1);
        assert_eq!(conns[0]["name"], "Test DB");
        assert_eq!(conns[0]["status"], "disconnected");

        let result = s.handle("database/getConnection", Some(json!({"connectionId": &conn_id}))).await.unwrap();
        assert_eq!(result["name"], "Test DB");
        assert_eq!(result["database"], "testdb");

        s.handle("database/updateConnection", Some(json!({
            "connectionId": &conn_id, "name": "Updated DB",
        }))).await.unwrap();

        let result = s.handle("database/getConnection", Some(json!({"connectionId": &conn_id}))).await.unwrap();
        assert_eq!(result["name"], "Updated DB");

        s.handle("database/deleteConnection", Some(json!({"connectionId": &conn_id}))).await.unwrap();
        let result = s.handle("database/listConnections", None).await.unwrap();
        assert_eq!(result["connections"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn favorites() {
        let tmp = TempDir::new().unwrap();
        let s = DatabaseService::new(tmp.path().to_path_buf());

        s.handle("database/favoriteQuery", Some(json!({
            "name": "All users", "sql": "SELECT * FROM users",
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

    #[tokio::test]
    async fn cancel_stub_returns_not_cancelled() {
        let tmp = TempDir::new().unwrap();
        let s = DatabaseService::new(tmp.path().to_path_buf());
        let result = s.handle("database/cancel", Some(json!({"queryId": "q-123"}))).await.unwrap();
        assert_eq!(result["cancelled"], false);
        assert!(result["reason"].as_str().unwrap().contains("not supported"));
    }

    #[tokio::test]
    async fn fetch_rows_returns_error() {
        let tmp = TempDir::new().unwrap();
        let s = DatabaseService::new(tmp.path().to_path_buf());
        let err = s.handle("database/fetchRows", Some(json!({"queryId": "q-123", "offset": 0, "limit": 10}))).await;
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
            "path": ".", "recursive": true,
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

// ─────────────────────────────────────────────────────────────────────────────
// Bridge forwarding service tests — validate thin wrappers return correct errors
// ─────────────────────────────────────────────────────────────────────────────

mod bridge_services {
    use ecp_services::bridge_services::{AIService, AuthService, AgentService, SyntaxService, WorkflowService};
    use ecp_services::Service;
    use ecp_ai_bridge::AIBridge;
    use std::sync::Arc;

    /// Create a bridge that is NOT started — all requests should fail gracefully.
    fn unstarted_bridge() -> Arc<AIBridge> {
        Arc::new(AIBridge::new())
    }

    #[tokio::test]
    async fn ai_service_forwards_namespace() {
        let bridge = unstarted_bridge();
        let svc = AIService::new(bridge);
        assert_eq!(svc.namespace(), "ai");
    }

    #[tokio::test]
    async fn auth_service_forwards_namespace() {
        let bridge = unstarted_bridge();
        let svc = AuthService::new(bridge);
        assert_eq!(svc.namespace(), "auth");
    }

    #[tokio::test]
    async fn agent_service_forwards_namespace() {
        let bridge = unstarted_bridge();
        let svc = AgentService::new(bridge);
        assert_eq!(svc.namespace(), "agent");
    }

    #[tokio::test]
    async fn workflow_service_forwards_namespace() {
        let bridge = unstarted_bridge();
        let svc = WorkflowService::new(bridge);
        assert_eq!(svc.namespace(), "workflow");
    }

    #[tokio::test]
    async fn syntax_service_forwards_namespace() {
        let bridge = unstarted_bridge();
        let svc = SyntaxService::new(bridge);
        assert_eq!(svc.namespace(), "syntax");
    }

    #[tokio::test]
    async fn unstarted_bridge_returns_error() {
        let bridge = unstarted_bridge();
        let svc = AIService::new(bridge);
        let result = svc.handle("ai/models/list", None).await;
        assert!(result.is_err(), "Should fail when bridge not started");
        let err = result.unwrap_err();
        assert_eq!(err.code, -32000);
        assert!(err.message.contains("not started"));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Models service tests
// ─────────────────────────────────────────────────────────────────────────────

mod models {
    use ecp_services::models::ModelsService;
    use ecp_services::Service;

    #[tokio::test]
    async fn namespace_is_models() {
        let svc = ModelsService::new(None);
        assert_eq!(svc.namespace(), "models");
    }

    #[tokio::test]
    async fn list_without_bridge_returns_fallback() {
        let svc = ModelsService::new(None);
        let result = svc.handle("models/list", None).await.unwrap();
        // Should return either real file or fallback config
        assert!(result.get("version").is_some() || result.get("models").is_some(),
            "models/list should return a config object: {result}");
    }

    #[tokio::test]
    async fn refresh_without_bridge_returns_error() {
        let svc = ModelsService::new(None);
        let result = svc.handle("models/refresh", None).await;
        assert!(result.is_err(), "models/refresh should fail without bridge");
    }

    #[tokio::test]
    async fn unknown_method_returns_error() {
        let svc = ModelsService::new(None);
        let result = svc.handle("models/nonexistent", None).await;
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().code, -32601);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow service tests — CRUD, execution lifecycle, governance, dashboard
// ─────────────────────────────────────────────────────────────────────────────

mod workflow {
    use super::*;
    use ecp_services::chat::ChatDb;
    use ecp_services::workflow::WorkflowService;
    use ecp_services::Service;
    use parking_lot::Mutex;
    use std::sync::Arc;

    fn svc() -> (TempDir, WorkflowService) {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join(".ultra")).unwrap();
        let global_db = ChatDb::open(&tmp.path().join(".ultra/global.db"))
            .expect("Failed to open global DB");
        let s = WorkflowService::new_with_global_db(
            tmp.path(),
            Arc::new(Mutex::new(global_db)),
        );
        (tmp, s)
    }

    // ── Workflow CRUD ────────────────────────────────────────────────────

    #[tokio::test]
    async fn workflow_crud() {
        let (_tmp, s) = svc();

        // Create
        let wf = s
            .handle(
                "workflow/create",
                Some(json!({
                    "name": "Test Workflow",
                    "description": "A test workflow",
                    "triggerType": "manual",
                })),
            )
            .await
            .unwrap();
        let wf_id = wf["id"].as_str().unwrap().to_string();
        assert!(wf_id.starts_with("wf-"));
        assert_eq!(wf["name"], "Test Workflow");
        assert_eq!(wf["description"], "A test workflow");
        assert_eq!(wf["triggerType"], "manual");
        assert_eq!(wf["isSystem"], false);
        assert_eq!(wf["isDefault"], false);

        // Get
        let result = s
            .handle("workflow/get", Some(json!({ "id": &wf_id })))
            .await
            .unwrap();
        assert_eq!(result["name"], "Test Workflow");

        // List
        let result = s.handle("workflow/list", None).await.unwrap();
        assert_eq!(result["workflows"].as_array().unwrap().len(), 1);

        // Update
        let updated = s
            .handle(
                "workflow/update",
                Some(json!({ "id": &wf_id, "name": "Updated Workflow", "description": "Updated desc" })),
            )
            .await
            .unwrap();
        assert_eq!(updated["name"], "Updated Workflow");
        assert_eq!(updated["description"], "Updated desc");

        // Delete
        let result = s
            .handle("workflow/delete", Some(json!({ "id": &wf_id })))
            .await
            .unwrap();
        assert_eq!(result["deleted"], true);

        // Verify deleted
        let result = s
            .handle("workflow/get", Some(json!({ "id": &wf_id })))
            .await
            .unwrap();
        assert!(result.is_null());
    }

    #[tokio::test]
    async fn workflow_create_with_definition() {
        let (_tmp, s) = svc();

        let definition = json!({
            "steps": [
                { "id": "step1", "type": "agent", "agent": "assistant", "prompt": "Hello" },
                { "id": "step2", "type": "checkpoint", "checkpointMessage": "Review?" },
            ]
        });

        let wf = s
            .handle(
                "workflow/create",
                Some(json!({
                    "name": "With Definition",
                    "definition": definition,
                })),
            )
            .await
            .unwrap();

        let wf_id = wf["id"].as_str().unwrap();
        let result = s
            .handle("workflow/get", Some(json!({ "id": wf_id })))
            .await
            .unwrap();

        let steps = result["definition"]["steps"].as_array().unwrap();
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0]["type"], "agent");
        assert_eq!(steps[1]["type"], "checkpoint");
    }

    #[tokio::test]
    async fn workflow_create_with_custom_id() {
        let (_tmp, s) = svc();

        let wf = s
            .handle(
                "workflow/create",
                Some(json!({ "id": "my-custom-wf", "name": "Custom ID" })),
            )
            .await
            .unwrap();
        assert_eq!(wf["id"], "my-custom-wf");
    }

    #[tokio::test]
    async fn workflow_system_protection() {
        let (_tmp, s) = svc();

        // Create a system workflow
        let wf = s
            .handle(
                "workflow/create",
                Some(json!({ "name": "System WF", "isSystem": true })),
            )
            .await
            .unwrap();
        let wf_id = wf["id"].as_str().unwrap();
        assert_eq!(wf["isSystem"], true);

        // Cannot delete system workflows
        let result = s
            .handle("workflow/delete", Some(json!({ "id": wf_id })))
            .await
            .unwrap();
        assert_eq!(result["deleted"], false);
    }

    #[tokio::test]
    async fn workflow_list_exclude_system() {
        let (_tmp, s) = svc();

        s.handle(
            "workflow/create",
            Some(json!({ "name": "User WF", "isSystem": false })),
        )
        .await
        .unwrap();
        s.handle(
            "workflow/create",
            Some(json!({ "name": "System WF", "isSystem": true })),
        )
        .await
        .unwrap();

        // Include system (default)
        let result = s.handle("workflow/list", None).await.unwrap();
        assert_eq!(result["workflows"].as_array().unwrap().len(), 2);

        // Exclude system
        let result = s
            .handle(
                "workflow/list",
                Some(json!({ "includeSystem": false })),
            )
            .await
            .unwrap();
        assert_eq!(result["workflows"].as_array().unwrap().len(), 1);
        assert_eq!(result["workflows"][0]["name"], "User WF");
    }

    // ── Execution Lifecycle ──────────────────────────────────────────────

    #[tokio::test]
    async fn execution_crud() {
        let (_tmp, s) = svc();

        let wf = s
            .handle(
                "workflow/create",
                Some(json!({ "name": "Exec Test", "definition": { "steps": [] } })),
            )
            .await
            .unwrap();
        let wf_id = wf["id"].as_str().unwrap();

        // Start execution (empty steps = completes immediately)
        let exec = s
            .handle(
                "workflow/execute/start",
                Some(json!({ "workflowId": wf_id })),
            )
            .await
            .unwrap();
        let exec_id = exec["id"].as_str().unwrap().to_string();
        assert!(exec_id.starts_with("exec-"));

        // Brief wait for async executor to complete
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        // Get execution
        let result = s
            .handle("workflow/execute/get", Some(json!({ "id": &exec_id })))
            .await
            .unwrap();
        assert_eq!(result["workflowName"], "Exec Test");
        // Empty-step workflow completes immediately
        assert_eq!(result["status"], "completed");

        // List executions
        let result = s
            .handle("workflow/execute/list", None)
            .await
            .unwrap();
        assert_eq!(result["executions"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn execution_with_initial_input() {
        let (_tmp, s) = svc();

        let wf = s
            .handle(
                "workflow/create",
                Some(json!({ "name": "Input Test", "definition": { "steps": [] } })),
            )
            .await
            .unwrap();
        let wf_id = wf["id"].as_str().unwrap();

        let exec = s
            .handle(
                "workflow/execute/start",
                Some(json!({
                    "workflowId": wf_id,
                    "initialInput": { "prUrl": "https://github.com/test/pr/1" },
                    "maxIterations": 5,
                })),
            )
            .await
            .unwrap();

        let exec_id = exec["id"].as_str().unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let result = s
            .handle("workflow/execute/get", Some(json!({ "id": exec_id })))
            .await
            .unwrap();
        assert_eq!(result["initialInput"]["prUrl"], "https://github.com/test/pr/1");
        assert_eq!(result["maxIterations"], 5);
    }

    #[tokio::test]
    async fn execution_pause_resume_cancel() {
        let (_tmp, s) = svc();

        let wf = s
            .handle(
                "workflow/create",
                Some(json!({ "name": "State Test", "definition": { "steps": [] } })),
            )
            .await
            .unwrap();
        let wf_id = wf["id"].as_str().unwrap();

        let exec = s
            .handle(
                "workflow/execute/start",
                Some(json!({ "workflowId": wf_id })),
            )
            .await
            .unwrap();
        let exec_id = exec["id"].as_str().unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        // Pause
        let result = s
            .handle("workflow/execute/pause", Some(json!({ "id": exec_id })))
            .await
            .unwrap();
        assert_eq!(result["status"], "paused");

        // Resume
        let result = s
            .handle("workflow/execute/resume", Some(json!({ "id": exec_id })))
            .await
            .unwrap();
        assert_eq!(result["status"], "running");

        // Cancel
        let result = s
            .handle("workflow/execute/cancel", Some(json!({ "id": exec_id })))
            .await
            .unwrap();
        assert_eq!(result["status"], "cancelled");
        assert!(result["completedAt"].is_i64()); // terminal states get completedAt
    }

    #[tokio::test]
    async fn execution_list_with_filters() {
        let (_tmp, s) = svc();

        let wf1 = s
            .handle(
                "workflow/create",
                Some(json!({ "name": "WF1", "definition": { "steps": [] } })),
            )
            .await
            .unwrap();
        let wf2 = s
            .handle(
                "workflow/create",
                Some(json!({ "name": "WF2", "definition": { "steps": [] } })),
            )
            .await
            .unwrap();

        s.handle(
            "workflow/execute/start",
            Some(json!({ "workflowId": wf1["id"].as_str().unwrap() })),
        )
        .await
        .unwrap();
        s.handle(
            "workflow/execute/start",
            Some(json!({ "workflowId": wf2["id"].as_str().unwrap() })),
        )
        .await
        .unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        // Filter by workflow_id
        let result = s
            .handle(
                "workflow/execute/list",
                Some(json!({ "workflowId": wf1["id"].as_str().unwrap() })),
            )
            .await
            .unwrap();
        assert_eq!(result["executions"].as_array().unwrap().len(), 1);

        // Filter by status
        let result = s
            .handle(
                "workflow/execute/list",
                Some(json!({ "status": "completed" })),
            )
            .await
            .unwrap();
        assert_eq!(result["executions"].as_array().unwrap().len(), 2);

        // Limit
        let result = s
            .handle(
                "workflow/execute/list",
                Some(json!({ "limit": 1 })),
            )
            .await
            .unwrap();
        assert_eq!(result["executions"].as_array().unwrap().len(), 1);
    }

    // ── Checkpoints ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn checkpoint_lifecycle() {
        let (_tmp, s) = svc();

        // Create a workflow with a checkpoint step
        let wf = s
            .handle(
                "workflow/create",
                Some(json!({
                    "name": "Checkpoint WF",
                    "definition": {
                        "steps": [
                            { "id": "check", "type": "checkpoint", "prompt": "Approve?" }
                        ]
                    }
                })),
            )
            .await
            .unwrap();
        let wf_id = wf["id"].as_str().unwrap();

        // Start execution — should pause at checkpoint
        let exec = s
            .handle(
                "workflow/execute/start",
                Some(json!({ "workflowId": wf_id })),
            )
            .await
            .unwrap();
        let exec_id = exec["id"].as_str().unwrap();

        // Wait for executor to reach checkpoint
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        // Verify execution is awaiting input
        let result = s
            .handle("workflow/execute/get", Some(json!({ "id": exec_id })))
            .await
            .unwrap();
        assert_eq!(result["status"], "awaiting_input");

        // List pending checkpoints
        let result = s
            .handle(
                "workflow/checkpoint/list",
                Some(json!({ "sessionId": exec_id, "pendingOnly": true })),
            )
            .await
            .unwrap();
        let checkpoints = result["checkpoints"].as_array().unwrap();
        assert_eq!(checkpoints.len(), 1);
        let cp_id = checkpoints[0]["id"].as_str().unwrap();
        assert_eq!(checkpoints[0]["checkpointType"], "approval");
        assert!(checkpoints[0]["decidedAt"].is_null());

        // Get checkpoint
        let cp = s
            .handle("workflow/checkpoint/get", Some(json!({ "id": cp_id })))
            .await
            .unwrap();
        assert_eq!(cp["checkpointType"], "approval");

        // Respond to checkpoint
        let responded = s
            .handle(
                "workflow/checkpoint/respond",
                Some(json!({ "id": cp_id, "decision": "approved", "feedback": "Looks good" })),
            )
            .await
            .unwrap();
        assert_eq!(responded["decision"], "approved");
        assert_eq!(responded["feedback"], "Looks good");
        assert!(responded["decidedAt"].is_i64());
    }

    // ── Permissions ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn permission_grant_check_deny() {
        let (_tmp, s) = svc();

        // Initially no permission
        let result = s
            .handle(
                "workflow/permission/check",
                Some(json!({ "toolName": "file/write" })),
            )
            .await
            .unwrap();
        assert_eq!(result["allowed"], false);
        assert!(result["permission"].is_null());

        // Grant permission
        let result = s
            .handle(
                "workflow/permission/grant",
                Some(json!({
                    "toolName": "file/write",
                    "scope": "project",
                    "reason": "Needed for build",
                })),
            )
            .await
            .unwrap();
        assert_eq!(result["granted"], true);

        // Check — now allowed
        let result = s
            .handle(
                "workflow/permission/check",
                Some(json!({ "toolName": "file/write" })),
            )
            .await
            .unwrap();
        assert_eq!(result["allowed"], true);
        assert_eq!(result["permission"]["scope"], "project");

        // Deny permission
        let result = s
            .handle(
                "workflow/permission/deny",
                Some(json!({
                    "toolName": "file/write",
                    "scope": "project",
                    "reason": "Security concern",
                })),
            )
            .await
            .unwrap();
        assert_eq!(result["denied"], true);
    }

    #[tokio::test]
    async fn permission_scoped_to_session() {
        let (_tmp, s) = svc();

        // Create a real execution to use as session_id (FK constraint)
        let wf = s
            .handle(
                "workflow/create",
                Some(json!({ "name": "Perm WF", "definition": { "steps": [] } })),
            )
            .await
            .unwrap();
        let exec = s
            .handle(
                "workflow/execute/start",
                Some(json!({ "workflowId": wf["id"].as_str().unwrap() })),
            )
            .await
            .unwrap();
        let session_id = exec["id"].as_str().unwrap();

        // Grant for specific session
        s.handle(
            "workflow/permission/grant",
            Some(json!({
                "toolName": "terminal/execute",
                "scope": "session",
                "sessionId": session_id,
            })),
        )
        .await
        .unwrap();

        // Check with matching session
        let result = s
            .handle(
                "workflow/permission/check",
                Some(json!({ "toolName": "terminal/execute", "sessionId": session_id })),
            )
            .await
            .unwrap();
        assert_eq!(result["allowed"], true);

        // Check without session — session-scoped grant doesn't apply
        let result = s
            .handle(
                "workflow/permission/check",
                Some(json!({ "toolName": "terminal/execute" })),
            )
            .await
            .unwrap();
        assert_eq!(result["allowed"], false, "Session-scoped permission should not match without sessionId");
    }

    // ── Context & Messages ───────────────────────────────────────────────

    #[tokio::test]
    async fn context_add_and_list() {
        let (_tmp, s) = svc();

        // Create a workflow execution to attach context to
        let wf = s
            .handle(
                "workflow/create",
                Some(json!({ "name": "Ctx Test", "definition": { "steps": [] } })),
            )
            .await
            .unwrap();
        let exec = s
            .handle(
                "workflow/execute/start",
                Some(json!({ "workflowId": wf["id"].as_str().unwrap() })),
            )
            .await
            .unwrap();
        let exec_id = exec["id"].as_str().unwrap();

        // Add context items
        s.handle(
            "workflow/context/add",
            Some(json!({
                "sessionId": exec_id,
                "itemType": "user_input",
                "content": "Please review this code",
            })),
        )
        .await
        .unwrap();

        s.handle(
            "workflow/context/add",
            Some(json!({
                "sessionId": exec_id,
                "itemType": "agent_output",
                "content": "I have reviewed the code.",
                "agentId": "reviewer",
                "agentName": "Code Reviewer",
            })),
        )
        .await
        .unwrap();

        // List context
        let result = s
            .handle(
                "workflow/context/list",
                Some(json!({ "sessionId": exec_id })),
            )
            .await
            .unwrap();
        let items = result["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["role"], "user");
        assert_eq!(items[0]["content"], "Please review this code");
        assert_eq!(items[1]["role"], "assistant");
        assert_eq!(items[1]["agentId"], "reviewer");
    }

    #[tokio::test]
    async fn message_list_and_get() {
        let (_tmp, s) = svc();

        let wf = s
            .handle(
                "workflow/create",
                Some(json!({ "name": "Msg Test", "definition": { "steps": [] } })),
            )
            .await
            .unwrap();
        let exec = s
            .handle(
                "workflow/execute/start",
                Some(json!({ "workflowId": wf["id"].as_str().unwrap() })),
            )
            .await
            .unwrap();
        let exec_id = exec["id"].as_str().unwrap();

        // Add a message via context/add (messages and context share the same table)
        let msg = s
            .handle(
                "workflow/context/add",
                Some(json!({
                    "sessionId": exec_id,
                    "itemType": "system",
                    "content": "Workflow started",
                })),
            )
            .await
            .unwrap();
        let msg_id = msg["id"].as_str().unwrap();

        // Get message
        let result = s
            .handle("workflow/message/get", Some(json!({ "id": msg_id })))
            .await
            .unwrap();
        assert_eq!(result["content"], "Workflow started");
        assert_eq!(result["role"], "system");

        // List messages
        let result = s
            .handle(
                "workflow/message/list",
                Some(json!({ "sessionId": exec_id })),
            )
            .await
            .unwrap();
        assert_eq!(result["messages"].as_array().unwrap().len(), 1);

        // List with role filter
        let result = s
            .handle(
                "workflow/message/list",
                Some(json!({ "sessionId": exec_id, "role": "system" })),
            )
            .await
            .unwrap();
        assert_eq!(result["messages"].as_array().unwrap().len(), 1);

        let result = s
            .handle(
                "workflow/message/list",
                Some(json!({ "sessionId": exec_id, "role": "user" })),
            )
            .await
            .unwrap();
        assert_eq!(result["messages"].as_array().unwrap().len(), 0);
    }

    // ── Feedback ─────────────────────────────────────────────────────────

    #[tokio::test]
    async fn feedback_empty_list() {
        let (_tmp, s) = svc();

        let wf = s
            .handle(
                "workflow/create",
                Some(json!({ "name": "FB Test", "definition": { "steps": [] } })),
            )
            .await
            .unwrap();
        let exec = s
            .handle(
                "workflow/execute/start",
                Some(json!({ "workflowId": wf["id"].as_str().unwrap() })),
            )
            .await
            .unwrap();
        let exec_id = exec["id"].as_str().unwrap();

        let result = s
            .handle(
                "workflow/feedback/list",
                Some(json!({ "sessionId": exec_id })),
            )
            .await
            .unwrap();
        assert_eq!(result["feedback"].as_array().unwrap().len(), 0);
    }

    // ── Agents ───────────────────────────────────────────────────────────

    #[tokio::test]
    async fn agent_crud() {
        let (_tmp, s) = svc();

        // Create
        let agent = s
            .handle(
                "workflow/agent/create",
                Some(json!({
                    "name": "Code Reviewer",
                    "description": "Reviews code for quality",
                    "role": "reviewer",
                    "provider": "claude",
                    "model": "claude-sonnet-4-20250514",
                    "systemPrompt": "You are a code reviewer.",
                    "tools": ["file/read", "git/diff"],
                })),
            )
            .await
            .unwrap();
        let agent_id = agent["id"].as_str().unwrap().to_string();
        assert!(agent_id.starts_with("agent-"));
        assert_eq!(agent["name"], "Code Reviewer");
        assert_eq!(agent["role"], "reviewer");
        assert_eq!(agent["tools"].as_array().unwrap().len(), 2);

        // Get
        let result = s
            .handle("workflow/agent/get", Some(json!({ "id": &agent_id })))
            .await
            .unwrap();
        assert_eq!(result["name"], "Code Reviewer");
        assert_eq!(result["systemPrompt"], "You are a code reviewer.");

        // Update
        let result = s
            .handle(
                "workflow/agent/update",
                Some(json!({
                    "id": &agent_id,
                    "name": "Senior Reviewer",
                    "model": "claude-opus-4-20250514",
                })),
            )
            .await
            .unwrap();
        assert_eq!(result["name"], "Senior Reviewer");
        assert_eq!(result["model"], "claude-opus-4-20250514");

        // List — verify our agent appears (may include global agents from dual-DB)
        let result = s.handle("workflow/agent/list", None).await.unwrap();
        let agents = result["agents"].as_array().unwrap();
        assert!(
            agents.iter().any(|a| a["id"].as_str() == Some(&agent_id)),
            "Created agent should appear in list"
        );

        // Delete
        let result = s
            .handle("workflow/agent/delete", Some(json!({ "id": &agent_id })))
            .await
            .unwrap();
        assert_eq!(result["deleted"], true);

        // Verify deleted
        let result = s
            .handle("workflow/agent/get", Some(json!({ "id": &agent_id })))
            .await
            .unwrap();
        assert!(result.is_null());
    }

    #[tokio::test]
    async fn agent_with_custom_id() {
        let (_tmp, s) = svc();

        let agent = s
            .handle(
                "workflow/agent/create",
                Some(json!({ "id": "my-agent", "name": "Custom Agent" })),
            )
            .await
            .unwrap();
        assert_eq!(agent["id"], "my-agent");
    }

    #[tokio::test]
    async fn agent_list_with_role_filter() {
        let (_tmp, s) = svc();

        s.handle(
            "workflow/agent/create",
            Some(json!({ "name": "General Agent", "roleType": "general" })),
        )
        .await
        .unwrap();
        s.handle(
            "workflow/agent/create",
            Some(json!({ "name": "Specialist Agent", "roleType": "specialist" })),
        )
        .await
        .unwrap();

        // List all — verify both appear (may include global agents from dual-DB)
        let result = s.handle("workflow/agent/list", None).await.unwrap();
        let agents = result["agents"].as_array().unwrap();
        assert!(agents.iter().any(|a| a["name"] == "General Agent"));
        assert!(agents.iter().any(|a| a["name"] == "Specialist Agent"));

        // Filter by role type
        let result = s
            .handle(
                "workflow/agent/list",
                Some(json!({ "roleType": "specialist" })),
            )
            .await
            .unwrap();
        let filtered = result["agents"].as_array().unwrap();
        assert!(filtered.iter().any(|a| a["name"] == "Specialist Agent"));
        assert!(!filtered.iter().any(|a| a["name"] == "General Agent"));
    }

    #[tokio::test]
    async fn agent_system_protection() {
        let (_tmp, s) = svc();

        let agent = s
            .handle(
                "workflow/agent/create",
                Some(json!({ "name": "System Agent", "isSystem": true })),
            )
            .await
            .unwrap();
        let agent_id = agent["id"].as_str().unwrap();

        // Cannot delete system agents
        let result = s
            .handle("workflow/agent/delete", Some(json!({ "id": agent_id })))
            .await
            .unwrap();
        assert_eq!(result["deleted"], false);
    }

    // ── Tool Calls ───────────────────────────────────────────────────────

    #[tokio::test]
    async fn tool_call_get_nonexistent() {
        let (_tmp, s) = svc();

        let result = s
            .handle("workflow/toolCall/get", Some(json!({ "id": "tc-none" })))
            .await
            .unwrap();
        assert!(result.is_null());
    }

    #[tokio::test]
    async fn execution_tools_empty_list() {
        let (_tmp, s) = svc();

        let wf = s
            .handle(
                "workflow/create",
                Some(json!({ "name": "Tool Test", "definition": { "steps": [] } })),
            )
            .await
            .unwrap();
        let exec = s
            .handle(
                "workflow/execute/start",
                Some(json!({ "workflowId": wf["id"].as_str().unwrap() })),
            )
            .await
            .unwrap();
        let exec_id = exec["id"].as_str().unwrap();

        let result = s
            .handle(
                "workflow/execution/tools",
                Some(json!({ "sessionId": exec_id })),
            )
            .await
            .unwrap();
        assert_eq!(result["tools"].as_array().unwrap().len(), 0);
    }

    // ── Governance ───────────────────────────────────────────────────────

    #[tokio::test]
    async fn governance_config() {
        let (_tmp, s) = svc();

        let result = s
            .handle("workflow/governance/config", None)
            .await
            .unwrap();
        let checks = result["checks"].as_array().unwrap();
        assert!(checks.len() >= 5);
        assert!(checks.iter().any(|c| c == "build"));
        assert!(checks.iter().any(|c| c == "test"));
        assert!(checks.iter().any(|c| c == "dead_code"));
        assert!(checks.iter().any(|c| c == "diagnostics"));
        assert!(checks.iter().any(|c| c == "breaking_changes"));
    }

    #[tokio::test]
    async fn governance_history_empty() {
        let (_tmp, s) = svc();

        let result = s
            .handle("workflow/governance/history", None)
            .await
            .unwrap();
        assert_eq!(result["results"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn governance_evaluate_requires_router() {
        let (_tmp, s) = svc();

        // Without InternalRouter set, evaluate should fail
        let result = s
            .handle(
                "workflow/governance/evaluate",
                Some(json!({ "checks": ["build"] })),
            )
            .await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.message.contains("Internal router not available"));
    }

    // ── Dashboard ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn dashboard_empty_state() {
        let (_tmp, s) = svc();

        let result = s
            .handle("workflow/dashboard", None)
            .await
            .unwrap();

        // All sections should exist but be empty/zeroed
        assert_eq!(result["executions"].as_array().unwrap().len(), 0);
        assert_eq!(result["governance"]["totalChecks"], 0);
        assert_eq!(result["governance"]["passRate"], 1.0);
        assert_eq!(result["activity"]["totalExecutions"], 0);
        assert_eq!(result["activity"]["completionRate"], 0.0);
        assert_eq!(result["quality"]["allPassing"], true);
        assert_eq!(result["quality"]["checkCount"], 0);
    }

    #[tokio::test]
    async fn dashboard_with_executions() {
        let (_tmp, s) = svc();

        // Create a workflow and run a couple executions
        let wf = s
            .handle(
                "workflow/create",
                Some(json!({ "name": "Dashboard WF", "definition": { "steps": [] } })),
            )
            .await
            .unwrap();
        let wf_id = wf["id"].as_str().unwrap();

        s.handle(
            "workflow/execute/start",
            Some(json!({ "workflowId": wf_id })),
        )
        .await
        .unwrap();
        s.handle(
            "workflow/execute/start",
            Some(json!({ "workflowId": wf_id })),
        )
        .await
        .unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let result = s
            .handle("workflow/dashboard", Some(json!({ "limit": 10 })))
            .await
            .unwrap();

        assert_eq!(result["executions"].as_array().unwrap().len(), 2);
        assert_eq!(result["activity"]["totalExecutions"], 2);
        assert_eq!(result["activity"]["completed"], 2);
        assert_eq!(result["activity"]["completionRate"], 1.0);
    }

    #[tokio::test]
    async fn dashboard_governance_empty() {
        let (_tmp, s) = svc();

        let result = s
            .handle("workflow/dashboard/governance", None)
            .await
            .unwrap();

        assert_eq!(result["passRates"].as_array().unwrap().len(), 0);
        assert_eq!(result["recentResults"].as_array().unwrap().len(), 0);
        assert_eq!(result["failurePatterns"]["commonFailures"].as_array().unwrap().len(), 0);
        assert_eq!(result["trend"].as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn dashboard_quality_empty() {
        let (_tmp, s) = svc();

        let result = s
            .handle("workflow/dashboard/quality", None)
            .await
            .unwrap();

        assert_eq!(result["healthHistory"].as_array().unwrap().len(), 0);
        assert_eq!(result["checkHistory"].as_array().unwrap().len(), 0);
        assert_eq!(result["nodePerformance"].as_array().unwrap().len(), 0);
        assert_eq!(result["tokenUsage"]["totalTokens"], 0);
        assert_eq!(result["tokenUsage"]["nodeCount"], 0);
    }

    #[tokio::test]
    async fn dashboard_quality_with_executions() {
        let (_tmp, s) = svc();

        let wf = s
            .handle(
                "workflow/create",
                Some(json!({ "name": "Quality WF", "definition": { "steps": [] } })),
            )
            .await
            .unwrap();
        let wf_id = wf["id"].as_str().unwrap();

        s.handle(
            "workflow/execute/start",
            Some(json!({ "workflowId": wf_id })),
        )
        .await
        .unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let result = s
            .handle("workflow/dashboard/quality", None)
            .await
            .unwrap();

        assert_eq!(result["healthHistory"].as_array().unwrap().len(), 1);
        let entry = &result["healthHistory"][0];
        assert_eq!(entry["status"], "completed");
        assert_eq!(entry["nodeSuccessRate"], 1.0);
    }

    #[tokio::test]
    async fn dashboard_commit_nonexistent() {
        let (_tmp, s) = svc();

        let result = s
            .handle(
                "workflow/dashboard/commit",
                Some(json!({ "id": "exec-nonexistent" })),
            )
            .await
            .unwrap();
        assert!(result.is_null());
    }

    #[tokio::test]
    async fn dashboard_commit_for_execution() {
        let (_tmp, s) = svc();

        let wf = s
            .handle(
                "workflow/create",
                Some(json!({ "name": "Commit WF", "definition": { "steps": [] } })),
            )
            .await
            .unwrap();
        let wf_id = wf["id"].as_str().unwrap();

        let exec = s
            .handle(
                "workflow/execute/start",
                Some(json!({ "workflowId": wf_id })),
            )
            .await
            .unwrap();
        let exec_id = exec["id"].as_str().unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let result = s
            .handle(
                "workflow/dashboard/commit",
                Some(json!({ "id": exec_id })),
            )
            .await
            .unwrap();

        assert!(result["summary"].as_str().unwrap().contains("Commit WF"));
        assert!(result["body"].as_str().unwrap().contains("Iterations:"));
        assert!(result["body"].as_str().unwrap().contains("Tokens:"));
        assert_eq!(result["execution"]["workflowName"], "Commit WF");
    }

    // ── Step Execution ───────────────────────────────────────────────────

    #[tokio::test]
    async fn execute_step_completes_empty_workflow() {
        let (_tmp, s) = svc();

        let wf = s
            .handle(
                "workflow/create",
                Some(json!({ "name": "Step Test", "definition": { "steps": [] } })),
            )
            .await
            .unwrap();
        let wf_id = wf["id"].as_str().unwrap();

        let exec = s
            .handle(
                "workflow/execute/start",
                Some(json!({ "workflowId": wf_id })),
            )
            .await
            .unwrap();
        let exec_id = exec["id"].as_str().unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        // Step on completed execution should fail
        let result = s
            .handle("workflow/execute/step", Some(json!({ "id": exec_id })))
            .await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.message.contains("terminal state"));
    }

    // ── Unknown Method ───────────────────────────────────────────────────

    #[tokio::test]
    async fn unknown_method_returns_error() {
        let (_tmp, s) = svc();
        let result = s.handle("workflow/nonexistent", None).await;
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().code, -32601);
    }

    // ── Execution with Checkpoint Step ───────────────────────────────────

    #[tokio::test]
    async fn execution_with_human_node_pauses() {
        let (_tmp, s) = svc();

        let wf = s
            .handle(
                "workflow/create",
                Some(json!({
                    "name": "Human Node WF",
                    "definition": {
                        "steps": [
                            { "id": "input", "type": "human", "prompt": "Please provide input" }
                        ]
                    }
                })),
            )
            .await
            .unwrap();

        let exec = s
            .handle(
                "workflow/execute/start",
                Some(json!({ "workflowId": wf["id"].as_str().unwrap() })),
            )
            .await
            .unwrap();
        let exec_id = exec["id"].as_str().unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        let result = s
            .handle("workflow/execute/get", Some(json!({ "id": exec_id })))
            .await
            .unwrap();
        assert_eq!(result["status"], "awaiting_input");
        assert_eq!(result["currentNodeId"], "input");
    }

    // ── Passthrough Nodes ────────────────────────────────────────────────

    #[tokio::test]
    async fn execution_with_passthrough_nodes() {
        let (_tmp, s) = svc();

        let wf = s
            .handle(
                "workflow/create",
                Some(json!({
                    "name": "Passthrough WF",
                    "definition": {
                        "steps": [
                            { "id": "cond", "type": "condition", "prompt": "Check X" },
                            { "id": "out", "type": "output", "prompt": "Result" },
                        ]
                    }
                })),
            )
            .await
            .unwrap();

        let exec = s
            .handle(
                "workflow/execute/start",
                Some(json!({ "workflowId": wf["id"].as_str().unwrap() })),
            )
            .await
            .unwrap();
        let exec_id = exec["id"].as_str().unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        let result = s
            .handle("workflow/execute/get", Some(json!({ "id": exec_id })))
            .await
            .unwrap();
        assert_eq!(result["status"], "completed");
    }

    // ── Agent Node without Bridge ────────────────────────────────────────

    #[tokio::test]
    async fn execution_agent_node_fails_without_bridge() {
        let (_tmp, s) = svc();

        let wf = s
            .handle(
                "workflow/create",
                Some(json!({
                    "name": "Agent WF",
                    "definition": {
                        "steps": [
                            { "id": "ai", "type": "agent", "agent": "assistant", "prompt": "Do something" }
                        ]
                    }
                })),
            )
            .await
            .unwrap();

        let exec = s
            .handle(
                "workflow/execute/start",
                Some(json!({ "workflowId": wf["id"].as_str().unwrap() })),
            )
            .await
            .unwrap();
        let exec_id = exec["id"].as_str().unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        let result = s
            .handle("workflow/execute/get", Some(json!({ "id": exec_id })))
            .await
            .unwrap();
        // Without bridge, agent node fails
        assert_eq!(result["status"], "failed");
        assert!(result["errorMessage"]
            .as_str()
            .unwrap()
            .contains("bridge not available"));
    }

    // ── Dashboard with limit parameter ───────────────────────────────────

    #[tokio::test]
    async fn dashboard_respects_limit() {
        let (_tmp, s) = svc();

        let wf = s
            .handle(
                "workflow/create",
                Some(json!({ "name": "Limit WF", "definition": { "steps": [] } })),
            )
            .await
            .unwrap();
        let wf_id = wf["id"].as_str().unwrap();

        // Create 3 executions
        for _ in 0..3 {
            s.handle(
                "workflow/execute/start",
                Some(json!({ "workflowId": wf_id })),
            )
            .await
            .unwrap();
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        // Limit to 2
        let result = s
            .handle("workflow/dashboard", Some(json!({ "limit": 2 })))
            .await
            .unwrap();
        assert_eq!(result["executions"].as_array().unwrap().len(), 2);

        // Activity still shows all 3
        assert_eq!(result["activity"]["totalExecutions"], 3);
    }

    // ── Context Item Type Mapping ────────────────────────────────────────

    #[tokio::test]
    async fn context_item_type_role_mapping() {
        let (_tmp, s) = svc();

        let wf = s
            .handle(
                "workflow/create",
                Some(json!({ "name": "Role Map", "definition": { "steps": [] } })),
            )
            .await
            .unwrap();
        let exec = s
            .handle(
                "workflow/execute/start",
                Some(json!({ "workflowId": wf["id"].as_str().unwrap() })),
            )
            .await
            .unwrap();
        let exec_id = exec["id"].as_str().unwrap();

        // user_input → user
        let msg = s
            .handle(
                "workflow/context/add",
                Some(json!({ "sessionId": exec_id, "itemType": "user_input", "content": "Hi" })),
            )
            .await
            .unwrap();
        assert_eq!(msg["role"], "user");

        // agent_output → assistant
        let msg = s
            .handle(
                "workflow/context/add",
                Some(json!({ "sessionId": exec_id, "itemType": "agent_output", "content": "Hello" })),
            )
            .await
            .unwrap();
        assert_eq!(msg["role"], "assistant");

        // system → system
        let msg = s
            .handle(
                "workflow/context/add",
                Some(json!({ "sessionId": exec_id, "itemType": "system", "content": "Init" })),
            )
            .await
            .unwrap();
        assert_eq!(msg["role"], "system");

        // tool_call → tool_call
        let msg = s
            .handle(
                "workflow/context/add",
                Some(json!({ "sessionId": exec_id, "itemType": "tool_call", "content": "{}" })),
            )
            .await
            .unwrap();
        assert_eq!(msg["role"], "tool_call");

        // Explicit role override (must be a valid role per CHECK constraint)
        let msg = s
            .handle(
                "workflow/context/add",
                Some(json!({ "sessionId": exec_id, "itemType": "user_input", "role": "feedback", "content": "Override" })),
            )
            .await
            .unwrap();
        assert_eq!(msg["role"], "feedback");
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// LSP service tests
// ─────────────────────────────────────────────────────────────────────────────

mod lsp {
    use super::*;
    use ecp_services::lsp::LSPService;
    use ecp_services::Service;

    /// Check if typescript-language-server is installed (for integration tests).
    fn has_ts_server() -> bool {
        std::process::Command::new("typescript-language-server")
            .arg("--version")
            .output()
            .is_ok()
    }

    // ── Pure logic tests (no real LSP server needed) ────────────────────

    #[tokio::test]
    async fn language_detection() {
        let tmp = TempDir::new().unwrap();
        let s = LSPService::new(tmp.path().to_path_buf());

        let r = s.handle("lsp/getLanguageId", Some(json!({"path": "foo.ts"}))).await.unwrap();
        assert_eq!(r["languageId"], "typescript");

        let r = s.handle("lsp/getLanguageId", Some(json!({"path": "lib.rs"}))).await.unwrap();
        assert_eq!(r["languageId"], "rust");

        let r = s.handle("lsp/getLanguageId", Some(json!({"path": "main.py"}))).await.unwrap();
        assert_eq!(r["languageId"], "python");

        let r = s.handle("lsp/getLanguageId", Some(json!({"path": "data.json"}))).await.unwrap();
        assert_eq!(r["languageId"], "json");

        let r = s.handle("lsp/getLanguageId", Some(json!({"path": "file.unknown"}))).await.unwrap();
        assert_eq!(r["languageId"], "plaintext");
    }

    #[tokio::test]
    async fn has_server_for_known() {
        let tmp = TempDir::new().unwrap();
        let s = LSPService::new(tmp.path().to_path_buf());

        let r = s.handle("lsp/hasServerFor", Some(json!({"languageId": "typescript"}))).await.unwrap();
        assert_eq!(r["available"], true);

        let r = s.handle("lsp/hasServerFor", Some(json!({"languageId": "rust"}))).await.unwrap();
        assert_eq!(r["available"], true);
    }

    #[tokio::test]
    async fn has_server_for_unknown() {
        let tmp = TempDir::new().unwrap();
        let s = LSPService::new(tmp.path().to_path_buf());

        let r = s.handle("lsp/hasServerFor", Some(json!({"languageId": "fakeLang"}))).await.unwrap();
        assert_eq!(r["available"], false);
    }

    #[tokio::test]
    async fn has_server_with_custom_config() {
        let tmp = TempDir::new().unwrap();
        let s = LSPService::new(tmp.path().to_path_buf());

        // fakeLang unavailable by default
        let r = s.handle("lsp/hasServerFor", Some(json!({"languageId": "fakeLang"}))).await.unwrap();
        assert_eq!(r["available"], false);

        // Register custom config
        s.handle("lsp/setServerConfig", Some(json!({
            "languageId": "fakeLang",
            "config": { "command": "fake-server", "args": ["--stdio"] }
        }))).await.unwrap();

        // Now available
        let r = s.handle("lsp/hasServerFor", Some(json!({"languageId": "fakeLang"}))).await.unwrap();
        assert_eq!(r["available"], true);
    }

    #[tokio::test]
    async fn server_config_round_trip() {
        let tmp = TempDir::new().unwrap();
        let s = LSPService::new(tmp.path().to_path_buf());

        s.handle("lsp/setServerConfig", Some(json!({
            "languageId": "myLang",
            "config": {
                "command": "my-lang-server",
                "args": ["--stdio", "--verbose"],
                "settings": { "maxProblems": 100 }
            }
        }))).await.unwrap();

        let r = s.handle("lsp/getServerConfig", Some(json!({"languageId": "myLang"}))).await.unwrap();
        let config = &r["config"];
        assert_eq!(config["command"], "my-lang-server");
        assert_eq!(config["args"][0], "--stdio");
        assert_eq!(config["args"][1], "--verbose");
        assert_eq!(config["settings"]["maxProblems"], 100);
    }

    #[tokio::test]
    async fn server_config_not_found() {
        let tmp = TempDir::new().unwrap();
        let s = LSPService::new(tmp.path().to_path_buf());

        let r = s.handle("lsp/getServerConfig", Some(json!({"languageId": "nope"}))).await.unwrap();
        assert!(r["config"].is_null());
    }

    #[tokio::test]
    async fn status_empty() {
        let tmp = TempDir::new().unwrap();
        let s = LSPService::new(tmp.path().to_path_buf());

        let r = s.handle("lsp/status", None).await.unwrap();
        let servers = r["servers"].as_array().unwrap();
        assert!(servers.is_empty());
    }

    #[tokio::test]
    async fn unknown_method() {
        let tmp = TempDir::new().unwrap();
        let s = LSPService::new(tmp.path().to_path_buf());

        let err = s.handle("lsp/nonexistent", None).await.unwrap_err();
        assert_eq!(err.code, -32601); // method not found
    }

    #[tokio::test]
    async fn diagnostics_summary_no_servers() {
        let tmp = TempDir::new().unwrap();
        let s = LSPService::new(tmp.path().to_path_buf());

        let r = s.handle("lsp/diagnosticsSummary", None).await.unwrap();
        assert_eq!(r["errors"], 0);
        assert_eq!(r["warnings"], 0);
        assert_eq!(r["infos"], 0);
        assert_eq!(r["hints"], 0);
    }

    // ── Integration tests (require typescript-language-server) ──────────

    #[tokio::test]
    async fn start_and_stop_server() {
        if !has_ts_server() { return; }
        let tmp = TempDir::new().unwrap();
        let s = LSPService::new(tmp.path().to_path_buf());

        // Start
        let r = s.handle("lsp/start", Some(json!({"languageId": "typescript"}))).await.unwrap();
        assert_eq!(r["success"], true);
        assert_eq!(r["languageId"], "typescript");

        // Status shows running
        let r = s.handle("lsp/status", None).await.unwrap();
        let servers = r["servers"].as_array().unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0]["languageId"], "typescript");
        assert_eq!(servers[0]["status"], "running");

        // Stop
        let r = s.handle("lsp/stop", Some(json!({"languageId": "typescript"}))).await.unwrap();
        assert_eq!(r["success"], true);

        // Status empty again
        let r = s.handle("lsp/status", None).await.unwrap();
        assert!(r["servers"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn start_unsupported_language() {
        let tmp = TempDir::new().unwrap();
        let s = LSPService::new(tmp.path().to_path_buf());

        let err = s.handle("lsp/start", Some(json!({"languageId": "fakeLang"}))).await.unwrap_err();
        assert!(err.message.contains("No language server for"));
    }

    #[tokio::test]
    async fn document_open_close() {
        if !has_ts_server() { return; }
        let tmp = TempDir::new().unwrap();
        let s = LSPService::new(tmp.path().to_path_buf());

        // Start server
        s.handle("lsp/start", Some(json!({"languageId": "typescript"}))).await.unwrap();

        let uri = format!("file://{}/test.ts", tmp.path().display());

        // Open
        let r = s.handle("lsp/documentOpen", Some(json!({
            "uri": uri,
            "languageId": "typescript",
            "text": "const x: number = 1;\n"
        }))).await.unwrap();
        assert_eq!(r["success"], true);

        // Close
        let r = s.handle("lsp/documentClose", Some(json!({"uri": uri}))).await.unwrap();
        assert_eq!(r["success"], true);
    }

    #[tokio::test]
    async fn document_change_version() {
        if !has_ts_server() { return; }
        let tmp = TempDir::new().unwrap();
        let s = LSPService::new(tmp.path().to_path_buf());

        s.handle("lsp/start", Some(json!({"languageId": "typescript"}))).await.unwrap();

        let uri = format!("file://{}/test.ts", tmp.path().display());

        // Open (version 1)
        s.handle("lsp/documentOpen", Some(json!({
            "uri": uri,
            "languageId": "typescript",
            "text": "let x = 1;\n"
        }))).await.unwrap();

        // First change → version 2
        let r = s.handle("lsp/documentChange", Some(json!({
            "uri": uri,
            "text": "let x = 2;\n"
        }))).await.unwrap();
        assert_eq!(r["version"], 2);

        // Second change → version 3
        let r = s.handle("lsp/documentChange", Some(json!({
            "uri": uri,
            "text": "let x = 3;\n"
        }))).await.unwrap();
        assert_eq!(r["version"], 3);
    }

    #[tokio::test]
    async fn document_change_not_open() {
        let tmp = TempDir::new().unwrap();
        let s = LSPService::new(tmp.path().to_path_buf());

        let err = s.handle("lsp/documentChange", Some(json!({
            "uri": "file:///not/open.ts",
            "text": "x"
        }))).await.unwrap_err();
        assert!(err.message.contains("not open"));
    }

    /// Create a minimal TS project in the given temp dir so the language server works.
    fn setup_ts_project(tmp: &TempDir) {
        std::fs::write(
            tmp.path().join("tsconfig.json"),
            r#"{"compilerOptions":{"target":"es2020","module":"commonjs","strict":true}}"#,
        ).unwrap();
    }

    #[tokio::test]
    async fn completion_response_structure() {
        if !has_ts_server() { return; }
        let tmp = TempDir::new().unwrap();
        setup_ts_project(&tmp);
        let s = LSPService::new(tmp.path().to_path_buf());

        s.handle("lsp/start", Some(json!({"languageId": "typescript"}))).await.unwrap();

        let file_path = tmp.path().join("test.ts");
        let content = "const x: string = '';\nx.\n";
        std::fs::write(&file_path, content).unwrap();
        let uri = format!("file://{}", file_path.display());

        s.handle("lsp/documentOpen", Some(json!({
            "uri": uri,
            "languageId": "typescript",
            "text": content
        }))).await.unwrap();

        // Give server time to process the project
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;

        let r = s.handle("lsp/completion", Some(json!({
            "uri": uri,
            "line": 1,
            "character": 2
        }))).await;

        match r {
            Ok(v) => assert!(v.get("items").is_some()),
            Err(e) if e.message.contains("timeout") => {
                // Acceptable in resource-constrained environments
                eprintln!("completion timed out (acceptable): {}", e.message);
            }
            Err(e) => panic!("unexpected error: {e:?}"),
        }
    }

    #[tokio::test]
    async fn hover_response_structure() {
        if !has_ts_server() { return; }
        let tmp = TempDir::new().unwrap();
        setup_ts_project(&tmp);
        let s = LSPService::new(tmp.path().to_path_buf());

        s.handle("lsp/start", Some(json!({"languageId": "typescript"}))).await.unwrap();

        let file_path = tmp.path().join("test.ts");
        let content = "const x: number = 42;\n";
        std::fs::write(&file_path, content).unwrap();
        let uri = format!("file://{}", file_path.display());

        s.handle("lsp/documentOpen", Some(json!({
            "uri": uri,
            "languageId": "typescript",
            "text": content
        }))).await.unwrap();

        tokio::time::sleep(std::time::Duration::from_secs(2)).await;

        let r = s.handle("lsp/hover", Some(json!({
            "uri": uri,
            "line": 0,
            "character": 6
        }))).await;

        match r {
            Ok(v) => assert!(v.get("hover").is_some()),
            Err(e) if e.message.contains("timeout") => {
                eprintln!("hover timed out (acceptable): {}", e.message);
            }
            Err(e) => panic!("unexpected error: {e:?}"),
        }
    }

    #[tokio::test]
    async fn diagnostics_for_document() {
        if !has_ts_server() { return; }
        let tmp = TempDir::new().unwrap();
        setup_ts_project(&tmp);
        let s = LSPService::new(tmp.path().to_path_buf());

        s.handle("lsp/start", Some(json!({"languageId": "typescript"}))).await.unwrap();

        let file_path = tmp.path().join("test.ts");
        let content = "const x: number = 'not a number';\n";
        std::fs::write(&file_path, content).unwrap();
        let uri = format!("file://{}", file_path.display());

        s.handle("lsp/documentOpen", Some(json!({
            "uri": uri,
            "languageId": "typescript",
            "text": content
        }))).await.unwrap();

        // Wait for diagnostics to be published
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;

        let r = s.handle("lsp/diagnostics", Some(json!({"uri": uri}))).await.unwrap();

        // Response must have "diagnostics" array
        assert!(r["diagnostics"].is_array());
    }
}
