/**
 * Claude API Provider
 *
 * Direct API integration with Anthropic's Claude models.
 * Uses the Messages API for chat completions.
 */

import {
  BaseAPIProvider,
  type APIChatRequest,
  registerAPIProvider,
} from './api-base.ts';
import type {
  AIProviderType,
  AIProviderConfig,
  AIProviderCapabilities,
  AIResponse,
  StreamEvent,
  ChatMessage,
  MessageContent,
  ToolDefinition,
} from '../../ai/types.ts';
import { getModelRegistry } from '../../models/index.ts';

/**
 * Anthropic API message format.
 */
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  >;
}

/**
 * Anthropic API tool format.
 */
interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Anthropic API response format.
 */
interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >;
  model: string;
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * Anthropic streaming event types.
 */
type AnthropicStreamEvent =
  | { type: 'message_start'; message: AnthropicResponse }
  | { type: 'content_block_start'; index: number; content_block: { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } }
  | { type: 'content_block_delta'; index: number; delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: string | null }; usage?: { output_tokens: number } }
  | { type: 'message_stop' }
  | { type: 'error'; error: { type: string; message: string } };

/**
 * Default API base URL.
 */
const DEFAULT_BASE_URL = 'https://api.anthropic.com';

/**
 * API version header.
 */
const API_VERSION = '2023-06-01';

/**
 * Claude API provider implementation.
 */
export class ClaudeAPIProvider extends BaseAPIProvider {
  readonly type: AIProviderType = 'claude';
  readonly name = 'Claude';

  private baseUrl: string;

  constructor(config: AIProviderConfig) {
    super(config);
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  }

  getCapabilities(): AIProviderCapabilities {
    return {
      toolUse: true,
      streaming: true,
      vision: true,
      systemMessages: true,
      maxContextTokens: 200000,
      maxOutputTokens: 8192,
    };
  }

  async isAvailable(): Promise<boolean> {
    const apiKey = await this.getApiKey(['ANTHROPIC_API_KEY']);
    return !!apiKey;
  }

  async getAvailableModels(): Promise<string[]> {
    const apiKey = await this.getApiKey(['ANTHROPIC_API_KEY']);
    if (!apiKey) {
      return this.getFallbackModels();
    }

    try {
      const response = await this.fetchWithRetry(
        `${this.baseUrl}/v1/models`,
        {
          method: 'GET',
          headers: {
            'anthropic-version': API_VERSION,
            'x-api-key': apiKey,
          },
        }
      );

      if (response.ok) {
        const data = await response.json() as {
          data: Array<{ id: string; display_name: string }>;
        };
        const models = data.data.map((m) => m.id);
        this.log(`Fetched ${models.length} models from Anthropic API`);
        return models;
      }

      this.log(`Failed to fetch models: ${response.status}`);
    } catch (error) {
      this.log(`Error fetching models: ${error}`);
    }

    return this.getFallbackModels();
  }

  private getFallbackModels(): string[] {
    const registry = getModelRegistry();
    const models = registry.getProviderModelIds('anthropic');
    // If registry has models, use them; otherwise fallback to hardcoded
    if (models.length > 0) {
      return models;
    }
    return [
      'claude-sonnet-4-20250514',
      'claude-opus-4-20250514',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
    ];
  }

  async chat(request: APIChatRequest): Promise<AIResponse> {
    const apiKey = await this.getApiKey(['ANTHROPIC_API_KEY']);
    if (!apiKey) {
      throw new Error('Anthropic API key not found');
    }

    this.currentAbortController = new AbortController();
    const combinedSignal = this.combineSignals(
      this.currentAbortController.signal,
      request.abortSignal
    );

    const registry = getModelRegistry();
    const defaultModel = registry.getProviderDefaultId('anthropic') || 'claude-sonnet-4-20250514';
    const model = this.config.model ?? defaultModel;
    const messages = this.convertMessages(request.messages);
    const tools = request.tools ? this.convertTools(request.tools) : undefined;

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxTokens ?? 4096,
    };

