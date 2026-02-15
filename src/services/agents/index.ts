/**
 * Agent Service
 *
 * ECP service for managing role-based agents.
 */

// Service interface
export type { AgentService, AgentServiceEvent, AgentServiceEventHandler } from './interface.ts';

// Service implementation
export { LocalAgentService } from './local.ts';

// Storage
export { AgentStorage, getAgentStorage, initAgentStorage, type PersistedAgent } from './storage.ts';
export {
  AgentDatabaseStore,
  type StoredAgent,
  type StoredAgentState,
  type StoredAgentMemory,
  type StoredAgentMetrics,
  type AgentMemoryType,
} from './database-store.ts';

// ECP adapter
export { AgentServiceAdapter } from './adapter.ts';
export type { HandlerResult, ECPError, ECPNotification, NotificationHandler } from './adapter.ts';

// Types
export {
  AgentErrorCodes,
  type AgentErrorCode,
  type AgentInstance,
  type AgentDetail,
  type CreateAgentRequest,
  type CreateAgentResponse,
  type GetAgentRequest,
  type GetAgentResponse,
  type ListAgentsRequest,
  type ListAgentsResponse,
  type DeleteAgentRequest,
  type DeleteAgentResponse,
  type InvokeAgentRequest,
  type InvokeAgentResponse,
  type GetAgentStateRequest,
  type GetAgentStateResponse,
  type SendMessageRequest,
  type SendMessageResponse,
  type GetMessagesRequest,
  type GetMessagesResponse,
  type SharedMemoryGetRequest,
  type SharedMemoryGetResponse,
  type SharedMemorySetRequest,
  type SharedMemorySetResponse,
  type ListRolesRequest,
  type ListRolesResponse,
  type GetRoleRequest,
  type GetRoleResponse,
  type AgentCreatedNotification,
  type AgentDeletedNotification,
  type AgentStatusNotification,
  type AgentMessageNotification,
  type MemoryChangedNotification,
} from './types.ts';
