/**
 * Agent LLM Integration
 *
 * Provides LLM capabilities to agents during execution.
 * This module bridges the agent system with the AI service.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Streaming event from LLM execution.
 */
export interface LLMStreamEvent {
  /** Event type */
  type: 'delta' | 'tool_use' | 'tool_result' | 'complete' | 'error';
  /** Text delta (for 'delta' type) */
  delta?: string;
  /** Accumulated text so far */
  accumulated?: string;
  /** Tool information (for 'tool_use' type) */
  tool?: {
    id: string;
    name: string;
    input: Record<string, unknown>;
  };
  /** Tool result (for 'tool_result' type) */
  toolResult?: {
    id: string;
    success: boolean;
    output: unknown;
  };
  /** Final content (for 'complete' type) */
  content?: string;
  /** Error message (for 'error' type) */
  error?: string;
}

/**
 * Callback for streaming events.
 */
export type LLMStreamCallback = (event: LLMStreamEvent) => void;

/**
 * Options for LLM invocation.
 */
export interface LLMInvokeOptions {
  /** System prompt override (defaults to role's system prompt) */
  systemPrompt?: string;
  /** Temperature (0-1) */
  temperature?: number;
  /** Max tokens to generate */
  maxTokens?: number;
  /** Enable streaming (default: true) */
  streaming?: boolean;
  /** Stream callback (required if streaming) */
  onStream?: LLMStreamCallback;
  /** Specific tools to enable (defaults to role's tools) */
  tools?: string[];
  /** Disable all tools */
  noTools?: boolean;
}

/**
 * Result of LLM invocation.
 */
export interface LLMResult {
  /** Whether the call succeeded */
  success: boolean;
  /** Generated content */
  content: string;
  /** Stop reason */
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'cancelled';
  /** Token usage */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  /** Tool calls made during execution */
  toolCalls?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    output: unknown;
    success: boolean;
  }>;
  /** Error message if failed */
  error?: string;
}

/**
 * LLM executor interface for agents.
 *
 * Agents use this interface to make LLM calls during execution.
 * The executor handles session management, streaming, and tool use.
 */
export interface LLMExecutor {
  /**
   * Invoke the LLM with a prompt.
   *
   * This is the main method for agents to generate content.
   * The LLM will use the agent's system prompt and capabilities.
   *
   * @param prompt - The user/task prompt to send
   * @param options - Optional configuration
   * @returns The LLM result
   */
  invoke(prompt: string, options?: LLMInvokeOptions): Promise<LLMResult>;

  /**
   * Continue a multi-turn conversation.
   *
   * Use this when you need to have a back-and-forth with the LLM,
   * building on previous responses.
   *
   * @param prompt - The follow-up prompt
   * @param options - Optional configuration
   * @returns The LLM result
   */
  continue(prompt: string, options?: LLMInvokeOptions): Promise<LLMResult>;

  /**
   * Get the conversation history for this execution.
   */
  getHistory(): Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;

  /**
   * Clear the conversation history.
   */
  clearHistory(): void;

  /**
   * Get the session ID (for debugging/tracking).
   */
  getSessionId(): string | undefined;
}

/**
 * Configuration for creating an LLM executor.
 */
export interface LLMExecutorConfig {
  /** Provider to use (e.g., 'claude', 'openai') */
  provider: string;
  /** Model to use (e.g., 'claude-sonnet-4-20250514') */
  model: string;
  /** System prompt for the agent */
  systemPrompt: string;
  /** Default temperature */
  temperature?: number;
  /** Default max tokens */
  maxTokens?: number;
  /** Available tools */
  tools?: string[];
  /** Working directory for tool execution */
  cwd?: string;
  /** Workflow context (if in workflow) */
  workflowId?: string;
  /** Execution ID for tracking */
  executionId?: string;
}

/**
 * Factory type for creating LLM executors.
 */
export type LLMExecutorFactory = (config: LLMExecutorConfig) => Promise<LLMExecutor>;

// ─────────────────────────────────────────────────────────────────────────────
// Null Executor (for testing/fallback)
// ─────────────────────────────────────────────────────────────────────────────

// Re-export AI service executor
export { AIServiceLLMExecutor, createAIServiceExecutor } from './ai-service-executor.ts';
export type { AIServiceForExecutor } from './ai-service-executor.ts';

/**
 * Null LLM executor that returns placeholder results.
 * Used when no AI service is available (e.g., in tests).
 * Returns success: true with placeholder content for test compatibility.
 */
export class NullLLMExecutor implements LLMExecutor {
  private history: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  async invoke(prompt: string, options?: LLMInvokeOptions): Promise<LLMResult> {
    this.history.push({ role: 'user', content: prompt });

    // Generate placeholder response based on prompt content
    const response = this.generatePlaceholderResponse(prompt);
    this.history.push({ role: 'assistant', content: response });

    // Call stream callback if provided
    if (options?.streaming !== false && options?.onStream) {
      options.onStream({ type: 'delta', delta: response, accumulated: response });
      options.onStream({ type: 'complete', content: response });
    }

    return {
      success: true,
      content: response,
      stopReason: 'end_turn',
      usage: {
        inputTokens: Math.ceil(prompt.length / 4),
        outputTokens: Math.ceil(response.length / 4),
        totalTokens: Math.ceil((prompt.length + response.length) / 4),
      },
    };
  }

  /**
   * Generate a placeholder response based on the prompt.
   * This provides minimal test-compatible output.
   */
  private generatePlaceholderResponse(prompt: string): string {
    // Extract what seems to be requested from the prompt
    if (prompt.toLowerCase().includes('code') || prompt.toLowerCase().includes('implement')) {
      return `\`\`\`typescript
// Placeholder implementation
function placeholder() {
  // TODO: Implement actual logic
  return 'placeholder';
}
\`\`\`

This is a placeholder implementation. Review and testing are recommended.`;
    }

    if (prompt.toLowerCase().includes('write') || prompt.toLowerCase().includes('content')) {
      return `# Placeholder Content

This is placeholder content generated in test mode.

The content addresses the topic provided in the prompt and follows the requested style guidelines.`;
    }

    // Default placeholder
    return `Placeholder response for: ${prompt.substring(0, 100)}...`;
  }

  async continue(prompt: string, options?: LLMInvokeOptions): Promise<LLMResult> {
    return this.invoke(prompt, options);
  }

  getHistory(): Array<{ role: 'user' | 'assistant'; content: string }> {
    return [...this.history];
  }

  clearHistory(): void {
    this.history = [];
  }

  getSessionId(): string | undefined {
    return undefined;
  }
}
