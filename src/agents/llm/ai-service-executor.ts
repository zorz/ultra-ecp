/**
 * AI Service LLM Executor
 *
 * LLM executor implementation that uses the AI service
 * to make actual LLM calls with streaming and tool support.
 */

import type {
  LLMExecutor,
  LLMExecutorConfig,
  LLMInvokeOptions,
  LLMResult,
} from './index.ts';
import { debugLog } from '../../debug.ts';

/**
 * AI Service interface (subset needed by executor).
 * This avoids circular dependencies with the full LocalAIService.
 * Uses `unknown` for complex types to maintain flexibility.
 */
export interface AIServiceForExecutor {
  createSession(options: {
    provider: {
      type: string;
      name: string;
      model?: string;
    };
    systemPrompt?: string;
    tools?: unknown[];
    cwd?: string;
  }): Promise<{ id: string }>;

  sendMessageStreaming(
    options: { sessionId: string; content: string; maxTokens?: number; temperature?: number },
    onEvent: (event: unknown) => void
  ): Promise<AIServiceResponse>;

  deleteSession(sessionId: string): boolean;

  getToolsForProvider(providerType: string): unknown[];
}

/**
 * Normalized stream event for internal processing.
 */
interface NormalizedStreamEvent {
  type: string;
  delta?: { type: string; text?: string };
  toolUseId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  success?: boolean;
  result?: unknown;
}

/**
 * AI response from the service.
 */
interface AIServiceResponse {
  message: {
    content: Array<{ type: string; text?: string }>;
  };
  stopReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

/**
 * LLM executor backed by the AI service.
 *
 * Creates an AI session and manages the conversation,
 * providing streaming and tool use support.
 */
export class AIServiceLLMExecutor implements LLMExecutor {
  private config: LLMExecutorConfig;
  private aiService: AIServiceForExecutor;
  private sessionId?: string;
  private history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  private toolCalls: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    output: unknown;
    success: boolean;
  }> = [];

  constructor(config: LLMExecutorConfig, aiService: AIServiceForExecutor) {
    this.config = config;
    this.aiService = aiService;
  }

  /**
   * Initialize the AI session if not already created.
   */
  private async ensureSession(): Promise<string> {
    if (this.sessionId) {
      return this.sessionId;
    }

    debugLog(`[LLMExecutor] Creating session for provider: ${this.config.provider}`);

    // Get tools for the provider
    const tools = this.config.tools
      ? this.aiService.getToolsForProvider(this.config.provider as 'claude' | 'openai' | 'gemini' | 'ollama')
      : [];

    const session = await this.aiService.createSession({
      provider: {
        type: this.config.provider,
        name: this.config.provider === 'claude' ? 'Anthropic' : this.config.provider,
        model: this.config.model,
      },
      systemPrompt: this.config.systemPrompt,
      tools,
      cwd: this.config.cwd,
    });

    this.sessionId = session.id;
    debugLog(`[LLMExecutor] Session created: ${this.sessionId}`);

    return this.sessionId;
  }

  async invoke(prompt: string, options?: LLMInvokeOptions): Promise<LLMResult> {
    const sessionId = await this.ensureSession();

    // Track history
    this.history.push({ role: 'user', content: prompt });

    // Reset tool calls for this invocation
    this.toolCalls = [];

    let accumulated = '';
    let lastError: string | undefined;

    try {
      debugLog(`[LLMExecutor] Sending message to session ${sessionId}`);

      const response = await this.aiService.sendMessageStreaming(
        {
          sessionId,
          content: prompt,
          maxTokens: options?.maxTokens ?? this.config.maxTokens,
          temperature: options?.temperature ?? this.config.temperature,
        },
        (rawEvent: unknown) => {
          // Cast to normalized type for processing
          const event = rawEvent as NormalizedStreamEvent;

          // Handle streaming events
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
            accumulated += event.delta.text;

            // Forward to caller's stream callback
            if (options?.streaming !== false && options?.onStream) {
              options.onStream({
                type: 'delta',
                delta: event.delta.text,
                accumulated,
              });
            }
          } else if (event.type === 'tool_use_started') {
            // Tool execution starting
            if (options?.onStream) {
              options.onStream({
                type: 'tool_use',
                tool: {
                  id: event.toolUseId ?? '',
                  name: event.toolName ?? '',
                  input: event.input ?? {},
                },
              });
            }
          } else if (event.type === 'tool_use_result') {
            // Tool execution completed
            this.toolCalls.push({
              id: event.toolUseId ?? '',
              name: event.toolName ?? '',
              input: event.input ?? {},
              output: event.result,
              success: event.success ?? true,
            });

            if (options?.onStream) {
              options.onStream({
                type: 'tool_result',
                toolResult: {
                  id: event.toolUseId ?? '',
                  success: event.success ?? true,
                  output: event.result,
                },
              });
            }
          }
        }
      );

      // Extract final content from response
      const finalContent = response.message.content
        .filter((block) => block.type === 'text' && block.text)
        .map((block) => block.text)
        .join('\n');

      // Use accumulated content if we got streaming, otherwise use final content
      const content = accumulated || finalContent;

      // Track assistant response in history
      this.history.push({ role: 'assistant', content });

      // Map stop reason
      const stopReason = this.mapStopReason(response.stopReason);

      // Send completion event
      if (options?.onStream) {
        options.onStream({
          type: 'complete',
          content,
        });
      }

      debugLog(`[LLMExecutor] Response complete: ${content.length} chars, reason: ${stopReason}`);

      return {
        success: true,
        content,
        stopReason,
        usage: response.usage
          ? {
              inputTokens: response.usage.inputTokens ?? 0,
              outputTokens: response.usage.outputTokens ?? 0,
              totalTokens: (response.usage.inputTokens ?? 0) + (response.usage.outputTokens ?? 0),
            }
          : undefined,
        toolCalls: this.toolCalls.length > 0 ? this.toolCalls : undefined,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      debugLog(`[LLMExecutor] Error: ${lastError}`);

      if (options?.onStream) {
        options.onStream({
          type: 'error',
          error: lastError,
        });
      }

      return {
        success: false,
        content: accumulated || '',
        error: lastError,
      };
    }
  }

  async continue(prompt: string, options?: LLMInvokeOptions): Promise<LLMResult> {
    // Continue uses the same session, so just call invoke
    return this.invoke(prompt, options);
  }

  getHistory(): Array<{ role: 'user' | 'assistant'; content: string }> {
    return [...this.history];
  }

  clearHistory(): void {
    this.history = [];
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * Clean up the session when done.
   */
  async cleanup(): Promise<void> {
    if (this.sessionId) {
      debugLog(`[LLMExecutor] Cleaning up session: ${this.sessionId}`);
      this.aiService.deleteSession(this.sessionId);
      this.sessionId = undefined;
    }
  }

  /**
   * Map AI service stop reason to LLM result stop reason.
   */
  private mapStopReason(
    reason?: string
  ): 'end_turn' | 'tool_use' | 'max_tokens' | 'cancelled' | undefined {
    switch (reason) {
      case 'end_turn':
        return 'end_turn';
      case 'tool_use':
        return 'tool_use';
      case 'max_tokens':
        return 'max_tokens';
      case 'cancelled':
      case 'stop':
        return 'cancelled';
      default:
        return undefined;
    }
  }
}

/**
 * Create an LLM executor backed by the AI service.
 */
export function createAIServiceExecutor(
  config: LLMExecutorConfig,
  aiService: AIServiceForExecutor
): AIServiceLLMExecutor {
  return new AIServiceLLMExecutor(config, aiService);
}
