/**
 * Gemini CLI Provider
 *
 * Implements the AI provider interface for Google Gemini CLI.
 * Uses the gemini CLI in non-interactive mode.
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
import { localSecretService } from '../../secret/local.ts';

/**
 * Convert our messages to Gemini format.
 */
function formatMessagesForGemini(
  messages: ChatMessage[],
  systemPrompt?: string
): string {
  const parts: string[] = [];

  // Add system prompt
  if (systemPrompt) {
    parts.push(`[System]\n${systemPrompt}\n`);
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

    if (msg.role === 'user') {
      parts.push(`User: ${text}`);
    } else if (msg.role === 'assistant') {
      parts.push(`Assistant: ${text}`);
    } else if (msg.role === 'system') {
      parts.push(`[System: ${text}]`);
    } else if (msg.role === 'tool') {
      parts.push(`${text}`);
    }
  }

  return parts.join('\n\n');
}

/**
 * Gemini CLI provider implementation.
 */
export class GeminiProvider extends BaseAIProvider {
  readonly type: AIProviderType = 'gemini';
  readonly name = 'Gemini';

  private sessionId: string | null = null;

  constructor(config: AIProviderConfig) {
    super(config);
  }

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[GeminiProvider] ${msg}`);
    }
  }

  /**
   * Get the current session ID.
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Set the session ID for resume.
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  getCapabilities(): AIProviderCapabilities {
    return {
      toolUse: true,
      streaming: true,
      vision: true,
      systemMessages: true,
      maxContextTokens: 1000000, // Gemini 1.5 Pro has 1M context
      maxOutputTokens: 8192,
    };
  }

  async isAvailable(): Promise<boolean> {
    return this.commandExists('gemini');
  }

  async getAvailableModels(): Promise<string[]> {
    // Try to fetch models from Google AI API if API key is available
    // Check secret service first (keychain), then falls back to env vars
    const apiKey = await localSecretService.get('GEMINI_API_KEY')
      || await localSecretService.get('GOOGLE_API_KEY');
    if (apiKey) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`
        );

        if (response.ok) {
          const data = await response.json() as {
            models: Array<{ name: string; displayName: string }>;
          };
          // Extract model names (format: "models/gemini-1.5-pro") and strip prefix
          const models = data.models
            .map((m) => m.name.replace('models/', ''))
            .filter((name) => name.startsWith('gemini'))
            .sort()
            .reverse(); // Newest first
          this.log(`Fetched ${models.length} Gemini models from API`);
          return models;
        }
        this.log(`Failed to fetch models from API: ${response.status}`);
      } catch (error) {
        this.log(`Error fetching models from API: ${error}`);
      }
    }

    // Fall back to common model identifiers
    this.log('Using fallback model list (no API key or API error)');
    return [
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-1.5-pro',
      'gemini-1.5-flash',
      'gemini-1.0-pro',
    ];
  }

  async chat(request: ChatCompletionRequest): Promise<AIResponse> {
    this.log('Starting chat request');

    const prompt = formatMessagesForGemini(request.messages, request.systemPrompt);
    const args = this.buildCliArgs(prompt, request);

    this.log(`Running: gemini ${args.slice(0, 3).join(' ')}...`);

    const { stdout, stderr, exitCode } = await this.runCommand('gemini', args, {
      cwd: request.cwd,
      abortSignal: request.abortSignal,
    });

    if (exitCode !== 0) {
      this.log(`Gemini CLI error: ${stderr}`);
      throw new Error(`Gemini CLI exited with code ${exitCode}: ${stderr}`);
    }

    return this.parseResponse(stdout);
  }

  async chatStream(
    request: ChatCompletionRequest,
    onEvent: (event: StreamEvent) => void
  ): Promise<AIResponse> {
    this.log('Starting streaming chat request');

    const prompt = formatMessagesForGemini(request.messages, request.systemPrompt);
    const args = this.buildCliArgs(prompt, request, true);

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
      'gemini',
      args,
      (data) => {
        // Parse streaming output
        const lines = data.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const event = JSON.parse(line);
            if (event.type === 'content' && event.text) {
              fullText += event.text;
              onEvent({
                type: 'content_block_delta',
                index: 0,
                delta: {
                  type: 'text_delta',
                  text: event.text,
                },
              });
            } else if (event.type === 'text' || event.delta?.text) {
              const text = event.text || event.delta?.text;
              fullText += text;
              onEvent({
                type: 'content_block_delta',
                index: 0,
                delta: {
                  type: 'text_delta',
                  text,
                },
              });
            }
          } catch {
            // Not JSON, treat as raw text
            if (line.trim() && !line.startsWith('{')) {
              fullText += line;
              onEvent({
                type: 'content_block_delta',
                index: 0,
                delta: {
                  type: 'text_delta',
                  text: line,
                },
              });
            }
          }
        }
      },
      {
        cwd: request.cwd,
        abortSignal: request.abortSignal,
      }
    );

    onEvent({ type: 'content_block_stop', index: 0 });
    onEvent({
      type: 'message_delta',
      delta: { stopReason: 'end_turn' },
    });
    onEvent({ type: 'message_stop' });

    if (exitCode !== 0 && exitCode !== null) {
      this.log(`Gemini CLI error: ${stderr}`);
      throw new Error(`Gemini CLI exited with code ${exitCode}: ${stderr}`);
    }

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
   * Build CLI arguments for the request.
   */
  private buildCliArgs(
    prompt: string,
    request: ChatCompletionRequest,
    streaming = false
  ): string[] {
    const args: string[] = [];

    // Use prompt mode
    args.push('-p', prompt);

    // Output format
    if (streaming) {
      args.push('--output-format', 'stream-json');
    } else {
      args.push('--output-format', 'json');
    }

    // Model if specified
    if (this.config.model) {
      args.push('--model', this.config.model);
    }

    // Max tokens
    if (request.maxTokens) {
      args.push('--max-tokens', request.maxTokens.toString());
    }

    // Resume session if we have one
    if (this.sessionId) {
      args.push('--session', this.sessionId);
      this.log(`Resuming session: ${this.sessionId}`);
    }

    // Pass allowed tools if any are specified
    if (request.tools && request.tools.length > 0) {
      // Handle both string[] and {name: string}[] formats (ECP sends strings, internal uses objects)
      const toolNames = request.tools.map(t => typeof t === 'string' ? t : t.name).join(',');
      args.push('--allowedTools', toolNames);
      this.log(`Passing ${request.tools.length} tools: ${toolNames}`);
    }

    return args;
  }

  /**
   * Parse Gemini response.
   */
  private parseResponse(output: string): AIResponse {
    const content: MessageContent[] = [];
    let foundText = false;

    // Try to parse JSON lines
    const lines = output.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line) as Record<string, unknown>;

        // Capture session ID if present
        if (event.session_id && !this.sessionId) {
          this.sessionId = event.session_id as string;
          this.log(`Captured session ID: ${this.sessionId}`);
        }

        if (event.type === 'result' && (event.message as { content?: Array<{ type: string; text?: string }> })?.content) {
          for (const block of (event.message as { content: Array<{ type: string; text?: string }> }).content) {
            if (block.type === 'text' && block.text) {
              content.push({ type: 'text', text: block.text });
              foundText = true;
            }
          }
        } else if ((event.response as { text?: string })?.text) {
          content.push({ type: 'text', text: (event.response as { text: string }).text });
          foundText = true;
        } else if (event.text) {
          content.push({ type: 'text', text: event.text as string });
          foundText = true;
        }
      } catch {
        // Not valid JSON
      }
    }

    // If no structured content, treat whole output as text
    if (!foundText) {
      content.push({ type: 'text', text: output.trim() });
    }

    return {
      message: {
        id: `msg-${Date.now()}`,
        role: 'assistant',
        content,
        timestamp: Date.now(),
      },
      stopReason: 'end_turn',
    };
  }
}

// Register the provider
registerProvider('gemini', (config) => new GeminiProvider(config));

/**
 * Create a Gemini provider instance.
 */
export function createGeminiProvider(config?: Partial<AIProviderConfig>): GeminiProvider {
  return new GeminiProvider({
    type: 'gemini',
    name: 'Gemini',
    ...config,
  });
}
