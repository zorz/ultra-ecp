/**
 * Workflow Schema Types
 *
 * TypeScript interfaces matching the workflow database schema.
 * These types are used by the workflow services and stores.
 */

// ============================================================================
// Enums and Literal Types
// ============================================================================

/** Source type for workflow definitions */
export type WorkflowSourceType = 'file' | 'inline';

/** Trigger types for workflows */
export type WorkflowTriggerType = 'manual' | 'on_message' | 'on_file_change' | 'scheduled';

/** Execution status */
export type ExecutionStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'awaiting_input'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Node execution status */
export type NodeExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/** Node types in a workflow */
export type NodeType =
  | 'router'
  | 'agent'
  | 'permission_gate'
  | 'checkpoint'
  | 'decision'
  | 'await_input'
  | 'review_panel'
  | 'trigger'
  | 'condition'
  | 'transform'
  | 'merge'
  | 'split'
  | 'loop'
  | 'vote'
  | 'human'
  | 'output';

/** Context item types */
export type ContextItemType =
  | 'user_input'
  | 'agent_output'
  | 'system'
  | 'tool_call'
  | 'tool_result'
  | 'feedback'
  | 'compaction';

/** Message roles for API compatibility */
export type MessageRole = 'user' | 'assistant' | 'system';

/** Feedback vote types (CCA) */
export type FeedbackVote = 'critical' | 'queue' | 'approve';

/** Feedback status */
export type FeedbackStatus = 'pending' | 'addressed' | 'queued' | 'dismissed';

/** Tool call status */
export type ToolCallStatus =
  | 'pending'
  | 'awaiting_permission'
  | 'approved'
  | 'denied'
  | 'running'
  | 'success'
  | 'error';

/** Permission scope */
export type PermissionScope = 'once' | 'execution' | 'workflow' | 'project' | 'global';

/** Permission decision */
export type PermissionDecision = 'approved' | 'denied';

/** Checkpoint types */
export type CheckpointType = 'approval' | 'arbiter' | 'input_required' | 'confirmation';

/** Feedback queue status */
export type FeedbackQueueStatus = 'queued' | 'pending_review' | 'addressed' | 'dismissed';

/** Surface trigger for feedback */
export type SurfaceTrigger = 'task_complete' | 'iteration_end' | 'manual' | 'immediate';

/** Message role in execution context (unified chat model) */
export type ExecutionMessageRole = 'user' | 'agent' | 'system';

/** Agent role types */
export type AgentRole = 'primary' | 'specialist' | 'reviewer' | 'orchestrator';

// ============================================================================
// Agent Types
// ============================================================================

/**
 * Stored agent definition (matches database schema).
 */
export interface StoredAgent {
  id: string;
  name: string;
  description: string | null;
  role: AgentRole;
  provider: string;
  model: string;
  system_prompt: string | null;
  tools: string | null;
  persona: string | null;
  persona_id: string | null;
  agency: string | null;      // JSON: AgentAgency
  is_system: number;
  is_active: number;
  created_at: number;
  updated_at: number | null;
}

/**
 * Agent definition with parsed fields.
 */
export interface Agent {
  id: string;
  name: string;
  description: string | null;
  role: AgentRole;
  provider: string;
  model: string;
  systemPrompt: string | null;
  tools: string[] | null;
  persona: AgentPersona | null;
  personaId: string | null;
  agency: AgentAgency | null;
  isSystem: boolean;
  isActive: boolean;
  createdAt: number;
  updatedAt: number | null;
}

/**
 * Agent persona for visual display (legacy).
 */
export interface AgentPersona {
  avatar?: string;
  color?: string;
}

// ============================================================================
// Persona Types (structured persona pipeline)
// ============================================================================

/** Pipeline status for persona development stages */
export type PersonaPipelineStatus =
  | 'draft' | 'sketched' | 'archetyped' | 'principled'
  | 'flavored' | 'compressed' | 'published';

/** Stored persona definition (matches database schema). */
export interface StoredPersona {
  id: string;
  name: string;
  description: string | null;
  problem_space: string | null;   // JSON
  high_level: string | null;      // JSON
  archetype: string | null;       // JSON
  principles: string | null;      // JSON
  taste: string | null;           // JSON
  compressed: string | null;      // Final text for system prompt
  pipeline_status: PersonaPipelineStatus;
  avatar: string | null;
  color: string | null;
  is_system: number;
  created_at: number;
  updated_at: number | null;
}

/** Persona definition with parsed fields. */
export interface Persona {
  id: string;
  name: string;
  description: string | null;
  problemSpace: PersonaProblemSpace | null;
  highLevel: PersonaHighLevel | null;
  archetype: PersonaArchetype | null;
  principles: PersonaPrinciples | null;
  taste: PersonaTaste | null;
  compressed: string | null;
  pipelineStatus: PersonaPipelineStatus;
  avatar: string | null;
  color: string | null;
  isSystem: boolean;
  createdAt: number;
  updatedAt: number | null;
}

