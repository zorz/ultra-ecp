/**
 * Validation Service
 *
 * Provides validation middleware for AI interactions.
 * Supports static validators, AI critics, and hierarchical context.
 *
 * @example
 * ```typescript
 * import { createValidationPipeline } from './services/validation';
 *
 * const pipeline = createValidationPipeline();
 *
 * // Register a static validator
 * pipeline.registerValidator({
 *   id: 'typescript',
 *   name: 'TypeScript Check',
 *   type: 'static',
 *   enabled: true,
 *   priority: 10,
 *   command: 'tsc --noEmit',
 *   triggers: ['pre-write', 'pre-commit'],
 *   filePatterns: ['**\/*.ts'],
 *   behavior: {
 *     onFailure: 'error',
 *     blockOnFailure: true,
 *     required: true,
 *     timeoutMs: 60000,
 *     onTimeout: 'error',
 *     cacheable: true,
 *   },
 * });
 *
 * // Run validation
 * const summary = await pipeline.validate('pre-write', {
 *   trigger: 'pre-write',
 *   timestamp: Date.now(),
 *   files: [{ path: 'src/index.ts', content: '...' }],
 *   sessionId: 'session-123',
 * });
 * ```
 */

// Types
export type {
  // Trigger types
  ValidationTrigger,
  ValidatorType,

  // Context types
  GitStatus,
  ToolCall,
  ToolResult,
  ActionHistory,
  FileContext,
  ValidatorContextConfig,
  ValidationContext,

  // Hierarchical context types
  Pattern,
  AntiPattern,
  Convention,
  Override,
  HierarchicalContext,
  ParsedContext,

  // Result types
  ValidationStatus,
  ValidationSeverity,
  ValidationDetails,
  ValidationResult,
  OverallValidationStatus,
  ValidationSummary,

  // Validator types
  ValidatorBehavior,
  ValidatorDefinition,

  // Consensus types
  ConsensusStrategy,
  ConsensusConfig,
  ConsensusResult,

  // Pipeline types
  ExecutionModel,
  ValidationPipelineConfig,

  // Feed types
  ValidationFeedEntry,

  // Utility types
  Unsubscribe,
} from './types.ts';

// Constants
export {
  DEFAULT_CONTEXT_CONFIG,
  DEFAULT_VALIDATOR_BEHAVIOR,
  DEFAULT_CONSENSUS_CONFIG,
  DEFAULT_PIPELINE_CONFIG,
  generateValidationId,
} from './types.ts';

// Errors
export { ValidationError, ValidationErrorCode, TimeoutError } from './errors.ts';

// Cache
export { ValidationCache } from './cache.ts';
export type { ValidationCacheOptions } from './cache.ts';

// Context Parser
export { parseContextFile, extractIds, validateOverrides } from './context-parser.ts';

// Context Watcher
export { ContextWatcher, createContextWatcher } from './context-watcher.ts';
export type {
  ContextChangeEvent,
  ContextChangeCallback,
  ContextWatcherOptions,
} from './context-watcher.ts';

// Context Resolver
export { ContextResolver, createContextResolver } from './context-resolver.ts';
export type {
  ContextResolverOptions,
  ContextInvalidationEvent,
  ContextInvalidationCallback,
} from './context-resolver.ts';

// Pipeline
export { ValidationPipeline, createValidationPipeline } from './pipeline.ts';

// Static Validators
export {
  runStaticValidator,
  createTypeScriptValidator,
  createESLintValidator,
  createTestValidator,
  createFormatterValidator,
  createStaticValidator,
} from './static-validator.ts';
export type {
  OutputFormat,
  ParsedOutput,
  StaticValidatorOptions,
} from './static-validator.ts';

// AI Critics
export {
  runAICritic,
  buildCriticPrompt,
  createCodeReviewCritic,
  createSecurityCritic,
  createArchitectureCritic,
} from './ai-critic.ts';
export type { AICriticResponse, AICriticConfig } from './ai-critic.ts';

// Configuration Loader
export { ConfigLoader, createConfigLoader, parseConfigString } from './config-loader.ts';
export type {
  ValidationConfigYAML,
  ConfigChangeEvent,
  ConfigChangeCallback,
  ConfigLoaderOptions,
} from './config-loader.ts';

// Human Interaction
export {
  HumanInteractionHandler,
  createHumanInteractionHandler,
  createApprovalRequest,
} from './human-interaction.ts';
export type {
  DecisionType,
  DecisionRequest,
  DecisionResponse,
  DecisionRequestCallback,
  FeedEntryCallback,
  HumanInteractionOptions,
} from './human-interaction.ts';
