//! Protocol layer tests — JSON-RPC serialization, errors, methods, auth types.

#[cfg(test)]
mod tests {
    use serde_json::json;
    use ecp_protocol::*;
    use ecp_protocol::jsonrpc::*;
    use ecp_protocol::auth::*;
    use ecp_protocol::methods::is_known_method;

    // ─────────────────────────────────────────────────────────────────────
    // RequestId
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn request_id_number_serialization() {
        let id = RequestId::Number(42);
        let json = serde_json::to_value(&id).unwrap();
        assert_eq!(json, json!(42));
    }

    #[test]
    fn request_id_string_serialization() {
        let id = RequestId::String("abc-123".into());
        let json = serde_json::to_value(&id).unwrap();
        assert_eq!(json, json!("abc-123"));
    }

    #[test]
    fn request_id_number_deserialization() {
        let id: RequestId = serde_json::from_value(json!(99)).unwrap();
        assert_eq!(id, RequestId::Number(99));
    }

    #[test]
    fn request_id_string_deserialization() {
        let id: RequestId = serde_json::from_value(json!("req-1")).unwrap();
        assert_eq!(id, RequestId::String("req-1".into()));
    }

    // ─────────────────────────────────────────────────────────────────────
    // ECPRequest
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn request_roundtrip() {
        let req = ECPRequest {
            jsonrpc: "2.0".into(),
            id: RequestId::Number(1),
            method: "file/read".into(),
            params: Some(json!({"path": "/tmp/test.txt"})),
        };
        let json_str = serde_json::to_string(&req).unwrap();
        let parsed: ECPRequest = serde_json::from_str(&json_str).unwrap();
        assert_eq!(parsed.method, "file/read");
        assert_eq!(parsed.id, RequestId::Number(1));
        assert!(parsed.is_valid());
    }

