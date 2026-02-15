/**
 * Ensemble Framework Types
 *
 * Core type definitions for the multi-agent orchestration system.
 */

import type { AIProviderType } from '../ai/types.ts';
import type { ValidationSummary, ValidationTrigger } from '../validation/types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Framework Configuration Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Context sharing mode between agents.
 */
export type ContextSharingMode = 'shared' | 'isolated';

/**
 * Execution model for agents.
 */
export type ExecutionModel = 'turn-based' | 'parallel';

/**
 * Communication pattern.
 */
export type CommunicationPattern = 'shared-feed' | 'direct' | 'hierarchical';

/**
 * Agent role in the framework.
 */
export type AgentRole = 'coder' | 'critic' | 'arbiter' | 'specialist' | 'coordinator';

/**
 * Agent definition in a framework.
 */
export interface AgentDefinition {
  /** Unique agent identifier */
  id: string;
  /** Agent role */
  role: AgentRole;
  /** AI provider to use */
  provider: AIProviderType;
  /** Model identifier */
  model: string;
  /** System prompt */
  systemPrompt: string;
  /** Available tools */
  tools: string[];
  /** API key (optional, falls back to environment) */
  apiKey?: string;
  /** Base URL (optional, for custom endpoints) */
  baseUrl?: string;
  /** Additional options */
  options?: Record<string, unknown>;
}

/**
 * Validator definition in a framework.
 */
export interface FrameworkValidatorDefinition {
  /** Unique validator identifier */
  id: string;
  /** Validator type */
  type: 'static' | 'ai-critic';
  /** AI provider (for ai-critic type) */
  provider?: AIProviderType;
  /** Model (for ai-critic type) */
  model?: string;
  /** System prompt (for ai-critic type) */
  systemPrompt?: string;
  /** Command (for static type) */
  command?: string;
  /** Validation triggers */
  triggers: ValidationTrigger[];
  /** Block on failure */
  blockOnFailure?: boolean;
}

/**
 * Workflow step condition.
 */
export type WorkflowCondition =
  | 'always'
  | 'no-consensus'
  | 'blocking-rejection'
  | 'approved'
  | 'rejected'
  | 'needs-revision';

/**
 * Workflow step action.
 */
export type WorkflowAction =
  | 'respond-to-task'
  | 'validate'
  | 'prompt-arbiter'
  | 'apply-changes'
  | 'request-feedback'
  | 'iterate';

/**
 * Workflow step definition.
 */
export interface WorkflowStep {
  /** Step identifier */
  step: string;
  /** Agent to execute (for agent steps) */
  agent?: string;
  /** Validators to run (for validation steps) */
  validators?: string[];
  /** Whether to run validators in parallel */
  parallel?: boolean;
  /** Condition for this step */
  condition?: WorkflowCondition;
  /** Action to take */
  action?: WorkflowAction;
  /** Next step if condition is met */
  next?: string;
  /** Alternative step if condition is not met */
  else?: string;
}

/**
 * Human role configuration.
 */
export interface HumanRoleConfig {
  /** Can interrupt at any time */
  canInterrupt: boolean;
  /** Can redirect the workflow */
  canRedirect: boolean;
  /** Tools that require permission */
  promptForPermission: string[];
  /** Escalate when agents disagree */
  escalateOnDisagreement: boolean;
}

/**
 * Framework settings.
 */
export interface FrameworkSettings {
  /** Context sharing mode */
  contextSharing: ContextSharingMode;
  /** Execution model */
  executionModel: ExecutionModel;
  /** Communication pattern */
  communicationPattern: CommunicationPattern;
}

/**
 * Complete framework definition.
 */
export interface FrameworkDefinition {
  /** Framework identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description */
  description: string;
  /** Settings */
  settings: FrameworkSettings;
  /** Agent definitions */
  agents: AgentDefinition[];
  /** Validator definitions */
  validators: FrameworkValidatorDefinition[];
  /** Workflow steps */
  workflow: WorkflowStep[];
  /** Human role configuration */
  humanRole: HumanRoleConfig;
}

/**
 * Default framework settings.
 */
export const DEFAULT_FRAMEWORK_SETTINGS: FrameworkSettings = {
  contextSharing: 'shared',
  executionModel: 'turn-based',
  communicationPattern: 'shared-feed',
};

/**
 * Default human role configuration.
 */
