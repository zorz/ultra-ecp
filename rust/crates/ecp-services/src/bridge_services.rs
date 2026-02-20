//! Bridge-delegated services — thin forwarding wrappers that route all methods
//! in their namespace to the AI bridge subprocess.
//!
//! These services handle namespaces where the implementation lives in TypeScript
//! (AI/Agent SDK, auth, workflow engine, syntax highlighting, etc.). The Rust
//! side is just a routing shim; all logic runs in the bridge subprocess.

use std::sync::Arc;

use ecp_ai_bridge::AIBridge;
use ecp_protocol::HandlerResult;

use crate::Service;

/// AI service — forwards all `ai/*` methods to the bridge subprocess.
/// Handles 40+ methods including sessions, messages, tools, permissions,
/// middleware, todos, agents, and personas.
pub struct AIService {
    bridge: Arc<AIBridge>,
}

impl AIService {
    pub fn new(bridge: Arc<AIBridge>) -> Self {
        Self { bridge }
    }
}

impl Service for AIService {
    fn namespace(&self) -> &str {
        "ai"
    }

    fn scope(&self) -> crate::ServiceScope {
        crate::ServiceScope::Global
    }

    fn is_bridge_delegated(&self) -> bool {
        true
    }

    async fn handle(&self, method: &str, params: Option<serde_json::Value>) -> HandlerResult {
        self.bridge.request(method, params).await
    }
}

/// Auth service — forwards all `auth/*` methods to the bridge subprocess.
/// Handles OAuth flows, API key management, provider switching.
pub struct AuthService {
    bridge: Arc<AIBridge>,
}

impl AuthService {
    pub fn new(bridge: Arc<AIBridge>) -> Self {
        Self { bridge }
    }
}

impl Service for AuthService {
    fn namespace(&self) -> &str {
        "auth"
    }

    fn scope(&self) -> crate::ServiceScope {
        crate::ServiceScope::Global
    }

    fn is_bridge_delegated(&self) -> bool {
        true
    }

    async fn handle(&self, method: &str, params: Option<serde_json::Value>) -> HandlerResult {
        self.bridge.request(method, params).await
    }
}

/// Agent service — forwards all `agent/*` methods to the bridge subprocess.
/// Handles agent CRUD, invocation, state, messaging, memory, and roles.
pub struct AgentService {
    bridge: Arc<AIBridge>,
}

impl AgentService {
    pub fn new(bridge: Arc<AIBridge>) -> Self {
        Self { bridge }
    }
}

impl Service for AgentService {
    fn namespace(&self) -> &str {
        "agent"
    }

    fn scope(&self) -> crate::ServiceScope {
        crate::ServiceScope::Global
    }

    fn is_bridge_delegated(&self) -> bool {
        true
    }

    async fn handle(&self, method: &str, params: Option<serde_json::Value>) -> HandlerResult {
        self.bridge.request(method, params).await
    }
}

/// Workflow service — forwards all `workflow/*` methods to the bridge subprocess.
/// Handles execution engine, checkpoints, context, agent coordination, permissions.
pub struct WorkflowService {
    bridge: Arc<AIBridge>,
}

impl WorkflowService {
    pub fn new(bridge: Arc<AIBridge>) -> Self {
        Self { bridge }
    }
}

impl Service for WorkflowService {
    fn namespace(&self) -> &str {
        "workflow"
    }

    fn scope(&self) -> crate::ServiceScope {
        crate::ServiceScope::Global
    }

    fn is_bridge_delegated(&self) -> bool {
        true
    }

    async fn handle(&self, method: &str, params: Option<serde_json::Value>) -> HandlerResult {
        self.bridge.request(method, params).await
    }
}

/// Syntax service — forwards all `syntax/*` methods to the bridge subprocess.
/// Handles Shiki-based syntax highlighting, sessions, themes, language detection.
pub struct SyntaxService {
    bridge: Arc<AIBridge>,
}

impl SyntaxService {
    pub fn new(bridge: Arc<AIBridge>) -> Self {
        Self { bridge }
    }
}

impl Service for SyntaxService {
    fn namespace(&self) -> &str {
        "syntax"
    }

    fn scope(&self) -> crate::ServiceScope {
        crate::ServiceScope::Global
    }

    fn is_bridge_delegated(&self) -> bool {
        true
    }

    async fn handle(&self, method: &str, params: Option<serde_json::Value>) -> HandlerResult {
        self.bridge.request(method, params).await
    }
}
