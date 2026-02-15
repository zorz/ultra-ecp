/**
 * Local Agent Service Implementation
 *
 * Manages agent instances, communication, and shared memory.
 */

import { Database } from 'bun:sqlite';
import { debugLog } from '../../debug.ts';
import {
  BaseRole,
  roleRegistry,
  createCommunicationContext,
  NullLLMExecutor,
  createAIServiceExecutor,
  type RoleCategory,
  type RoleMetadata,
  type RoleConfig,
  type AgentCapabilities,
  type AgentRuntimeStatus,
  type AgentPersistentState,
  type AgentMessage,
  type ExecutionResult,
  type ExecutionContext,
  type CommunicationContext,
  type LLMExecutor,
  type AIServiceForExecutor,
} from '../../agents/index.ts';
import type { AgentService, AgentServiceEvent, AgentServiceEventHandler } from './interface.ts';
import type { AgentInstance, AgentDetail, AgentScope } from './types.ts';
import { AgentStorage, getAgentStorage, type PersistedAgent } from './storage.ts';
import { AgentDatabaseStore } from './database-store.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Internal Types
// ─────────────────────────────────────────────────────────────────────────────

interface ManagedAgent {
  instance: BaseRole;
  name: string;
  description?: string;
  config: RoleConfig;
  workflowId?: string;
  scope: AgentScope;
}

// ─────────────────────────────────────────────────────────────────────────────
// Local Agent Service
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Local implementation of the agent service.
 */
export class LocalAgentService implements AgentService {
  /** Active agent instances (in-memory, runtime only) */
  private agents = new Map<string, ManagedAgent>();

  /** Communication contexts by ID (workflow/session) */
  private communicationContexts = new Map<string, CommunicationContext>();

  /** Event handlers */
  private eventHandlers: AgentServiceEventHandler[] = [];

  /** Agent counter for ID generation */
  private agentCounter = 0;

  /** Message counter */
  private messageCounter = 0;

  /** File-based storage (for global agents) */
  private fileStorage: AgentStorage;

  /** Database storage (for project agents, optional) */
  private dbStore?: AgentDatabaseStore;

  /** AI service for LLM calls (optional) */
  private aiService?: AIServiceForExecutor;

  /** Project path for project-scoped agents */
  private projectPath?: string;

  /** Whether initialized */
  private initialized = false;

  constructor(projectPath?: string) {
    this.projectPath = projectPath;
    this.fileStorage = getAgentStorage(projectPath);
  }

  /**
   * Set the AI service for LLM integration.
   * When set, agents can make actual LLM calls during execution.
   */
  setAIService(service: AIServiceForExecutor): void {
    this.aiService = service;
    debugLog('[agents] AI service configured for LLM integration');
  }

  /**
   * Set the database for project agent persistence.
   * When set, project agents use SQLite; global agents still use file storage.
   */
  setDatabase(db: Database): void {
    this.dbStore = new AgentDatabaseStore(db);
    debugLog('[agents] Database store initialized');
  }

