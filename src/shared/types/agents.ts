/**
 * Shared Agent Types
 *
 * Common agent types used across services and clients.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Agent Role and Status
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Agent role in the system.
 */
export type AgentRole = 'primary' | 'specialist' | 'reviewer' | 'orchestrator';

/**
 * Agent status during execution.
 */
export type AgentStatus = 'idle' | 'thinking' | 'tool_use' | 'error';

// ─────────────────────────────────────────────────────────────────────────────
// Agent Definition Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Agent persona for visual display.
 */
export interface AgentPersona {
  avatar?: string;
  color?: string;
}

/**
 * Agent information for display.
 */
export interface AgentInfo {
  id: string;
  name: string;
  description?: string | null;
  role: AgentRole;
  provider?: string;
  model?: string;
  systemPrompt?: string | null;
  tools?: string[] | null;
  persona?: AgentPersona | null;
  isSystem?: boolean;
  isActive?: boolean;
}

/**
 * Agent state during execution (extends AgentInfo with status).
 */
export interface AgentState extends AgentInfo {
  status: AgentStatus;
  currentAction?: string;
  lastError?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Event Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Agent status change event.
 */
export interface AgentStatusEvent {
  agentId: string;
  status: AgentStatus;
  action?: string;
  error?: string;
}
