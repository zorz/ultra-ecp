/**
 * Agent Service ECP Adapter
 *
 * Bridges the agent service to the ECP JSON-RPC protocol.
 */

import { debugLog } from '../../debug.ts';
import type { LocalAgentService } from './local.ts';
import type { AgentServiceEvent } from './interface.ts';
import {
  AgentErrorCodes,
  type CreateAgentRequest,
  type GetAgentRequest,
  type ListAgentsRequest,
  type DeleteAgentRequest,
  type InvokeAgentRequest,
  type GetAgentStateRequest,
  type SendMessageRequest,
  type GetMessagesRequest,
  type SharedMemoryGetRequest,
  type SharedMemorySetRequest,
  type ListRolesRequest,
  type GetRoleRequest,
} from './types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ECP Error type.
 */
export interface ECPError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * Handler result type (matches ECP pattern).
 */
export type HandlerResult<T = unknown> =
  | { result: T }
  | { error: ECPError };

/**
 * ECP notification message.
 */
export interface ECPNotification {
  jsonrpc: '2.0';
  method: string;
  params: unknown;
}

/**
 * Notification handler function.
 */
export type NotificationHandler = (notification: ECPNotification) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ECP adapter for the agent service.
 */
export class AgentServiceAdapter {
  private service: LocalAgentService;
  private notificationHandler?: NotificationHandler;

  constructor(service: LocalAgentService) {
    this.service = service;

    // Subscribe to service events and forward as notifications
    this.service.onEvent((event) => this.handleServiceEvent(event));
  }

