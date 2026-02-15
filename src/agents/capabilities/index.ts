/**
 * Agent Capabilities System
 *
 * Defines what an agent can do - tools, actions, and constraints.
 * Capabilities are composable and can be inherited through role hierarchy.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tool Capability Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A tool that an agent can use.
 */
export interface ToolCapability {
  /** Unique tool identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Tool description for LLM context */
  description: string;
  /** Whether this tool requires user permission */
  requiresPermission?: boolean;
  /** Tool-specific configuration */
  config?: Record<string, unknown>;
}

/**
 * Constraints on tool usage.
 */
export interface ToolConstraints {
  /** Maximum calls per execution */
  maxCalls?: number;
  /** Tools that cannot be used together */
  mutuallyExclusive?: string[];
  /** Required approval for these tools */
  requireApproval?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Communication Capabilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How an agent can communicate with other agents.
 */
export interface CommunicationCapability {
  /** Can send direct messages to other agents */
  canDirectMessage: boolean;
  /** Can broadcast to all agents in workflow */
  canBroadcast: boolean;
  /** Can read shared memory/context */
  canReadSharedMemory: boolean;
  /** Can write to shared memory/context */
  canWriteSharedMemory: boolean;
  /** Can create sub-agents */
  canSpawnAgents: boolean;
  /** Can modify workflows (meta-capability) */
  canModifyWorkflows: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource Capabilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resource limits for an agent.
 */
export interface ResourceLimits {
  /** Maximum tokens per turn */
  maxTokensPerTurn?: number;
  /** Maximum total tokens per execution */
  maxTotalTokens?: number;
  /** Maximum execution time in ms */
  maxExecutionTime?: number;
  /** Maximum concurrent tool calls */
  maxConcurrentTools?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Capabilities Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Complete capability set for an agent.
 * Capabilities define WHAT an agent can do, while roles define WHO they are.
 */
export interface AgentCapabilities {
  /** Tools this agent can use */
  tools: ToolCapability[];

  /** Tool usage constraints */
  toolConstraints?: ToolConstraints;

  /** Communication abilities */
  communication: CommunicationCapability;

  /** Resource limits */
  resources?: ResourceLimits;

  /** Custom capability flags */
  flags?: Record<string, boolean>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Capabilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default communication capabilities (restricted).
 */
export const DEFAULT_COMMUNICATION: CommunicationCapability = {
  canDirectMessage: false,
  canBroadcast: false,
  canReadSharedMemory: true,
  canWriteSharedMemory: false,
  canSpawnAgents: false,
  canModifyWorkflows: false,
};

/**
 * Default resource limits.
 */
export const DEFAULT_RESOURCES: ResourceLimits = {
  maxTokensPerTurn: 4096,
  maxTotalTokens: 32000,
  maxExecutionTime: 120000, // 2 minutes
  maxConcurrentTools: 3,
};

/**
 * Creates a base capability set with defaults.
 */
export function createCapabilities(
  partial?: Partial<AgentCapabilities>
): AgentCapabilities {
  return {
    tools: partial?.tools ?? [],
    toolConstraints: partial?.toolConstraints,
    communication: {
      ...DEFAULT_COMMUNICATION,
      ...partial?.communication,
    },
    resources: {
      ...DEFAULT_RESOURCES,
      ...partial?.resources,
    },
    flags: partial?.flags,
  };
}

/**
 * Merges two capability sets, with override taking precedence.
 */
export function mergeCapabilities(
  base: AgentCapabilities,
  override: Partial<AgentCapabilities>
): AgentCapabilities {
  return {
    tools: [...base.tools, ...(override.tools ?? [])],
    toolConstraints: {
      ...base.toolConstraints,
      ...override.toolConstraints,
    },
    communication: {
      ...base.communication,
      ...override.communication,
    },
    resources: {
      ...base.resources,
      ...override.resources,
    },
    flags: {
      ...base.flags,
      ...override.flags,
    },
  };
}
