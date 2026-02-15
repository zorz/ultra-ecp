/**
 * OpenAI API Provider
 *
 * Direct API integration with OpenAI's chat models.
 * Uses the Chat Completions API.
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
  TextContent,
  ToolUseContent,
  ToolDefinition,
} from '../../ai/types.ts';
import { getModelRegistry } from '../../models/index.ts';

/**
 * OpenAI API message format.
 */
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

/**
 * OpenAI API tool format.
 */
interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties?: Record<string, unknown>;
      required?: string[];
    };
  };
}

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
    finish_reason: string | null;
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
      content?: string | null;
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
 * Default API base URL.
 */
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * OpenAI API provider implementation.
 */
export class OpenAIAPIProvider extends BaseAPIProvider {
  readonly type: AIProviderType = 'openai';
  readonly name = 'OpenAI';

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
      maxContextTokens: 128000,
      maxOutputTokens: 4096,
    };
  }

  async isAvailable(): Promise<boolean> {
    const apiKey = await this.getApiKey(['OPENAI_API_KEY']);
    return !!apiKey;
  }

  async getAvailableModels(): Promise<string[]> {
    const apiKey = await this.getApiKey(['OPENAI_API_KEY']);
    if (!apiKey) {
      return this.getFallbackModels();
    }

    try {
      const response = await this.fetchWithRetry(
        `${this.baseUrl}/models`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
          },
        }
      );

      if (response.ok) {
        const data = await response.json() as {
          data: Array<{ id: string; owned_by: string }>;
        };
        // Filter to chat-capable models
        const chatModels = data.data
          .filter((m) => /^(gpt-|o1|o3)/.test(m.id))
          .map((m) => m.id)
          .sort();
        this.log(`Fetched ${chatModels.length} chat models from OpenAI API`);
        return chatModels;
      }

      this.log(`Failed to fetch models: ${response.status}`);
    } catch (error) {
      this.log(`Error fetching models: ${error}`);
    }

    return this.getFallbackModels();
  }

  private getFallbackModels(): string[] {
    const registry = getModelRegistry();
    const models = registry.getProviderModelIds('openai');
    if (models.length > 0) {
      return models;
    }
    return [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4-turbo',
      'gpt-4',
      'gpt-3.5-turbo',
      'o1',
      'o1-mini',
      'o1-preview',
      'o3-mini',
    ];
  }

  async chat(request: APIChatRequest): Promise<AIResponse> {
    const apiKey = await this.getApiKey(['OPENAI_API_KEY']);
    if (!apiKey) {
      throw new Error('OpenAI API key not found');
    }

    this.currentAbortController = new AbortController();
    const combinedSignal = this.combineSignals(
      this.currentAbortController.signal,
      request.abortSignal
    );

    const registry = getModelRegistry();
    const defaultModel = registry.getProviderDefaultId('openai') || 'gpt-4o';
    const model = this.config.model ?? defaultModel;
    const messages = this.convertMessages(request.messages, request.systemPrompt);
    const tools = request.tools ? this.convertTools(request.tools) : undefined;

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxTokens ?? 4096,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    this.log(`Chat request to ${model}`);

    const response = await this.fetchWithRetry(
      `${this.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${error}`);
    }

    const data = await response.json() as OpenAIResponse;
    return this.convertResponse(data);
  }

  async chatStream(
    request: APIChatRequest,
    onEvent: (event: StreamEvent) => void
  ): Promise<AIResponse> {
    const apiKey = await this.getApiKey(['OPENAI_API_KEY']);
    if (!apiKey) {
      throw new Error('OpenAI API key not found');
    }

    this.currentAbortController = new AbortController();
    const combinedSignal = this.combineSignals(
      this.currentAbortController.signal,
      request.abortSignal
    );

    const registry = getModelRegistry();
    const defaultModel = registry.getProviderDefaultId('openai') || 'gpt-4o';
    const model = this.config.model ?? defaultModel;
    const messages = this.convertMessages(request.messages, request.systemPrompt);
    const tools = request.tools ? this.convertTools(request.tools) : undefined;

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxTokens ?? 4096,
      stream: true,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    this.log(`Streaming chat request to ${model}`);

    const response = await this.fetchWithRetry(
      `${this.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${error}`);
    }

    // Parse streaming response
    const content: MessageContent[] = [];
    let messageId = '';
    let stopReason: AIResponse['stopReason'] = 'end_turn';

    // Track current content for accumulation
    let currentText = '';
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

    let hasEmittedStart = false;

    for await (const chunk of this.parseSSEStream(response)) {
      const streamChunk = chunk as unknown as OpenAIStreamChunk;

      if (!messageId && streamChunk.id) {
        messageId = streamChunk.id;
      }

      const choice = streamChunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta;

      // Emit message start on first chunk
      if (!hasEmittedStart) {
        hasEmittedStart = true;
        onEvent({
          type: 'message_start',
          message: { id: messageId || `msg-${Date.now()}`, role: 'assistant' },
        });
        onEvent({
          type: 'content_block_start',
          index: 0,
          contentBlock: { type: 'text' },
        });
      }

      // Handle text content
      if (delta.content) {
        currentText += delta.content;
        onEvent({
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'text_delta',
            text: delta.content,
          },
        });
      }

      // Handle tool calls
      if (delta.tool_calls) {
        for (const toolCall of delta.tool_calls) {
          const index = toolCall.index;
          const existing = toolCalls.get(index);

          if (!existing) {
            toolCalls.set(index, {
              id: toolCall.id ?? '',
              name: toolCall.function?.name ?? '',
              arguments: toolCall.function?.arguments ?? '',
            });
          } else {
            if (toolCall.id) existing.id = toolCall.id;
            if (toolCall.function?.name) existing.name = toolCall.function.name;
            if (toolCall.function?.arguments) existing.arguments += toolCall.function.arguments;
          }
        }
      }

      // Handle finish reason
      if (choice.finish_reason) {
        stopReason = this.mapFinishReason(choice.finish_reason);
      }
    }

    // Finalize content
    onEvent({ type: 'content_block_stop', index: 0 });

    if (currentText) {
      content.push({ type: 'text', text: currentText });
    }

    // Add tool calls
    for (const [, toolCall] of toolCalls) {
      try {
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.name,
          input: JSON.parse(toolCall.arguments || '{}'),
        });
      } catch {
        this.log(`Failed to parse tool arguments: ${toolCall.arguments}`);
      }
    }

    // Map stop reason for delta event (excludes 'error')
    const deltaStopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' =
      stopReason === 'error' ? 'end_turn' : stopReason;
    onEvent({
      type: 'message_delta',
      delta: { stopReason: deltaStopReason },
    });
    onEvent({ type: 'message_stop' });

    return {
      message: {
        id: messageId || `msg-${Date.now()}`,
        role: 'assistant',
        content,
        timestamp: Date.now(),
      },
      stopReason,
    };
  }

  /**
   * Convert our messages to OpenAI format.
   */
  private convertMessages(messages: ChatMessage[], systemPrompt?: string): OpenAIMessage[] {
    const result: OpenAIMessage[] = [];

    // Add system prompt first
    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      if (msg.role === 'system') {
        // Extract text from system message
        const text = msg.content
          .filter((c): c is TextContent => c.type === 'text')
          .map((c) => c.text)
          .join('\n');
        result.push({ role: 'system', content: text });
        continue;
      }

      if (msg.role === 'tool') {
        // Tool results
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            const content = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content);
            result.push({
              role: 'tool',
              content,
              tool_call_id: block.toolUseId,
            });
          }
        }
        continue;
      }

      // User or assistant messages
      const role = msg.role === 'assistant' ? 'assistant' : 'user';

      // Check for tool calls in assistant messages
      const toolCalls = msg.content.filter(
        (c): c is ToolUseContent => c.type === 'tool_use'
      );

      // Extract text content
      const textContent = msg.content
        .filter((c): c is TextContent => c.type === 'text')
        .map((c) => c.text)
        .join('\n');

      if (toolCalls.length > 0 && role === 'assistant') {
        result.push({
          role: 'assistant',
          content: textContent || null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.input),
            },
          })),
        });
      } else {
        result.push({
          role,
          content: textContent,
        });
      }
    }

    return result;
  }

  /**
   * Convert our tools to OpenAI format.
   */
  private convertTools(tools: ToolDefinition[]): OpenAITool[] {
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: tool.inputSchema.properties,
          required: tool.inputSchema.required,
        },
      },
    }));
  }

  /**
   * Convert OpenAI response to our format.
   */
  private convertResponse(data: OpenAIResponse): AIResponse {
    const choice = data.choices[0];
    if (!choice) {
      throw new Error('No choices in response');
    }

    const content: MessageContent[] = [];

    if (choice.message.content) {
      content.push({ type: 'text', text: choice.message.content });
    }

    if (choice.message.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
        try {
          content.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: JSON.parse(toolCall.function.arguments),
          });
        } catch {
          this.log(`Failed to parse tool arguments: ${toolCall.function.arguments}`);
        }
      }
    }

    return {
      message: {
        id: data.id,
        role: 'assistant',
        content,
        timestamp: Date.now(),
      },
      stopReason: this.mapFinishReason(choice.finish_reason),
      usage: data.usage
        ? {
            inputTokens: data.usage.prompt_tokens,
            outputTokens: data.usage.completion_tokens,
          }
        : undefined,
    };
  }

  /**
   * Map OpenAI finish reason to our format.
   */
  private mapFinishReason(reason: string | null): AIResponse['stopReason'] {
    switch (reason) {
      case 'stop':
        return 'end_turn';
      case 'tool_calls':
        return 'tool_use';
      case 'length':
        return 'max_tokens';
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
registerAPIProvider('openai', (config) => new OpenAIAPIProvider(config));

/**
 * Create an OpenAI API provider instance.
 */
export function createOpenAIAPIProvider(config?: Partial<AIProviderConfig>): OpenAIAPIProvider {
  return new OpenAIAPIProvider({
    type: 'openai',
    name: 'OpenAI',
    ...config,
  });
}
