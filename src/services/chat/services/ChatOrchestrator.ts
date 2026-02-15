/**
 * ChatOrchestrator - Main Chat Service Entry Point
 *
 * Coordinates between stores, agents, and context building to handle
 * chat conversations. This is the primary interface for chat operations.
 */

import { Database } from 'bun:sqlite';
import { debugLog } from '../../../debug.ts';
import { MessageStore } from '../stores/MessageStore.ts';
import { SessionStore } from '../stores/SessionStore.ts';
import { PermissionStore } from '../stores/PermissionStore.ts';
import { TodoStore } from '../stores/TodoStore.ts';
import { AgentManager, type AgentExecutor } from './AgentManager.ts';
import { ContextBuilder, type IBuiltContext, type IBuildContextOptions } from './ContextBuilder.ts';
import { CompactionService, type IStoredCompaction, type ICompactionSelection } from './CompactionService.ts';
import type { IAgent, IAgentConfig } from '../types/agents.ts';
import type { ISessionMessage, IAssistantMessage, IAgentMessage } from '../types/messages.ts';
import type { IPermission, IGrantPermissionOptions, PermissionScope } from '../types/permissions.ts';
import { loadModels, type ModelsConfig, type ModelInfo } from '../../ai/model-registry.ts';

/**
 * Options for creating a ChatOrchestrator.
 */
export interface IChatOrchestratorOptions {
  /** Database instance */
  db: Database;
  /** Default model to use */
  defaultModel?: string;
  /** Default provider */
  defaultProvider?: string;
  /** Maximum context tokens */
  maxContextTokens?: number;
}

/**
 * Options for sending a message.
 */
export interface ISendMessageOptions {
  /** Session ID */
  sessionId: string;
  /** Message content */
  content: string;
  /** Target agent ID (optional, parsed from @mentions if not specified) */
  agentId?: string;
  /** Additional context to include */
  additionalContext?: string;
  /** Custom system prompt for this message */
  systemPrompt?: string;
}

/**
 * Result of sending a message.
 */
export interface ISendMessageResult {
  /** The user message that was saved */
  userMessage: ISessionMessage;
  /** The assistant response */
  assistantMessage: IAssistantMessage | IAgentMessage;
  /** Context that was built for the request */
  context: IBuiltContext;
  /** Agent that handled the message */
  agent: IAgent;
  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * Options for creating a session via the orchestrator.
 */
export interface IOrchestratorSessionOptions {
  /** Custom session ID (generated if not provided) */
  id?: string;
  /** Session title */
  title?: string;
  /** System prompt */
  systemPrompt?: string;
  /** Provider (default from options) */
  provider?: string;
  /** Model (default from options) */
  model?: string;
}

/** Fallback defaults if model registry fails to load */
const FALLBACK_MODEL = 'claude-opus-4-5-20251101';
const FALLBACK_PROVIDER = 'anthropic';

/**
 * ChatOrchestrator - main service class.
 */
export class ChatOrchestrator {
  readonly messageStore: MessageStore;
  readonly sessionStore: SessionStore;
  readonly permissionStore: PermissionStore;
  readonly todoStore: TodoStore;
  readonly agentManager: AgentManager;
  readonly contextBuilder: ContextBuilder;
  readonly compactionService: CompactionService;

  private db: Database;
  private defaultModel: string;
  private defaultProvider: string;
  private maxContextTokens: number;
  private executor: AgentExecutor | null = null;

  /** Cached models config from registry */
  private modelsConfig: ModelsConfig | null = null;
  /** Whether models have been loaded */
  private modelsLoaded = false;

