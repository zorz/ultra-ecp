/**
 * Ollama API Provider
 *
 * Direct API integration with local Ollama server.
 * Uses the Ollama HTTP API.
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
} from '../../ai/types.ts';

/**
 * Ollama API message format.
 */
interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  images?: string[];
}

/**
 * Ollama API response format.
 */
interface OllamaResponse {
  model: string;
  created_at: string;
  message: {
    role: string;
    content: string;
  };
  done: boolean;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

/**
 * Ollama streaming chunk format.
 */
interface OllamaStreamChunk {
  model: string;
  created_at: string;
  message?: {
    role: string;
    content: string;
  };
  done: boolean;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
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
 * Default API base URL (local Ollama server).
 */
const DEFAULT_BASE_URL = 'http://localhost:11434';

/**
 * Ollama API provider implementation.
 */
export class OllamaAPIProvider extends BaseAPIProvider {
  readonly type: AIProviderType = 'ollama';
  readonly name = 'Ollama';

  private baseUrl: string;

  constructor(config: AIProviderConfig) {
    super(config);
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
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
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async getAvailableModels(): Promise<string[]> {
    try {
      const response = await this.fetchWithRetry(
        `${this.baseUrl}/api/tags`,
        { method: 'GET' }
      );

      if (response.ok) {
        const data = await response.json() as OllamaModelList;
        const models = data.models.map((m) => m.name);
        this.log(`Fetched ${models.length} models from Ollama`);
        return models;
      }

      this.log(`Failed to fetch models: ${response.status}`);
    } catch (error) {
      this.log(`Error fetching models: ${error}`);
    }

    return [];
  }

  async chat(request: APIChatRequest): Promise<AIResponse> {
    this.currentAbortController = new AbortController();
    const combinedSignal = this.combineSignals(
      this.currentAbortController.signal,
      request.abortSignal
    );

    const model = this.config.model ?? 'llama2';
    const messages = this.convertMessages(request.messages, request.systemPrompt);

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
    };

    if (request.temperature !== undefined) {
      body.options = { temperature: request.temperature };
    }

    this.log(`Chat request to ${model}`);

    const response = await this.fetchWithRetry(
      `${this.baseUrl}/api/chat`,
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
      throw new Error(`Ollama API error ${response.status}: ${error}`);
    }

    const data = await response.json() as OllamaResponse;
    return this.convertResponse(data);
  }

  async chatStream(
    request: APIChatRequest,
    onEvent: (event: StreamEvent) => void
  ): Promise<AIResponse> {
    this.currentAbortController = new AbortController();
    const combinedSignal = this.combineSignals(
      this.currentAbortController.signal,
      request.abortSignal
    );

    const model = this.config.model ?? 'llama2';
    const messages = this.convertMessages(request.messages, request.systemPrompt);

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
    };

    if (request.temperature !== undefined) {
      body.options = { temperature: request.temperature };
    }

    this.log(`Streaming chat request to ${model}`);

    const response = await this.fetchWithRetry(
      `${this.baseUrl}/api/chat`,
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
      throw new Error(`Ollama API error ${response.status}: ${error}`);
    }

    // Parse streaming response (NDJSON)
    const content: MessageContent[] = [];
    let messageId = `msg-${Date.now()}`;
    let currentText = '';
    let inputTokens = 0;
    let outputTokens = 0;

    let hasEmittedStart = false;

    for await (const chunk of this.parseNDJSONStream(response)) {
      const streamChunk = chunk as unknown as OllamaStreamChunk;

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

      // Handle content
      if (streamChunk.message?.content) {
        currentText += streamChunk.message.content;
        onEvent({
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'text_delta',
            text: streamChunk.message.content,
          },
        });
      }

      // Handle completion
      if (streamChunk.done) {
        inputTokens = streamChunk.prompt_eval_count ?? 0;
        outputTokens = streamChunk.eval_count ?? 0;
      }
    }

    // Finalize
    onEvent({ type: 'content_block_stop', index: 0 });

    if (currentText) {
      content.push({ type: 'text', text: currentText });
    }

    onEvent({
      type: 'message_delta',
      delta: { stopReason: 'end_turn' },
    });
    onEvent({ type: 'message_stop' });

    return {
      message: {
        id: messageId,
        role: 'assistant',
        content,
        timestamp: Date.now(),
      },
      stopReason: 'end_turn',
      usage: {
        inputTokens,
        outputTokens,
      },
    };
  }

  /**
   * Convert our messages to Ollama format.
   */
  private convertMessages(messages: ChatMessage[], systemPrompt?: string): OllamaMessage[] {
    const result: OllamaMessage[] = [];

    // Add system prompt first
    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      // Map role
      let role: OllamaMessage['role'];
      if (msg.role === 'system') {
        role = 'system';
      } else if (msg.role === 'assistant') {
        role = 'assistant';
      } else {
        role = 'user';
      }

      // Extract text content
      const textParts = msg.content
        .filter((c): c is TextContent => c.type === 'text')
        .map((c) => c.text);

      const text = textParts.join('\n');

      // Extract images (base64)
      const images = msg.content
        .filter((c) => c.type === 'image')
        .map((c) => (c as { type: 'image'; data: string }).data);

      if (text || images.length > 0) {
        const message: OllamaMessage = { role, content: text };
        if (images.length > 0) {
          message.images = images;
        }
        result.push(message);
      }
    }

    return result;
  }

  /**
   * Convert Ollama response to our format.
   */
  private convertResponse(data: OllamaResponse): AIResponse {
    return {
      message: {
        id: `msg-${Date.now()}`,
        role: 'assistant',
        content: [{ type: 'text', text: data.message.content }],
        timestamp: Date.now(),
      },
      stopReason: 'end_turn',
      usage: {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
      },
    };
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

  /**
   * Pull a model from the Ollama library.
   */
  async pullModel(modelName: string): Promise<boolean> {
    try {
      const response = await this.fetchWithRetry(
        `${this.baseUrl}/api/pull`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: modelName }),
        }
      );
      return response.ok;
    } catch {
      return false;
    }
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
registerAPIProvider('ollama', (config) => new OllamaAPIProvider(config));

/**
 * Create an Ollama API provider instance.
 */
export function createOllamaAPIProvider(config?: Partial<AIProviderConfig>): OllamaAPIProvider {
  return new OllamaAPIProvider({
    type: 'ollama',
    name: 'Ollama',
    ...config,
  });
}
