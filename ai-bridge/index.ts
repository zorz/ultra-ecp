/**
 * AI Bridge — TypeScript subprocess for AI provider interactions.
 *
 * This runs as a child process of the Rust ECP server, communicating via
 * JSON-RPC over stdin/stdout. It provides access to the official TypeScript
 * AI SDKs (Anthropic Agent SDK, OpenAI, etc.) without requiring Rust FFI.
 *
 * Protocol: one JSON object per line on stdin (request) / stdout (response).
 *
 * Supported methods:
 *   ai/message/create   — Send a message and get a response (non-streaming)
 *   ai/message/stream    — Stream a response (events emitted as notifications)
 *   ai/models/list       — List available models for a provider
 *   ai/provider/status   — Check provider availability
 *   ai/tools/list        — List registered tools
 */

import Anthropic from "@anthropic-ai/sdk";
import { createInterface } from "readline";

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

// ─────────────────────────────────────────────────────────────────────────────
// Provider management
// ─────────────────────────────────────────────────────────────────────────────

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic();
  }
  return anthropicClient;
}

// ─────────────────────────────────────────────────────────────────────────────
// Request handlers
// ─────────────────────────────────────────────────────────────────────────────

async function handleRequest(req: BridgeRequest): Promise<BridgeResponse> {
  try {
    const result = await dispatch(req.method, req.params ?? {});
    return { id: req.id, result };
  } catch (err: any) {
    return {
      id: req.id,
      error: {
        code: err.status ?? -32000,
        message: err.message ?? String(err),
      },
    };
  }
}

async function dispatch(
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  switch (method) {
    case "ai/message/create":
      return handleMessageCreate(params);

    case "ai/message/stream":
      return handleMessageStream(params);

    case "ai/models/list":
      return handleModelsList(params);

    case "ai/provider/status":
      return handleProviderStatus(params);

    case "ai/tools/list":
      return { tools: [] };

    case "ai/ping":
      return { pong: true, timestamp: Date.now() };

    default:
      throw { code: -32601, message: `Method not found: ${method}` };
  }
}

// ─── ai/message/create ──────────────────────────────────────────────────────

async function handleMessageCreate(
  params: Record<string, unknown>
): Promise<unknown> {
  const provider = (params.provider as string) ?? "anthropic";

  if (provider === "anthropic" || provider === "claude") {
    const client = getAnthropicClient();
    const response = await client.messages.create({
      model: (params.model as string) ?? "claude-sonnet-4-20250514",
      max_tokens: (params.maxTokens as number) ?? 8192,
      system: params.systemPrompt as string | undefined,
      messages: params.messages as Anthropic.MessageParam[],
      tools: params.tools as Anthropic.Tool[] | undefined,
    });

    return {
      id: response.id,
      role: response.role,
      content: response.content,
      model: response.model,
      stopReason: response.stop_reason,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  throw { code: -32000, message: `Unsupported provider: ${provider}` };
}

// ─── ai/message/stream ──────────────────────────────────────────────────────

async function handleMessageStream(
  params: Record<string, unknown>
): Promise<unknown> {
  const provider = (params.provider as string) ?? "anthropic";

  if (provider === "anthropic" || provider === "claude") {
    const client = getAnthropicClient();
    const stream = await client.messages.create({
      model: (params.model as string) ?? "claude-sonnet-4-20250514",
      max_tokens: (params.maxTokens as number) ?? 8192,
      system: params.systemPrompt as string | undefined,
      messages: params.messages as Anthropic.MessageParam[],
      tools: params.tools as Anthropic.Tool[] | undefined,
      stream: true,
    });

    // Collect full response while emitting events
    let fullContent: Anthropic.ContentBlock[] = [];
    let usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: string | null = null;

    for await (const event of stream) {
      // Emit event as notification
      emitNotification("ai/stream/event", {
        requestId: params.requestId,
        event: event.type,
        data: event,
      });

      if (event.type === "message_start") {
        usage.inputTokens = event.message.usage.input_tokens;
      } else if (event.type === "content_block_start") {
        fullContent.push(event.content_block as Anthropic.ContentBlock);
      } else if (event.type === "content_block_delta") {
        const block = fullContent[event.index];
        if (block && "text" in block && "delta" in event && "text" in event.delta) {
          (block as any).text += event.delta.text;
        }
      } else if (event.type === "message_delta") {
        stopReason = event.delta.stop_reason;
        usage.outputTokens = event.usage.output_tokens;
      }
    }

    return {
      role: "assistant",
      content: fullContent,
      stopReason,
      usage,
    };
  }

  throw { code: -32000, message: `Unsupported provider: ${provider}` };
}

// ─── ai/models/list ─────────────────────────────────────────────────────────

async function handleModelsList(
  params: Record<string, unknown>
): Promise<unknown> {
  const provider = (params.provider as string) ?? "anthropic";

  if (provider === "anthropic" || provider === "claude") {
    return {
      models: [
        {
          id: "claude-opus-4-20250514",
          name: "Claude Opus 4",
          contextWindow: 200000,
          maxOutput: 32000,
        },
        {
          id: "claude-sonnet-4-20250514",
          name: "Claude Sonnet 4",
          contextWindow: 200000,
          maxOutput: 16000,
        },
        {
          id: "claude-haiku-3-5-20241022",
          name: "Claude 3.5 Haiku",
          contextWindow: 200000,
          maxOutput: 8192,
        },
      ],
    };
  }

  return { models: [] };
}

// ─── ai/provider/status ─────────────────────────────────────────────────────

async function handleProviderStatus(
  params: Record<string, unknown>
): Promise<unknown> {
  const provider = (params.provider as string) ?? "anthropic";

  if (provider === "anthropic" || provider === "claude") {
    const hasKey = !!process.env.ANTHROPIC_API_KEY;
    return {
      provider: "anthropic",
      available: hasKey,
      reason: hasKey ? undefined : "ANTHROPIC_API_KEY not set",
    };
  }

  return { provider, available: false, reason: "Provider not configured" };
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
// Main loop
// ─────────────────────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin });

rl.on("line", async (line: string) => {
  try {
    const req: BridgeRequest = JSON.parse(line);
    const response = await handleRequest(req);
    sendResponse(response);
  } catch (err: any) {
    // Parse error — send error response with id 0
    sendResponse({
      id: 0,
      error: { code: -32700, message: `Parse error: ${err.message}` },
    });
  }
});

rl.on("close", () => {
  process.exit(0);
});

// Signal ready
emitNotification("ai/bridge/ready", { timestamp: Date.now() });
