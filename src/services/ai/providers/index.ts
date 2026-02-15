/**
 * AI Providers
 *
 * Exports all AI provider implementations.
 */

// Base provider interface and utilities
export {
  type AIProvider,
  type ChatCompletionRequest,
  BaseAIProvider,
  registerProvider,
  createProvider,
  getRegisteredProviders,
  type ProviderFactory,
} from './base.ts';

// Provider implementations (CLI-based)
export { ClaudeProvider, createClaudeProvider } from './claude.ts';
export { OpenAIProvider, createOpenAIProvider } from './openai.ts';
export { GeminiProvider, createGeminiProvider } from './gemini.ts';
export { OllamaProvider, createOllamaProvider } from './ollama.ts';

// HTTP API provider implementations
export { ClaudeHTTPProvider, createClaudeHTTPProvider } from './claude-http.ts';
export { OpenAIHTTPProvider, createOpenAIHTTPProvider } from './openai-http.ts';
export { GeminiHTTPProvider, createGeminiHTTPProvider } from './gemini-http.ts';

// Import CLI providers to register them
import './claude.ts';
import './openai.ts';
import './gemini.ts';
import './ollama.ts';

// Import HTTP providers to register them (these will be preferred by default)
import './claude-http.ts';
import './openai-http.ts';
import './gemini-http.ts';

import type { AIProviderConfig } from '../types.ts';
import { createClaudeHTTPProvider } from './claude-http.ts';
import { createOpenAIHTTPProvider } from './openai-http.ts';
import { createGeminiHTTPProvider } from './gemini-http.ts';
import type { AIProvider } from './base.ts';

/**
 * Create an HTTP API provider explicitly.
 * Note: createProvider() now defaults to HTTP providers when available.
 * This function is kept for backward compatibility.
 */
export function createHTTPProvider(config: AIProviderConfig): AIProvider | null {
  switch (config.type) {
    case 'claude':
      return createClaudeHTTPProvider(config);
    case 'openai':
      return createOpenAIHTTPProvider(config);
    case 'gemini':
      return createGeminiHTTPProvider(config);
    default:
      return null;
  }
}
