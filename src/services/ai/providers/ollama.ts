/**
 * Ollama CLI Provider
 *
 * Implements the AI provider interface for Ollama (local LLMs).
 * Uses the ollama CLI for running local models.
 */

import {
  BaseAIProvider,
  type ChatCompletionRequest,
  registerProvider,
} from './base.ts';
import type {
  AIProviderType,
  AIProviderConfig,
  AIProviderCapabilities,
  AIResponse,
  ChatMessage,
  StreamEvent,
  MessageContent,
  TextContent,
  ToolUseContent,
  ToolResultContent,
} from '../types.ts';
import { debugLog, isDebugEnabled } from '../../../debug.ts';

/**
 * Ollama API response format.
 */
interface OllamaResponse {
  model: string;
  created_at: string;
  message?: {
    role: string;
    content: string;
  };
  response?: string;
  done: boolean;
  context?: number[];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

/**
 * Ollama model list response.
 */
interface OllamaModelList {
  models: Array<{
    name: string;
    model: string;
    modified_at: string;
    size: number;
    digest: string;
  }>;
}

/**
 * Convert our messages to Ollama chat format.
 */
function formatMessagesForOllama(
  messages: ChatMessage[],
  systemPrompt?: string
): Array<{ role: string; content: string }> {
  const formatted: Array<{ role: string; content: string }> = [];

  // Add system prompt first
  if (systemPrompt) {
    formatted.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of messages) {
    // Extract text content
    const textParts = msg.content
      .filter((c): c is TextContent => c.type === 'text')
      .map((c) => c.text);

    // Extract tool use content (from assistant messages)
    const toolUseParts = msg.content
      .filter((c): c is ToolUseContent => c.type === 'tool_use')
      .map((c) => `[Called tool: ${c.name} with ${JSON.stringify(c.input)}]`);

    // Extract tool result content (from tool messages)
    const toolResultParts = msg.content
      .filter((c): c is ToolResultContent => c.type === 'tool_result')
      .map((c) => {
        const resultStr = typeof c.content === 'string'
          ? c.content
          : JSON.stringify(c.content, null, 2);
        const maxLen = 2000;
        const truncated = resultStr.length > maxLen
          ? resultStr.substring(0, maxLen) + `\n... (truncated, ${resultStr.length - maxLen} more chars)`
          : resultStr;
        return `[Tool result for ${c.toolUseId}${c.isError ? ' (ERROR)' : ''}:\n${truncated}]`;
      });

    const allParts = [...textParts, ...toolUseParts, ...toolResultParts];
    const text = allParts.join('\n');

    if (!text.trim()) continue;

    // Map roles appropriately
    let role: string;
    if (msg.role === 'assistant') {
      role = 'assistant';
    } else if (msg.role === 'system') {
      role = 'system';
    } else if (msg.role === 'tool') {
      // Tool results go as user messages in simple format
      role = 'user';
    } else {
      role = 'user';
    }

    formatted.push({ role, content: text });
  }

  return formatted;
}

/**
 * Ollama CLI provider implementation.
 */
export class OllamaProvider extends BaseAIProvider {
  readonly type: AIProviderType = 'ollama';
  readonly name = 'Ollama';

