/**
 * Agent Service Types
 *
 * Types for the agent service ECP API.
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

// Re-export types needed by other modules
export type { AgentRuntimeStatus };

// ─────────────────────────────────────────────────────────────────────────────
// Agent Instance Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persistence scope for agents.
 */
export type AgentScope = 'global' | 'project';

/**
 * Agent instance info (returned from API).
 */
export interface AgentInstance {
  /** Unique instance ID */
  id: string;
  /** Role type */
  roleType: string;
  /** Display name */
  name: string;
  /** Optional description */
  description?: string;
  /** Current status */
  status: AgentRuntimeStatus;
  /** When created */
  createdAt: string;
  /** Last active */
  lastActiveAt: string;
  /** Number of runs */
  runCount: number;
  /** Current action (if any) */
  currentAction?: string;
  /** Active workflow (if any) */
  workflowId?: string;
  /** Persistence scope */
  scope: AgentScope;
}

/**
 * Detailed agent info including capabilities.
 */
export interface AgentDetail extends AgentInstance {
  /** Role metadata */
  role: RoleMetadata;
  /** Agent capabilities */
  capabilities: AgentCapabilities;
  /** Configuration used to create */
  config: RoleConfig;
  /** Metrics */
  metrics: {
    tasksCompleted: number;
    tasksFailed: number;
    avgResponseTime: number;
    totalTokens: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Request/Response Types
// ─────────────────────────────────────────────────────────────────────────────

/** Create agent request */
export interface CreateAgentRequest {
  /** Role type to instantiate */
  roleType: string;
  /** Optional custom ID (auto-generated if not provided) */
  id?: string;
  /** Display name */
  name: string;
  /** Description */
  description?: string;
  /** Role configuration overrides */
  config?: RoleConfig;
  /** Persistence scope (defaults to 'project') */
  scope?: AgentScope;
}

/** Create agent response */
export interface CreateAgentResponse {
  agent: AgentInstance;
}

/** Get agent request */
export interface GetAgentRequest {
  id: string;
  /** Include full details */
  detailed?: boolean;
}

/** Get agent response */
export interface GetAgentResponse {
  agent: AgentInstance | AgentDetail;
}

/** List agents request */
export interface ListAgentsRequest {
  /** Filter by role type */
  roleType?: string;
  /** Filter by status */
  status?: AgentRuntimeStatus;
  /** Filter by workflow */
  workflowId?: string;
  /** Pagination offset */
  offset?: number;
  /** Pagination limit */
  limit?: number;
}

/** List agents response */
export interface ListAgentsResponse {
  agents: AgentInstance[];
  total: number;
}

/** Delete agent request */
export interface DeleteAgentRequest {
  id: string;
}

/** Delete agent response */
export interface DeleteAgentResponse {
  success: boolean;
}

/** Invoke agent request */
export interface InvokeAgentRequest {
  /** Agent ID */
  id: string;
  /** Input data */
  input: Record<string, unknown>;
  /** Optional workflow context */
  workflowId?: string;
  /** Optional session ID */
  sessionId?: string;
}

/** Invoke agent response */
export interface InvokeAgentResponse {
  result: ExecutionResult;
}

/** Get agent state request */
export interface GetAgentStateRequest {
  id: string;
}

/** Get agent state response */
export interface GetAgentStateResponse {
  state: AgentPersistentState;
}

/** Send message request */
export interface SendMessageRequest {
  /** Sender agent ID */
  from: string;
  /** Target agent ID */
  to: string;
  /** Message type */
  type: 'request' | 'response' | 'notification' | 'feedback';
  /** Message content */
  content: string;
  /** Optional structured data */
  data?: Record<string, unknown>;
}

/** Send message response */
export interface SendMessageResponse {
  messageId: string;
}

/** Get messages request */
export interface GetMessagesRequest {
  /** Agent ID to get messages for */
  agentId: string;
  /** Only pending messages */
  pendingOnly?: boolean;
}

/** Get messages response */
export interface GetMessagesResponse {
  messages: AgentMessage[];
}

/** Shared memory get request */
export interface SharedMemoryGetRequest {
  /** Context ID (workflow or session) */
  contextId: string;
  /** Key to get */
  key: string;
}

/** Shared memory get response */
export interface SharedMemoryGetResponse {
  value: unknown;
  version: number;
  writtenBy: string;
  writtenAt: string;
}

/** Shared memory set request */
export interface SharedMemorySetRequest {
  /** Context ID */
  contextId: string;
  /** Key to set */
  key: string;
  /** Value */
  value: unknown;
  /** Agent ID writing */
  agentId: string;
  /** Optional TTL in ms */
  ttl?: number;
}

/** Shared memory set response */
export interface SharedMemorySetResponse {
  success: boolean;
  version: number;
}

/** List roles request */
export interface ListRolesRequest {
  /** Filter by category */
  category?: RoleCategory;
  /** Filter by tags */
  tags?: string[];
}

/** List roles response */
export interface ListRolesResponse {
  roles: RoleMetadata[];
}

/** Get role request */
export interface GetRoleRequest {
  roleType: string;
}

/** Get role response */
export interface GetRoleResponse {
  role: RoleMetadata;
  defaultCapabilities: AgentCapabilities;
  systemPrompt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Codes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Agent service error codes.
 * Range: -32300 to -32399
 */
export const AgentErrorCodes = {
  /** Generic agent error */
  AgentError: -32300,
  /** Agent not found */
  AgentNotFound: -32301,
  /** Role type not found */
  RoleNotFound: -32302,
  /** Agent already exists */
  AgentExists: -32303,
  /** Invalid agent state */
  InvalidState: -32304,
  /** Agent is busy */
  AgentBusy: -32305,
  /** Message delivery failed */
  MessageFailed: -32306,
  /** Shared memory error */
  MemoryError: -32307,
  /** Permission denied */
  PermissionDenied: -32308,
  /** Invalid parameters */
  InvalidParams: -32602,
} as const;

export type AgentErrorCode = (typeof AgentErrorCodes)[keyof typeof AgentErrorCodes];

// ─────────────────────────────────────────────────────────────────────────────
// Notification Types
// ─────────────────────────────────────────────────────────────────────────────

/** Agent created notification */
export interface AgentCreatedNotification {
  agent: AgentInstance;
}

/** Agent deleted notification */
export interface AgentDeletedNotification {
  id: string;
}

/** Agent status changed notification */
export interface AgentStatusNotification {
  id: string;
  status: AgentRuntimeStatus;
  action?: string;
  error?: string;
}

/** Agent message received notification */
export interface AgentMessageNotification {
  message: AgentMessage;
}

/** Shared memory changed notification */
export interface MemoryChangedNotification {
  contextId: string;
  key: string;
  type: 'set' | 'delete' | 'expire';
  value?: unknown;
  changedBy: string;
}
