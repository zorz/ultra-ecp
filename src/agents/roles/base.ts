/**
 * Base Agent Role System
 *
 * The foundation of the role-oriented agent architecture.
 * Agents are first-class citizens with roles that define their identity,
 * capabilities, and behavior patterns.
 *
 * Inheritance hierarchy:
 *   BaseRole
 *   ├── CreativeRole (generates content)
 *   ├── EvaluativeRole (reviews/critiques)
 *   │   └── ReviewerRole
 *   │       └── SecurityReviewerRole
 *   ├── ObservationalRole (monitors/reports)
 *   ├── DecisionRole (makes choices)
 *   └── OrchestratorRole (coordinates agents)
 */

import type {
  AgentCapabilities,
  CommunicationCapability,
} from '../capabilities/index.ts';
import { mergeCapabilities } from '../capabilities/index.ts';
import type {
  AgentRuntimeState,
  AgentPersistentState,
  MemoryEntry,
} from '../state/index.ts';
import { createInitialState, createWorkingMemory } from '../state/index.ts';
import type { LLMExecutor } from '../llm/index.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Role Identity Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Role category for classification.
 */
export type RoleCategory =
  | 'creative'
  | 'evaluative'
  | 'observational'
  | 'decision'
  | 'orchestrator'
  | 'custom';

/**
 * Role metadata for registration and discovery.
 */
export interface RoleMetadata {
  /** Unique role type identifier (e.g., 'security-reviewer') */
  roleType: string;
  /** Human-readable name */
  displayName: string;
  /** Description of what this role does */
  description: string;
  /** Category for grouping */
  category: RoleCategory;
  /** Parent role type (for inheritance chain) */
  parentRole?: string;
  /** Version for schema migrations */
  version: string;
  /** Tags for filtering/discovery */
  tags?: string[];
}

/**
 * Configuration for instantiating a role.
 */