  /**
   * Set the notification handler for sending real-time updates.
   */
  setNotificationHandler(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  /**
   * Handle an ECP request.
   */
  async handleRequest(method: string, params: unknown): Promise<HandlerResult> {
    debugLog(`[agents] Handling request: ${method}`);

    try {
      switch (method) {
        // Role management
        case 'agent/role/list':
          return this.handleListRoles(params);
        case 'agent/role/get':
          return this.handleGetRole(params);

        // Agent CRUD
        case 'agent/create':
          return this.handleCreateAgent(params);
        case 'agent/get':
          return this.handleGetAgent(params);
        case 'agent/list':
          return this.handleListAgents(params);
        case 'agent/delete':
          return this.handleDeleteAgent(params);

        // Agent execution
        case 'agent/invoke':
          return this.handleInvokeAgent(params);
        case 'agent/state/get':
          return this.handleGetAgentState(params);
        case 'agent/state/save':
          return this.handleSaveAgentState(params);

        // Communication
        case 'agent/message/send':
          return this.handleSendMessage(params);
        case 'agent/message/list':
          return this.handleGetMessages(params);
        case 'agent/message/acknowledge':
          return this.handleAcknowledgeMessage(params);

        // Shared memory
        case 'agent/memory/get':
          return this.handleGetSharedMemory(params);
        case 'agent/memory/set':
          return this.handleSetSharedMemory(params);
        case 'agent/memory/delete':
          return this.handleDeleteSharedMemory(params);
        case 'agent/memory/keys':
          return this.handleListSharedMemoryKeys(params);

        default:
          return {
            error: {
              code: -32601,
              message: `Unknown method: ${method}`,
            },
          };
      }
    } catch (error) {
      debugLog(`[agents] Request error: ${error}`);
      return {
        error: {
          code: AgentErrorCodes.AgentError,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Role Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private async handleListRoles(params: unknown): Promise<HandlerResult> {
    const p = params as ListRolesRequest | undefined;
    const roles = await this.service.listRoles(p?.category, p?.tags);
    return { result: { roles } };
  }

  private async handleGetRole(params: unknown): Promise<HandlerResult> {
    const p = params as GetRoleRequest;
    if (!p?.roleType) {
      return {
        error: {
          code: AgentErrorCodes.InvalidParams,
          message: 'roleType is required',
        },
      };
    }

    const result = await this.service.getRole(p.roleType);
    if (!result) {
      return {
        error: {
          code: AgentErrorCodes.RoleNotFound,
          message: `Role not found: ${p.roleType}`,
        },
      };
    }

    return { result };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Agent CRUD Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private async handleCreateAgent(params: unknown): Promise<HandlerResult> {
    const p = params as CreateAgentRequest;
    if (!p?.roleType || !p?.name) {
      return {
        error: {
          code: AgentErrorCodes.InvalidParams,
          message: 'roleType and name are required',
        },
      };
    }

    try {
      const agent = await this.service.createAgent({
        roleType: p.roleType,
        id: p.id,
        name: p.name,
        description: p.description,
        config: p.config,
        scope: p.scope,
      });
      return { result: { agent } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Unknown role type')) {
        return {
          error: {
            code: AgentErrorCodes.RoleNotFound,
            message,
          },
        };
      }
      if (message.includes('already exists')) {
        return {
          error: {
            code: AgentErrorCodes.AgentExists,
            message,
          },
        };
      }
      throw error;
    }
  }

  private async handleGetAgent(params: unknown): Promise<HandlerResult> {
    const p = params as GetAgentRequest;
    if (!p?.id) {
      return {
        error: {
          code: AgentErrorCodes.InvalidParams,
          message: 'id is required',
        },
      };
    }

    const agent = await this.service.getAgent(p.id, p.detailed);
    if (!agent) {
      return {
        error: {
          code: AgentErrorCodes.AgentNotFound,
          message: `Agent not found: ${p.id}`,
        },
      };
    }

    return { result: { agent } };
  }

  private async handleListAgents(params: unknown): Promise<HandlerResult> {
    const p = params as ListAgentsRequest | undefined;
    const result = await this.service.listAgents({
      roleType: p?.roleType,
      status: p?.status,
      workflowId: p?.workflowId,
      offset: p?.offset,
      limit: p?.limit,
    });
    return { result };
  }

  private async handleDeleteAgent(params: unknown): Promise<HandlerResult> {
    const p = params as DeleteAgentRequest;
    if (!p?.id) {
      return {
        error: {
          code: AgentErrorCodes.InvalidParams,
          message: 'id is required',
        },
      };
    }

    const success = await this.service.deleteAgent(p.id);
    if (!success) {
      return {
        error: {
          code: AgentErrorCodes.AgentNotFound,
          message: `Agent not found: ${p.id}`,
        },
      };
    }

    return { result: { success } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Execution Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private async handleInvokeAgent(params: unknown): Promise<HandlerResult> {
    const p = params as InvokeAgentRequest;
    if (!p?.id || !p?.input) {
      return {
        error: {
          code: AgentErrorCodes.InvalidParams,
          message: 'id and input are required',
        },
      };
    }

    const result = await this.service.invokeAgent(p.id, p.input, {
      workflowId: p.workflowId,
      sessionId: p.sessionId,
    });

    return { result: { result } };
  }

  private async handleGetAgentState(params: unknown): Promise<HandlerResult> {
    const p = params as GetAgentStateRequest;
    if (!p?.id) {
      return {
        error: {
          code: AgentErrorCodes.InvalidParams,
          message: 'id is required',
        },
      };
    }

    const state = await this.service.getAgentState(p.id);
    if (!state) {
      return {
        error: {
          code: AgentErrorCodes.AgentNotFound,
          message: `Agent not found: ${p.id}`,
        },
      };
    }

    return { result: { state } };
  }

  private async handleSaveAgentState(params: unknown): Promise<HandlerResult> {
    const p = params as { id: string };
    if (!p?.id) {
      return {
        error: {
          code: AgentErrorCodes.InvalidParams,
          message: 'id is required',
        },
      };
    }

    try {
      await this.service.saveAgentState(p.id);
      return { result: { success: true } };
    } catch (error) {
      return {
        error: {
          code: AgentErrorCodes.AgentNotFound,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Communication Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private async handleSendMessage(params: unknown): Promise<HandlerResult> {
    const p = params as SendMessageRequest;
    if (!p?.from || !p?.to || !p?.type || !p?.content) {
      return {
        error: {
          code: AgentErrorCodes.InvalidParams,
          message: 'from, to, type, and content are required',
        },
      };
    }

    try {
      const messageId = await this.service.sendMessage(
        p.from,
        p.to,
        p.type,
        p.content,
        p.data
      );
      return { result: { messageId } };
    } catch (error) {
      return {
        error: {
          code: AgentErrorCodes.MessageFailed,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async handleGetMessages(params: unknown): Promise<HandlerResult> {
    const p = params as GetMessagesRequest;
    if (!p?.agentId) {
      return {
        error: {
          code: AgentErrorCodes.InvalidParams,
          message: 'agentId is required',
        },
      };
    }

    const messages = await this.service.getMessages(p.agentId, p.pendingOnly);
    return { result: { messages } };
  }

  private async handleAcknowledgeMessage(params: unknown): Promise<HandlerResult> {
    const p = params as { messageId: string };
    if (!p?.messageId) {
      return {
        error: {
          code: AgentErrorCodes.InvalidParams,
          message: 'messageId is required',
        },
      };
    }

    await this.service.acknowledgeMessage(p.messageId);
    return { result: { success: true } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Shared Memory Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private async handleGetSharedMemory(params: unknown): Promise<HandlerResult> {
    const p = params as SharedMemoryGetRequest;
    if (!p?.contextId || !p?.key) {
      return {
        error: {
          code: AgentErrorCodes.InvalidParams,
          message: 'contextId and key are required',
        },
      };
    }

    const result = await this.service.getSharedMemory(p.contextId, p.key);
    if (!result) {
      return { result: { value: null } };
    }

    return {
      result: {
        value: result.value,
        version: result.version,
        writtenBy: result.writtenBy,
        writtenAt: result.writtenAt.toISOString(),
      },
    };
  }

  private async handleSetSharedMemory(params: unknown): Promise<HandlerResult> {
    const p = params as SharedMemorySetRequest;
    if (!p?.contextId || !p?.key || p?.value === undefined || !p?.agentId) {
      return {
        error: {
          code: AgentErrorCodes.InvalidParams,
          message: 'contextId, key, value, and agentId are required',
        },
      };
    }

    const result = await this.service.setSharedMemory(
      p.contextId,
      p.key,
      p.value,
      p.agentId,
      p.ttl
    );

    return { result: { success: true, version: result.version } };
  }

  private async handleDeleteSharedMemory(params: unknown): Promise<HandlerResult> {
    const p = params as { contextId: string; key: string; agentId: string };
    if (!p?.contextId || !p?.key || !p?.agentId) {
      return {
        error: {
          code: AgentErrorCodes.InvalidParams,
          message: 'contextId, key, and agentId are required',
        },
      };
    }

    const success = await this.service.deleteSharedMemory(
      p.contextId,
      p.key,
      p.agentId
    );

    return { result: { success } };
  }

  private async handleListSharedMemoryKeys(params: unknown): Promise<HandlerResult> {
    const p = params as { contextId: string };
    if (!p?.contextId) {
      return {
        error: {
          code: AgentErrorCodes.InvalidParams,
          message: 'contextId is required',
        },
      };
    }

    const keys = await this.service.listSharedMemoryKeys(p.contextId);
    return { result: { keys } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Event Handling
  // ─────────────────────────────────────────────────────────────────────────

  private handleServiceEvent(event: AgentServiceEvent): void {
    if (!this.notificationHandler) {
      return;
    }

    let notification: ECPNotification | null = null;

    switch (event.type) {
      case 'agent:created':
        notification = {
          jsonrpc: '2.0',
          method: 'agent/created',
          params: { agent: event.agent },
        };
        break;

      case 'agent:deleted':
        notification = {
          jsonrpc: '2.0',
          method: 'agent/deleted',
          params: { id: event.id },
        };
        break;

      case 'agent:status':
        notification = {
          jsonrpc: '2.0',
          method: 'agent/status',
          params: {
            id: event.id,
            status: event.status,
            action: event.action,
            error: event.error,
          },
        };
        break;

      case 'agent:message':
        notification = {
          jsonrpc: '2.0',
          method: 'agent/message',
          params: { message: event.message },
        };
        break;

      case 'memory:changed':
        notification = {
          jsonrpc: '2.0',
          method: 'agent/memory/changed',
          params: {
            contextId: event.contextId,
            key: event.key,
            type: event.changeType,
            value: event.value,
            changedBy: event.changedBy,
          },
        };
        break;
    }

    if (notification) {
      this.notificationHandler(notification);
    }
  }
}