// Pipeline stage sub-types
export interface PersonaProblemSpace {
  domain: string;
  challenges: string[];
  targetAudience: string;
  context: string;
}
export interface PersonaHighLevel {
  identity: string;
  expertise: string[];
  communicationStyle: string;
  values: string[];
}
export interface PersonaArchetype {
  name: string;
  description: string;
  strengths: string[];
  blindSpots: string[];
}
export interface PersonaPrinciples {
  principles: string[];
  assumptions: string[];
  philosophy: string;
  antiPatterns: string[];
}
export interface PersonaTaste {
  tone: string;
  verbosity: 'concise' | 'moderate' | 'detailed';
  formatting: string;
  personality: string;
  examples: string[];
}

/** Options for creating a persona. */
export interface CreatePersonaOptions {
  id?: string;
  name: string;
  description?: string;
  problemSpace?: PersonaProblemSpace;
  highLevel?: PersonaHighLevel;
  archetype?: PersonaArchetype;
  principles?: PersonaPrinciples;
  taste?: PersonaTaste;
  compressed?: string;
  pipelineStatus?: PersonaPipelineStatus;
  avatar?: string;
  color?: string;
  isSystem?: boolean;
}

/** Options for updating a persona. */
export interface UpdatePersonaOptions {
  name?: string;
  description?: string | null;
  problemSpace?: PersonaProblemSpace | null;
  highLevel?: PersonaHighLevel | null;
  archetype?: PersonaArchetype | null;
  principles?: PersonaPrinciples | null;
  taste?: PersonaTaste | null;
  compressed?: string | null;
  pipelineStatus?: PersonaPipelineStatus;
  avatar?: string | null;
  color?: string | null;
}

// ============================================================================
// Agency Types (structured agent responsibilities)
// ============================================================================

/** Structured definition of what an agent does. */
export interface AgentAgency {
  roleDescription: string;
  responsibilities: string[];
  expectedOutputs: string[];
  constraints: string[];
  delegationRules: AgentDelegationRules;
}

/** Delegation rules within an agency definition. */
export interface AgentDelegationRules {
  canDelegate: boolean;
  delegationCriteria: string[];
  preferredDelegates: string[];
  escalationPolicy: string;
}

/**
 * Options for creating an agent.
 */
export interface CreateAgentOptions {
  id?: string;
  name: string;
  description?: string;
  role?: AgentRole;
  provider?: string;
  model?: string;
  systemPrompt?: string;
  tools?: string[];
  persona?: AgentPersona;
  personaId?: string;
  agency?: AgentAgency;
  isSystem?: boolean;
  isActive?: boolean;
}

/**
 * Options for updating an agent.
 */
export interface UpdateAgentOptions {
  name?: string;
  description?: string | null;
  role?: AgentRole;
  provider?: string;
  model?: string;
  systemPrompt?: string | null;
  tools?: string[] | null;
  persona?: AgentPersona | null;
  personaId?: string | null;
  agency?: AgentAgency | null;
  isActive?: boolean;
}

// ============================================================================
// Stored Types (match database schema)
// ============================================================================

/**
 * Stored workflow definition.
 */
export interface StoredWorkflow {
  id: string;
  name: string;
  description: string | null;
  source_type: WorkflowSourceType;
  source_path: string | null;
  definition: string | null;
  trigger_type: WorkflowTriggerType | null;
  trigger_config: string | null;
  is_system: number;
  is_default: number;
  agent_pool: string | null;
  default_agent_id: string | null;
  created_at: number;
  updated_at: number | null;
}

/**
 * Stored workflow execution.
 */
export interface StoredWorkflowExecution {
  id: string;
  workflow_id: string;
  workflow_name?: string | null;
  chat_session_id: string | null;
  status: ExecutionStatus;
  current_node_id: string | null;
  iteration_count: number;
  max_iterations: number;
  initial_input: string | null;
  final_output: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number | null;
  completed_at: number | null;
}

/**
 * Stored node execution.
 */
export interface StoredNodeExecution {
  id: string;
  execution_id: string;
  node_id: string;
  node_type: NodeType;
  status: NodeExecutionStatus;
  iteration_number: number;
  input: string | null;
  output: string | null;
  agent_id: string | null;
  agent_name: string | null;
  started_at: number | null;
  completed_at: number | null;
  duration_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
}

/**
 * Stored context item.
 */
