/**
 * AI Service
 *
 * Manages AI chat sessions, providers, and the middleware pipeline.
 * Forces AI to interact with the editor through the ECP.
 */

// Types
export * from './types.ts';

// Interface
export type { AIService } from './interface.ts';

// Implementation
export { LocalAIService, createLocalAIService } from './local.ts';

// Adapter
export { AIServiceAdapter, AIErrorCodes } from './adapter.ts';

// Providers
export {
  type AIProvider,
  type ChatCompletionRequest,
  BaseAIProvider,
  createProvider,
  getRegisteredProviders,
  ClaudeProvider,
  createClaudeProvider,
  OpenAIProvider,
  createOpenAIProvider,
  GeminiProvider,
  createGeminiProvider,
  OllamaProvider,
  createOllamaProvider,
} from './providers/index.ts';

// Framework
export {
  Pipeline,
  createPipeline,
  createValidatorMiddleware,
  createFilterMiddleware,
  createLoggerMiddleware,
  createRateLimitMiddleware,
  createApprovalMiddleware,
  createMaxLengthValidator,
  createSecretFilter,
  createPIIFilter,
  createDebugLogger,
} from './framework/index.ts';

// Tools
export {
  allECPTools,
  fileTools,
  documentTools,
  gitTools,
  terminalTools,
  lspTools,
  getToolsByCategory,
  getToolByName,
  ToolExecutor,
  createToolExecutor,
} from './tools/index.ts';
