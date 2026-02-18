//! Middleware chain for request processing.
//!
//! Middleware can inspect/modify requests before routing and inspect
//! results after execution. They run in priority order.

use serde_json::Value;

/// Middleware result — whether to allow or block the request.
pub struct MiddlewareResult {
    /// Whether the request should proceed
    pub allowed: bool,
    /// Optionally modified params
    pub params: Option<Value>,
    /// Feedback message if blocked
    pub feedback: Option<String>,
}

impl MiddlewareResult {
    pub fn allow(params: Option<Value>) -> Self {
        Self {
            allowed: true,
            params,
            feedback: None,
        }
    }

    pub fn block(feedback: impl Into<String>) -> Self {
        Self {
            allowed: false,
            params: None,
            feedback: Some(feedback.into()),
        }
    }
}

/// Trait for request middleware.
pub trait Middleware: Send + Sync {
    /// Process a request before it reaches the service.
    /// Takes owned method string to avoid lifetime issues with dyn dispatch.
    fn before(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> impl std::future::Future<Output = MiddlewareResult> + Send;

    /// Process a result after the service returns (optional).
    fn after(
        &self,
        _method: &str,
        _params: &Value,
        _result: &Value,
    ) -> impl std::future::Future<Output = ()> + Send {
        async {}
    }

    /// Middleware name for debugging.
    fn name(&self) -> &str;

    /// Priority (lower runs first).
    fn priority(&self) -> i32 {
        0
    }
}

/// A chain of middleware executed in priority order.
pub struct MiddlewareChain {
    middlewares: Vec<Box<dyn MiddlewareDyn>>,
}

/// Object-safe version of Middleware trait — all refs share lifetime `'a`.
trait MiddlewareDyn: Send + Sync {
    fn before_dyn<'a>(
        &'a self,
        method: &'a str,
        params: Option<Value>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = MiddlewareResult> + Send + 'a>>;

    fn after_dyn<'a>(
        &'a self,
        method: &'a str,
        params: &'a Value,
        result: &'a Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>>;

    fn name_dyn(&self) -> &str;
    fn priority_dyn(&self) -> i32;
}

impl<T: Middleware> MiddlewareDyn for T {
    fn before_dyn<'a>(
        &'a self,
        method: &'a str,
        params: Option<Value>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = MiddlewareResult> + Send + 'a>> {
        Box::pin(self.before(method, params))
    }

    fn after_dyn<'a>(
        &'a self,
        method: &'a str,
        params: &'a Value,
        result: &'a Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        Box::pin(self.after(method, params, result))
    }

    fn name_dyn(&self) -> &str {
        self.name()
    }

    fn priority_dyn(&self) -> i32 {
        self.priority()
    }
}

impl MiddlewareChain {
    pub fn new() -> Self {
        Self {
            middlewares: Vec::new(),
        }
    }

    pub fn add<M: Middleware + 'static>(&mut self, middleware: M) {
        self.middlewares.push(Box::new(middleware));
        self.middlewares.sort_by_key(|m| m.priority_dyn());
    }

    /// Run the before-chain. Returns the (possibly modified) params or a block.
    pub async fn run_before(
        &self,
        method: &str,
        mut params: Option<Value>,
    ) -> MiddlewareResult {
        for mw in &self.middlewares {
            let result = mw.before_dyn(method, params.clone()).await;
            if !result.allowed {
                return result;
            }
            if let Some(modified) = result.params {
                params = Some(modified);
            }
        }
        MiddlewareResult::allow(params)
    }

    /// Run the after-chain.
    pub async fn run_after(
        &self,
        method: &str,
        params: &Value,
        result: &Value,
    ) {
        for mw in &self.middlewares {
            mw.after_dyn(method, params, result).await;
        }
    }

    pub fn names(&self) -> Vec<&str> {
        self.middlewares.iter().map(|m| m.name_dyn()).collect()
    }
}

impl Default for MiddlewareChain {
    fn default() -> Self {
        Self::new()
    }
}
