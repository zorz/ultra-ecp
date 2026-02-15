/**
 * Agent Service Interface
 *
 * Contract for agent service implementations.
 */

import type {
  RoleCategory,
  RoleMetadata,
  RoleConfig,
  AgentCapabilities,
  AgentRuntimeStatus,
  AgentPersistentState,
  AgentMessage,
  ExecutionResult,
} from '../../agents/index.ts';
import type { AgentInstance, AgentDetail } from './types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Service Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Agent service for managing agent instances.
 */
export interface AgentService {
  // ─────────────────────────────────────────────────────────────────────────
  // Role Management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * List registered role types.
   */
  listRoles(category?: RoleCategory, tags?: string[]): Promise<RoleMetadata[]>;

  /**
   * Get role metadata and default configuration.
   */
  getRole(roleType: string): Promise<{
    role: RoleMetadata;
    defaultCapabilities: AgentCapabilities;
    systemPrompt: string;
  } | null>;

  // ─────────────────────────────────────────────────────────────────────────
  // Agent Instance Management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a new agent instance from a role type.
   */
  createAgent(options: {
    roleType: string;
    id?: string;
    name: string;
    description?: string;
    config?: RoleConfig;
  }): Promise<AgentInstance>;

  /**
   * Get an agent instance by ID.
   */
  getAgent(id: string, detailed?: boolean): Promise<AgentInstance | AgentDetail | null>;

  /**
   * List agent instances with optional filters.
   */
  listAgents(filters?: {
    roleType?: string;
    status?: AgentRuntimeStatus;
    workflowId?: string;
    offset?: number;
    limit?: number;
  }): Promise<{ agents: AgentInstance[]; total: number }>;

  /**
   * Delete an agent instance.
   */
  deleteAgent(id: string): Promise<boolean>;

  // ─────────────────────────────────────────────────────────────────────────
  // Agent Execution
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Invoke an agent's execute method.
   */
  invokeAgent(
    id: string,
    input: Record<string, unknown>,
    options?: {
      workflowId?: string;
      sessionId?: string;
    }
  ): Promise<ExecutionResult>;

  /**
   * Get agent state.
   */
  getAgentState(id: string): Promise<AgentPersistentState | null>;

  /**
   * Save agent state.
   */
  saveAgentState(id: string): Promise<void>;

  // ─────────────────────────────────────────────────────────────────────────
  // Agent Communication
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Send a message from one agent to another.
   */
  sendMessage(
    from: string,
    to: string,
    type: AgentMessage['type'],
    content: string,
    data?: Record<string, unknown>
  ): Promise<string>;

  /**
   * Get messages for an agent.
   */
  getMessages(agentId: string, pendingOnly?: boolean): Promise<AgentMessage[]>;

  /**
   * Acknowledge a message as read.
   */
  acknowledgeMessage(messageId: string): Promise<void>;

  // ─────────────────────────────────────────────────────────────────────────
  // Shared Memory
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get a value from shared memory.
   */
  getSharedMemory(
    contextId: string,
    key: string
  ): Promise<{
    value: unknown;
    version: number;
    writtenBy: string;
    writtenAt: Date;
  } | null>;

  /**
   * Set a value in shared memory.
   */
  setSharedMemory(
    contextId: string,
    key: string,
    value: unknown,
    agentId: string,
    ttl?: number
  ): Promise<{ version: number }>;

  /**
   * Delete a value from shared memory.
   */
  deleteSharedMemory(contextId: string, key: string, agentId: string): Promise<boolean>;

  /**
   * List all keys in a shared memory context.
   */
  listSharedMemoryKeys(contextId: string): Promise<string[]>;

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Initialize the service.
   */
  initialize(): Promise<void>;

  /**
   * Shutdown the service.
   */
  shutdown(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Events emitted by the agent service.
 */
export type AgentServiceEvent =
  | { type: 'agent:created'; agent: AgentInstance }
  | { type: 'agent:deleted'; id: string }
  | { type: 'agent:status'; id: string; status: AgentRuntimeStatus; action?: string; error?: string }
  | { type: 'agent:message'; message: AgentMessage }
  | { type: 'memory:changed'; contextId: string; key: string; changeType: 'set' | 'delete' | 'expire'; value?: unknown; changedBy: string };

/**
 * Event handler for agent service events.
 */
export type AgentServiceEventHandler = (event: AgentServiceEvent) => void;
