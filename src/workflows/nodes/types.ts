/**
 * Workflow Node System - Core Types
 *
 * A generic node-based workflow engine where any pattern (including CCA)
 * can be constructed from composable node types. This enables:
 * - Visual node editing
 * - Chat-driven workflow creation
 * - AI-generated workflows
 * - User-buildable patterns
 */

// ─────────────────────────────────────────────────────────────────────────────
// Node Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All available node types in the system.
 */
export type NodeType =
  | 'trigger'     // Entry point - starts workflow execution
  | 'agent'       // AI agent that processes/generates content
  | 'condition'   // Branches based on a condition
  | 'transform'   // Transforms data (code, template, etc.)
  | 'merge'       // Combines results from multiple branches
  | 'split'       // Runs multiple branches in parallel
  | 'loop'        // Iterates over a collection
  | 'vote'        // Collects votes from multiple agents
  | 'human'       // Requires human input/decision
  | 'output';     // Terminal node - produces final output

/**
 * Node status during execution.
 */
export type NodeStatus =
  | 'idle'        // Not yet executed
  | 'pending'     // Waiting for inputs
  | 'running'     // Currently executing
  | 'success'     // Completed successfully
  | 'error'       // Failed with error
  | 'skipped';    // Skipped (condition branch not taken)

// ─────────────────────────────────────────────────────────────────────────────
// Port Types (for connections)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Data types that can flow between nodes.
 */
export type PortDataType =
  | 'any'         // Accepts any type
  | 'text'        // Plain text
  | 'json'        // Structured JSON data
  | 'code'        // Source code
  | 'file'        // File reference
  | 'boolean'     // True/false
  | 'number'      // Numeric value
  | 'array'       // Array of items
  | 'vote';       // Vote result (pass/queue/fail)

/**
 * An input or output port on a node.
 */