  /**
   * Initialize the service by loading persisted agents.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    debugLog('[agents] Initializing agent service...');

    // Load project agents from database if available
    if (this.dbStore) {
      const { agents: dbAgents } = this.dbStore.listAgents({ scope: 'project' });
      for (const stored of dbAgents) {
        try {
          const roleMetadata = roleRegistry.getMetadata(stored.roleType);
          if (!roleMetadata) {
            debugLog(`[agents] Skipping agent ${stored.id}: role ${stored.roleType} not found`);
            continue;
          }

          const instance = roleRegistry.create(stored.roleType, stored.id, stored.config as RoleConfig);
          const managed: ManagedAgent = {
            instance,
            name: stored.name,
            description: stored.description ?? undefined,
            config: stored.config as RoleConfig,
            scope: stored.scope,
          };
          this.agents.set(stored.id, managed);
          debugLog(`[agents] Loaded agent ${stored.id} from database`);
        } catch (error) {
          debugLog(`[agents] Failed to load agent ${stored.id}: ${error}`);
        }
      }
    }

    // Load global agents from file storage
    const globalAgents = await this.fileStorage.listByScope('global');
    for (const persisted of globalAgents) {
      try {
        const roleMetadata = roleRegistry.getMetadata(persisted.roleType);
        if (!roleMetadata) {
          debugLog(`[agents] Skipping agent ${persisted.id}: role ${persisted.roleType} not found`);
          continue;
        }

        const instance = roleRegistry.create(persisted.roleType, persisted.id, persisted.config);
        const managed: ManagedAgent = {
          instance,
          name: persisted.name,
          description: persisted.description,
          config: persisted.config,
          scope: persisted.scope,
        };
        this.agents.set(persisted.id, managed);
        debugLog(`[agents] Loaded global agent ${persisted.id} from file`);
      } catch (error) {
        debugLog(`[agents] Failed to load agent ${persisted.id}: ${error}`);
      }
    }

    // Also load project agents from file storage if no database and we have a project path
    if (!this.dbStore && this.projectPath) {
      const projectAgents = await this.fileStorage.listByScope('project');
      for (const persisted of projectAgents) {
        if (this.agents.has(persisted.id)) continue; // Skip duplicates
        try {
          const roleMetadata = roleRegistry.getMetadata(persisted.roleType);
          if (!roleMetadata) continue;

          const instance = roleRegistry.create(persisted.roleType, persisted.id, persisted.config);
          const managed: ManagedAgent = {
            instance,
            name: persisted.name,
            description: persisted.description,
            config: persisted.config,
            scope: persisted.scope,
          };
          this.agents.set(persisted.id, managed);
          debugLog(`[agents] Loaded project agent ${persisted.id} from file`);
        } catch (error) {
          debugLog(`[agents] Failed to load agent ${persisted.id}: ${error}`);
        }
      }
    }

    this.initialized = true;
    debugLog(`[agents] Initialized with ${this.agents.size} agents`);
  }

  /**
   * Set the project path (called when workspace changes).
   */
  setProjectPath(path: string): void {
    this.projectPath = path;
    this.fileStorage.setProjectPath(path);
    // Re-initialize to load project-specific agents
    this.initialized = false;
    this.initialize();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Role Management
  // ─────────────────────────────────────────────────────────────────────────

  async listRoles(category?: RoleCategory, tags?: string[]): Promise<RoleMetadata[]> {
    let roles = roleRegistry.listRoles();

    if (category) {
      roles = roles.filter((r) => r.category === category);
    }

    if (tags && tags.length > 0) {
      roles = roles.filter((r) =>
        r.tags && tags.some((t) => r.tags!.includes(t))
      );
    }

    return roles;
  }

  async getRole(roleType: string): Promise<{
    role: RoleMetadata;
    defaultCapabilities: AgentCapabilities;
    systemPrompt: string;
  } | null> {
    const metadata = roleRegistry.getMetadata(roleType);
    if (!metadata) {
      return null;
    }

    // Create a temporary instance to get defaults
    const tempAgent = roleRegistry.create(roleType, '_temp_');
    const capabilities = tempAgent.getCapabilities();
    const systemPrompt = tempAgent.getSystemPrompt();

    return {
      role: metadata,
      defaultCapabilities: capabilities as AgentCapabilities,
      systemPrompt,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Agent Instance Management
  // ─────────────────────────────────────────────────────────────────────────

  async createAgent(options: {
    roleType: string;
    id?: string;
    name: string;
    description?: string;
    config?: RoleConfig;
    scope?: AgentScope;
  }): Promise<AgentInstance> {
    const { roleType, name, description, config } = options;
    const scope = options.scope ?? 'project';

    // Verify role exists
    const roleMetadata = roleRegistry.getMetadata(roleType);
    if (!roleMetadata) {
      throw new Error(`Unknown role type: ${roleType}`);
    }

    // Generate or use provided ID
    const id = options.id ?? `agent_${++this.agentCounter}_${Date.now()}`;

    // Check for duplicate
    if (this.agents.has(id)) {
      throw new Error(`Agent already exists: ${id}`);
    }

    // Create the agent instance
    const instance = roleRegistry.create(roleType, id, config);

    // Store managed agent in memory
    const managed: ManagedAgent = {
      instance,
      name,
      description,
      config: config ?? {},
      scope,
    };
    this.agents.set(id, managed);

    // Persist to appropriate storage
    if (scope === 'project' && this.dbStore) {
      // Use database for project agents
      this.dbStore.createAgent({
        id,
        roleType,
        name,
        description: description ?? null,
        scope,
        config: (config ?? {}) as Record<string, unknown>,
      });
    } else {
      // Use file storage for global agents or when no database
      const now = new Date().toISOString();
      const persisted: PersistedAgent = {
        id,
        roleType,
        name,
        description,
        scope,
        createdAt: now,
        lastActiveAt: now,
        runCount: 0,
        config: config ?? {},
        metrics: {
          tasksCompleted: 0,
          tasksFailed: 0,
          avgResponseTime: 0,
          totalTokens: 0,
        },
      };
      await this.fileStorage.save(persisted);
    }

    const agentInstance = this.toAgentInstance(id, managed);

    // Emit event
    this.emit({ type: 'agent:created', agent: agentInstance });

    debugLog(`[agents] Created agent ${id} with role ${roleType} (scope: ${scope})`);

    return agentInstance;
  }

  async getAgent(id: string, detailed?: boolean): Promise<AgentInstance | AgentDetail | null> {
    const managed = this.agents.get(id);
    if (!managed) {
      return null;
    }

    if (detailed) {
      return this.toAgentDetail(id, managed);
    }

    return this.toAgentInstance(id, managed);
  }

  async listAgents(filters?: {
    roleType?: string;
    status?: AgentRuntimeStatus;
    workflowId?: string;
    offset?: number;
    limit?: number;
  }): Promise<{ agents: AgentInstance[]; total: number }> {
    let entries = Array.from(this.agents.entries());

    // Apply filters
    if (filters?.roleType) {
      entries = entries.filter(
        ([, m]) => m.instance.getMetadata().roleType === filters.roleType
      );
    }

    if (filters?.status) {
      entries = entries.filter(
        ([, m]) => m.instance.getState().status === filters.status
      );
    }

    if (filters?.workflowId) {
      entries = entries.filter(([, m]) => m.workflowId === filters.workflowId);
    }

    const total = entries.length;

    // Apply pagination
    const offset = filters?.offset ?? 0;
    const limit = filters?.limit ?? 100;
    entries = entries.slice(offset, offset + limit);

    const agents = entries.map(([id, managed]) => this.toAgentInstance(id, managed));

    return { agents, total };
  }

  async deleteAgent(id: string): Promise<boolean> {
    const managed = this.agents.get(id);
    if (!managed) {
      // Try to delete from storage even if not in memory
      // First try database
      if (this.dbStore) {
        const deleted = this.dbStore.deleteAgent(id);
        if (deleted) {
          this.emit({ type: 'agent:deleted', id });
          debugLog(`[agents] Deleted agent ${id} from database`);
          return true;
        }
      }
      // Then try file storage
      const deleted = await this.fileStorage.deleteById(id);
      if (deleted) {
        this.emit({ type: 'agent:deleted', id });
        debugLog(`[agents] Deleted agent ${id} from file storage`);
      }
      return deleted;
    }

    // Remove from memory
    this.agents.delete(id);

    // Delete from appropriate storage
    if (managed.scope === 'project' && this.dbStore) {
      this.dbStore.deleteAgent(id);
    } else {
      await this.fileStorage.delete(id, managed.scope);
    }

    // Emit event
    this.emit({ type: 'agent:deleted', id });

    debugLog(`[agents] Deleted agent ${id}`);

    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Agent Execution
  // ─────────────────────────────────────────────────────────────────────────

  async invokeAgent(
    id: string,
    input: Record<string, unknown>,
    options?: {
      workflowId?: string;
      sessionId?: string;
    }
  ): Promise<ExecutionResult> {
    const managed = this.agents.get(id);
    if (!managed) {
      return { success: false, error: `Agent not found: ${id}` };
    }

    const { instance } = managed;
    const state = instance.getState();

    // Check if agent is available
    if (state.status !== 'idle' && state.status !== 'completed') {
      return { success: false, error: `Agent is busy: ${state.status}` };
    }

    // Update workflow association
    if (options?.workflowId) {
      managed.workflowId = options.workflowId;
    }

    // Get or create communication context
    const contextId = options?.workflowId ?? options?.sessionId ?? id;
    const commContext = this.getOrCreateCommunicationContext(contextId);

    // Create LLM executor for this invocation
    let llmExecutor: LLMExecutor;
    if (this.aiService) {
      // Use AI service for real LLM calls
      const systemPrompt = instance.getSystemPrompt();
      const capabilities = instance.getCapabilities();
      const provider = managed.config.provider ?? 'claude';
      const model = managed.config.model ?? 'claude-sonnet-4-20250514';

      llmExecutor = createAIServiceExecutor(
        {
          provider,
          model,
          systemPrompt,
          maxTokens: capabilities.resources?.maxTokensPerTurn ?? 8192,
          cwd: this.projectPath,
          workflowId: options?.workflowId,
          executionId: contextId,
        },
        this.aiService
      );
      debugLog(`[agents] Created AI service executor for agent ${id}`);
    } else {
      // No AI service, use null executor
      llmExecutor = new NullLLMExecutor();
      debugLog(`[agents] Using null executor for agent ${id} (no AI service)`);
    }

    // Build execution context
    const context: ExecutionContext = {
      workflowId: options?.workflowId,
      sessionId: options?.sessionId ?? contextId,
      input,
      sharedMemory: {},
      incomingMessages: await commContext.messageBus.getPending(id),
      sendMessage: async (_to: string, message: AgentMessage) => {
        await commContext.messageBus.send(message);
        this.emit({ type: 'agent:message', message });
      },
      writeSharedMemory: async (key: string, value: unknown) => {
        await commContext.sharedMemory.set(key, value, id);
        this.emit({
          type: 'memory:changed',
          contextId,
          key,
          changeType: 'set',
          value,
          changedBy: id,
        });
      },
      emit: (event) => {
        if (event.type === 'status_change') {
          this.emit({
            type: 'agent:status',
            id,
            status: event.data['status'] as AgentRuntimeStatus,
            action: event.data['action'] as string | undefined,
            error: event.data['error'] as string | undefined,
          });
        }
      },
      llm: llmExecutor,
    };

    // Load shared memory into context
    const memoryEntries = await commContext.sharedMemory.entries();
    for (const entry of memoryEntries) {
      context.sharedMemory[entry.key] = entry.value;
    }

    try {
      // Emit status change
      this.emit({ type: 'agent:status', id, status: 'executing', action: 'Invoking...' });

      // Execute
      await instance.beforeExecute(context);
      const result = await instance.execute(context);
      await instance.afterExecute(context, result);

      // Apply shared memory updates
      if (result.sharedMemoryUpdates) {
        for (const [key, value] of Object.entries(result.sharedMemoryUpdates)) {
          await commContext.sharedMemory.set(key, value, id);
          this.emit({
            type: 'memory:changed',
            contextId,
            key,
            changeType: 'set',
            value,
            changedBy: id,
          });
        }
      }

      // Send outgoing messages
      if (result.outgoingMessages) {
        for (const msg of result.outgoingMessages) {
          await commContext.messageBus.send(msg);
          this.emit({ type: 'agent:message', message: msg });
        }
      }

      // Emit completion status
      this.emit({
        type: 'agent:status',
        id,
        status: result.success ? 'idle' : 'error',
        error: result.error,
      });

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await instance.onError(error instanceof Error ? error : new Error(errorMessage));

      this.emit({ type: 'agent:status', id, status: 'error', error: errorMessage });

      return { success: false, error: errorMessage };
    } finally {
      // Clean up LLM executor session
      if ('cleanup' in llmExecutor && typeof llmExecutor.cleanup === 'function') {
        await llmExecutor.cleanup();
      }
    }
  }

  async getAgentState(id: string): Promise<AgentPersistentState | null> {
    const managed = this.agents.get(id);
    if (!managed) {
      return null;
    }

    return managed.instance.getPersistentState();
  }

  async saveAgentState(id: string): Promise<void> {
    const managed = this.agents.get(id);
    if (!managed) {
      throw new Error(`Agent not found: ${id}`);
    }

    // Persist state to database if available
    if (this.dbStore && managed.scope === 'project') {
      const state = managed.instance.getState();
      const persistentState = managed.instance.getPersistentState();

      // Build context JSON from memory and preferences
      const contextData = {
        memory: persistentState.memory,
        preferences: persistentState.preferences,
      };

      // Update state in database
      this.dbStore.updateAgentState(id, {
        status: state.status,
        currentAction: state.currentAction ?? null,
        contextJson: JSON.stringify(contextData),
      });

      // Update metrics
      this.dbStore.recordRun(id, {
        success: true,
        tokens: state.metrics.totalTokens,
        responseTimeMs: state.metrics.avgResponseTime,
      });

      debugLog(`[agents] Saved state for agent ${id} to database`);
    } else {
      // For file-based storage, update activity
      await this.fileStorage.updateActivity(id, managed.scope);
      debugLog(`[agents] Saved state for agent ${id} to file`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Agent Communication
  // ─────────────────────────────────────────────────────────────────────────

  async sendMessage(
    from: string,
    to: string,
    type: AgentMessage['type'],
    content: string,
    data?: Record<string, unknown>
  ): Promise<string> {
    const message: AgentMessage = {
      from,
      to,
      type,
      content,
      data,
      timestamp: new Date(),
      correlationId: `msg_${++this.messageCounter}`,
    };

    // Find a communication context that has both agents
    // For now, use a global context
    const context = this.getOrCreateCommunicationContext('global');
    const messageId = await context.messageBus.send(message);

    this.emit({ type: 'agent:message', message });

    return messageId;
  }

  async getMessages(agentId: string, pendingOnly?: boolean): Promise<AgentMessage[]> {
    const context = this.getOrCreateCommunicationContext('global');

    if (pendingOnly) {
      return context.messageBus.getPending(agentId);
    }

    // For full message history, we'd need persistence
    return context.messageBus.getPending(agentId);
  }

  async acknowledgeMessage(messageId: string): Promise<void> {
    const context = this.getOrCreateCommunicationContext('global');
    await context.messageBus.acknowledge(messageId);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Shared Memory
  // ─────────────────────────────────────────────────────────────────────────

  async getSharedMemory(
    contextId: string,
    key: string
  ): Promise<{
    value: unknown;
    version: number;
    writtenBy: string;
    writtenAt: Date;
  } | null> {
    const context = this.communicationContexts.get(contextId);
    if (!context) {
      return null;
    }

    const entry = await context.sharedMemory.getEntry(key);
    if (!entry) {
      return null;
    }

    return {
      value: entry.value,
      version: entry.version,
      writtenBy: entry.writtenBy,
      writtenAt: entry.writtenAt,
    };
  }

  async setSharedMemory(
    contextId: string,
    key: string,
    value: unknown,
    agentId: string,
    ttl?: number
  ): Promise<{ version: number }> {
    const context = this.getOrCreateCommunicationContext(contextId);
    await context.sharedMemory.set(key, value, agentId, ttl);

    const entry = await context.sharedMemory.getEntry(key);

    this.emit({
      type: 'memory:changed',
      contextId,
      key,
      changeType: 'set',
      value,
      changedBy: agentId,
    });

    return { version: entry?.version ?? 1 };
  }

  async deleteSharedMemory(
    contextId: string,
    key: string,
    agentId: string
  ): Promise<boolean> {
    const context = this.communicationContexts.get(contextId);
    if (!context) {
      return false;
    }

    const deleted = await context.sharedMemory.delete(key, agentId);

    if (deleted) {
      this.emit({
        type: 'memory:changed',
        contextId,
        key,
        changeType: 'delete',
        changedBy: agentId,
      });
    }

    return deleted;
  }

  async listSharedMemoryKeys(contextId: string): Promise<string[]> {
    const context = this.communicationContexts.get(contextId);
    if (!context) {
      return [];
    }

    return context.sharedMemory.keys();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    // Clear all agents from memory (they're persisted to disk)
    this.agents.clear();
    this.communicationContexts.clear();
    this.initialized = false;
    debugLog('[agents] Agent service shut down');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Event Handling
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Subscribe to agent service events.
   */
  onEvent(handler: AgentServiceEventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
    };
  }

  private emit(event: AgentServiceEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        debugLog(`[agents] Event handler error: ${error}`);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private getOrCreateCommunicationContext(contextId: string): CommunicationContext {
    let context = this.communicationContexts.get(contextId);
    if (!context) {
      context = createCommunicationContext();
      this.communicationContexts.set(contextId, context);
    }
    return context;
  }

  private toAgentInstance(id: string, managed: ManagedAgent): AgentInstance {
    const state = managed.instance.getState();
    const metadata = managed.instance.getMetadata();

    return {
      id,
      roleType: metadata.roleType,
      name: managed.name,
      description: managed.description,
      status: state.status,
      createdAt: state.createdAt.toISOString(),
      lastActiveAt: state.lastActiveAt.toISOString(),
      runCount: state.runCount,
      currentAction: state.currentAction,
      workflowId: managed.workflowId,
      scope: managed.scope,
    };
  }

  private toAgentDetail(id: string, managed: ManagedAgent): AgentDetail {
    const instance = this.toAgentInstance(id, managed);
    const state = managed.instance.getState();
    const capabilities = managed.instance.getCapabilities();
    const metadata = managed.instance.getMetadata();

    return {
      ...instance,
      role: metadata,
      capabilities: capabilities as AgentCapabilities,
      config: managed.config,
      metrics: {
        tasksCompleted: state.metrics.tasksCompleted,
        tasksFailed: state.metrics.tasksFailed,
        avgResponseTime: state.metrics.avgResponseTime,
        totalTokens: state.metrics.totalTokens,
      },
    };
  }
}
