/**
 * Agent State Management
 *
 * Handles persistence and retrieval of agent state across workflow runs.
 * Agents are first-class citizens that maintain identity and memory.
 */

// ─────────────────────────────────────────────────────────────────────────────
// State Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runtime status of an agent.
 */
export type AgentRuntimeStatus =
  | 'idle'
  | 'thinking'
  | 'executing'
  | 'waiting'
  | 'error'
  | 'completed';

/**
 * Memory entry for agent context.
 */
export interface MemoryEntry {
  /** Unique entry ID */
  id: string;
  /** When this memory was created */
  timestamp: Date;
  /** Type of memory (conversation, observation, decision, etc.) */
  type: 'conversation' | 'observation' | 'decision' | 'feedback' | 'learning';
  /** The actual content */
  content: string;
  /** Associated metadata */
  metadata?: Record<string, unknown>;
  /** Relevance score for retrieval (0-1) */
  relevance?: number;
  /** Source agent or workflow */
  source?: string;
}

/**
 * Agent's working memory (short-term, current execution).
 */
export interface WorkingMemory {
  /** Current task context */
  currentTask?: string;
  /** Recent messages (limited window) */
  recentMessages: MemoryEntry[];
  /** Intermediate results */
  scratchpad: Record<string, unknown>;
  /** Active goals/objectives */
  activeGoals: string[];
}

/**
 * Agent's long-term memory (persisted across runs).
 */
export interface LongTermMemory {
  /** Key learnings and insights */
  learnings: MemoryEntry[];
  /** Important decisions made */
  decisions: MemoryEntry[];
  /** Feedback received */
  feedback: MemoryEntry[];
  /** Domain-specific knowledge */
  domainKnowledge: Record<string, MemoryEntry[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent State
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Complete agent state (persisted).
 */
export interface AgentPersistentState {
  /** Agent instance ID */
  agentId: string;
  /** Role type identifier */
  roleType: string;
  /** When this agent was created */
  createdAt: Date;
  /** Last activity timestamp */
  lastActiveAt: Date;
  /** Number of workflow runs participated in */
  runCount: number;
  /** Long-term memory */
  memory: LongTermMemory;
  /** Agent-specific settings/preferences */
  preferences: Record<string, unknown>;
  /** Performance metrics */
  metrics: AgentMetrics;
}

/**
 * Agent metrics for performance tracking.
 */
export interface AgentMetrics {
  /** Total tasks completed */
  tasksCompleted: number;
  /** Tasks that resulted in errors */
  tasksFailed: number;
  /** Average response time in ms */
  avgResponseTime: number;
  /** Total tokens used */
  totalTokens: number;
  /** Feedback scores received */
  feedbackScores: number[];
}

/**
 * Full runtime state (persistent + working).
 */
export interface AgentRuntimeState extends AgentPersistentState {
  /** Current runtime status */
  status: AgentRuntimeStatus;
  /** Working memory for current execution */
  workingMemory: WorkingMemory;
  /** Current error if any */
  error?: string;
  /** Parent workflow ID if in a workflow */
  workflowId?: string;
  /** Current action being performed */
  currentAction?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// State Store Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Interface for agent state persistence.
 */
export interface AgentStateStore {
  /** Load agent state by ID */
  load(agentId: string): Promise<AgentPersistentState | null>;

  /** Save agent state */
  save(state: AgentPersistentState): Promise<void>;

  /** Delete agent state */
  delete(agentId: string): Promise<void>;

  /** List all agents of a specific role type */
  listByRole(roleType: string): Promise<AgentPersistentState[]>;

  /** Search agent memories */
  searchMemories(
    agentId: string,
    query: string,
    limit?: number
  ): Promise<MemoryEntry[]>;

  /** Add a memory entry */
  addMemory(agentId: string, entry: MemoryEntry): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// State Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates initial persistent state for a new agent.
 */
export function createInitialState(
  agentId: string,
  roleType: string
): AgentPersistentState {
  const now = new Date();
  return {
    agentId,
    roleType,
    createdAt: now,
    lastActiveAt: now,
    runCount: 0,
    memory: {
      learnings: [],
      decisions: [],
      feedback: [],
      domainKnowledge: {},
    },
    preferences: {},
    metrics: {
      tasksCompleted: 0,
      tasksFailed: 0,
      avgResponseTime: 0,
      totalTokens: 0,
      feedbackScores: [],
    },
  };
}

/**
 * Creates working memory for a new execution.
 */
export function createWorkingMemory(): WorkingMemory {
  return {
    currentTask: undefined,
    recentMessages: [],
    scratchpad: {},
    activeGoals: [],
  };
}

/**
 * Creates full runtime state from persistent state.
 */
export function createRuntimeState(
  persistent: AgentPersistentState
): AgentRuntimeState {
  return {
    ...persistent,
    status: 'idle',
    workingMemory: createWorkingMemory(),
  };
}
