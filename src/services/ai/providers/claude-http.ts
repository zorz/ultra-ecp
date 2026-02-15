/**
 * Claude HTTP API Provider
 *
 * Implements the AI provider interface using Anthropic's Messages API directly.
 * Uses HTTP API instead of CLI tools.
 */

import {
  BaseAIProvider,
  registerProvider,
  type ChatCompletionRequest,
} from './base.ts';
import type {
  AIProviderType,
  AIProviderConfig,
  AIProviderCapabilities,
  AIResponse,
  ChatMessage,
  StreamEvent,
  TextContent,
  ToolUseContent,
  ToolResultContent,
} from '../types.ts';
import { debugLog, isDebugEnabled } from '../../../debug.ts';
import { localSecretService } from '../../secret/local.ts';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Anthropic API message format.
 */
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Array<{ type: 'text'; text: string }>;
  is_error?: boolean;
}

/**
 * Anthropic Messages API response format.
 */
interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * Convert our messages to Anthropic API format.
 * Merges consecutive same-role messages to comply with Anthropic's API requirements.
 * This is especially important for tool_result messages which may be added separately
 * but must be combined into a single user message for the API.
 */
function formatMessagesForAnthropic(messages: ChatMessage[]): AnthropicMessage[] {
  const formatted: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue; // System handled separately

    const contentBlocks: AnthropicContentBlock[] = [];

    for (const c of msg.content) {
      if (c.type === 'text') {
        contentBlocks.push({ type: 'text', text: (c as TextContent).text });
      } else if (c.type === 'tool_use') {
        const tu = c as ToolUseContent;
        contentBlocks.push({
          type: 'tool_use',
          id: tu.id,
          name: tu.name,
          input: tu.input,
        });
      } else if (c.type === 'tool_result') {
        const tr = c as ToolResultContent;
        const content = typeof tr.content === 'string'
          ? tr.content
          : JSON.stringify(tr.content);
        contentBlocks.push({
          type: 'tool_result',
          tool_use_id: tr.toolUseId,
          content,
          is_error: tr.isError,
        });
      }
    }

    if (contentBlocks.length > 0) {
      const role = msg.role === 'assistant' ? 'assistant' : 'user';

      // Check if we should merge with the previous message (same role)
      // This handles cases where multiple tool_result messages need to be combined
      const lastMessage = formatted[formatted.length - 1];
      if (lastMessage && lastMessage.role === role && Array.isArray(lastMessage.content)) {
        // Merge content blocks into the existing message
        lastMessage.content.push(...contentBlocks);
      } else {
        // Create a new message
        formatted.push({
          role,
          content: contentBlocks,
        });
      }
    }
  }

  return formatted;
}

/**
 * Claude HTTP API provider implementation.
 */
export class ClaudeHTTPProvider extends BaseAIProvider {
  readonly type: AIProviderType = 'claude';
  readonly name = 'Claude (HTTP)';

  private apiKey: string | null = null;