export interface StoredContextItem {
  id: string;
  execution_id: string;
  node_execution_id: string | null;
  item_type: ContextItemType;
  role: MessageRole | null;
  content: string;
  agent_id: string | null;
  agent_name: string | null;
  agent_role: string | null;
  feedback_source_agent_id: string | null;
  feedback_target_agent_id: string | null;
  feedback_vote: FeedbackVote | null;
  feedback_status: FeedbackStatus | null;
  iteration_number: number;
  is_active: number;
  compacted_into_id: string | null;
  tokens: number | null;
  is_complete: number;
  created_at: number;
}

/**
 * Stored workflow tool call.
 */
export interface StoredWorkflowToolCall {
  id: string;
  execution_id: string;
  node_execution_id: string | null;
  context_item_id: string | null;
  tool_name: string;
  input: string | null;
  output: string | null;
  status: ToolCallStatus;
  error_message: string | null;
  started_at: number | null;
  completed_at: number | null;
}

/**
 * Stored workflow permission.
 */
export interface StoredWorkflowPermission {
  id: string;
  execution_id: string | null;
  workflow_id: string | null;
  tool_name: string;
  pattern: string | null;
  scope: PermissionScope;
  decision: PermissionDecision;
  granted_at: number;
  expires_at: number | null;
}

/**
 * Stored checkpoint.
 */
export interface StoredCheckpoint {
  id: string;
  execution_id: string;
  node_execution_id: string | null;
  checkpoint_type: CheckpointType;
  prompt_message: string | null;
  options: string | null;
  decision: string | null;
  feedback: string | null;
  created_at: number;
  decided_at: number | null;
}

/**
 * Stored feedback queue item.
 */
export interface StoredFeedbackQueueItem {
  id: string;
  execution_id: string;
  context_item_id: string;
  status: FeedbackQueueStatus;
  priority: number;
  surface_trigger: SurfaceTrigger;
  queued_at: number;
  surfaced_at: number | null;
  resolved_at: number | null;
}

/**
 * Stored execution message.
 */
export interface StoredExecutionMessage {
  id: string;
  execution_id: string;
  role: ExecutionMessageRole;
  agent_id: string | null;
  agent_name: string | null;
  content: string;
  node_execution_id: string | null;
  is_complete: number;
  created_at: number;
}

// ============================================================================
// Domain Types (used in application code)
// ============================================================================

/**
 * Workflow definition with parsed fields.
 */
export interface Workflow {
  id: string;
  name: string;
  description: string | null;
  sourceType: WorkflowSourceType;
  sourcePath: string | null;
  definition: WorkflowDefinition | null;
  triggerType: WorkflowTriggerType | null;
  triggerConfig: TriggerConfig | null;
  isSystem: boolean;
  isDefault: boolean;
  agentPool: string[] | null;
  defaultAgentId: string | null;
  createdAt: number;
  updatedAt: number | null;
}

/**
 * Workflow definition structure (parsed from YAML/JSON).
 */
export interface WorkflowDefinition {
  name: string;
  description?: string;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  on_error?: 'fail' | 'retry' | 'continue';
  max_iterations?: number;
  /** Default tools allowed for all nodes in this workflow */
  defaultAllowedTools?: string[];
  /** Tools explicitly denied for all nodes */
  defaultDeniedTools?: string[];
}

/**
 * Workflow trigger configuration.
 */
export interface WorkflowTrigger {
  type: WorkflowTriggerType;
  config?: TriggerConfig;
}

/**
 * Trigger-specific configuration.
 */
export interface TriggerConfig {
  /** For on_file_change: file patterns to watch */
  patterns?: string[];
  /** For scheduled: cron expression */
  cron?: string;
  /** For on_message: keywords to trigger */
  keywords?: string[];
}

/**
 * Workflow step definition.
 */
export interface WorkflowStep {
  id: string;
  type?: NodeType;
  agent?: string;
  action?: string;
  prompt?: string;
  depends?: string[];
  checkpoint?: boolean;
  checkpointMessage?: string;
  /** Tools this node is allowed to use (overrides workflow defaults) */
  allowedTools?: string[];
  /** Tools this node is explicitly denied (overrides workflow defaults) */
  deniedTools?: string[];
  /** Question or prompt for review panels (what should reviewers evaluate) */
  reviewQuestion?: string;
  /** Merge strategy for merge nodes: 'wait_all' (default) or 'wait_any' */
  mergeStrategy?: 'wait_all' | 'wait_any';
  /** Loop type for loop nodes: 'for_each', 'while', or 'times' */
  loopType?: 'for_each' | 'while' | 'times';
  /** Array field to iterate over (for for_each loops) */
  loopArrayField?: string;
  /** Maximum iterations for loops */
  loopMaxIterations?: number;
  /** Parallel limit for split nodes (0 = unlimited) */
  parallelLimit?: number;
}

/**
 * Workflow execution with parsed fields.
 */
