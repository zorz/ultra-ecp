/**
 * Ensemble Providers
 *
 * Direct API-based AI provider implementations for the ensemble framework.
 * These providers make HTTP requests directly to provider APIs,
 * unlike the CLI-based providers in src/services/ai/providers/.
 */

// Base types and registry
export {
  type APIProvider,
  type APIChatRequest,
  type APIProviderFactory,
  BaseAPIProvider,
  registerAPIProvider,
  createAPIProvider,
  getRegisteredAPIProviders,
} from './api-base.ts';

// Claude API provider
export {
  ClaudeAPIProvider,
  createClaudeAPIProvider,
} from './claude-api.ts';

// OpenAI API provider
export {
  OpenAIAPIProvider,
  createOpenAIAPIProvider,
} from './openai-api.ts';

// Gemini API provider
export {
  GeminiAPIProvider,
  createGeminiAPIProvider,
} from './gemini-api.ts';

// Ollama API provider
export {
  OllamaAPIProvider,
  createOllamaAPIProvider,
} from './ollama-api.ts';
