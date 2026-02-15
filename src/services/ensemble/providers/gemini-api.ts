/**
 * Gemini API Provider
 *
 * Direct API integration with Google's Gemini models.
 * Uses the Generative Language API.
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
 * Gemini API content format.
 */
interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<
    | { text: string }
    | { inlineData: { mimeType: string; data: string } }
    | { functionCall: { name: string; args: Record<string, unknown> } }
    | { functionResponse: { name: string; response: unknown } }
  >;
}

/**
 * Gemini API tool format.
 */
interface GeminiTool {
  functionDeclarations: Array<{
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties?: Record<string, unknown>;
      required?: string[];
    };
  }>;
}

/**
 * Gemini API response format.
 */
interface GeminiResponse {
  candidates: Array<{
    content: {
      role: string;
      parts: Array<
        | { text: string }
        | { functionCall: { name: string; args: Record<string, unknown> } }
      >;
    };
    finishReason: string;
    safetyRatings?: Array<{
      category: string;
      probability: string;
    }>;
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

/**
 * Gemini streaming chunk format.
 */
interface GeminiStreamChunk {
  candidates?: Array<{
    content?: {
      role?: string;
      parts?: Array<
        | { text: string }
        | { functionCall: { name: string; args: Record<string, unknown> } }
      >;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
  };
}

/**
 * Default API base URL.
 */
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Gemini API provider implementation.
 */
export class GeminiAPIProvider extends BaseAPIProvider {
  readonly type: AIProviderType = 'gemini';
  readonly name = 'Gemini';

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
      maxContextTokens: 1000000, // Gemini 1.5 Pro
      maxOutputTokens: 8192,
    };
  }

  async isAvailable(): Promise<boolean> {
    const apiKey = await this.getApiKey(['GEMINI_API_KEY', 'GOOGLE_API_KEY']);
    return !!apiKey;
  }

  async getAvailableModels(): Promise<string[]> {
    const apiKey = await this.getApiKey(['GEMINI_API_KEY', 'GOOGLE_API_KEY']);
    if (!apiKey) {
      return this.getFallbackModels();
    }

    try {
      const response = await this.fetchWithRetry(
        `${this.baseUrl}/models?key=${apiKey}&pageSize=100`,
        { method: 'GET' }
      );

      if (response.ok) {
        const data = await response.json() as {
          models: Array<{ name: string; displayName: string }>;
        };
        const models = data.models
          .map((m) => m.name.replace('models/', ''))
          .filter((name) => name.startsWith('gemini'))
          .sort()
          .reverse();
        this.log(`Fetched ${models.length} Gemini models from API`);
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
    const models = registry.getProviderModelIds('google');
    if (models.length > 0) {
      return models;
    }
    return [
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-1.5-pro',
      'gemini-1.5-flash',
      'gemini-1.0-pro',
    ];
  }

  async chat(request: APIChatRequest): Promise<AIResponse> {
    const apiKey = await this.getApiKey(['GEMINI_API_KEY', 'GOOGLE_API_KEY']);
    if (!apiKey) {
      throw new Error('Gemini API key not found');
    }

    this.currentAbortController = new AbortController();
    const combinedSignal = this.combineSignals(
      this.currentAbortController.signal,
      request.abortSignal
    );

    const registry = getModelRegistry();
    const defaultModel = registry.getProviderDefaultId('google') || 'gemini-1.5-flash';
    const model = this.config.model ?? defaultModel;
    const contents = this.convertMessages(request.messages);
    const tools = request.tools ? this.convertTools(request.tools) : undefined;

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? 8192,
      },
    };

    if (request.systemPrompt) {
      body.systemInstruction = { parts: [{ text: request.systemPrompt }] };
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    if (request.temperature !== undefined) {
      (body.generationConfig as Record<string, unknown>).temperature = request.temperature;
    }

    this.log(`Chat request to ${model}`);

    const response = await this.fetchWithRetry(
      `${this.baseUrl}/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${error}`);
    }

    const data = await response.json() as GeminiResponse;
    return this.convertResponse(data);
  }

  async chatStream(
    request: APIChatRequest,
    onEvent: (event: StreamEvent) => void
  ): Promise<AIResponse> {
    const apiKey = await this.getApiKey(['GEMINI_API_KEY', 'GOOGLE_API_KEY']);
    if (!apiKey) {
      throw new Error('Gemini API key not found');
    }

    this.currentAbortController = new AbortController();
    const combinedSignal = this.combineSignals(
      this.currentAbortController.signal,
      request.abortSignal
    );

    const registry = getModelRegistry();
    const defaultModel = registry.getProviderDefaultId('google') || 'gemini-1.5-flash';
    const model = this.config.model ?? defaultModel;
    const contents = this.convertMessages(request.messages);
    const tools = request.tools ? this.convertTools(request.tools) : undefined;

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? 8192,
      },
    };

    if (request.systemPrompt) {
      body.systemInstruction = { parts: [{ text: request.systemPrompt }] };
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    if (request.temperature !== undefined) {
      (body.generationConfig as Record<string, unknown>).temperature = request.temperature;
    }

    this.log(`Streaming chat request to ${model}`);

    const response = await this.fetchWithRetry(
      `${this.baseUrl}/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${error}`);
    }