export interface NodePort {
  /** Port ID (unique within the node) */
  id: string;
  /** Display name */
  name: string;
  /** Data type accepted/produced */
  dataType: PortDataType;
  /** Whether this port is required */
  required: boolean;
  /** For outputs: condition label (e.g., "yes", "no" for condition nodes) */
  condition?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Base Node Definition
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Base interface for all workflow nodes.
 */
export interface WorkflowNode {
  /** Unique node ID */
  id: string;
  /** Node type */
  type: NodeType;
  /** Display label */
  label: string;
  /** Position in visual editor */
  position: { x: number; y: number };
  /** Input ports */
  inputs: NodePort[];
  /** Output ports */
  outputs: NodePort[];
  /** Node-specific configuration */
  config: NodeConfig;
  /** Runtime status */
  status?: NodeStatus;
  /** Runtime error message */
  error?: string;
  /** Last execution output */
  lastOutput?: unknown;
  /** Execution timing */
  timing?: {
    startedAt?: Date;
    completedAt?: Date;
    durationMs?: number;
  };
}

/**
 * Node configuration varies by type.
 */
export type NodeConfig =
  | TriggerConfig
  | AgentConfig
  | ConditionConfig
  | TransformConfig
  | MergeConfig
  | SplitConfig
  | LoopConfig
  | VoteConfig
  | HumanConfig
  | OutputConfig;

// ─────────────────────────────────────────────────────────────────────────────
// Trigger Node
// ─────────────────────────────────────────────────────────────────────────────

export type TriggerType =
  | 'message'     // User sends a message
  | 'file'        // File change detected
  | 'schedule'    // Scheduled interval
  | 'webhook'     // HTTP webhook
  | 'manual';     // Manual trigger

export interface TriggerConfig {
  nodeType: 'trigger';
  triggerType: TriggerType;
  /** For schedule: cron expression */
  schedule?: string;
  /** For file: glob patterns to watch */
  filePatterns?: string[];
  /** For webhook: expected payload schema */
  webhookSchema?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Node
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentConfig {
  nodeType: 'agent';
  /** Role type from the role registry */
  roleType: string;
  /** Custom system prompt override */
  systemPrompt?: string;
  /** Model to use */
  model?: string;
  /** Temperature for generation */
  temperature?: number;
  /** Max tokens */
  maxTokens?: number;
  /** Tools enabled for this agent */
  tools?: string[];
  /** Whether to stream output */
  streaming?: boolean;
  /** Input mapping: how to construct the prompt from inputs */
  inputTemplate?: string;
  /** Output parsing: how to extract structured data from response */
  outputSchema?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Condition Node
// ─────────────────────────────────────────────────────────────────────────────

export type ConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'greater_than'
  | 'less_than'
  | 'is_empty'
  | 'is_not_empty'
  | 'matches_regex'
  | 'custom';

export interface ConditionRule {
  /** Field to check (dot notation for nested) */
  field: string;
  /** Comparison operator */
  operator: ConditionOperator;
  /** Value to compare against */
  value?: unknown;
  /** Custom expression (for 'custom' operator) */
  expression?: string;
}

export interface ConditionConfig {
  nodeType: 'condition';
  /** Condition rules (ANDed together) */
  rules: ConditionRule[];
  /** Labels for true/false branches */
  trueLabel?: string;
  falseLabel?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transform Node
// ─────────────────────────────────────────────────────────────────────────────

export type TransformType =
  | 'template'    // Handlebars-style template with conditionals, loops, helpers
  | 'jq'          // JQ-style JSON transformation
  | 'javascript'  // Safe JavaScript code evaluation
  | 'expression'  // Simple JavaScript expression (no statements)
  | 'extract'     // Extract fields from input
  | 'map'         // Map over array
  | 'mapping';    // Variable extraction with field mapping

/** Variable mapping for 'mapping' transform type */
export interface VariableMappingConfig {
  /** Source path (dot notation) */
  from: string;
  /** Destination path (dot notation) */
  to: string;
  /** Optional transform to apply */
  transform?: 'string' | 'number' | 'boolean' | 'json' | 'uppercase' | 'lowercase' | 'trim';
  /** Default value if source is undefined */
  default?: unknown;
}

export interface TransformConfig {
  nodeType: 'transform';
  transformType: TransformType;
  /** Template string (for 'template') - Handlebars-style with {{#if}}, {{#each}}, helpers */
  template?: string;
  /** JQ expression (for 'jq') */
  jqExpression?: string;
  /** JavaScript code (for 'javascript') */
  code?: string;
  /** JavaScript expression (for 'expression') */
  expression?: string;
  /** Fields to extract (for 'extract') */
  fields?: string[];
  /** Map expression (for 'map') */
  mapExpression?: string;
  /** Variable mappings (for 'mapping') */
  mappings?: VariableMappingConfig[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge Node
// ─────────────────────────────────────────────────────────────────────────────

export type MergeStrategy =
  | 'wait_all'     // Wait for all inputs
  | 'wait_any'     // Continue when any input arrives
  | 'concatenate'  // Combine all results into array
  | 'object'       // Combine into object with named keys
  | 'custom';      // Custom merge logic

export interface MergeConfig {
  nodeType: 'merge';
  strategy: MergeStrategy;
  /** For 'wait_all': timeout before continuing anyway */
  timeoutMs?: number;
  /** For 'object': mapping of input port to output key */
  keyMapping?: Record<string, string>;
  /** Custom merge code */
  customCode?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Split Node
// ─────────────────────────────────────────────────────────────────────────────

export type SplitStrategy =
  | 'parallel'     // Run all branches in parallel
  | 'round_robin'  // Distribute items round-robin
  | 'broadcast';   // Send same data to all branches

export interface SplitConfig {
  nodeType: 'split';
  strategy: SplitStrategy;
  /** Number of parallel branches */
  branchCount?: number;
  /** Maximum concurrent executions */
  maxConcurrency?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loop Node
// ─────────────────────────────────────────────────────────────────────────────

export type LoopType =
  | 'for_each'     // Iterate over array
  | 'while'        // Loop while condition true
  | 'times';       // Loop N times

export interface LoopConfig {
  nodeType: 'loop';
  loopType: LoopType;
  /** For 'for_each': field containing array */
  arrayField?: string;
  /** For 'while': condition to check */
  condition?: ConditionRule;
  /** For 'times': number of iterations */
  count?: number;
  /** Maximum iterations (safety limit) */
  maxIterations?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vote Node (for CCA-style patterns)
// ─────────────────────────────────────────────────────────────────────────────

export type VoteType = 'pass' | 'queue' | 'fail';

export interface VoteConfig {
  nodeType: 'vote';
  /** Vote options available */
  voteOptions: VoteType[];
  /** Threshold for majority (0-1) */
  threshold: number;
  /** How to handle ties */
  tieBreaker: 'first' | 'random' | 'escalate';
  /** Field in input containing the vote */
  voteField: string;
  /** Field containing vote reasoning */
  reasonField?: string;
  /** Field containing voter ID */
  voterField?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Human Node (for Arbiter-style patterns)
// ─────────────────────────────────────────────────────────────────────────────

export interface HumanChoice {
  id: string;
  label: string;
  description?: string;
}

export interface HumanConfig {
  nodeType: 'human';
  /** Prompt to show the human */
  prompt: string;
  /** Available choices */
  choices: HumanChoice[];
  /** Whether free-text input is allowed */
  allowFreeText?: boolean;
  /** Timeout before auto-selecting default */
  timeoutMs?: number;
  /** Default choice if timeout */
  defaultChoice?: string;
  /** Context to show (fields from input) */
  contextFields?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Output Node
// ─────────────────────────────────────────────────────────────────────────────

export type OutputDestination =
  | 'chat'         // Send to chat UI
  | 'file'         // Write to file
  | 'webhook'      // POST to webhook
  | 'variable'     // Store in workflow variable
  | 'log';         // Log only (for debugging)

export interface OutputConfig {
  nodeType: 'output';
  destination: OutputDestination;
  /** For 'chat': message format template */
  messageTemplate?: string;
  /** For 'file': file path template */
  filePath?: string;
  /** For 'webhook': URL and headers */
  webhookUrl?: string;
  webhookHeaders?: Record<string, string>;
  /** For 'variable': variable name */
  variableName?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Edges (Connections)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A connection between two nodes.
 */
export interface WorkflowEdge {
  /** Unique edge ID */
  id: string;
  /** Source node ID */
  sourceNodeId: string;
  /** Source port ID */
  sourcePortId: string;
  /** Target node ID */
  targetNodeId: string;
  /** Target port ID */
  targetPortId: string;
  /** Optional label (for condition branches) */
  label?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow Definition
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Complete workflow definition (the graph).
 */
export interface WorkflowDefinition {
  /** Workflow ID */
  id: string;
  /** Display name */
  name: string;
  /** Description */
  description?: string;
  /** Version */
  version: string;
  /** All nodes in the workflow */
  nodes: WorkflowNode[];
  /** All edges connecting nodes */
  edges: WorkflowEdge[];
  /** Workflow-level variables */
  variables?: Record<string, unknown>;
  /** Metadata */
  metadata?: {
    author?: string;
    createdAt?: Date;
    updatedAt?: Date;
    tags?: string[];
    /** Template this was created from */
    templateId?: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow Instance (Runtime)
// ─────────────────────────────────────────────────────────────────────────────

export type WorkflowStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'waiting_human'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Runtime instance of a workflow execution.
 */
export interface WorkflowInstance {
  /** Instance ID */
  id: string;
  /** Workflow definition ID */
  workflowId: string;
  /** Current status */
  status: WorkflowStatus;
  /** Node states (keyed by node ID) */
  nodeStates: Record<string, NodeState>;
  /** Data flowing through the workflow */
  data: Record<string, unknown>;
  /** Execution history */
  history: ExecutionStep[];
  /** When started */
  startedAt: Date;
  /** When completed/failed */
  completedAt?: Date;
  /** Final output (if completed) */
  output?: unknown;
  /** Error (if failed) */
  error?: string;
}

/**
 * State of a single node during execution.
 */
export interface NodeState {
  nodeId: string;
  status: NodeStatus;
  inputs: Record<string, unknown>;
  output?: unknown;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  /** Number of times this node has executed (for loops) */
  executionCount: number;
}

/**
 * A single step in the execution history.
 */
export interface ExecutionStep {
  /** Step ID */
  id: string;
  /** Node that executed */
  nodeId: string;
  /** Node label (for display) */
  nodeLabel: string;
  /** What happened */
  action: 'started' | 'completed' | 'failed' | 'skipped' | 'waiting';
  /** Timestamp */
  timestamp: Date;
  /** Input data */
  input?: unknown;
  /** Output data */
  output?: unknown;
  /** Error message */
  error?: string;
  /** Duration */
  durationMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Events emitted during workflow execution.
 */
export type WorkflowEvent =
  | { type: 'workflow:started'; instance: WorkflowInstance }
  | { type: 'workflow:completed'; instance: WorkflowInstance; output: unknown }
  | { type: 'workflow:failed'; instance: WorkflowInstance; error: string }
  | { type: 'workflow:paused'; instance: WorkflowInstance }
  | { type: 'workflow:resumed'; instance: WorkflowInstance }
  | { type: 'workflow:cancelled'; instance: WorkflowInstance }
  | { type: 'node:started'; nodeId: string; nodeLabel: string; input: unknown }
  | { type: 'node:progress'; nodeId: string; content: string; accumulated: string }
  | { type: 'node:completed'; nodeId: string; nodeLabel: string; output: unknown; durationMs: number }
  | { type: 'node:failed'; nodeId: string; nodeLabel: string; error: string }
  | { type: 'node:skipped'; nodeId: string; nodeLabel: string; reason: string }
  | { type: 'human:requested'; nodeId: string; prompt: string; choices: HumanChoice[] }
  | { type: 'human:responded'; nodeId: string; choice: string; freeText?: string }
  | { type: 'vote:cast'; nodeId: string; voterId: string; vote: VoteType; reason?: string }
  | { type: 'vote:tallied'; nodeId: string; tally: Record<VoteType, number>; outcome: VoteType };

/**
 * Event handler type.
 */
export type WorkflowEventHandler = (event: WorkflowEvent) => void;