export interface RoleConfig {
  /** Override the default system prompt */
  systemPrompt?: string;
  /** Additional capabilities beyond defaults */
  additionalCapabilities?: Partial<AgentCapabilities>;
  /** Role-specific configuration */
  roleConfig?: Record<string, unknown>;
  /** LLM provider to use */
  provider?: string;
  /** LLM model to use */
  model?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution Context
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Context provided to an agent during execution.
 */
export interface ExecutionContext {
  /** Current workflow ID (if in workflow) */
  workflowId?: string;
  /** Current node ID (if in workflow) */
  nodeId?: string;
  /** Session ID for this execution */
  sessionId: string;
  /** Input data from workflow or direct invocation */
  input: Record<string, unknown>;
  /** Shared memory accessible to all agents in workflow */
  sharedMemory: Record<string, unknown>;
  /** Messages from other agents */
  incomingMessages: AgentMessage[];
  /** Callback to send message to another agent */
  sendMessage: (to: string, message: AgentMessage) => Promise<void>;
  /** Callback to write to shared memory */
  writeSharedMemory: (key: string, value: unknown) => Promise<void>;
  /** Callback to emit events */
  emit: (event: AgentEvent) => void;
  /** LLM executor for making AI calls */
  llm: LLMExecutor;
}

/**
 * Message between agents.
 */
export interface AgentMessage {
  /** Sender agent ID */
  from: string;
  /** Target agent ID */
  to: string;
  /** Message type */
  type: 'request' | 'response' | 'notification' | 'feedback';
  /** Message content */
  content: string;
  /** Structured data */
  data?: Record<string, unknown>;
  /** When sent */
  timestamp: Date;
  /** Correlation ID for request/response pairs */
  correlationId?: string;
}

/**
 * Events emitted by agents.
 */
export interface AgentEvent {
  /** Event type */
  type: 'status_change' | 'output' | 'error' | 'metric' | 'memory_update';
  /** Event data */
  data: Record<string, unknown>;
  /** Timestamp */
  timestamp: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution Result
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of agent execution.
 */
export interface ExecutionResult {
  /** Whether execution succeeded */
  success: boolean;
  /** Primary output */
  output?: unknown;
  /** Structured outputs by key */
  outputs?: Record<string, unknown>;
  /** Error if failed */
  error?: string;
  /** Messages to send to other agents */
  outgoingMessages?: AgentMessage[];
  /** Updates to shared memory */
  sharedMemoryUpdates?: Record<string, unknown>;
  /** Memories to persist */
  newMemories?: Omit<MemoryEntry, 'id' | 'timestamp'>[];
  /** Metrics from this execution */
  metrics?: {
    tokensUsed?: number;
    executionTimeMs?: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Base Role Abstract Class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Abstract base class for all agent roles.
 *
 * Subclasses must implement:
 * - getMetadata(): Define role identity
 * - getDefaultCapabilities(): Define default capabilities
 * - getSystemPrompt(): Define the agent's persona/instructions
 * - execute(): Implement the core behavior
 */
export abstract class BaseRole {
  /** Unique instance ID */
  readonly agentId: string;

  /** Runtime state */
  protected state: AgentRuntimeState;

  /** Capabilities for this instance */
  protected capabilities: AgentCapabilities;

  /** Configuration */
  protected config: RoleConfig;

  constructor(
    agentId: string,
    config: RoleConfig = {},
    existingState?: AgentPersistentState
  ) {
    this.agentId = agentId;
    this.config = config;

    // Initialize or restore state
    const metadata = this.getMetadata();
    const persistentState =
      existingState ?? createInitialState(agentId, metadata.roleType);

    this.state = {
      ...persistentState,
      status: 'idle',
      workingMemory: createWorkingMemory(),
    };

    // Build capabilities from defaults + config overrides
    const defaultCaps = this.getDefaultCapabilities();
    this.capabilities = config.additionalCapabilities
      ? mergeCapabilities(defaultCaps, config.additionalCapabilities)
      : defaultCaps;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Abstract Methods (must be implemented by subclasses)
  // ───────────────────────────────────────────────────────────────────────────

  /** Get role metadata for registration/discovery */
  abstract getMetadata(): RoleMetadata;

  /** Get default capabilities for this role */
  abstract getDefaultCapabilities(): AgentCapabilities;

  /** Get the system prompt that defines this agent's persona */
  abstract getSystemPrompt(): string;

  /** Execute the agent's core behavior */
  abstract execute(context: ExecutionContext): Promise<ExecutionResult>;

  // ───────────────────────────────────────────────────────────────────────────
  // State Management
  // ───────────────────────────────────────────────────────────────────────────

  /** Get current runtime state */
  getState(): Readonly<AgentRuntimeState> {
    return this.state;
  }

  /** Get persistent state for saving */
  getPersistentState(): AgentPersistentState {
    const { status, workingMemory, error, workflowId, currentAction, ...persistent } =
      this.state;
    return persistent;
  }

  /** Get capabilities */
  getCapabilities(): Readonly<AgentCapabilities> {
    return this.capabilities;
  }

  /** Update status */
  protected setStatus(
    status: AgentRuntimeState['status'],
    action?: string
  ): void {
    this.state.status = status;
    this.state.currentAction = action;
    this.state.lastActiveAt = new Date();
  }

  /** Add to working memory */
  protected addToWorkingMemory(key: string, value: unknown): void {
    this.state.workingMemory.scratchpad[key] = value;
  }

  /** Set current task */
  protected setCurrentTask(task: string): void {
    this.state.workingMemory.currentTask = task;
  }

  /** Add a goal */
  protected addGoal(goal: string): void {
    if (!this.state.workingMemory.activeGoals.includes(goal)) {
      this.state.workingMemory.activeGoals.push(goal);
    }
  }

  /** Remove a goal (completed) */
  protected removeGoal(goal: string): void {
    this.state.workingMemory.activeGoals =
      this.state.workingMemory.activeGoals.filter((g) => g !== goal);
  }

  /** Add a memory entry to long-term storage */
  protected addMemory(entry: Omit<MemoryEntry, 'id' | 'timestamp'>): void {
    const fullEntry: MemoryEntry = {
      ...entry,
      id: crypto.randomUUID(),
      timestamp: new Date(),
    };

    switch (entry.type) {
      case 'learning':
        this.state.memory.learnings.push(fullEntry);
        break;
      case 'decision':
        this.state.memory.decisions.push(fullEntry);
        break;
      case 'feedback':
        this.state.memory.feedback.push(fullEntry);
        break;
      default: {
        // Store in domain knowledge under the type
        const entryType = entry.type;
        const domainKnowledge = this.state.memory.domainKnowledge;
        if (!domainKnowledge[entryType]) {
          domainKnowledge[entryType] = [];
        }
        domainKnowledge[entryType]!.push(fullEntry);
      }
    }
  }

  /** Update metrics after execution */
  protected updateMetrics(result: ExecutionResult): void {
    if (result.success) {
      this.state.metrics.tasksCompleted++;
    } else {
      this.state.metrics.tasksFailed++;
    }

    if (result.metrics?.tokensUsed) {
      this.state.metrics.totalTokens += result.metrics.tokensUsed;
    }

    if (result.metrics?.executionTimeMs) {
      const { avgResponseTime, tasksCompleted, tasksFailed } = this.state.metrics;
      const totalTasks = tasksCompleted + tasksFailed;
      // Running average
      this.state.metrics.avgResponseTime =
        (avgResponseTime * (totalTasks - 1) + result.metrics.executionTimeMs) /
        totalTasks;
    }

    this.state.runCount++;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Communication Helpers
  // ───────────────────────────────────────────────────────────────────────────

  /** Check if this agent can perform a communication action */
  canCommunicate(action: keyof CommunicationCapability): boolean {
    return this.capabilities.communication[action] === true;
  }

  /** Create a message to another agent */
  protected createMessage(
    to: string,
    type: AgentMessage['type'],
    content: string,
    data?: Record<string, unknown>
  ): AgentMessage {
    return {
      from: this.agentId,
      to,
      type,
      content,
      data,
      timestamp: new Date(),
      correlationId: crypto.randomUUID(),
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Lifecycle Hooks (can be overridden)
  // ───────────────────────────────────────────────────────────────────────────

  /** Called before execution starts */
  async beforeExecute(_context: ExecutionContext): Promise<void> {
    this.setStatus('thinking');
    this.state.runCount++;
  }

  /** Called after execution completes */
  async afterExecute(
    _context: ExecutionContext,
    result: ExecutionResult
  ): Promise<void> {
    this.updateMetrics(result);
    this.setStatus(result.success ? 'idle' : 'error');
  }

  /** Called when agent encounters an error */
  async onError(error: Error): Promise<void> {
    this.state.status = 'error';
    this.state.error = error.message;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Role Registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Factory function type for creating role instances.
 */
export type RoleFactory = (
  agentId: string,
  config?: RoleConfig,
  existingState?: AgentPersistentState
) => BaseRole;

/**
 * Registry for role types.
 */
export class RoleRegistry {
  private static instance: RoleRegistry;
  private roles = new Map<string, { metadata: RoleMetadata; factory: RoleFactory }>();

  static getInstance(): RoleRegistry {
    if (!RoleRegistry.instance) {
      RoleRegistry.instance = new RoleRegistry();
    }
    return RoleRegistry.instance;
  }

  /** Register a role type */
  register(metadata: RoleMetadata, factory: RoleFactory): void {
    this.roles.set(metadata.roleType, { metadata, factory });
  }

  /** Get a role factory by type */
  getFactory(roleType: string): RoleFactory | undefined {
    return this.roles.get(roleType)?.factory;
  }

  /** Get role metadata by type */
  getMetadata(roleType: string): RoleMetadata | undefined {
    return this.roles.get(roleType)?.metadata;
  }

  /** List all registered role types */
  listRoles(): RoleMetadata[] {
    return Array.from(this.roles.values()).map((r) => r.metadata);
  }

  /** List roles by category */
  listByCategory(category: RoleCategory): RoleMetadata[] {
    return this.listRoles().filter((r) => r.category === category);
  }

  /** Create an agent from a registered role type */
  create(
    roleType: string,
    agentId: string,
    config?: RoleConfig,
    existingState?: AgentPersistentState
  ): BaseRole {
    const factory = this.getFactory(roleType);
    if (!factory) {
      throw new Error(`Unknown role type: ${roleType}`);
    }
    return factory(agentId, config, existingState);
  }
}

/** Global role registry */
export const roleRegistry = RoleRegistry.getInstance();