    #[test]
    fn request_without_params() {
        let json = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "document/list"
        });
        let req: ECPRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.method, "document/list");
        assert!(req.params.is_none());
        assert!(req.is_valid());
    }

    #[test]
    fn request_invalid_version() {
        let req = ECPRequest {
            jsonrpc: "1.0".into(),
            id: RequestId::Number(1),
            method: "test".into(),
            params: None,
        };
        assert!(!req.is_valid());
    }

    #[test]
    fn request_empty_method_invalid() {
        let req = ECPRequest {
            jsonrpc: "2.0".into(),
            id: RequestId::Number(1),
            method: "".into(),
            params: None,
        };
        assert!(!req.is_valid());
    }

    #[test]
    fn request_deserialized_from_wire_format() {
        // This is exactly what a Mac client would send
        let wire = r#"{"jsonrpc":"2.0","id":1,"method":"file/read","params":{"path":"/tmp/test.txt"}}"#;
        let req: ECPRequest = serde_json::from_str(wire).unwrap();
        assert_eq!(req.method, "file/read");
        assert_eq!(req.params.as_ref().unwrap()["path"], "/tmp/test.txt");
    }

    // ─────────────────────────────────────────────────────────────────────
    // ECPResponse
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn success_response_serialization() {
        let resp = ECPResponse::success(RequestId::Number(1), json!({"content": "hello"}));
        assert!(resp.is_success());
        assert!(!resp.is_error());

        let json_str = serde_json::to_string(&resp).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();
        assert_eq!(parsed["jsonrpc"], "2.0");
        assert_eq!(parsed["id"], 1);
        assert_eq!(parsed["result"]["content"], "hello");
        assert!(parsed.get("error").is_none());
    }

    #[test]
    fn error_response_serialization() {
        let resp = ECPResponse::error(
            Some(RequestId::Number(5)),
            ECPError::method_not_found("file/unknown"),
        );
        assert!(resp.is_error());
        assert!(!resp.is_success());

        let json_str = serde_json::to_string(&resp).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();
        assert_eq!(parsed["id"], 5);
        assert_eq!(parsed["error"]["code"], -32601);
        assert!(parsed["error"]["message"].as_str().unwrap().contains("file/unknown"));
    }

    #[test]
    fn error_response_null_id() {
        let resp = ECPResponse::error(None, ECPError::parse_error("bad json"));
        let json_str = serde_json::to_string(&resp).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();
        assert!(parsed["id"].is_null());
        assert_eq!(parsed["error"]["code"], -32700);
    }

    #[test]
    fn response_roundtrip_success() {
        let resp = ECPResponse::success(RequestId::String("abc".into()), json!(42));
        let json_str = serde_json::to_string(&resp).unwrap();
        let parsed: ECPResponse = serde_json::from_str(&json_str).unwrap();
        assert!(parsed.is_success());
    }

    // ─────────────────────────────────────────────────────────────────────
    // ECPNotification
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn notification_serialization() {
        let notif = ECPNotification::new("file/didChange", Some(json!({"path": "/test.rs"})));
        let json_str = serde_json::to_string(&notif).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();
        assert_eq!(parsed["jsonrpc"], "2.0");
        assert_eq!(parsed["method"], "file/didChange");
        assert!(parsed.get("id").is_none()); // Notifications have no id
    }

    #[test]
    fn notification_without_params() {
        let notif = ECPNotification::new("server/connected", None);
        let json_str = serde_json::to_string(&notif).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();
        assert!(parsed.get("params").is_none());
    }

    // ─────────────────────────────────────────────────────────────────────
    // ECPCaller
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn caller_human_serialization() {
        let caller = ECPCaller::Human;
        let json = serde_json::to_value(&caller).unwrap();
        assert_eq!(json["type"], "human");
    }

    #[test]
    fn caller_agent_serialization() {
        let caller = ECPCaller::Agent {
            agent_id: "agent-1".into(),
            execution_id: Some("exec-1".into()),
        };
        let json = serde_json::to_value(&caller).unwrap();
        assert_eq!(json["type"], "agent");
        assert_eq!(json["agentId"], "agent-1");
        assert_eq!(json["executionId"], "exec-1");
    }

    // ─────────────────────────────────────────────────────────────────────
    // Error codes
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn error_code_values() {
        assert_eq!(ECPErrorCode::ParseError.code(), -32700);
        assert_eq!(ECPErrorCode::InvalidRequest.code(), -32600);
        assert_eq!(ECPErrorCode::MethodNotFound.code(), -32601);
        assert_eq!(ECPErrorCode::InvalidParams.code(), -32602);
        assert_eq!(ECPErrorCode::InternalError.code(), -32603);
        assert_eq!(ECPErrorCode::ServerError.code(), -32000);
        assert_eq!(ECPErrorCode::ServerNotInitialized.code(), -32001);
        assert_eq!(ECPErrorCode::ServerShuttingDown.code(), -32002);
        assert_eq!(ECPErrorCode::Custom(-42).code(), -42);
    }

    #[test]
    fn error_code_roundtrip() {
        assert_eq!(ECPErrorCode::from_code(-32700), ECPErrorCode::ParseError);
        assert_eq!(ECPErrorCode::from_code(-32601), ECPErrorCode::MethodNotFound);
        assert_eq!(ECPErrorCode::from_code(-32000), ECPErrorCode::ServerError);
        assert_eq!(ECPErrorCode::from_code(-99999), ECPErrorCode::Custom(-99999));
    }

    #[test]
    fn error_constructors() {
        let e = ECPError::parse_error("bad json");
        assert_eq!(e.code, -32700);
        assert_eq!(e.message, "bad json");

        let e = ECPError::method_not_found("file/unknown");
        assert_eq!(e.code, -32601);
        assert!(e.message.contains("file/unknown"));

        let e = ECPError::invalid_params("missing path");
        assert_eq!(e.code, -32602);

        let e = ECPError::server_error("disk full");
        assert_eq!(e.code, -32000);
    }

    #[test]
    fn error_with_data() {
        let e = ECPError::server_error("detail")
            .with_data(json!({"file": "test.rs", "line": 42}));
        assert!(e.data.is_some());
        assert_eq!(e.data.as_ref().unwrap()["file"], "test.rs");
    }

    #[test]
    fn error_display() {
        let e = ECPError::parse_error("bad");
        let s = format!("{e}");
        assert!(s.contains("-32700"));
        assert!(s.contains("bad"));
    }

    #[test]
    fn error_serialization() {
        let e = ECPError::server_error("oops");
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["code"], -32000);
        assert_eq!(json["message"], "oops");
        // data should be absent when None
        assert!(json.get("data").is_none());
    }

    // ─────────────────────────────────────────────────────────────────────
    // Auth types
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn handshake_params_serialization() {
        let params = HandshakeParams {
            token: "test-token".into(),
            client: Some(HandshakeClientInfo {
                name: "ultra-mac".into(),
                version: Some("1.0.0".into()),
            }),
        };
        let json = serde_json::to_value(&params).unwrap();
        assert_eq!(json["token"], "test-token");
        assert_eq!(json["client"]["name"], "ultra-mac");
    }

    #[test]
    fn handshake_result_serialization() {
        let result = HandshakeResult {
            client_id: "client-1".into(),
            session_id: "sess-1".into(),
            server_version: "0.1.0".into(),
            workspace_root: Some("/home/user/project".into()),
            cert_fingerprint: None,
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["clientId"], "client-1");
        assert_eq!(json["sessionId"], "sess-1");
        assert_eq!(json["serverVersion"], "0.1.0");
        assert_eq!(json["workspaceRoot"], "/home/user/project");
    }

    #[test]
    fn auth_error_codes() {
        assert_eq!(AuthErrorCode::NotAuthenticated.code(), -32010);
        assert_eq!(AuthErrorCode::InvalidToken.code(), -32011);
        assert_eq!(AuthErrorCode::HandshakeTimeout.code(), -32012);
        assert_eq!(AuthErrorCode::ConnectionRejected.code(), -32013);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Method validation
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn known_methods() {
        assert!(is_known_method("document/open"));
        assert!(is_known_method("file/read"));
        assert!(is_known_method("file/write"));
        assert!(is_known_method("git/status"));
        assert!(is_known_method("terminal/create"));
        assert!(is_known_method("config/get"));
        assert!(is_known_method("session/save"));
        assert!(is_known_method("secret/get"));
        assert!(is_known_method("lsp/start"));
        assert!(is_known_method("ai/message/send"));
    }

    #[test]
    fn unknown_methods() {
        assert!(!is_known_method(""));
        assert!(!is_known_method("nonexistent"));
        // is_known_method checks by namespace prefix, so file/nonexistent is "known"
        assert!(is_known_method("file/nonexistent"));
        assert!(!is_known_method("completely/made/up"));
    }

    // ─────────────────────────────────────────────────────────────────────
    // Wire format compatibility (what Mac client sends/expects)
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn full_request_response_wire_format() {
        // Client sends this exact request
        let request_wire = r#"{"jsonrpc":"2.0","id":1,"method":"document/open","params":{"uri":"file:///tmp/test.rs","languageId":"rust"}}"#;
        let req: ECPRequest = serde_json::from_str(request_wire).unwrap();
        assert_eq!(req.method, "document/open");

        // Server should respond with this shape
        let resp = ECPResponse::success(req.id, json!({
            "documentId": "doc-123",
            "uri": "file:///tmp/test.rs",
            "languageId": "rust",
            "lineCount": 1,
            "version": 1,
        }));
        let resp_json = serde_json::to_string(&resp).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&resp_json).unwrap();
        assert_eq!(parsed["jsonrpc"], "2.0");
        assert_eq!(parsed["id"], 1);
        assert_eq!(parsed["result"]["documentId"], "doc-123");
    }

    #[test]
    fn auth_handshake_wire_format() {
        // Server sends auth/required
        let auth_required = ECPNotification::new("auth/required", Some(
            serde_json::to_value(AuthRequiredParams {
                server_version: "0.1.0".into(),
                timeout: 10000,
            }).unwrap()
        ));
        let wire = serde_json::to_string(&auth_required).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&wire).unwrap();
        assert_eq!(parsed["method"], "auth/required");
        assert_eq!(parsed["params"]["serverVersion"], "0.1.0");
        assert_eq!(parsed["params"]["timeout"], 10000);

        // Client responds with handshake
        let handshake_wire = r#"{"jsonrpc":"2.0","id":"auth-1","method":"auth/handshake","params":{"token":"test-token","client":{"name":"ultra-mac","version":"2.0"}}}"#;
        let handshake: ECPRequest = serde_json::from_str(handshake_wire).unwrap();
        assert_eq!(handshake.method, "auth/handshake");

        let params: HandshakeParams = serde_json::from_value(handshake.params.unwrap()).unwrap();
        assert_eq!(params.token, "test-token");
        assert_eq!(params.client.as_ref().unwrap().name, "ultra-mac");
    }
}