export const DEFAULT_HUMAN_ROLE: HumanRoleConfig = {
  canInterrupt: true,
  canRedirect: true,
  promptForPermission: ['write', 'bash'],
  escalateOnDisagreement: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// Feed Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Feed entry type.
 */
export type FeedEntryType =
  | 'message'
  | 'change'
  | 'validation'
  | 'critic'
  | 'decision'
  | 'action'
  | 'error'
  | 'system';

/**
 * Feed entry source.
 */
export type FeedEntrySource = 'agent' | 'human' | 'system' | 'validator' | 'critic';

/**
 * Message feed entry content.
 */
export interface MessageFeedContent {
  text: string;
  role: 'user' | 'assistant';
}

/**
 * Change feed entry content.
 */
export interface ChangeFeedContent {
  type: 'file_edit' | 'file_create' | 'file_delete' | 'command';
  path?: string;
  command?: string;
  diff?: string;
  status: 'proposed' | 'approved' | 'applied' | 'rejected';
}

/**
 * Validation feed entry content.
 */
export interface ValidationFeedContent {
  summary: ValidationSummary;
  trigger: ValidationTrigger;
}

/**
 * Critic review feed entry content.
 */
export interface CriticFeedContent {
  criticId: string;
  criticName: string;
  verdict: 'approve' | 'reject' | 'concerns' | 'error';
  message: string;
  path?: string;
  issues?: Array<{ severity: string; message: string; line?: number }>;
}

/**
 * Decision feed entry content.
 */
export interface DecisionFeedContent {
  type: 'approve' | 'reject' | 'defer' | 'redirect';
  reason?: string;
  targetId?: string;
}

/**
 * Action feed entry content.
 */
export interface ActionFeedContent {
  type: 'tool_use' | 'permission_request' | 'interrupt' | 'redirect';
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: unknown;
  description?: string;
}

/**
 * Error feed entry content.
 */
export interface ErrorFeedContent {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * System feed entry content.
 */
export interface SystemFeedContent {
  event: 'session_start' | 'session_end' | 'agent_joined' | 'agent_left' | 'workflow_step';
  details?: Record<string, unknown>;
}

/**
 * Feed entry content union type.
 */
export type FeedEntryContent =
  | MessageFeedContent
  | ChangeFeedContent
  | ValidationFeedContent
  | CriticFeedContent
  | DecisionFeedContent
  | ActionFeedContent
  | ErrorFeedContent
  | SystemFeedContent;

/**
 * A single entry in the shared feed.
 */
export interface FeedEntry {
  /** Unique entry ID */
  id: string;
  /** Entry type */
  type: FeedEntryType;
  /** Entry source */
  source: FeedEntrySource;
  /** Source agent ID (if from agent) */
  sourceId?: string;
  /** Entry content */
  content: FeedEntryContent;
  /** When this entry was created */
  timestamp: number;
  /** ID of entry this replies to */
  replyTo?: string;
  /** Metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Feed filter options.
 */
export interface FeedFilter {
  /** Filter by entry types */
  types?: FeedEntryType[];
  /** Filter by sources */
  sources?: FeedEntrySource[];
  /** Filter by source agent ID */
  sourceId?: string;
  /** Filter entries after this timestamp */
  after?: number;
  /** Filter entries before this timestamp */
  before?: number;
  /** Maximum number of entries */
  limit?: number;
}

/**
 * Feed listener callback.
 */
export type FeedListener = (entry: FeedEntry) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Session Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensemble session state.
 */
export type EnsembleSessionState =
  | 'initializing'
  | 'idle'
  | 'running'
  | 'waiting_human'
  | 'paused'
  | 'completed'
  | 'aborted'
  | 'error';

/**
 * Pending decision for human.
 */
export interface PendingDecision {
  /** Decision ID */
  id: string;
  /** Type of decision needed */
  type: 'approve' | 'reject' | 'select' | 'feedback';
  /** Human-readable prompt */
  prompt: string;
  /** Options (for select type) */
  options?: Array<{ id: string; label: string; description?: string }>;
  /** Related feed entry ID */
  feedEntryId?: string;
  /** When this was created */
  createdAt: number;
  /** Timeout (ms) */
  timeoutMs?: number;
}

/**
 * Agent status in a session.
 */
export interface AgentStatus {
  /** Agent ID */
  id: string;
  /** Agent role */
  role: AgentRole;
  /** Current state */
  state: 'idle' | 'thinking' | 'executing' | 'waiting' | 'error';
  /** Last activity timestamp */
  lastActivity: number;
  /** Current activity description */
  currentActivity?: string;
}

/**
 * Ensemble session.
 */
export interface EnsembleSession {
  /** Session ID */
  id: string;
  /** Framework being used */
  framework: FrameworkDefinition;
  /** Current state */
  state: EnsembleSessionState;
  /** Initial task/prompt */
  task: string;
  /** Agent statuses */
  agents: AgentStatus[];
  /** Pending decisions for human */
  pendingDecisions: PendingDecision[];
  /** Current workflow step */
  currentStep?: string;
  /** When session was created */
  createdAt: number;
  /** When session was last updated */
  updatedAt: number;
  /** Session metadata */
  metadata?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensemble event types.
 */
export type EnsembleEventType =
  | 'session_created'
  | 'session_updated'
  | 'session_ended'
  | 'agent_state_changed'
  | 'feed_entry_added'
  | 'decision_requested'
  | 'decision_made'
  | 'workflow_step_changed'
  | 'error';

/**
 * Ensemble event.
 */
export interface EnsembleEvent {
  type: EnsembleEventType;
  sessionId: string;
  data?: unknown;
  timestamp: number;
}

/**
 * Ensemble event callback.
 */
export type EnsembleEventCallback = (event: EnsembleEvent) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Utility Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unsubscribe function.
 */
export type Unsubscribe = () => void;

/**
 * Generate a unique feed entry ID.
 */
export function generateFeedEntryId(): string {
  return `feed-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Generate a unique session ID.
 */
export function generateEnsembleSessionId(): string {
  return `ensemble-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Generate a unique decision ID.
 */
export function generateDecisionId(): string {
  return `decision-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}
