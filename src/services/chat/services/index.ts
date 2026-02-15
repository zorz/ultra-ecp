/**
 * Chat Services Index
 *
 * Re-exports all service classes for the chat system.
 */

// Agent Manager
export {
  AgentManager,
  createAgentManager,
  type AgentManagerEvent,
  type AgentManagerEventListener,
  type AgentExecutor,
} from './AgentManager.ts';

// Context Builder
export {
  ContextBuilder,
  createContextBuilder,
  type IContextMessage,
  type IBuiltContext,
  type IBuildContextOptions,
} from './ContextBuilder.ts';

// Chat Orchestrator
export {
  ChatOrchestrator,
  createChatOrchestrator,
  type IChatOrchestratorOptions,
  type ISendMessageOptions,
  type ISendMessageResult,
  type IOrchestratorSessionOptions,
} from './ChatOrchestrator.ts';

// Compaction Service
export {
  CompactionService,
  createCompactionService,
  type IStoredCompaction,
  type ICreateCompactionOptions,
  type ICompactionSelection,
  type IBuildSummaryOptions,
} from './CompactionService.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Workflow Services (Phase 2)
// ─────────────────────────────────────────────────────────────────────────────

// Workflow Service (CRUD)
export {
  WorkflowService,
  createWorkflowService,
  type ListWorkflowsOptions,
  type UpdateWorkflowOptions,
} from './WorkflowService.ts';

// Workflow Execution Service
export {
  WorkflowExecutionService,
  createWorkflowExecutionService,
  type ListExecutionsOptions,
  type ListNodeExecutionsOptions,
  type StartExecutionResult,
} from './WorkflowExecutionService.ts';

// Context Item Service
export {
  ContextItemService,
  createContextItemService,
  type ListContextItemsOptions,
} from './ContextItemService.ts';

// Checkpoint Service
export {
  CheckpointService,
  createCheckpointService,
  type ListCheckpointsOptions,
} from './CheckpointService.ts';

// Feedback Queue Service
export {
  FeedbackQueueService,
  createFeedbackQueueService,
  type ListFeedbackOptions,
} from './FeedbackQueueService.ts';

// Workflow Permission Service
export {
  WorkflowPermissionService,
  createWorkflowPermissionService,
  type PermissionContext,
  type GrantPermissionOptions,
  type WorkflowPermission,
  type PermissionCheckResult,
} from './WorkflowPermissionService.ts';

// Workflow Executor (Orchestrator)
export {
  WorkflowExecutor,
  createWorkflowExecutor,
  type NodeContext,
  type NodeResult,
  type StartExecutionOptions,
  type ExecutionStepResult,
} from './WorkflowExecutor.ts';

// Execution Message Service (Unified Chat Model)
export {
  ExecutionMessageService,
  createExecutionMessageService,
  type ListExecutionMessagesOptions,
} from './ExecutionMessageService.ts';

// Agent Service (Agent Registry)
export {
  AgentService,
  createAgentService,
  type ListAgentsOptions,
} from './AgentService.ts';

// Workflow Tool Call Service
export {
  WorkflowToolCallService,
  createWorkflowToolCallService,
  type WorkflowToolCall,
  type ToolCallWithNode,
  type ToolCallsByNode,
  type ToolCallStatus,
  type CreateToolCallOptions,
  type ListToolCallsOptions,
} from './WorkflowToolCallService.ts';

// Review Panel Service
export {
  ReviewPanelService,
  createReviewPanelService,
} from './ReviewPanelService.ts';

// Review Panel Types
export type {
  ReviewVote,
  ReviewerVote,
  ReviewIssue,
  ReviewerConfig,
  ReviewPanelConfig,
  ReviewPanelExecution,
  PanelOutcome,
  PanelStatus,
  AggregationSummary,
  VotingStrategy,
  VotingThresholds,
  OutcomeConfig,
  CreatePanelOptions,
  AddVoteOptions,
} from '../types/review-panel.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Unified Schema Services (Phase 3 - Clean Break)
// ─────────────────────────────────────────────────────────────────────────────

// Document Service (PRDs, assessments, vulnerabilities, etc.)
export {
  DocumentService,
  createDocumentService,
  type DocumentWithChildren,
} from './DocumentService.ts';