    if (request.systemPrompt) {
      body.system = request.systemPrompt;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    this.log(`Chat request to ${model}`);

    const response = await this.fetchWithRetry(
      `${this.baseUrl}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': API_VERSION,
          'x-api-key': apiKey,
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${error}`);
    }

    const data = await response.json() as AnthropicResponse;
    return this.convertResponse(data);
  }

  async chatStream(
    request: APIChatRequest,
    onEvent: (event: StreamEvent) => void
  ): Promise<AIResponse> {
    const apiKey = await this.getApiKey(['ANTHROPIC_API_KEY']);
    if (!apiKey) {
      throw new Error('Anthropic API key not found');
    }

    this.currentAbortController = new AbortController();
    const combinedSignal = this.combineSignals(
      this.currentAbortController.signal,
      request.abortSignal
    );

    const registry = getModelRegistry();
    const defaultModel = registry.getProviderDefaultId('anthropic') || 'claude-sonnet-4-20250514';
    const model = this.config.model ?? defaultModel;
    const messages = this.convertMessages(request.messages);
    const tools = request.tools ? this.convertTools(request.tools) : undefined;

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxTokens ?? 4096,
      stream: true,
    };

    if (request.systemPrompt) {
      body.system = request.systemPrompt;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    this.log(`Streaming chat request to ${model}`);

    const response = await this.fetchWithRetry(
      `${this.baseUrl}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': API_VERSION,
          'x-api-key': apiKey,
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${error}`);
    }

    // Parse streaming response
    const content: MessageContent[] = [];
    let messageId = '';
    let stopReason: AIResponse['stopReason'] = 'end_turn';
    let inputTokens = 0;
    let outputTokens = 0;

    // Track current content block for accumulation
    let currentBlockIndex = -1;
    let currentText = '';
    let currentToolId = '';
    let currentToolName = '';
    let currentToolInput = '';

    for await (const event of this.parseSSEStream(response)) {
      const streamEvent = event as AnthropicStreamEvent;

      switch (streamEvent.type) {
        case 'message_start':
          messageId = streamEvent.message.id;
          inputTokens = streamEvent.message.usage?.input_tokens ?? 0;
          onEvent({
            type: 'message_start',
            message: { id: messageId, role: 'assistant' },
          });
          break;

        case 'content_block_start':
          currentBlockIndex = streamEvent.index;
          if (streamEvent.content_block.type === 'text') {
            currentText = streamEvent.content_block.text ?? '';
            onEvent({
              type: 'content_block_start',
              index: currentBlockIndex,
              contentBlock: { type: 'text' },
            });
          } else if (streamEvent.content_block.type === 'tool_use') {
            currentToolId = streamEvent.content_block.id;
            currentToolName = streamEvent.content_block.name;
            currentToolInput = '';
            onEvent({
              type: 'content_block_start',
              index: currentBlockIndex,
              contentBlock: {
                type: 'tool_use',
                id: currentToolId,
                name: currentToolName,
              },
            });
          }
          break;

        case 'content_block_delta':
          if (streamEvent.delta.type === 'text_delta') {
            currentText += streamEvent.delta.text;
            onEvent({
              type: 'content_block_delta',
              index: streamEvent.index,
              delta: {
                type: 'text_delta',
                text: streamEvent.delta.text,
              },
            });
          } else if (streamEvent.delta.type === 'input_json_delta') {
            currentToolInput += streamEvent.delta.partial_json;
            onEvent({
              type: 'content_block_delta',
              index: streamEvent.index,
              delta: {
                type: 'input_json_delta',
                partialJson: streamEvent.delta.partial_json,
              },
            });
          }
          break;

        case 'content_block_stop':
          onEvent({
            type: 'content_block_stop',
            index: streamEvent.index,
          });

          // Add completed content block
          if (currentText) {
            content.push({ type: 'text', text: currentText });
            currentText = '';
          }
          if (currentToolId && currentToolName) {
            try {
              content.push({
                type: 'tool_use',
                id: currentToolId,
                name: currentToolName,
                input: JSON.parse(currentToolInput || '{}'),
              });
            } catch {
              this.log(`Failed to parse tool input: ${currentToolInput}`);
            }
            currentToolId = '';
            currentToolName = '';
            currentToolInput = '';
          }
          break;

        case 'message_delta':
          outputTokens = streamEvent.usage?.output_tokens ?? outputTokens;
          if (streamEvent.delta.stop_reason) {
            stopReason = this.mapStopReason(streamEvent.delta.stop_reason);
          }
          // Map stop reason for delta event (excludes 'error')
          const deltaStopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' =
            stopReason === 'error' ? 'end_turn' : stopReason;
          onEvent({
            type: 'message_delta',
            delta: { stopReason: deltaStopReason },
          });
          break;

        case 'message_stop':
          onEvent({ type: 'message_stop' });
          break;

        case 'error':
          onEvent({
            type: 'error',
            error: {
              type: streamEvent.error.type,
              message: streamEvent.error.message,
            },
          });
          throw new Error(`Stream error: ${streamEvent.error.message}`);
      }
    }

    return {
      message: {
        id: messageId || `msg-${Date.now()}`,
        role: 'assistant',
        content,
        timestamp: Date.now(),
      },
      stopReason,
      usage: {
        inputTokens,
        outputTokens,
      },
    };
  }

  /**
   * Convert our messages to Anthropic format.
   */
  private convertMessages(messages: ChatMessage[]): AnthropicMessage[] {
    const result: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        // System messages go in the system parameter, skip here
        continue;
      }

      const role = msg.role === 'tool' ? 'user' : msg.role === 'assistant' ? 'assistant' : 'user';
      const content: AnthropicMessage['content'] = [];

      for (const block of msg.content) {
        if (block.type === 'text') {
          content.push({ type: 'text', text: block.text });
        } else if (block.type === 'image') {
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: block.mediaType,
              data: block.data,
            },
          });
        } else if (block.type === 'tool_use') {
          content.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          });
        } else if (block.type === 'tool_result') {
          const resultContent = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content);
          content.push({
            type: 'tool_result',
            tool_use_id: block.toolUseId,
            content: resultContent,
            is_error: block.isError,
          });
        }
      }

      if (content.length > 0) {
        result.push({ role, content });
      }
    }

    return result;
  }

  /**
   * Convert our tools to Anthropic format.
   */
  private convertTools(tools: ToolDefinition[]): AnthropicTool[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: 'object',
        properties: tool.inputSchema.properties,
        required: tool.inputSchema.required,
      },
    }));
  }

  /**
   * Convert Anthropic response to our format.
   */
  private convertResponse(data: AnthropicResponse): AIResponse {
    const content: MessageContent[] = [];

    for (const block of data.content) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        content.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
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

  /**
   * Map Anthropic stop reason to our format.
   */
  private mapStopReason(reason: string | null): AIResponse['stopReason'] {
    switch (reason) {
      case 'end_turn':
        return 'end_turn';
      case 'tool_use':
        return 'tool_use';
      case 'max_tokens':
        return 'max_tokens';
      case 'stop_sequence':
        return 'stop_sequence';
      default:
        return 'end_turn';
    }
  }

  /**
   * Combine multiple abort signals.
   */
  private combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
    const controller = new AbortController();

    for (const signal of signals) {
      if (!signal) continue;

      if (signal.aborted) {
        controller.abort();
        break;
      }

      signal.addEventListener('abort', () => controller.abort());
    }

    return controller.signal;
  }
}

// Register the provider
registerAPIProvider('claude', (config) => new ClaudeAPIProvider(config));

/**
 * Create a Claude API provider instance.
 */
export function createClaudeAPIProvider(config?: Partial<AIProviderConfig>): ClaudeAPIProvider {
  return new ClaudeAPIProvider({
    type: 'claude',
    name: 'Claude',
    ...config,
  });
}