export interface WorkflowExecution {
  id: string;
  workflowId: string;
  workflowName: string | null;
  chatSessionId: string | null;
  status: ExecutionStatus;
  currentNodeId: string | null;
  iterationCount: number;
  maxIterations: number;
  initialInput: unknown;
  finalOutput: unknown;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number | null;
  completedAt: number | null;
}

/**
 * Node execution with parsed fields.
 */
export interface NodeExecution {
  id: string;
  executionId: string;
  nodeId: string;
  nodeType: NodeType;
  status: NodeExecutionStatus;
  iterationNumber: number;
  input: unknown;
  output: unknown;
  agentId: string | null;
  agentName: string | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
}

/**
 * Context item with parsed fields.
 */
export interface ContextItem {
  id: string;
  executionId: string;
  nodeExecutionId: string | null;
  itemType: ContextItemType;
  role: MessageRole | null;
  content: string;
  agentId: string | null;
  agentName: string | null;
  agentRole: string | null;
  feedbackSourceAgentId: string | null;
  feedbackTargetAgentId: string | null;
  feedbackVote: FeedbackVote | null;
  feedbackStatus: FeedbackStatus | null;
  iterationNumber: number;
  isActive: boolean;
  compactedIntoId: string | null;
  tokens: number | null;
  isComplete: boolean;
  createdAt: number;
}

/**
 * Checkpoint with parsed fields.
 */
export interface Checkpoint {
  id: string;
  executionId: string;
  nodeExecutionId: string | null;
  checkpointType: CheckpointType;
  promptMessage: string | null;
  options: string[] | null;
  decision: string | null;
  feedback: string | null;
  createdAt: number;
  decidedAt: number | null;
}

/**
 * Feedback queue item with parsed fields.
 */
export interface FeedbackQueueItem {
  id: string;
  executionId: string;
  contextItemId: string;
  status: FeedbackQueueStatus;
  priority: number;
  surfaceTrigger: SurfaceTrigger;
  queuedAt: number;
  surfacedAt: number | null;
  resolvedAt: number | null;
}

// ============================================================================
// Execution Messages (Unified Chat Model)
// ============================================================================

/**
 * A message in a workflow execution (unified chat model).
 * All user inputs and agent outputs are stored as messages.
 */
export interface ExecutionMessage {
  id: string;
  executionId: string;
  role: ExecutionMessageRole;
  /** Agent ID for agent messages */
  agentId: string | null;
  /** Display name for agent */
  agentName: string | null;
  /** Message content */
  content: string;
  /** Link to node execution that produced this message */
  nodeExecutionId: string | null;
  /** For streaming: whether message is complete */
  isComplete: boolean;
  /** Timestamp */
  createdAt: number;
}

/**
 * Options for creating an execution message.
 */
export interface CreateExecutionMessageOptions {
  executionId: string;
  role: ExecutionMessageRole;
  content: string;
  agentId?: string;
  agentName?: string;
  nodeExecutionId?: string;
  isComplete?: boolean;
}

// ============================================================================
// Input/Create Types
// ============================================================================

/**
 * Options for creating a workflow.
 */
export interface CreateWorkflowOptions {
  id?: string;
  name: string;
  description?: string;
  sourceType?: WorkflowSourceType;
  sourcePath?: string;
  definition?: WorkflowDefinition;
  triggerType?: WorkflowTriggerType;
  triggerConfig?: TriggerConfig;
  isSystem?: boolean;
  isDefault?: boolean;
  agentPool?: string[];
  defaultAgentId?: string;
}

/**
 * Options for starting a workflow execution.
 */
export interface StartExecutionOptions {
  workflowId: string;
  chatSessionId?: string;
  initialInput?: unknown;
  maxIterations?: number;
}

/**
 * Options for creating a context item.
 */
export interface CreateContextItemOptions {
  executionId: string;
  nodeExecutionId?: string;
  itemType: ContextItemType;
  role?: MessageRole;
  content: string;
  agentId?: string;
  agentName?: string;
  agentRole?: string;
  feedbackSourceAgentId?: string;
  feedbackTargetAgentId?: string;
  feedbackVote?: FeedbackVote;
  feedbackStatus?: FeedbackStatus;
  iterationNumber?: number;
  tokens?: number;
  isComplete?: boolean;
}

/**
 * Options for creating a checkpoint.
 */
export interface CreateCheckpointOptions {
  executionId: string;
  nodeExecutionId?: string;
  checkpointType: CheckpointType;
  promptMessage?: string;
  options?: string[];
}

/**
 * Options for queuing feedback.
 */
export interface QueueFeedbackOptions {
  executionId: string;
  contextItemId: string;
  priority?: number;
  surfaceTrigger?: SurfaceTrigger;
}
