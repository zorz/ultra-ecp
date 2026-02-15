/**
 * Base API Provider
 *
 * Abstract base class for direct API-based AI providers.
 * Unlike CLI providers, these make HTTP requests directly to provider APIs.
 */

import type {
  AIProviderType,
  AIProviderConfig,
  AIProviderCapabilities,
  ChatMessage,
  ToolDefinition,
  AIResponse,
  StreamEvent,
} from '../../ai/types.ts';
import { debugLog, isDebugEnabled } from '../../../debug.ts';
import { localSecretService } from '../../secret/local.ts';

/**
 * Request options for API chat completion.
 */
export interface APIChatRequest {
  /** Messages in the conversation */
  messages: ChatMessage[];
  /** System prompt */
  systemPrompt?: string;
  /** Available tools */
  tools?: ToolDefinition[];
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Temperature for response generation (0-1) */
  temperature?: number;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
}

/**
 * API provider interface for ensemble framework.
 */
export interface APIProvider {
  /** Provider type */
  readonly type: AIProviderType;
  /** Provider display name */
  readonly name: string;
  /** Provider configuration */
  readonly config: AIProviderConfig;

  /**
   * Get provider capabilities.
   */
  getCapabilities(): AIProviderCapabilities;

  /**
   * Check if the provider is available (API key exists).
   */
  isAvailable(): Promise<boolean>;

  /**
   * Get available models for this provider.
   */
  getAvailableModels(): Promise<string[]>;

  /**
   * Send a chat completion request.
   */
  chat(request: APIChatRequest): Promise<AIResponse>;

  /**
   * Send a streaming chat completion request.
   */
  chatStream(
    request: APIChatRequest,
    onEvent: (event: StreamEvent) => void
  ): Promise<AIResponse>;

  /**
   * Cancel the current request.
   */
  cancel(): void;
}

/**
 * Base class for API-based providers.
 */
export abstract class BaseAPIProvider implements APIProvider {
  abstract readonly type: AIProviderType;
  abstract readonly name: string;
  readonly config: AIProviderConfig;

  /** Current abort controller for cancellation */
  protected currentAbortController: AbortController | null = null;

  /** Cached API key */
  protected cachedApiKey: string | null = null;

  constructor(config: AIProviderConfig) {
    this.config = config;
  }

  protected log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[${this.constructor.name}] ${msg}`);
    }
  }

  abstract getCapabilities(): AIProviderCapabilities;
  abstract isAvailable(): Promise<boolean>;
  abstract getAvailableModels(): Promise<string[]>;
  abstract chat(request: APIChatRequest): Promise<AIResponse>;
  abstract chatStream(
    request: APIChatRequest,
    onEvent: (event: StreamEvent) => void
  ): Promise<AIResponse>;

  /**
   * Cancel the current request.
   */
  cancel(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }
  }

  /**
   * Get API key from config, cache, or secret service.
   */
  protected async getApiKey(envNames: string[]): Promise<string | null> {
    // Check config first
    if (this.config.apiKey) {
      return this.config.apiKey;
    }

    // Check cache
    if (this.cachedApiKey) {
      return this.cachedApiKey;
    }

    // Try secret service for each env name
    try {
      for (const envName of envNames) {
        const key = await localSecretService.get(envName);
        if (key) {
          this.cachedApiKey = key;
          return key;
        }
      }
    } catch {
      // Secret service not initialized or other error
      this.log('Secret service unavailable, checking environment variables');
    }

    // Fallback to environment variables
    for (const envName of envNames) {
      const key = process.env[envName];
      if (key) {
        this.cachedApiKey = key;
        return key;
      }
    }

    return null;
  }

  /**
   * Make an HTTP request with common error handling.
   */
  protected async fetchWithRetry(
    url: string,
    options: RequestInit,
    maxRetries = 3
  ): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await fetch(url, options);

        // Don't retry client errors (4xx) except rate limits
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          return response;
        }

        // Retry server errors (5xx) and rate limits
        if (response.status >= 500 || response.status === 429) {
          lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);

          // Exponential backoff
          const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
          this.log(`Retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry if aborted
        if (lastError.name === 'AbortError') {
          throw lastError;
        }

        // Exponential backoff
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        this.log(`Retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${lastError.message}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError ?? new Error('Request failed after retries');
  }

  /**
   * Parse Server-Sent Events (SSE) stream.
   */
  protected async *parseSSEStream(
    response: Response
  ): AsyncGenerator<Record<string, unknown>> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;

          if (trimmed.startsWith('data: ')) {
            const data = trimmed.slice(6);
            if (data === '[DONE]') continue;

            try {
              yield JSON.parse(data);
            } catch {
              // Not valid JSON
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Parse newline-delimited JSON stream.
   */
  protected async *parseNDJSONStream(
    response: Response
  ): AsyncGenerator<Record<string, unknown>> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            yield JSON.parse(trimmed);
          } catch {
            // Not valid JSON
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/**
 * API provider factory function.
 */
export type APIProviderFactory = (config: AIProviderConfig) => APIProvider;

/**
 * Registry for API providers.
 */
const apiProviderFactories = new Map<AIProviderType, APIProviderFactory>();

/**
 * Register an API provider factory.
 */
export function registerAPIProvider(type: AIProviderType, factory: APIProviderFactory): void {
  apiProviderFactories.set(type, factory);
}

/**
 * Create an API provider instance.
 */
export function createAPIProvider(config: AIProviderConfig): APIProvider | null {
  const factory = apiProviderFactories.get(config.type);
  if (!factory) {
    return null;
  }
  return factory(config);
}

/**
 * Get registered API provider types.
 */
export function getRegisteredAPIProviders(): AIProviderType[] {
  return Array.from(apiProviderFactories.keys());
}
