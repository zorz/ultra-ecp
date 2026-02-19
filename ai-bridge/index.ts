/**
 * AI Bridge — TypeScript subprocess for AI provider interactions.
 *
 * This runs as a child process of the Rust ECP server, communicating via
 * JSON-RPC over stdin/stdout. It hosts the full TypeScript AI service stack
 * including the Anthropic Agent SDK, auth service, agent service, and syntax
 * highlighting — services that require TypeScript SDKs.
 *
 * ## Protocol (one JSON object per line on stdin/stdout)
 *
 * ### Rust → Bridge (stdin):
 *   - Request:           { id: number, method: string, params?: object }
 *   - Callback response: { callbackId: string, result?: any, error?: { code, message } }
 *
 * ### Bridge → Rust (stdout):
 *   - Response:          { id: number, result?: any, error?: { code, message } }
 *   - Notification:      { method: string, params?: object }
 *   - Callback request:  { callbackId: string, method: string, params?: object }
 */

import { createInterface } from "readline";

// Import existing TypeScript services from the parent project
import { LocalAIService } from "../src/services/ai/local.ts";
import { AIServiceAdapter } from "../src/services/ai/adapter.ts";
import { AuthServiceAdapter } from "../src/services/auth/adapter.ts";
import { LocalAgentService } from "../src/services/agents/local.ts";
import { AgentServiceAdapter } from "../src/services/agents/adapter.ts";
import { LocalSyntaxService } from "../src/services/syntax/service.ts";
import { SyntaxServiceAdapter } from "../src/services/syntax/adapter.ts";
import type { ECPNotification } from "../src/protocol/types.ts";
import { loadModels, refreshModels } from "../src/services/ai/model-registry.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface BridgeRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface BridgeResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface BridgeNotification {
  method: string;
  params?: Record<string, unknown>;
}

interface BridgeCallbackRequest {
  callbackId: string;
  method: string;
  params?: Record<string, unknown>;
}

