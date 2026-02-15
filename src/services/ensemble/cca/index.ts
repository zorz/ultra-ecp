/**
 * CCA Framework
 *
 * Coder-Critic-Arbiter workflow implementation.
 *
 * @example
 * ```typescript
 * import { createCCAWorkflow, DEFAULT_CCA_OPTIONS } from './cca';
 *
 * const workflow = createCCAWorkflow({
 *   coder: agentInstance,
 *   coderProvider: apiProvider,
 *   validationPipeline: pipeline,
 *   feed: sharedFeed,
 * });
 *
 * // Subscribe to events
 * workflow.onEvent((event) => {
 *   console.log(event.type, event.data);
 * });
 *
 * // Run the workflow
 * const result = await workflow.run('Build a REST API', 'session-1');
 * ```
 */

// Types
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
} from './types.ts';

// Constants
export { DEFAULT_CCA_OPTIONS } from './types.ts';

// Workflow
export {
  CCAWorkflow,
  createCCAWorkflow,
} from './workflow.ts';
export type {
  CCAWorkflowDependencies,
  ArbiterDecisionRequest,
} from './workflow.ts';

// Session
export {
  CCASession,
  createCCASession,
  DEFAULT_CRITICS,
  getResumableSession,
  getRecentSessions,
  getTaskContext,
  getFileHistory,
} from './session.ts';
export type {
  CCASessionConfig,
  CCASessionHandlers,
  CCASessionEvents,
  CriticConfig,
  CriticReviewDisplay,
  SerializedCCASession,
  RestoredSessionData,
} from './session.ts';

// TUI Integration
export {
  createCCATUISession,
} from './integration.ts';
export type {
  CCATUIConfig,
  CCATUIController,
} from './integration.ts';

// Storage
export {
  CCAStorage,
  getCCAStorage,
  closeCCAStorage,
  closeAllCCAStorage,
} from './storage.ts';
export type {
  StoredSession,
  StoredIteration,
  StoredChange,
  StoredCriticReview,
  StoredArbiterDecision,
  StoredFeedEntry,
  StoredToolExecution,
  SessionSummary,
  QueryOptions,
} from './storage.ts';