  constructor(config: AIProviderConfig) {
    super(config);
  }

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[OllamaProvider] ${msg}`);
    }
  }

  getCapabilities(): AIProviderCapabilities {
    // Capabilities vary by model, use conservative defaults
    return {
      toolUse: false, // Most local models don't support tools well
      streaming: true,
      vision: false, // Depends on model
      systemMessages: true,
      maxContextTokens: 8192, // Varies by model
      maxOutputTokens: 4096,
    };
  }

  async isAvailable(): Promise<boolean> {
    // Check if ollama CLI exists and server is running
    const hasOllama = await this.commandExists('ollama');
    if (!hasOllama) return false;

    // Check if server is running by listing models
    try {
      const { exitCode } = await this.runCommand('ollama', ['list']);
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  async getAvailableModels(): Promise<string[]> {
    try {
      const { stdout, exitCode } = await this.runCommand('ollama', ['list']);

      if (exitCode !== 0) {
        return [];
      }

      // Parse the table output
      const lines = stdout.split('\n');
      const models: string[] = [];

      // Skip header line
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i]?.trim();
        if (!line) continue;

        // First column is the model name
        const parts = line.split(/\s+/);
        const modelName = parts[0];
        if (modelName) {
          models.push(modelName);
        }
      }

      return models;
    } catch {
      return [];
    }
  }

  async chat(request: ChatCompletionRequest): Promise<AIResponse> {
    this.log('Starting chat request');

    const model = this.config.model || 'llama2';
    const messages = formatMessagesForOllama(request.messages, request.systemPrompt);

    // Build the prompt for ollama run
    const prompt = messages.map((m) => {
      if (m.role === 'system') {
        return `System: ${m.content}`;
      } else if (m.role === 'user') {
        return `User: ${m.content}`;
      } else {
        return `Assistant: ${m.content}`;
      }
    }).join('\n\n') + '\n\nAssistant:';

    const args = ['run', model, prompt];

    this.log(`Running: ollama run ${model}...`);

    const { stdout, stderr, exitCode } = await this.runCommand('ollama', args, {
      cwd: request.cwd,
      abortSignal: request.abortSignal,
    });

    if (exitCode !== 0) {
      this.log(`Ollama CLI error: ${stderr}`);
      throw new Error(`Ollama CLI exited with code ${exitCode}: ${stderr}`);
    }

    return {
      message: {
        id: `msg-${Date.now()}`,
        role: 'assistant',
        content: [{ type: 'text', text: stdout.trim() }],
        timestamp: Date.now(),
      },
      stopReason: 'end_turn',
    };
  }

  async chatStream(
    request: ChatCompletionRequest,
    onEvent: (event: StreamEvent) => void
  ): Promise<AIResponse> {
    this.log('Starting streaming chat request');

    const model = this.config.model || 'llama2';
    const messages = formatMessagesForOllama(request.messages, request.systemPrompt);

    // Build the prompt
    const prompt = messages.map((m) => {
      if (m.role === 'system') {
        return `System: ${m.content}`;
      } else if (m.role === 'user') {
        return `User: ${m.content}`;
      } else {
        return `Assistant: ${m.content}`;
      }
    }).join('\n\n') + '\n\nAssistant:';

    const args = ['run', model, prompt];

    let fullText = '';
    let messageId = `msg-${Date.now()}`;

    onEvent({
      type: 'message_start',
      message: { id: messageId, role: 'assistant' },
    });

    onEvent({
      type: 'content_block_start',
      index: 0,
      contentBlock: { type: 'text' },
    });

    const { stderr, exitCode } = await this.runCommandStreaming(
      'ollama',
      args,
      (data) => {
        fullText += data;
        onEvent({
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'text_delta',
            text: data,
          },
        });
      },
      {
        cwd: request.cwd,
        abortSignal: request.abortSignal,
      }
    );

    // Check for errors BEFORE emitting message_stop so the client gets an
    // error event instead of "(No response)" when Ollama fails
    if (exitCode !== 0 && exitCode !== null) {
      this.log(`Ollama CLI error (exit ${exitCode}): ${stderr}`);
      // Emit error event so client shows a meaningful message
      onEvent({
        type: 'error',
        error: { message: `Ollama exited with code ${exitCode}: ${stderr.trim() || 'unknown error'}` },
      } as StreamEvent);
      throw new Error(`Ollama CLI exited with code ${exitCode}: ${stderr}`);
    }

    // Detect empty response (model produced no output)
    if (!fullText.trim()) {
      this.log(`Ollama returned empty response. stderr: ${stderr}`);
      onEvent({
        type: 'error',
        error: { message: `Ollama returned an empty response. ${stderr.trim() ? `stderr: ${stderr.trim()}` : 'The model may be unavailable or the prompt may be too long.'}` },
      } as StreamEvent);
      throw new Error('Ollama returned an empty response');
    }

    onEvent({ type: 'content_block_stop', index: 0 });
    onEvent({
      type: 'message_delta',
      delta: { stopReason: 'end_turn' },
    });
    onEvent({ type: 'message_stop' });

    return {
      message: {
        id: messageId,
        role: 'assistant',
        content: [{ type: 'text', text: fullText }],
        timestamp: Date.now(),
      },
      stopReason: 'end_turn',
    };
  }

  /**
   * Pull a model from the Ollama library.
   */
  async pullModel(modelName: string): Promise<boolean> {
    const { exitCode } = await this.runCommand('ollama', ['pull', modelName]);
    return exitCode === 0;
  }

  /**
   * Check if a specific model is available locally.
   */
  async hasModel(modelName: string): Promise<boolean> {
    const models = await this.getAvailableModels();
    return models.some((m) => m === modelName || m.startsWith(modelName + ':'));
  }
}

// Register the provider
registerProvider('ollama', (config) => new OllamaProvider(config));

/**
 * Create an Ollama provider instance.
 */
export function createOllamaProvider(config?: Partial<AIProviderConfig>): OllamaProvider {
  return new OllamaProvider({
    type: 'ollama',
    name: 'Ollama',
    ...config,
  });
}