interface BridgeCallbackResponse {
  callbackId: string;
  result?: unknown;
  error?: { code: number; message: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Callback infrastructure — call back into Rust ECP services
// ─────────────────────────────────────────────────────────────────────────────

let callbackCounter = 0;
const pendingCallbacks = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

/**
 * Call an ECP service method via the Rust server (bridge → Rust → bridge).
 * Used by the Agent SDK to execute tools like file/read, git/status, etc.
 */
export async function callECPMethod(
  method: string,
  params?: Record<string, unknown>
): Promise<unknown> {
  const callbackId = `cb-${++callbackCounter}`;

  return new Promise<unknown>((resolve, reject) => {
    pendingCallbacks.set(callbackId, { resolve, reject });

    const request: BridgeCallbackRequest = { callbackId, method, params };
    process.stdout.write(JSON.stringify(request) + "\n");
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Service initialization
// ─────────────────────────────────────────────────────────────────────────────

// Parse workspace from command line
const workspaceArg = process.argv.indexOf("--workspace");
const workspaceRoot =
  workspaceArg >= 0 && process.argv[workspaceArg + 1]
    ? process.argv[workspaceArg + 1]
    : process.cwd();

// Notification handler — forwards service notifications to Rust via stdout
// Matches the NotificationHandler type: (notification: ECPNotification) => void
const notificationHandler = (notification: ECPNotification) => {
  emitNotification(notification.method, (notification.params as Record<string, unknown>) ?? {});
};

// ECP request handler — forwards ECP calls through the callback protocol to Rust
// Matches the setECPRequest signature: <T>(method: string, params?: unknown) => Promise<T>
const ecpRequestHandler = async <T>(method: string, params?: unknown): Promise<T> => {
  const result = await callECPMethod(method, params as Record<string, unknown>);
  return result as T;
};

// ── AI Service ──────────────────────────────────────────────────────────────

let aiAdapter: AIServiceAdapter | null = null;
let authAdapter: AuthServiceAdapter | null = null;
let agentAdapter: AgentServiceAdapter | null = null;
let syntaxAdapter: SyntaxServiceAdapter | null = null;

async function initializeServices() {
  try {
    // AI Service — the core agentic AI layer
    const aiService = new LocalAIService();
    aiService.setECPRequest(ecpRequestHandler);
    await aiService.init();

    aiAdapter = new AIServiceAdapter(aiService, workspaceRoot);
    aiAdapter.setECPRequest(ecpRequestHandler);
    aiAdapter.setNotificationHandler(notificationHandler);
    await aiAdapter.loadAgentsFromConfig();

    // Wire ChatStorage — delegates to Rust ChatService via callbacks.
    // Methods are async because they cross the bridge boundary; the adapter
    // awaits them (we patched sync → async in adapter.ts).
    const bridgeChatStorage = {
      async getMessages(sessionId: string, options?: { limit?: number; offset?: number; after?: number }) {
        const result = await callECPMethod("chat/message/list", {
          sessionId,
          limit: options?.limit,
          offset: options?.offset,
          after: options?.after,
        });
        return Array.isArray(result) ? result : [];
      },
      async getSessionAgents(sessionId: string, options?: { includeLeft?: boolean }) {
        const result = await callECPMethod("chat/sessionAgent/list", {
          sessionId,
          includeLeft: options?.includeLeft ?? false,
        });
        return Array.isArray(result) ? result : [];
      },
      async addSessionAgent(sessionId: string, agentId: string, role: string, agentName?: string) {
        await callECPMethod("chat/sessionAgent/add", { sessionId, agentId, role, agentName });
      },
      async removeSessionAgent(sessionId: string, agentId: string) {
        await callECPMethod("chat/sessionAgent/remove", { sessionId, agentId });
      },
    };
    aiAdapter.setChatStorage(bridgeChatStorage as any);

    emitNotification("ai/bridge/service-ready", { service: "ai" });
  } catch (err: any) {
    process.stderr.write(`[ai-bridge] Failed to init AI service: ${err.message}\n`);
  }

  try {
    // Auth Service — OAuth, API key management
    // Create a bridge-aware secret service that delegates to Rust
    const bridgeSecretService = {
      async get(key: string): Promise<string | null> {
        const result = await callECPMethod("secret/get", { key }) as any;
        return result?.value ?? null;
      },
      async set(key: string, value: string): Promise<void> {
        await callECPMethod("secret/set", { key, value });
      },
      async delete(key: string): Promise<boolean> {
        const result = await callECPMethod("secret/delete", { key }) as any;
        return result?.success ?? false;
      },
      async has(key: string): Promise<boolean> {
        const result = await callECPMethod("secret/has", { key }) as any;
        return result?.exists ?? false;
      },
      async list(): Promise<string[]> {
        const result = await callECPMethod("secret/list") as any;
        return result?.keys ?? [];
      },
    };

    authAdapter = new AuthServiceAdapter(bridgeSecretService as any);
    emitNotification("ai/bridge/service-ready", { service: "auth" });
  } catch (err: any) {
    process.stderr.write(`[ai-bridge] Failed to init auth service: ${err.message}\n`);
  }

  try {
    // Agent Service — studio agent registry
    const agentService = new LocalAgentService(workspaceRoot);
    agentAdapter = new AgentServiceAdapter(agentService);
    agentAdapter.setNotificationHandler(notificationHandler);

    emitNotification("ai/bridge/service-ready", { service: "agent" });
  } catch (err: any) {
    process.stderr.write(`[ai-bridge] Failed to init agent service: ${err.message}\n`);
  }

  try {
    // Syntax Service — Shiki-based highlighting
    const syntaxService = new LocalSyntaxService();
    syntaxAdapter = new SyntaxServiceAdapter(syntaxService);

    emitNotification("ai/bridge/service-ready", { service: "syntax" });
  } catch (err: any) {
    process.stderr.write(`[ai-bridge] Failed to init syntax service: ${err.message}\n`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Request dispatch
// ─────────────────────────────────────────────────────────────────────────────

async function handleRequest(req: BridgeRequest): Promise<BridgeResponse> {
  try {
    const result = await dispatch(req.method, req.params ?? {});
    return { id: req.id, result };
  } catch (err: any) {
    return {
      id: req.id,
      error: {
        code: err.status ?? err.code ?? -32000,
        message: err.message ?? String(err),
      },
    };
  }
}

async function dispatch(
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const [namespace] = method.split("/");

  switch (namespace) {
    case "ai": {
      if (!aiAdapter) throw { code: -32000, message: "AI service not initialized" };

      // Intercept todo operations — persist to chat.db via Rust ChatService
      if (method === "ai/todo/write") {
        // Let adapter handle in-memory store + notification
        const result = await aiAdapter.handleRequest(method, params);
        if ("error" in result) throw result.error;

        // Persist to chat.db via callback to Rust
        const p = params as { sessionId?: string; todos?: unknown[] };
        if (p.sessionId && Array.isArray(p.todos)) {
          callECPMethod("chat/todo/replace", {
            sessionId: p.sessionId,
            todos: p.todos,
          }).catch((err) => {
            process.stderr.write(
              `[ai-bridge] Failed to persist todos to chat.db: ${err.message}\n`
            );
          });
        }
        return result.result;
      }

      if (method === "ai/todo/get") {
        // Read from chat.db (persisted) instead of in-memory
        const p = params as { sessionId?: string };
        if (p.sessionId) {
          try {
            const todos = await callECPMethod("chat/todo/list", {
              sessionId: p.sessionId,
            });
            return { todos: Array.isArray(todos) ? todos : [] };
          } catch {
            // Fall through to adapter's in-memory store
          }
        }
      }

      const result = await aiAdapter.handleRequest(method, params);
      if ("error" in result) throw result.error;
      return result.result;
    }

    case "auth": {
      if (!authAdapter) throw { code: -32000, message: "Auth service not initialized" };
      const result = await authAdapter.handleRequest(method, params);
      if ("error" in result) throw result.error;
      return result.result;
    }

    case "agent": {
      if (!agentAdapter) throw { code: -32000, message: "Agent service not initialized" };
      const result = await agentAdapter.handleRequest(method, params);
      if ("error" in result) throw result.error;
      return result.result;
    }

    case "syntax": {
      if (!syntaxAdapter) throw { code: -32000, message: "Syntax service not initialized" };
      const result = await syntaxAdapter.handleRequest(method, params);
      if ("error" in result) throw result.error;
      return result.result;
    }

    case "models": {
      if (method === "models/list") {
        return await loadModels();
      } else if (method === "models/refresh") {
        return await refreshModels();
      }
      throw { code: -32601, message: `Method not found: ${method}` };
    }

    default:
      throw { code: -32601, message: `Method not found: ${method}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O
// ─────────────────────────────────────────────────────────────────────────────

function emitNotification(method: string, params: Record<string, unknown>) {
  const notification: BridgeNotification = { method, params };
  process.stdout.write(JSON.stringify(notification) + "\n");
}

function sendResponse(response: BridgeResponse) {
  process.stdout.write(JSON.stringify(response) + "\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Message classifier — stdin carries both requests AND callback responses
// ─────────────────────────────────────────────────────────────────────────────

function handleIncomingLine(line: string) {
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    sendResponse({
      id: 0,
      error: { code: -32700, message: "Parse error: invalid JSON" },
    });
    return;
  }

  if ("callbackId" in parsed) {
    // Callback response from Rust
    const cbResp = parsed as BridgeCallbackResponse;
    const pending = pendingCallbacks.get(cbResp.callbackId);
    if (pending) {
      pendingCallbacks.delete(cbResp.callbackId);
      if (cbResp.error) {
        pending.reject(
          Object.assign(new Error(cbResp.error.message), {
            code: cbResp.error.code,
          })
        );
      } else {
        pending.resolve(cbResp.result);
      }
    }
  } else if ("id" in parsed && "method" in parsed) {
    // Request from Rust
    const req = parsed as BridgeRequest;
    handleRequest(req).then((response) => sendResponse(response));
  } else {
    sendResponse({
      id: parsed.id ?? 0,
      error: {
        code: -32600,
        message: "Invalid message: missing id or method",
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main loop
// ─────────────────────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin });

rl.on("line", (line: string) => {
  handleIncomingLine(line);
});

rl.on("close", () => {
  process.exit(0);
});

// Signal ready (basic bridge protocol ready)
emitNotification("ai/bridge/ready", { timestamp: Date.now() });

// Initialize services asynchronously
initializeServices().catch((err) => {
  process.stderr.write(
    `[ai-bridge] Service initialization failed: ${err.message}\n`
  );
});