    // Parse streaming response
    const content: MessageContent[] = [];
    let messageId = `msg-${Date.now()}`;
    let stopReason: AIResponse['stopReason'] = 'end_turn';
    let inputTokens = 0;
    let outputTokens = 0;

    let currentText = '';
    let hasEmittedStart = false;
    let toolCallCounter = 0;

    for await (const chunk of this.parseSSEStream(response)) {
      const streamChunk = chunk as GeminiStreamChunk;

      // Emit message start on first chunk
      if (!hasEmittedStart) {
        hasEmittedStart = true;
        onEvent({
          type: 'message_start',
          message: { id: messageId, role: 'assistant' },
        });
        onEvent({
          type: 'content_block_start',
          index: 0,
          contentBlock: { type: 'text' },
        });
      }

      // Process candidates
      const candidate = streamChunk.candidates?.[0];
      if (candidate?.content?.parts) {
        for (const part of candidate.content.parts) {
          if ('text' in part && part.text) {
            const newText = part.text;
            currentText += newText;
            onEvent({
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'text_delta',
                text: newText,
              },
            });
          } else if ('functionCall' in part) {
            // Function call
            const toolId = `tool-${++toolCallCounter}`;
            content.push({
              type: 'tool_use',
              id: toolId,
              name: part.functionCall.name,
              input: part.functionCall.args,
            });
            stopReason = 'tool_use';
          }
        }
      }

      // Handle finish reason
      if (candidate?.finishReason) {
        stopReason = this.mapFinishReason(candidate.finishReason);
      }

      // Handle usage metadata
      if (streamChunk.usageMetadata) {
        inputTokens = streamChunk.usageMetadata.promptTokenCount ?? inputTokens;
        outputTokens = streamChunk.usageMetadata.candidatesTokenCount ?? outputTokens;
      }
    }

    // Finalize
    onEvent({ type: 'content_block_stop', index: 0 });

    if (currentText) {
      content.push({ type: 'text', text: currentText });
    }

    onEvent({
      type: 'message_delta',
      delta: { stopReason: stopReason === 'tool_use' ? 'tool_use' : 'end_turn' },
    });
    onEvent({ type: 'message_stop' });

    return {
      message: {
        id: messageId,
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
   * Convert our messages to Gemini format.
   */
  private convertMessages(messages: ChatMessage[]): GeminiContent[] {
    const result: GeminiContent[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        // System messages go in systemInstruction
        continue;
      }

      const role = msg.role === 'assistant' ? 'model' : 'user';
      const parts: GeminiContent['parts'] = [];

      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push({ text: block.text });
        } else if (block.type === 'image') {
          parts.push({
            inlineData: {
              mimeType: block.mediaType,
              data: block.data,
            },
          });
        } else if (block.type === 'tool_use') {
          parts.push({
            functionCall: {
              name: block.name,
              args: block.input,
            },
          });
        } else if (block.type === 'tool_result') {
          parts.push({
            functionResponse: {
              name: block.toolUseId, // Gemini uses name, but we store toolUseId
              response: block.content,
            },
          });
        }
      }

      if (parts.length > 0) {
        result.push({ role, parts });
      }
    }

    return result;
  }

  /**
   * Convert our tools to Gemini format.
   */
  private convertTools(tools: ToolDefinition[]): GeminiTool[] {
    return [{
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: tool.inputSchema.properties,
          required: tool.inputSchema.required,
        },
      })),
    }];
  }

  /**
   * Convert Gemini response to our format.
   */
  private convertResponse(data: GeminiResponse): AIResponse {
    const candidate = data.candidates[0];
    if (!candidate) {
      throw new Error('No candidates in response');
    }

    const content: MessageContent[] = [];
    let toolCallCounter = 0;

    for (const part of candidate.content.parts) {
      if ('text' in part) {
        content.push({ type: 'text', text: part.text });
      } else if ('functionCall' in part) {
        const toolId = `tool-${++toolCallCounter}`;
        content.push({
          type: 'tool_use',
          id: toolId,
          name: part.functionCall.name,
          input: part.functionCall.args,
        });
      }
    }

    const hasToolUse = content.some((c) => c.type === 'tool_use');

    return {
      message: {
        id: `msg-${Date.now()}`,
        role: 'assistant',
        content,
        timestamp: Date.now(),
      },
      stopReason: hasToolUse ? 'tool_use' : this.mapFinishReason(candidate.finishReason),
      usage: data.usageMetadata
        ? {
            inputTokens: data.usageMetadata.promptTokenCount,
            outputTokens: data.usageMetadata.candidatesTokenCount,
          }
        : undefined,
    };
  }

  /**
   * Map Gemini finish reason to our format.
   */
  private mapFinishReason(reason: string): AIResponse['stopReason'] {
    switch (reason) {
      case 'STOP':
        return 'end_turn';
      case 'MAX_TOKENS':
        return 'max_tokens';
      case 'SAFETY':
      case 'RECITATION':
      case 'OTHER':
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
registerAPIProvider('gemini', (config) => new GeminiAPIProvider(config));

/**
 * Create a Gemini API provider instance.
 */
export function createGeminiAPIProvider(config?: Partial<AIProviderConfig>): GeminiAPIProvider {
  return new GeminiAPIProvider({
    type: 'gemini',
    name: 'Gemini',
    ...config,
  });
}