  constructor(config: AIProviderConfig) {
    super(config);
  }

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[ClaudeHTTPProvider] ${msg}`);
    }
  }

  getCapabilities(): AIProviderCapabilities {
    return {
      streaming: true,
      toolUse: true,
      vision: true,
      systemMessages: true,
      maxContextTokens: 200000,
      maxOutputTokens: 8192,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const apiKey = await this.getApiKey();
      return !!apiKey;
    } catch {
      return false;
    }
  }

  private async getApiKey(): Promise<string> {
    if (this.apiKey) {
      return this.apiKey;
    }

    // Try config first
    if (this.config.apiKey) {
      this.apiKey = this.config.apiKey;
      return this.apiKey;
    }

    // Try secret service
    try {
      await localSecretService.init();
      const secret = await localSecretService.get('ANTHROPIC_API_KEY');
      if (secret) {
        this.log('Found ANTHROPIC_API_KEY in secret service');
        this.apiKey = secret;
        return this.apiKey;
      }
      // Try alternate name
      const secretAlt = await localSecretService.get('anthropic-api-key');
      if (secretAlt) {
        this.log('Found anthropic-api-key in secret service');
        this.apiKey = secretAlt;
        return this.apiKey;
      }
    } catch (err) {
      this.log(`Secret service error: ${err}`);
    }

    // Try environment
    const envKey = process.env.ANTHROPIC_API_KEY;
    if (envKey) {
      this.apiKey = envKey;
      return this.apiKey;
    }

    throw new Error('Anthropic API key not found');
  }

  async getAvailableModels(): Promise<string[]> {
    return [
      'claude-sonnet-4-5-20250514',
      'claude-opus-4-5-20250514',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
    ];
  }

  async chat(request: ChatCompletionRequest): Promise<AIResponse> {
    const apiKey = await this.getApiKey();
    const model = this.config.model || 'claude-sonnet-4-5-20250514';

    this.log(`Chat request to ${model}`);

    const messages = formatMessagesForAnthropic(request.messages);

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxTokens ?? 8192,
    };

    if (request.systemPrompt) {
      body.system = request.systemPrompt;
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    // Add tools if provided
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    }

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: request.abortSignal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as AnthropicResponse;
    return this.parseResponse(data);
  }

  async chatStream(
    request: ChatCompletionRequest,
    onEvent: (event: StreamEvent) => void
  ): Promise<AIResponse> {
    const apiKey = await this.getApiKey();
    const model = this.config.model || 'claude-sonnet-4-5-20250514';

    this.log(`Stream chat request to ${model}`);

    const messages = formatMessagesForAnthropic(request.messages);

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxTokens ?? 8192,
      stream: true,
    };

    if (request.systemPrompt) {
      body.system = request.systemPrompt;
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    }

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: request.abortSignal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
    }

    // Parse SSE stream
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let fullText = '';
    const toolUses: Map<number, { id: string; name: string; input: string }> = new Map();
    let currentToolIndex = -1;
    let stopReason: AIResponse['stopReason'] = 'end_turn';
    let usage = { inputTokens: 0, outputTokens: 0 };
    let messageId = '';

    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const event = JSON.parse(data);

          switch (event.type) {
            case 'message_start':
              messageId = event.message?.id || '';
              onEvent({ type: 'message_start', message: { id: messageId, role: 'assistant' } });
              if (event.message?.usage) {
                usage.inputTokens = event.message.usage.input_tokens || 0;
              }
              break;

            case 'content_block_start':
              if (event.content_block?.type === 'tool_use') {
                currentToolIndex = event.index;
                const toolId = event.content_block.id || '';
                const toolName = event.content_block.name || '';
                toolUses.set(currentToolIndex, {
                  id: toolId,
                  name: toolName,
                  input: '',
                });
                // Emit tool_use event so client knows a tool is being called
                onEvent({
                  type: 'tool_use',
                  id: toolId,
                  name: toolName,
                } as StreamEvent);
              }
              break;

            case 'content_block_delta':
              if (event.delta?.type === 'text_delta') {
                fullText += event.delta.text || '';
                onEvent({
                  type: 'content_block_delta',
                  index: event.index,
                  delta: { type: 'text_delta', text: event.delta.text || '' },
                });
              } else if (event.delta?.type === 'input_json_delta') {
                const tool = toolUses.get(event.index);
                if (tool) {
                  tool.input += event.delta.partial_json || '';
                }
              }
              break;

            case 'content_block_stop':
              // Check if this was a tool_use block that completed
              const completedTool = toolUses.get(event.index);
              if (completedTool) {
                // Emit tool_use_complete even if input is empty (some tools have no input)
                let parsedInput = {};
                if (completedTool.input) {
                  try {
                    parsedInput = JSON.parse(completedTool.input);
                  } catch {
                    this.log(`Failed to parse tool input JSON: ${completedTool.input}`);
                  }
                }
                this.log(`Tool use complete: ${completedTool.name} (${completedTool.id}) input: ${JSON.stringify(parsedInput)}`);
                onEvent({
                  type: 'tool_use_complete',
                  id: completedTool.id,
                  name: completedTool.name,
                  input: parsedInput,
                } as StreamEvent);
              }
              break;

            case 'message_delta':
              if (event.delta?.stop_reason) {
                stopReason = this.mapStopReason(event.delta.stop_reason);
              }
              if (event.usage) {
                usage.outputTokens = event.usage.output_tokens || 0;
              }
              break;

            case 'message_stop':
              onEvent({ type: 'message_stop' });
              break;
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    // Build final response
    const content: Array<TextContent | ToolUseContent> = [];
    if (fullText) {
      content.push({ type: 'text', text: fullText });
    }
    for (const tool of toolUses.values()) {
      try {
        content.push({
          type: 'tool_use',
          id: tool.id,
          name: tool.name,
          input: JSON.parse(tool.input || '{}'),
        });
      } catch {
        // Invalid JSON
      }
    }

    // Detect empty response (no text and no tool use)
    if (content.length === 0) {
      this.log('Claude API returned empty response (no text, no tool use)');
    }

    return {
      message: {
        id: messageId || `msg-${Date.now()}`,
        role: 'assistant',
        content,
        timestamp: Date.now(),
      },
      stopReason,
      usage,
    };
  }

  private parseResponse(data: AnthropicResponse): AIResponse {
    const content: Array<TextContent | ToolUseContent> = [];

    for (const block of data.content) {
      if (block.type === 'text' && block.text) {
        content.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use' && block.id && block.name) {
        content.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input || {},
        });
      }
    }

    return {
      message: {
        id: data.id,
        role: 'assistant',
        content,
        timestamp: Date.now(),
      },
      stopReason: this.mapStopReason(data.stop_reason),
      usage: {
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
      },
    };
  }

  private mapStopReason(reason: string): AIResponse['stopReason'] {
    switch (reason) {
      case 'tool_use':
        return 'tool_use';
      case 'max_tokens':
        return 'max_tokens';
      case 'stop_sequence':
      case 'end_turn':
      default:
        return 'end_turn';
    }
  }

  override cancel(): void {
    // HTTP requests are cancelled via AbortController
  }
}

/**
 * Create a Claude HTTP provider instance.
 */
export function createClaudeHTTPProvider(config: AIProviderConfig): ClaudeHTTPProvider {
  return new ClaudeHTTPProvider(config);
}

// Register as HTTP provider for 'claude'
registerProvider('claude', (config) => new ClaudeHTTPProvider(config), true);
