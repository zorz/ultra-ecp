/**
 * Ensemble Framework
 *
 * Multi-agent AI orchestration system.
 *
 * @example
 * ```typescript
 * import {
 *   createEnsembleOrchestrator,
 *   createFrameworkLoader,
 * } from './services/ensemble';
 *
 * // Load framework from YAML
 * const loader = createFrameworkLoader();
 * const { framework } = await loader.loadFromFile('./frameworks/cca.yaml');
 *
 * // Create orchestrator
 * const orchestrator = createEnsembleOrchestrator(framework, {
 *   tools: [...],
 * });
 *
 * // Start session
 * const session = await orchestrator.startSession('Build a REST API');
 *
 * // Subscribe to events
 * orchestrator.onEvent((event) => {
 *   console.log(event.type, event.data);
 * });
 * ```
 */

// Types
export type {
  // Framework types
  ContextSharingMode,
  ExecutionModel,
  CommunicationPattern,
  AgentRole,
  AgentDefinition,
  FrameworkValidatorDefinition,
  WorkflowCondition,
  WorkflowAction,
  WorkflowStep,
  HumanRoleConfig,
  FrameworkSettings,
  FrameworkDefinition,

  // Feed types
  FeedEntryType,
  FeedEntrySource,
  MessageFeedContent,
  ChangeFeedContent,
  ValidationFeedContent,
  CriticFeedContent,
  DecisionFeedContent,
  ActionFeedContent,
  ErrorFeedContent,
  SystemFeedContent,
  FeedEntryContent,
  FeedEntry,
  FeedFilter,
  FeedListener,

  // Session types
  EnsembleSessionState,
  PendingDecision,
  AgentStatus,
  EnsembleSession,

  // Event types
  EnsembleEventType,
  EnsembleEvent,
  EnsembleEventCallback,

  // Utility types
  Unsubscribe,
} from './types.ts';

// Constants
export {
  DEFAULT_FRAMEWORK_SETTINGS,
  DEFAULT_HUMAN_ROLE,
  generateFeedEntryId,
  generateEnsembleSessionId,
  generateDecisionId,
} from './types.ts';

// Shared Feed
export { SharedFeed, createSharedFeed } from './shared-feed.ts';
export type { SharedFeedOptions } from './shared-feed.ts';

// Agent Instance
export { AgentInstance, createAgentInstance } from './agent-instance.ts';
export type {
  ConversationContext,
  AgentResponse,
  ToolExecutionResult,
  AgentStateCallback,
  AgentInstanceOptions,
} from './agent-instance.ts';

// Orchestrator
export { EnsembleOrchestrator, createEnsembleOrchestrator } from './orchestrator.ts';
export type { OrchestratorOptions, DecisionResult } from './orchestrator.ts';

// Framework Loader
export { FrameworkLoader, createFrameworkLoader, parseFrameworkString } from './framework-loader.ts';
export type { LoadFrameworkResult, FrameworkLoaderOptions } from './framework-loader.ts';

// API Providers
export {
  BaseAPIProvider,
  createAPIProvider,
  registerAPIProvider,
  getRegisteredAPIProviders,
  ClaudeAPIProvider,
  createClaudeAPIProvider,
  OpenAIAPIProvider,
  createOpenAIAPIProvider,
  GeminiAPIProvider,
  createGeminiAPIProvider,
  OllamaAPIProvider,
  createOllamaAPIProvider,
} from './providers/index.ts';
export type {
  APIProvider,
  APIChatRequest,
  APIProviderFactory,
} from './providers/index.ts';

// CCA Framework
export {
  CCAWorkflow,
  createCCAWorkflow,
  DEFAULT_CCA_OPTIONS,
  CCASession,
  createCCASession,
  createCCATUISession,
  DEFAULT_CRITICS,
  getResumableSession,
  getRecentSessions,
} from './cca/index.ts';
export type {
  CCAWorkflowState,
  ProposedChange,
  CriticReview,
  CriticIssue,
  ArbiterDecision,
  CCAIteration,
  CCASessionState,
  CCAWorkflowOptions,
  CCAEventType,
  CCAEvent,
  CCAEventCallback,
  CCAWorkflowDependencies,
  ArbiterDecisionRequest,
  CCASessionConfig,
  CCASessionHandlers,
  CCASessionEvents,
  CCATUIConfig,
  CCATUIController,
  CriticConfig,
  RestoredSessionData,
} from './cca/index.ts';

// Tool Executor and Result Processing
export {
  ToolExecutor,
  createToolExecutor,
} from './tools/executor.ts';
export {
  ResultProcessor,
  ContextStore,
  createResultProcessor,
  createContextStore,
  DEFAULT_LIMITS,
} from './tools/result-processor.ts';
export type {
  ToolExecutionRequest,
  ToolExecutionResult as ExecutorToolResult,
  ExecutorToolDefinition,
  ToolHandler,
  PermissionPromptHandler,
  ToolExecutorConfig,
  ResultSizeLimits,
} from './tools/types.ts';
export type {
  StoredResult,
  ProcessedResult,
} from './tools/result-processor.ts';
