/**
 * OpenAI CLI Provider
 *
 * Implements the AI provider interface for OpenAI CLI.
 * Uses the openai CLI or the codex CLI in non-interactive mode.
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
 * OpenAI API response format.
 */
interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * OpenAI streaming chunk format.
 */
interface OpenAIStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: string | null;
  }>;
}

/**
 * Convert our messages to OpenAI format.
 */
function formatMessagesForOpenAI(
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
 * OpenAI CLI provider implementation.
 */
export class OpenAIProvider extends BaseAIProvider {
  readonly type: AIProviderType = 'openai';
  readonly name = 'OpenAI';

  private sessionId: string | null = null;

  constructor(config: AIProviderConfig) {
    super(config);
  }

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[OpenAIProvider] ${msg}`);
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
      maxContextTokens: 128000,
      maxOutputTokens: 4096,
    };
  }

  async isAvailable(): Promise<boolean> {
    // Check for openai CLI or codex CLI
    const hasOpenAI = await this.commandExists('openai');
    const hasCodex = await this.commandExists('codex');
    return hasOpenAI || hasCodex;
  }

  async getAvailableModels(): Promise<string[]> {
    // Try to fetch models from OpenAI API if API key is available
    // Check secret service first (keychain), then falls back to env vars
    const apiKey = await localSecretService.get('OPENAI_API_KEY');
    if (apiKey) {
      try {
        const response = await fetch('https://api.openai.com/v1/models', {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
          },
        });

        if (response.ok) {
          const data = await response.json() as {
            data: Array<{ id: string; owned_by: string }>;
          };
          // Filter to usable chat completion models
          const chatModels = data.data
            .map((m) => m.id)
            .filter((id) => {
              if (!/^(gpt-|o[1-9])/.test(id)) return false;
              if (id.includes('audio') || id.includes('realtime') || id.includes('transcribe')) return false;
              if (id.includes('tts') || id.includes('whisper') || id.includes('embedding')) return false;
              if (id.includes('instruct') || id.includes('davinci') || id.includes('babbage')) return false;
              if (id.includes('search') || id.includes('image') || id.includes('codex')) return false;
              if (id.endsWith('-chat-latest') || id.endsWith('-preview') || id.includes('-16k')) return false;
              if (/\d{4}-\d{2}-\d{2}$/.test(id) || /-\d{4}$/.test(id)) return false;
              return true;
            })
            .sort();
          this.log(`Fetched ${chatModels.length} chat models from OpenAI API`);
          return chatModels;
        }
        this.log(`Failed to fetch models from API: ${response.status}`);
      } catch (error) {
        this.log(`Error fetching models from API: ${error}`);
      }
    }

    // Fall back to common model identifiers
    this.log('Using fallback model list (no API key or API error)');
    return [
      'gpt-5.2',
      'gpt-5.2-pro',
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4.1-nano',
      'o3',
      'o3-mini',
      'o3-pro',
      'o4-mini',
    ];
  }

  async chat(request: ChatCompletionRequest): Promise<AIResponse> {
    this.log('Starting chat request');

    // Build the request as JSON for the CLI
    const messages = formatMessagesForOpenAI(request.messages, request.systemPrompt);
    const model = this.config.model || 'gpt-4o';

    // Use openai CLI with api subcommand
    const requestBody = {
      model,
      messages,
      max_tokens: request.maxTokens || 4096,
      temperature: request.temperature ?? 0.7,
    };

    // Try codex first if available (it has a simpler interface)
    const hasCodex = await this.commandExists('codex');

    if (hasCodex) {
      return this.chatWithCodex(request);
    }

    // Fall back to openai CLI
    const args = [
      'api',
      'chat.completions.create',
      '-m', model,
    ];

    // Add messages
    for (const msg of messages) {
      args.push('-g', msg.role, msg.content);
    }

    if (request.maxTokens) {
      args.push('--max-tokens', request.maxTokens.toString());
    }

    this.log(`Running: openai ${args.slice(0, 5).join(' ')}...`);

    const { stdout, stderr, exitCode } = await this.runCommand('openai', args, {
      cwd: request.cwd,
      abortSignal: request.abortSignal,
    });

    if (exitCode !== 0) {
      this.log(`OpenAI CLI error: ${stderr}`);
      throw new Error(`OpenAI CLI exited with code ${exitCode}: ${stderr}`);
    }

    return this.parseResponse(stdout);
  }

  /**
   * Chat using the Codex CLI.
   */
  private async chatWithCodex(request: ChatCompletionRequest): Promise<AIResponse> {
    // Codex CLI takes a prompt directly
    const messages = formatMessagesForOpenAI(request.messages, request.systemPrompt);
    const prompt = messages.map((m) => `${m.role}: ${m.content}`).join('\n');

    const args = [
      '-p', prompt,
      '--output-format', 'json',
    ];

    if (this.config.model) {
      args.push('--model', this.config.model);
    }

    // Resume session if we have one
    if (this.sessionId) {
      args.push('--resume', this.sessionId);
      this.log(`Resuming session: ${this.sessionId}`);
    }

    // Pass allowed tools if any are specified
    if (request.tools && request.tools.length > 0) {
      const toolNames = request.tools.map(t => typeof t === 'string' ? t : t.name).join(',');
      args.push('--allowedTools', toolNames);
      this.log(`Passing ${request.tools.length} tools: ${toolNames}`);
    }

    this.log(`Running: codex ${args.slice(0, 3).join(' ')}...`);

    const { stdout, stderr, exitCode } = await this.runCommand('codex', args, {
      cwd: request.cwd,
      abortSignal: request.abortSignal,
    });

    if (exitCode !== 0) {
      this.log(`Codex CLI error: ${stderr}`);
      throw new Error(`Codex CLI exited with code ${exitCode}: ${stderr}`);
    }

    return this.parseCodexResponse(stdout);
  }

  async chatStream(
    request: ChatCompletionRequest,
    onEvent: (event: StreamEvent) => void
  ): Promise<AIResponse> {
    this.log('Starting streaming chat request');

    // Check for codex CLI first
    const hasCodex = await this.commandExists('codex');

    if (hasCodex) {
      return this.chatStreamWithCodex(request, onEvent);
    }

    // Use openai CLI with streaming
    const messages = formatMessagesForOpenAI(request.messages, request.systemPrompt);
    const model = this.config.model || 'gpt-4o';

    const args = [
      'api',
      'chat.completions.create',
      '-m', model,
      '--stream',
    ];

    for (const msg of messages) {
      args.push('-g', msg.role, msg.content);
    }

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
      'openai',
      args,
      (data) => {
        // Parse SSE format
        const lines = data.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6);
            if (jsonStr === '[DONE]') continue;

            try {
              const chunk = JSON.parse(jsonStr) as OpenAIStreamChunk;
              const delta = chunk.choices[0]?.delta;

              if (delta?.content) {
                fullText += delta.content;
                onEvent({
                  type: 'content_block_delta',
                  index: 0,
                  delta: {
                    type: 'text_delta',
                    text: delta.content,
                  },
                });
              }
            } catch {
              // Not valid JSON
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
      this.log(`OpenAI CLI error: ${stderr}`);
      throw new Error(`OpenAI CLI exited with code ${exitCode}: ${stderr}`);
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
   * Stream chat using the Codex CLI.
   */
  private async chatStreamWithCodex(
    request: ChatCompletionRequest,
    onEvent: (event: StreamEvent) => void
  ): Promise<AIResponse> {
    const messages = formatMessagesForOpenAI(request.messages, request.systemPrompt);
    const prompt = messages.map((m) => `${m.role}: ${m.content}`).join('\n');

    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
    ];

    if (this.config.model) {
      args.push('--model', this.config.model);
    }

    // Resume session if we have one
    if (this.sessionId) {
      args.push('--resume', this.sessionId);
      this.log(`Resuming session: ${this.sessionId}`);
    }

    // Pass allowed tools if any are specified
    if (request.tools && request.tools.length > 0) {
      const toolNames = request.tools.map(t => typeof t === 'string' ? t : t.name).join(',');
      args.push('--allowedTools', toolNames);
      this.log(`Passing ${request.tools.length} tools: ${toolNames}`);
    }

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
      'codex',
      args,
      (data) => {
        const lines = data.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const event = JSON.parse(line) as Record<string, unknown>;

            // Capture session ID if present
            if (event.session_id && !this.sessionId) {
              this.sessionId = event.session_id as string;
              this.log(`Captured session ID: ${this.sessionId}`);
            }

            if (event.type === 'content_block_delta' && (event.delta as { text?: string })?.text) {
              const text = (event.delta as { text: string }).text;
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
            // Not valid JSON, might be raw text
            if (line.trim()) {
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
      this.log(`Codex CLI error: ${stderr}`);
      throw new Error(`Codex CLI exited with code ${exitCode}: ${stderr}`);
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
   * Parse OpenAI API response.
   */
  private parseResponse(output: string): AIResponse {
    try {
      const response = JSON.parse(output) as OpenAIResponse;
      const choice = response.choices[0];
      const content: MessageContent[] = [];

      if (!choice) {
        throw new Error('No choices in response');
      }

      if (choice.message.content) {
        content.push({ type: 'text', text: choice.message.content });
      }

      if (choice.message.tool_calls) {
        for (const toolCall of choice.message.tool_calls) {
          content.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: JSON.parse(toolCall.function.arguments),
          });
        }
      }

      const hasToolUse = choice.message.tool_calls && choice.message.tool_calls.length > 0;

      return {
        message: {
          id: response.id,
          role: 'assistant',
          content,
          timestamp: Date.now(),
        },
        stopReason: hasToolUse ? 'tool_use' : 'end_turn',
        usage: response.usage
          ? {
              inputTokens: response.usage.prompt_tokens,
              outputTokens: response.usage.completion_tokens,
            }
          : undefined,
      };
    } catch {
      // If not valid JSON, treat as plain text
      return {
        message: {
          id: `msg-${Date.now()}`,
          role: 'assistant',
          content: [{ type: 'text', text: output.trim() }],
          timestamp: Date.now(),
        },
        stopReason: 'end_turn',
      };
    }
  }

  /**
   * Parse Codex CLI response.
   */
  private parseCodexResponse(output: string): AIResponse {
    // Try to parse as JSON
    const lines = output.split('\n');
    let fullText = '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line) as Record<string, unknown>;

        // Capture session ID if present
        if (event.session_id && !this.sessionId) {
          this.sessionId = event.session_id as string;
          this.log(`Captured session ID: ${this.sessionId}`);
        }

        if ((event.message as { content?: Array<{ type: string; text?: string }> })?.content) {
          for (const block of (event.message as { content: Array<{ type: string; text?: string }> }).content) {
            if (block.type === 'text' && block.text) {
              fullText += block.text;
            }
          }
        } else if (event.type === 'result' && event.result) {
          fullText += event.result as string;
        }
      } catch {
        // Not JSON, treat as text
        fullText += line + '\n';
      }
    }

    return {
      message: {
        id: `msg-${Date.now()}`,
        role: 'assistant',
        content: [{ type: 'text', text: fullText.trim() }],
        timestamp: Date.now(),
      },
      stopReason: 'end_turn',
    };
  }
}

// Register the provider
registerProvider('openai', (config) => new OpenAIProvider(config));

/**
 * Create an OpenAI provider instance.
 */
export function createOpenAIProvider(config?: Partial<AIProviderConfig>): OpenAIProvider {
  return new OpenAIProvider({
    type: 'openai',
    name: 'OpenAI',
    ...config,
  });
}