  constructor(options: IChatOrchestratorOptions) {
    const { db, defaultModel = FALLBACK_MODEL, defaultProvider = FALLBACK_PROVIDER, maxContextTokens = 100000 } = options;

    this.db = db;

    // Initialize stores
    this.messageStore = new MessageStore(db);
    this.sessionStore = new SessionStore(db);
    this.permissionStore = new PermissionStore(db);
    this.todoStore = new TodoStore(db);

    // Initialize services
    this.agentManager = new AgentManager();
    this.contextBuilder = new ContextBuilder(this.messageStore, this.sessionStore);
    this.compactionService = new CompactionService(this.messageStore, this.sessionStore, db);

    // Store defaults
    this.defaultModel = defaultModel;
    this.defaultProvider = defaultProvider;
    this.maxContextTokens = maxContextTokens;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Model Registry Integration
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Initialize the orchestrator by loading models from the registry.
   * This should be called after construction to fetch available models.
   * Falls back to hardcoded defaults if the registry fails.
   */
  async initialize(): Promise<void> {
    if (this.modelsLoaded) return;

    try {
      this.modelsConfig = await loadModels();
      this.modelsLoaded = true;

      // Update defaults from registry if available
      if (this.modelsConfig.providerDefaults) {
        const registryDefault = this.modelsConfig.providerDefaults[this.defaultProvider as keyof typeof this.modelsConfig.providerDefaults];
        if (registryDefault) {
          this.defaultModel = registryDefault;
        }
      }
    } catch (error) {
      debugLog(`[ChatOrchestrator] Failed to load models from registry, using fallback defaults: ${error}`);
      // Keep using constructor defaults
      this.modelsLoaded = true;
    }
  }

  /**
   * Get the current models configuration.
   * Returns null if not yet initialized.
   */
  getModelsConfig(): ModelsConfig | null {
    return this.modelsConfig;
  }

  /**
   * Get all available models.
   */
  getAvailableModels(): ModelInfo[] {
    return this.modelsConfig?.models ?? [];
  }

  /**
   * Get models for a specific provider.
   */
  getModelsForProvider(provider: string): ModelInfo[] {
    return this.getAvailableModels().filter((m) => m.provider === provider);
  }

  /**
   * Get the default model ID for a provider.
   */
  getProviderDefault(provider: string): string | undefined {
    return this.modelsConfig?.providerDefaults[provider as keyof ModelsConfig['providerDefaults']];
  }

  /**
   * Get a model by ID.
   */
  getModel(modelId: string): ModelInfo | undefined {
    return this.getAvailableModels().find((m) => m.id === modelId);
  }

  /**
   * Get the current default model.
   */
  getDefaultModel(): string {
    return this.defaultModel;
  }

  /**
   * Get the current default provider.
   */
  getDefaultProvider(): string {
    return this.defaultProvider;
  }

  /**
   * Set the default model.
   */
  setDefaultModel(modelId: string): void {
    this.defaultModel = modelId;
  }

  /**
   * Set the default provider and optionally update the model to that provider's default.
   */
  setDefaultProvider(provider: string, updateModel = true): void {
    this.defaultProvider = provider;
    if (updateModel) {
      const providerDefault = this.getProviderDefault(provider);
      if (providerDefault) {
        this.defaultModel = providerDefault;
      }
    }
  }

  /**
   * Check if models have been loaded.
   */
  isInitialized(): boolean {
    return this.modelsLoaded;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Agent & Executor
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Set the agent executor function.
   * This must be called before agents can process messages.
   */
  setExecutor(executor: AgentExecutor): void {
    this.executor = executor;
    this.agentManager.setExecutor(executor);
  }

  /**
   * Register an agent.
   */
  registerAgent(config: IAgentConfig): IAgent {
    return this.agentManager.registerAgent(config);
  }

  /**
   * Create a new chat session.
   */
  createSession(options: IOrchestratorSessionOptions = {}): string {
    const session = this.sessionStore.create({
      id: options.id ?? crypto.randomUUID(),
      title: options.title ?? null,
      systemPrompt: options.systemPrompt ?? null,
      provider: options.provider ?? this.defaultProvider,
      model: options.model ?? this.defaultModel,
    });

    return session.id;
  }

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string) {
    return this.sessionStore.get(sessionId);
  }

  /**
   * List all sessions.
   */
  listSessions(options?: { provider?: string; limit?: number; offset?: number }) {
    return this.sessionStore.list(options);
  }

  /**
   * Delete a session.
   */
  deleteSession(sessionId: string): boolean {
    return this.sessionStore.delete(sessionId);
  }

  /**
   * Send a message and get a response.
   * This is the main method for chat interactions.
   */
  async sendMessage(options: ISendMessageOptions): Promise<ISendMessageResult> {
    const startTime = Date.now();
    const { sessionId, content, additionalContext, systemPrompt } = options;

    // Ensure session exists
    const session = this.sessionStore.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Parse @mentions from content
    const { mentions, cleanText } = this.agentManager.parseMentions(content);

    // Determine target agent
    let agent: IAgent;
    if (options.agentId) {
      const specified = this.agentManager.getAgent(options.agentId);
      if (!specified) {
        throw new Error(`Agent ${options.agentId} not found`);
      }
      agent = specified;
    } else if (mentions.length > 0 && mentions[0]) {
      // Use first mentioned agent
      const firstMention = mentions[0];
      const mentioned = this.agentManager.getAgent(firstMention.agentId);
      if (!mentioned) {
        throw new Error(`Mentioned agent ${firstMention.agentId} not found`);
      }
      agent = mentioned;
    } else {
      // Use primary agent
      agent = this.agentManager.getPrimaryAgent();
    }

    // Save the user message
    const userMessage = this.messageStore.create({
      id: crypto.randomUUID(),
      sessionId,
      role: 'user',
      content: content, // Save original with mentions
    });

    // Build context
    const context = this.contextBuilder.build({
      sessionId,
      agent,
      maxTokens: this.maxContextTokens,
      systemPrompt,
      additionalContext,
      appendMessages: [{ role: 'user', content: cleanText }],
    });

    // Execute the agent
    if (!this.executor) {
      throw new Error('No agent executor configured. Call setExecutor() first.');
    }

    this.agentManager.updateStatus(agent.id, 'thinking');

    try {
      const response = await this.executor(agent, cleanText, {
        sessionId,
        delegatedFrom: undefined,
      });

      this.agentManager.updateStatus(agent.id, 'idle');

      // Save the assistant message
      const assistantMessage = this.messageStore.create({
        id: response.id ?? crypto.randomUUID(),
        sessionId,
        role: 'assistant',
        content: typeof response.content === 'string'
          ? response.content
          : JSON.stringify(response.content),
        model: response.model ?? agent.model ?? this.defaultModel,
        inputTokens: response.usage?.inputTokens ?? null,
        outputTokens: response.usage?.outputTokens ?? null,
        durationMs: response.durationMs ?? null,
      });

      const durationMs = Date.now() - startTime;

      return {
        userMessage: this.messageStore.toSessionMessage(userMessage),
        assistantMessage: {
          ...this.messageStore.toSessionMessage(assistantMessage),
          role: 'assistant',
        } as IAssistantMessage,
        context,
        agent,
        durationMs,
      };
    } catch (error) {
      this.agentManager.updateStatus(agent.id, 'error');
      throw error;
    }
  }

  /**
   * Get messages for a session.
   */
  getMessages(sessionId: string, options?: { limit?: number; after?: number }) {
    return this.messageStore.listBySession(sessionId, options);
  }

  /**
   * Search messages.
   */
  searchMessages(query: string, options?: { sessionId?: string; limit?: number }) {
    return this.messageStore.search(query, options);
  }

  /**
   * Build context without sending a message (useful for preview).
   */
  buildContext(options: IBuildContextOptions): IBuiltContext {
    return this.contextBuilder.build(options);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Permission methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Check if a tool action is permitted.
   */
  checkPermission(toolName: string, input: string, sessionId?: string) {
    return this.permissionStore.checkPermission(toolName, input, sessionId);
  }

  /**
   * Grant a permission.
   */
  grantPermission(options: IGrantPermissionOptions): IPermission {
    return this.permissionStore.grantPermission(options);
  }

  /**
   * Revoke a permission.
   */
  revokePermission(id: string): void {
    this.permissionStore.revokePermission(id);
  }

  /**
   * List permissions.
   */
  listPermissions(options?: { sessionId?: string; toolName?: string; scope?: PermissionScope }) {
    return this.permissionStore.listPermissions(options);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Todo methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get todos for a session.
   */
  getTodos(sessionId?: string | null) {
    return this.todoStore.list({ sessionId });
  }

  /**
   * Replace all todos for a session.
   */
  replaceTodos(sessionId: string | null, todos: Parameters<typeof this.todoStore.replaceForSession>[1]) {
    return this.todoStore.replaceForSession(sessionId, todos);
  }

  /**
   * Update a todo's status.
   */
  updateTodoStatus(todoId: string, status: 'pending' | 'in_progress' | 'completed') {
    return this.todoStore.updateStatus(todoId, status);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Agent methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * List all registered agents.
   */
  listAgents(): IAgent[] {
    return this.agentManager.listAgents();
  }

  /**
   * Get an agent by ID.
   */
  getAgent(agentId: string): IAgent | undefined {
    return this.agentManager.getAgent(agentId);
  }

  /**
   * Parse @mentions from text.
   */
  parseMentions(text: string) {
    return this.agentManager.parseMentions(text);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Utility methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get statistics for a session.
   */
  getSessionStats(sessionId: string) {
    const messageCount = this.messageStore.countBySession(sessionId);
    const usage = this.messageStore.getUsageStats(sessionId);
    const todoStats = this.todoStore.getStats(sessionId);
    const contextSummary = this.contextBuilder.getContextSummary(sessionId);

    return {
      messageCount,
      usage,
      todos: todoStats,
      context: contextSummary,
    };
  }

  /**
   * Get overall statistics.
   */
  getStats() {
    return {
      sessionCount: this.sessionStore.count(),
      agentCount: this.agentManager.size,
      permissionCount: this.permissionStore.count(),
      todoCount: this.todoStore.count(),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Compaction methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Select messages for compaction with agent-awareness.
   */
  selectMessagesForCompaction(
    sessionId: string,
    options?: { keepRecentCount?: number; maxTokens?: number }
  ): ICompactionSelection {
    return this.compactionService.selectMessagesForCompaction(sessionId, options);
  }

  /**
   * Create a compaction record.
   */
  createCompaction(options: {
    sessionId: string;
    summary: string;
    startMessageId: string;
    endMessageId: string;
    messageCount: number;
    tokensBefore?: number;
    tokensAfter?: number;
    agentIds?: string[];
  }): IStoredCompaction {
    return this.compactionService.createCompaction(options);
  }

  /**
   * Get active compactions for a session.
   */
  getActiveCompactions(sessionId: string): IStoredCompaction[] {
    return this.compactionService.getActiveCompactions(sessionId);
  }

  /**
   * Expand a compaction to show original messages.
   */
  expandCompaction(compactionId: string): void {
    this.compactionService.expandCompaction(compactionId);
  }

  /**
   * Collapse a compaction to use the summary.
   */
  collapseCompaction(compactionId: string): void {
    this.compactionService.collapseCompaction(compactionId);
  }

  /**
   * Build curated context with compactions applied.
   */
  buildCuratedContext(sessionId: string, options?: { includeExpanded?: boolean }) {
    return this.compactionService.buildCuratedContext(sessionId, options);
  }

  /**
   * Get the compaction prompt for generating summaries.
   */
  getCompactionPrompt(): string {
    return this.compactionService.getCompactionPrompt();
  }

  /**
   * Build conversation text for compaction with agent attribution.
   */
  buildConversationTextForCompaction(sessionId: string, messageIds?: string[]): string {
    let messages = this.messageStore.listBySession(sessionId, { limit: 1000 });

    // Filter to specific message IDs if provided
    if (messageIds && messageIds.length > 0) {
      const idSet = new Set(messageIds);
      messages = messages.filter(m => idSet.has(m.id));
    }

    return this.compactionService.buildConversationText(messages);
  }

  /**
   * Notify agents that context has been compacted.
   * Adds a system message to the session for agent awareness.
   */
  notifyAgentsOfCompaction(
    sessionId: string,
    compaction: IStoredCompaction,
    affectedAgentNames: string[]
  ): void {
    const content = `[Context Compaction Notice] ${compaction.messageCount} messages have been compacted into a summary. ` +
      `Agents affected: ${affectedAgentNames.length > 0 ? affectedAgentNames.join(', ') : 'none'}. ` +
      `Tokens reduced from ~${compaction.tokensBefore || 'unknown'} to ~${compaction.tokensAfter || 'unknown'}.`;

    this.messageStore.create({
      id: `compaction-notice-${compaction.id}`,
      sessionId,
      role: 'system',
      content,
    });
  }
}

/**
 * Create a new ChatOrchestrator instance.
 */
export function createChatOrchestrator(options: IChatOrchestratorOptions): ChatOrchestrator {
  return new ChatOrchestrator(options);
}
