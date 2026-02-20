/**
 * AI Service ECP Adapter
 *
 * Maps JSON-RPC 2.0 methods to AIService operations.
 * This adapter handles the protocol layer, allowing the service
 * to be accessed via ECP.
 */

import { debugLog } from '../../debug.ts';
import type { LocalAIService } from './local.ts';
import type {
  CreateSessionOptions,
  SendMessageOptions,
  ChatMessage,
  MessageRole,
  AIResponse,
  AIProviderType,
} from './types.ts';
import type { HandlerResult, NotificationHandler } from '../../protocol/types.ts';
import {
  validateECPParams,
  AIProviderParamsSchema,
  AISessionCreateParamsSchema,
  AISessionIdParamsSchema,
  AIMessageSendParamsSchema,
  AIToolExecuteParamsSchema,
  AIPermissionApproveParamsSchema,
  AIPermissionDenyParamsSchema,
  AIAutoApprovedToolsParamsSchema,
  AIRemoveApprovalParamsSchema,
  AIMiddlewareEnableParamsSchema,
  AIAddMessageParamsSchema,
  AITodoWriteParamsSchema,
  AITodoGetParamsSchema,
} from '../../protocol/schemas.ts';
import type { ChatOrchestrator } from '../chat/services/ChatOrchestrator.ts';
import type { IAgent, IAgentConfig, AgentRole } from '../chat/types/agents.ts';
import { loadAgents, updateAgentInConfig } from '../chat/config/agent-loader.ts';
import type { LocalAgentService } from '../agents/local.ts';
import type { AgentInstance, AgentDetail } from '../agents/types.ts';
import { AgentSessionRegistry } from './agent-session-registry.ts';
import type { ChatStorage } from '../chat/storage.ts';
import type { PersonaService } from '../chat/services/PersonaService.ts';
import type { AgentService as ChatAgentService } from '../chat/services/AgentService.ts';

/**
 * ECP error codes for AI service.
 */
export const AIErrorCodes = {
  SessionNotFound: -32010,
  ProviderNotFound: -32011,
  ProviderUnavailable: -32012,
  InvalidRequest: -32602,
  InternalError: -32603,
} as const;

/**
 * Parse raw provider API error messages into user-friendly strings.
 *
 * Provider errors arrive in formats like:
 *   "Anthropic API error 400: {\"type\":\"error\",\"error\":{...\"message\":\"Your credit balance...\"}}"
 *   "OpenAI API error 429: {\"error\":{\"message\":\"Rate limit exceeded\"}}"
 *   "Gemini API error 403: {\"error\":{\"message\":\"API key not valid\"}}"
 *   "Anthropic API key not found" (simple string)
 *   "Claude CLI exited with code 1: error text"
 *
 * This extracts the human-readable message from embedded JSON when possible.
 */
function parseProviderError(raw: string): string {
  // Try to find embedded JSON in the error string
  const jsonStart = raw.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart));
      // Anthropic format: { error: { message: "..." } }
      // OpenAI format:    { error: { message: "..." } }
      // Gemini format:    { error: { message: "..." } }
      const msg = parsed?.error?.message || parsed?.message;
      if (msg && typeof msg === 'string') {
        // Extract provider name from prefix (e.g. "Anthropic API error 400:")
        const prefix = raw.slice(0, jsonStart).trim().replace(/:$/, '');
        const providerMatch = prefix.match(/^(\w+)\s+API\s+error\s+(\d+)/i);
        if (providerMatch) {
          return `${providerMatch[1]} (${providerMatch[2]}): ${msg}`;
        }
        return msg;
      }
    } catch {
      // JSON parse failed, fall through
    }
  }
  return raw;
}

/**
 * AI Service ECP Adapter.
 *
 * Maps JSON-RPC methods to AIService operations:
 *
 * - ai/providers -> getAvailableProviders()
 * - ai/provider/capabilities -> getProviderCapabilities()
 * - ai/provider/available -> isProviderAvailable()
 * - ai/provider/models -> getAvailableModels()
 * - ai/session/create -> createSession()
 * - ai/session/get -> getSession()
 * - ai/session/list -> listSessions()
 * - ai/session/delete -> deleteSession()
 * - ai/session/clear -> clearSession()
 * - ai/message/send -> sendMessage()
 * - ai/message/stream -> sendMessageStreaming()
 * - ai/message/cancel -> cancelMessage()
 * - ai/message/add -> addMessage()
 * - ai/messages -> getMessages()
 * - ai/tools -> getAvailableTools()
 * - ai/tools/ecp -> getECPTools()
 * - ai/tool/execute -> executeTool()
 * - ai/permission/approve -> approveToolPermission(scope, folderPath)
 * - ai/permission/deny -> denyToolPermission()
 * - ai/permission/remove -> removeApproval(scope, sessionId, folderPath, toolName)
 * - ai/permissions -> getPendingPermissions()
 * - ai/permissions/auto-approved -> setAutoApprovedTools()
 * - ai/permissions/session -> getSessionApprovals(sessionId)
 * - ai/permissions/session/clear -> clearSessionApprovals(sessionId)
 * - ai/permissions/folder -> getFolderApprovals()
 * - ai/permissions/global -> getGlobalApprovals()
 * - ai/middleware/list -> getMiddleware()
 * - ai/middleware/enable -> setMiddlewareEnabled()
 * - ai/pipeline/config -> getPipelineConfig()
 * - ai/todo/write -> setTodos(sessionId, todos)
 * - ai/todo/get -> getTodos(sessionId)
 */
/**
 * AI todo item for task tracking.
 */
export interface AITodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export class AIServiceAdapter {
  private service: LocalAIService;
  private notificationHandler?: NotificationHandler;
  /** Todos per session (sessionId -> todos) */
  private sessionTodos: Map<string, AITodoItem[]> = new Map();
  /** Workspace root for tool execution (startup default) */
  private workspaceRoot: string;
  /** Per-request workspace path resolver (multi-workspace support) */
  private workspacePathResolver: (() => string) | null = null;
  /** Chat orchestrator for multi-agent support */
  private chatOrchestrator: ChatOrchestrator | null = null;
  /** Agent service for studio agent registry */
  private agentService: LocalAgentService | null = null;
  /** Whether agents have been loaded from config */
  private agentsLoaded = false;
  /** Fallback agent storage when orchestrator is not available */
  private fallbackAgents: Map<string, IAgentConfig> = new Map();
  /** Primary agent ID from fallback storage */
  private fallbackPrimaryAgentId: string | null = null;
  /** Agent session registry for per-agent AI sessions */
  private agentSessionRegistry: AgentSessionRegistry | null = null;
  /** Chat storage for transcript context */
  private chatStorage: ChatStorage | null = null;
  /** Persona service for resolving persona references */
  private personaService: PersonaService | null = null;
  /** Chat agent service for database agent lookups */
  private chatAgentService: ChatAgentService | null = null;
  /** Callback to get the default AI model from settings */
  private getDefaultModel: (() => string) | null = null;
  /** ECP request function for recording tool calls to chat DB */
  private ecpRequest: ((method: string, params?: unknown) => Promise<unknown>) | null = null;

  constructor(service: LocalAIService, workspaceRoot?: string) {
    this.service = service;
    this.workspaceRoot = workspaceRoot || process.cwd();
    this.setupEventHandlers();
  }

  /**
   * Set a per-request workspace path resolver for multi-workspace support.
   * When set, this function is called instead of using the static workspaceRoot.
   */
  setWorkspacePathResolver(fn: () => string): void {
    this.workspacePathResolver = fn;
  }

  /** Get the effective workspace path (per-request resolver or startup default). */
  private getWorkspacePath(): string {
    return this.workspacePathResolver?.() ?? this.workspaceRoot;
  }

  /**
   * Set the ChatOrchestrator for multi-agent support.
   * This should be called after construction to enable agent features.
   * If agents have already been loaded, they will be re-registered with the new orchestrator.
   */
  setChatOrchestrator(orchestrator: ChatOrchestrator): void {
    this.chatOrchestrator = orchestrator;

    // Re-register any already-loaded agents with the new orchestrator
    if (this.agentsLoaded && this.fallbackAgents.size > 0) {
      for (const agent of this.fallbackAgents.values()) {
        orchestrator.registerAgent(agent);
      }
      console.log(`[AIServiceAdapter] Re-registered ${this.fallbackAgents.size} agents with new orchestrator`);
    }

    debugLog('[AIServiceAdapter] ChatOrchestrator set');
  }

  /**
   * Get the ChatOrchestrator (if set).
   */
  getChatOrchestrator(): ChatOrchestrator | null {
    return this.chatOrchestrator;
  }

  /**
   * Set the AgentService for unified agent registry.
   * When set, studio agents are merged into the chat agent list.
   */
  setAgentService(service: LocalAgentService): void {
    this.agentService = service;
    debugLog('[AIServiceAdapter] AgentService set');
  }

  /**
   * Set the ChatStorage for transcript context building.
   * This enables per-agent sessions to receive context about
   * what happened in the conversation while they were inactive.
   */
  setChatStorage(storage: ChatStorage): void {
    this.chatStorage = storage;

    // Now that we have all dependencies, create the agent session registry
    this.agentSessionRegistry = new AgentSessionRegistry(
      this.service,
      async (agentId) => {
        const config = this.chatOrchestrator?.agentManager.getAgent(agentId)
                    ?? this.fallbackAgents.get(agentId);
        if (!config) return undefined;

        // Resolve persona compressed text if agent has personaId in database
        if (!config.personaCompressed && this.personaService && this.chatAgentService) {
          const dbAgent = await Promise.resolve(this.chatAgentService.getAgent(agentId));
          if (dbAgent?.personaId) {
            const persona = await Promise.resolve(this.personaService.getPersona(dbAgent.personaId));
            if (persona?.compressed) {
              return { ...config, personaCompressed: persona.compressed, agency: dbAgent.agency ?? config.agency };
            }
            if (dbAgent.agency) {
              return { ...config, agency: dbAgent.agency };
            }
          }
        }

        return config;
      },
      this.getWorkspacePath(),
    );
    // Forward the workspace path resolver to the registry
    if (this.workspacePathResolver) {
      this.agentSessionRegistry.setWorkspacePathResolver(this.workspacePathResolver);
    }

    debugLog('[AIServiceAdapter] ChatStorage set, AgentSessionRegistry initialized');
  }

  /**
   * Set the PersonaService for resolving persona references.
   * When set, agents with personaId get their persona's compressed text injected.
   */
  setPersonaService(service: PersonaService): void {
    this.personaService = service;
    debugLog('[AIServiceAdapter] PersonaService set');
  }

  /**
   * Set the ChatAgentService for database agent lookups.
   * Used to resolve persona_id from stored agent records.
   */
  setChatAgentService(service: ChatAgentService): void {
    this.chatAgentService = service;
    debugLog('[AIServiceAdapter] ChatAgentService set');
  }

  /**
   * Set a callback to retrieve the default AI model from settings.
   */
  setDefaultModelGetter(getter: () => string): void {
    this.getDefaultModel = getter;
  }

  /**
   * Set the ECP request function for recording tool calls to the chat DB.
   */
  setECPRequest(fn: (method: string, params?: unknown) => Promise<unknown>): void {
    this.ecpRequest = fn;
    this.service.setEcpRequest(fn);
    debugLog('[AIServiceAdapter] ECP request function set');
  }

  /**
   * Send a message with streaming, awaiting completion.
   * Unlike the ECP endpoint which returns immediately, this waits for the full response.
   * Useful for workflow execution where we need streaming callbacks but also need to wait.
   *
   * @param options - Message options including sessionId and content
   * @param onDelta - Callback for text streaming deltas
   * @param onPermissionRequest - Callback when a tool needs user permission
   * @param onToolExecution - Callback for tool execution events (started/completed)
   */
  async sendMessageWithStreaming(
    options: SendMessageOptions,
    onDelta?: (delta: string, accumulated: string) => void,
    onPermissionRequest?: (request: {
      id: string;
      toolName: string;
      input: Record<string, unknown>;
      description: string;
    }) => void,
    onToolExecution?: (event: {
      type: 'started' | 'completed';
      toolId: string;
      toolName: string;
      input?: unknown;
      output?: unknown;
      success?: boolean;
      error?: string;
      autoApproved?: boolean;
      approvalScope?: string;
    }) => void,
    onIteration?: (event: {
      type: 'start' | 'complete';
      iteration: number;
      iterationContent?: string;
      hasToolUse?: boolean;
    }) => void
  ): Promise<AIResponse> {
    let accumulated = '';
    const toolNames = new Map<string, string>();

    const response = await this.service.sendMessageStreaming(options, (event) => {
      if (event.type === 'content_block_delta' && 'delta' in event) {
        const delta = event.delta as { type: string; text?: string };
        if (delta.type === 'text_delta' && delta.text) {
          accumulated += delta.text;
          onDelta?.(delta.text, accumulated);
        }
      } else if (event.type === 'tool_use_request' && onPermissionRequest) {
        // Forward permission request events to the caller
        const req = event as unknown as {
          id: string;
          name: string;
          input: Record<string, unknown>;
          description: string;
        };
        onPermissionRequest({
          id: req.id,
          toolName: req.name,
          input: req.input,
          description: req.description,
        });
      } else if (event.type === 'tool_use_started' && onToolExecution) {
        // Forward tool started events to the caller
        const evt = event as unknown as {
          toolUseId: string;
          toolName: string;
          input: unknown;
          autoApproved: boolean;
          approvalScope?: string;
        };
        toolNames.set(evt.toolUseId, evt.toolName);
        onToolExecution({
          type: 'started',
          toolId: evt.toolUseId,
          toolName: evt.toolName,
          input: evt.input,
          autoApproved: evt.autoApproved,
          approvalScope: evt.approvalScope,
        });
      } else if (event.type === 'tool_use_result' && onToolExecution) {
        // Forward tool result events to the caller
        const evt = event as unknown as {
          toolUseId: string;
          success: boolean;
          result: unknown;
        };
        onToolExecution({
          type: 'completed',
          toolId: evt.toolUseId,
          toolName: toolNames.get(evt.toolUseId) || '',
          output: evt.result,
          success: evt.success,
          error: evt.success ? undefined : String(evt.result),
        });
      } else if (event.type === 'iteration_start' && onIteration) {
        // Forward iteration start events (new iteration beginning after tool use)
        const evt = event as unknown as { iteration: number; previousIterationContent?: string };
        // Reset accumulated content for the new iteration
        accumulated = '';
        onIteration({
          type: 'start',
          iteration: evt.iteration,
        });
      } else if (event.type === 'iteration_complete' && onIteration) {
        // Forward iteration complete events (iteration finished, possibly with tool use)
        const evt = event as unknown as { iteration: number; iterationContent: string; hasToolUse: boolean };
        onIteration({
          type: 'complete',
          iteration: evt.iteration,
          iterationContent: evt.iterationContent,
          hasToolUse: evt.hasToolUse,
        });
      }
    });

    return response;
  }

  /**
   * Load agents from configuration files.
   * Call this during initialization to register default agents.
   * Works with or without ChatOrchestrator - agents are stored in fallback
   * storage when orchestrator is not available.
   */
  async loadAgentsFromConfig(): Promise<void> {
    console.log('[AIServiceAdapter] loadAgentsFromConfig called, agentsLoaded:', this.agentsLoaded);
    if (this.agentsLoaded) return;

    try {
      const wsPath = this.getWorkspacePath();
      console.log('[AIServiceAdapter] Loading agents from workspace:', wsPath || '(no workspace)');
      const result = await loadAgents(wsPath);
      console.log('[AIServiceAdapter] loadAgents returned:', result.agents.length, 'agents');

      // Register each agent with orchestrator (if available) and fallback storage
      for (const agentConfig of result.agents) {
        // Always store in fallback
        this.fallbackAgents.set(agentConfig.id, agentConfig);
        console.log('[AIServiceAdapter] Added to fallback:', agentConfig.name);

        // Register with orchestrator if available
        if (this.chatOrchestrator) {
          this.chatOrchestrator.registerAgent(agentConfig);
          console.log('[AIServiceAdapter] Registered with orchestrator:', agentConfig.name);
        }
      }

      // Store primary agent ID
      this.fallbackPrimaryAgentId = result.primaryAgentId;

      // Log any warnings
      for (const warning of result.warnings) {
        console.warn('[AIServiceAdapter] Agent config warning:', warning);
      }

      const sources = result.sources.length > 0 ? result.sources.join(', ') : 'built-in defaults';
      console.log(`[AIServiceAdapter] Loaded ${result.agents.length} agents from: ${sources}`);
      debugLog(`[AIServiceAdapter] Loaded ${result.agents.length} agents from: ${sources}`);

      // Update agent session registry with available agents for delegation roster
      if (this.agentSessionRegistry) {
        this.agentSessionRegistry.setAvailableAgents(
          result.agents.map(a => ({
            id: a.id,
            name: a.name,
            role: a.role,
            description: a.description ?? undefined,
          }))
        );
      }

      this.agentsLoaded = true;
    } catch (error) {
      console.error('[AIServiceAdapter] Failed to load agent config:', error);
      // Don't fail - fallback agents may still be available
    }
  }

  /**
   * Set handler for outgoing notifications.
   */
  setNotificationHandler(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  /**
   * Handle an incoming ECP request.
   */
  async handleRequest(method: string, params: unknown): Promise<HandlerResult> {
    debugLog(`[AIServiceAdapter] Handling request: ${method}`);

    try {
      return await this.dispatch(method, params);
    } catch (error) {
      debugLog(`[AIServiceAdapter] Error handling ${method}: ${error}`);
      return {
        error: {
          code: AIErrorCodes.InternalError,
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  }

  /**
   * Dispatch a method to the appropriate handler.
   */
  private async dispatch(method: string, params: unknown): Promise<HandlerResult> {
    switch (method) {
      // Provider management
      case 'ai/providers':
        return this.handleGetProviders();
      case 'ai/provider/capabilities':
        return this.handleGetProviderCapabilities(params);
      case 'ai/provider/available':
        return this.handleIsProviderAvailable(params);
      case 'ai/provider/models':
        return this.handleGetAvailableModels(params);

      // Session management
      case 'ai/session/create':
        return this.handleCreateSession(params);
      case 'ai/session/get':
        return this.handleGetSession(params);
      case 'ai/session/list':
        return this.handleListSessions();
      case 'ai/session/delete':
        return this.handleDeleteSession(params);
      case 'ai/session/clear':
        return this.handleClearSession(params);

      // Messaging
      case 'ai/message/send':
        return this.handleSendMessage(params);
      case 'ai/message/stream':
        return this.handleSendMessageStreaming(params);
      case 'ai/message/cancel':
        return this.handleCancelMessage(params);
      case 'ai/message/add':
        return this.handleAddMessage(params);
      case 'ai/messages':
        return this.handleGetMessages(params);

      // Tools
      case 'ai/tools':
        return this.handleGetTools();
      case 'ai/tools/ecp':
        return this.handleGetECPTools();
      case 'ai/tool/execute':
        return this.handleExecuteTool(params);

      // Permissions
      case 'ai/permission/approve':
        return this.handleApprovePermission(params);
      case 'ai/permission/deny':
        return this.handleDenyPermission(params);
      case 'ai/permissions':
        return this.handleGetPendingPermissions();
      case 'ai/permissions/auto-approved':
        return this.handleSetAutoApprovedTools(params);
      case 'ai/permissions/session':
        return this.handleGetSessionApprovals(params);
      case 'ai/permissions/folder':
        return this.handleGetFolderApprovals();
      case 'ai/permissions/global':
        return this.handleGetGlobalApprovals();
      case 'ai/permissions/session/clear':
        return this.handleClearSessionApprovals(params);
      case 'ai/permission/remove':
        return this.handleRemoveApproval(params);

      // Middleware
      case 'ai/middleware/list':
        return this.handleGetMiddleware();
      case 'ai/middleware/enable':
        return this.handleSetMiddlewareEnabled(params);
      case 'ai/pipeline/config':
        return this.handleGetPipelineConfig();

      // Todos
      case 'ai/todo/write':
        return this.handleTodoWrite(params);
      case 'ai/todo/get':
        return this.handleGetTodos(params);

      // Agent management
      case 'ai/agent/list':
        return this.handleListAgents();
      case 'ai/agent/get':
        return this.handleGetAgent(params);
      case 'ai/agent/status':
        return this.handleGetAgentStatus(params);
      case 'ai/agent/update':
        return this.handleUpdateAgent(params);
      case 'ai/agent/config/reload':
        return this.handleReloadAgents();
      case 'ai/session/agents':
        return this.handleGetSessionAgents(params);
      case 'ai/session/agent/add':
        return this.handleAddSessionAgent(params);
      case 'ai/session/agent/remove':
        return this.handleRemoveSessionAgent(params);
      case 'ai/mention/suggest':
        return this.handleMentionSuggest(params);

      // Persona management
      case 'ai/persona/list':
        return this.handleListPersonas(params);
      case 'ai/persona/get':
        return this.handleGetPersona(params);
      case 'ai/persona/create':
        return this.handleCreatePersona(params);
      case 'ai/persona/update':
        return this.handleUpdatePersona(params);
      case 'ai/persona/delete':
        return this.handleDeletePersona(params);
      case 'ai/persona/compress':
        return this.handleCompressPersona(params);

      default:
        return {
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
        };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Provider Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private handleGetProviders(): HandlerResult {
    const providers = this.service.getAvailableProviders();
    return { result: { providers } };
  }

  private handleGetProviderCapabilities(params: unknown): HandlerResult {
    const validation = validateECPParams(AIProviderParamsSchema, params, AIErrorCodes.InvalidRequest);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const capabilities = this.service.getProviderCapabilities(p.provider);
    return { result: capabilities };
  }

  private async handleIsProviderAvailable(params: unknown): Promise<HandlerResult> {
    const validation = validateECPParams(AIProviderParamsSchema, params, AIErrorCodes.InvalidRequest);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const available = await this.service.isProviderAvailable(p.provider);
    return { result: { available } };
  }

  private async handleGetAvailableModels(params: unknown): Promise<HandlerResult> {
    const validation = validateECPParams(AIProviderParamsSchema, params, AIErrorCodes.InvalidRequest);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const models = await this.service.getAvailableModels(p.provider);
    return { result: { models } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Session Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private async handleCreateSession(params: unknown): Promise<HandlerResult> {
    const validation = validateECPParams(AISessionCreateParamsSchema, params, AIErrorCodes.InvalidRequest);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    try {
      // Transform ECP params to internal CreateSessionOptions format
      // ECP schema has provider as string, but internal expects AIProviderConfig object
      const providerNames: Record<string, string> = {
        claude: 'Claude',
        openai: 'OpenAI',
        gemini: 'Gemini',
        ollama: 'Ollama',
        'agent-sdk': 'Claude (Agent SDK)',
      };

      // Convert ECP message format to internal ChatMessage format for session restoration
      // Filter out: empty messages, tool role messages (not in Anthropic format),
      // placeholder text, and ensure only user/assistant roles are included
      const convertedMessages: ChatMessage[] | undefined = p.messages
        ?.filter(msg => {
          // Must have content
          if (!msg.content || msg.content.trim() === '') return false;
          // Only user/assistant roles (no system, no tool)
          if (msg.role !== 'user' && msg.role !== 'assistant') return false;
          // Filter out placeholder messages
          if (msg.content === '(No response)') return false;
          // Filter out very short assistant messages (likely placeholders)
          if (msg.role === 'assistant' && msg.content.trim().length < 5) return false;
          return true;
        })
        ?.map(msg => ({
          id: msg.id,
          role: msg.role as MessageRole,
          content: [{ type: 'text' as const, text: msg.content }],
          timestamp: msg.timestamp || Date.now(),
        }));

      const sessionOptions: CreateSessionOptions = {
        provider: {
          type: p.provider,
          name: providerNames[p.provider] || p.provider,
          model: p.model,
        },
        systemPrompt: p.systemPrompt,
        // Tools from ECP are string[] (tool names like "Read", "Write", etc.)
        // The providers now handle both string[] and ToolDefinition[] formats
        tools: p.tools as unknown as CreateSessionOptions['tools'],
        messages: convertedMessages,
        cwd: this.getWorkspacePath(),
      };

      const session = await this.service.createSession(sessionOptions);
      return { result: session };
    } catch (error) {
      return {
        error: {
          code: AIErrorCodes.ProviderUnavailable,
          message: error instanceof Error ? error.message : 'Failed to create session',
        },
      };
    }
  }

  private handleGetSession(params: unknown): HandlerResult {
    const validation = validateECPParams(AISessionIdParamsSchema, params, AIErrorCodes.InvalidRequest);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const session = this.service.getSession(p.sessionId);
    if (!session) {
      return { error: { code: AIErrorCodes.SessionNotFound, message: 'Session not found' } };
    }

    return { result: session };
  }

  private handleListSessions(): HandlerResult {
    const sessions = this.service.listSessions();
    return { result: { sessions } };
  }

  private handleDeleteSession(params: unknown): HandlerResult {
    const validation = validateECPParams(AISessionIdParamsSchema, params, AIErrorCodes.InvalidRequest);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    // Clean up agent sessions for this chat
    if (this.agentSessionRegistry) {
      this.agentSessionRegistry.deleteChatSessions(p.sessionId);
    }

    const deleted = this.service.deleteSession(p.sessionId);
    return { result: { deleted } };
  }

  private handleClearSession(params: unknown): HandlerResult {
    const validation = validateECPParams(AISessionIdParamsSchema, params, AIErrorCodes.InvalidRequest);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const cleared = this.service.clearSession(p.sessionId);
    return { result: { cleared } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Messaging Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private async handleSendMessage(params: unknown): Promise<HandlerResult> {
    const validation = validateECPParams(AIMessageSendParamsSchema, params, AIErrorCodes.InvalidRequest);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    try {
      const response = await this.service.sendMessage(p as SendMessageOptions);
      return { result: response };
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : 'Failed to send message';
      return {
        error: {
          code: AIErrorCodes.InternalError,
          message: parseProviderError(rawMessage),
        },
      };
    }
  }

  private handleSendMessageStreaming(params: unknown): HandlerResult {
    const validation = validateECPParams(AIMessageSendParamsSchema, params, AIErrorCodes.InvalidRequest);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data as SendMessageOptions & {
      streamId?: string;
      targetAgentId?: string;
      storageSessionId?: string;
      sourceAgentId?: string;
    };

    const streamId = (p as { streamId?: string }).streamId || `stream-${Date.now()}`;

    // Determine target agent for attribution
    let targetAgent: IAgent | undefined;
    if (this.chatOrchestrator) {
      const agentManager = this.chatOrchestrator.agentManager;

      // First check explicit targetAgentId
      if (p.targetAgentId) {
        targetAgent = agentManager.getAgent(p.targetAgentId);
      }

      // If no explicit target, parse @mentions from content
      if (!targetAgent && typeof p.content === 'string') {
        const { mentions } = agentManager.parseMentions(p.content);
        if (mentions.length > 0 && mentions[0]) {
          targetAgent = agentManager.getAgent(mentions[0].agentId);
        }
      }

      // Fall back to primary agent if available
      if (!targetAgent && agentManager.hasPrimaryAgent()) {
        targetAgent = agentManager.getPrimaryAgent();
      }
    }

    // Route through agent session registry if we have a target agent
    // Otherwise fall through to the default session (backward compatible)
    const startStreaming = async () => {
      let streamSessionId = p.sessionId;

      if (targetAgent && this.agentSessionRegistry) {
        try {
          // Build transcript context from chat storage
          const agentEntry = this.agentSessionRegistry.getSession(p.sessionId, targetAgent.id);
          let transcriptContext: string | undefined;

          if (agentEntry && p.storageSessionId) {
            // Returning agent — inject messages since last use
            transcriptContext = await this.buildTranscriptContext(p.storageSessionId, agentEntry.lastUsedAt);
          } else if (!agentEntry && p.storageSessionId) {
            // New agent — inject recent transcript for context
            transcriptContext = await this.buildTranscriptContext(p.storageSessionId);
          }

          // Get the chat session to determine fallback provider
          const chatSession = this.service.getSession(p.sessionId);
          const fallbackProvider = chatSession
            ? { type: chatSession.provider.type, model: chatSession.provider.model }
            : { type: 'claude' as AIProviderType };

          const entry = await this.agentSessionRegistry.getOrCreateSession(
            p.sessionId,
            targetAgent.id,
            fallbackProvider,
            transcriptContext,
            p.sourceAgentId,
          );

          // Route to the agent's own AI session
          streamSessionId = entry.aiSessionId;
          entry.messageCount++;
        } catch (error) {
          console.warn(`[AIServiceAdapter] Failed to create agent session for ${targetAgent.id}, falling back to shared session:`, error);
          // Fall through to shared session
        }
      }

      // Send the message to the resolved session
      const streamOptions = { ...p, sessionId: streamSessionId };

      // Track DelegateToAgent handoff during streaming
      const handoffState = {
        pending: null as { targetAgentId: string; targetAgentName: string; message: string; context?: string } | null,
        delegateToolId: null as string | null,
      };

      await this.service.sendMessageStreaming(streamOptions, (event) => {
        // Detect DelegateToAgent tool calls
        const evt = event as unknown as Record<string, unknown>;
        if (evt.type === 'tool_use_started' && evt.toolName === 'DelegateToAgent') {
          handoffState.delegateToolId = evt.toolUseId as string;
        }
        if (evt.type === 'tool_use_result' && handoffState.delegateToolId && evt.toolUseId === handoffState.delegateToolId) {
          try {
            const resultStr = typeof evt.result === 'string' ? evt.result : JSON.stringify(evt.result);
            const parsed = JSON.parse(resultStr);
            if (parsed?.__handoff) {
              handoffState.pending = parsed.__handoff;
              debugLog(`[AIServiceAdapter] Detected handoff to agent: ${parsed.__handoff.targetAgentId}`);
            }
          } catch { /* not JSON or no handoff marker */ }
          handoffState.delegateToolId = null;
        }

        // Record tool calls to chat DB for activity pane
        // Only when storageSessionId is available (references the chat DB sessions table)
        if (evt.type === 'tool_use_started' && this.ecpRequest && p.storageSessionId) {
          this.ecpRequest('chat/toolCall/add', {
            id: evt.toolUseId,
            sessionId: p.storageSessionId,
            toolName: evt.toolName,
            input: evt.input,
            agentId: targetAgent?.id,
            agentName: targetAgent?.name,
          }).catch((err) => {
            debugLog(`[AIServiceAdapter] Failed to record tool call start: ${err}`);
          });
        }
        if (evt.type === 'tool_use_result' && this.ecpRequest && p.storageSessionId) {
          this.ecpRequest('chat/toolCall/complete', {
            id: evt.toolUseId,
            sessionId: p.storageSessionId,
            output: evt.result,
            errorMessage: (evt as Record<string, unknown>).success === false ? String(evt.result) : undefined,
          }).catch((err) => {
            debugLog(`[AIServiceAdapter] Failed to record tool call result: ${err}`);
          });
        }

        // Bridge Agent SDK TodoWrite to chat DB via ECP todo system
        if (evt.type === 'todo_update' && Array.isArray(evt.todos)) {
          const sessionId = p.storageSessionId || null;
          const todos = (evt.todos as Array<Record<string, unknown>>).map((t, i) => ({
            // Agent SDK TodoWrite may send `subject` (from TaskCreate) or `content`
            content: String(t.content || t.subject || ''),
            status: (t.status as string) || 'pending',
            activeForm: t.activeForm ? String(t.activeForm) : undefined,
          }));
          // Route through ECP which persists to chat.db and sends chat/todo/replaced
          if (this.ecpRequest) {
            this.ecpRequest('ai/todo/write', { sessionId, todos }).catch(err => {
              debugLog(`[AIServiceAdapter] Failed to bridge TodoWrite: ${err}`);
            });
          }
          return; // Don't forward synthetic event to GUI
        }

        // Bridge Agent SDK tool_use_started for DocumentCreate/Update/etc. tools
        // to ECP document system (future: intercept and forward)

        // Augment events with agent info for attribution
        const augmentedEvent = targetAgent ? {
          ...event,
          agentId: targetAgent.id,
          agentName: targetAgent.name,
          agentRole: targetAgent.role,
        } : event;

        // Send stream events as notifications using the CHAT session ID
        // (not the internal agent session ID) so the client doesn't know about routing
        this.sendNotification('ai/stream/event', {
          streamId,
          sessionId: p.sessionId,
          event: augmentedEvent,
        });
      });

      // After streaming completes, check for handoff
      if (handoffState.pending) {
        const ho = handoffState.pending;
        debugLog(`[AIServiceAdapter] Emitting handoff notification: ${ho.targetAgentName}`);
        this.sendNotification('ai/agent/handoff', {
          sessionId: p.sessionId,
          storageSessionId: p.storageSessionId,
          targetAgentId: ho.targetAgentId,
          targetAgentName: ho.targetAgentName,
          sourceAgentId: targetAgent?.id,
          message: ho.message,
          context: ho.context,
        });
      }
    };

    // Start streaming in background - don't await
    startStreaming().catch((error) => {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const userMessage = parseProviderError(rawMessage);
      console.error(`[AIServiceAdapter] Streaming error:`, rawMessage);
      // Send error as stream event so client knows something went wrong
      this.sendNotification('ai/stream/event', {
        streamId,
        sessionId: p.sessionId,
        event: { type: 'error', error: { message: userMessage } },
      });
    });

    // Return streamId immediately
    return { result: { streamId } };
  }

  /**
   * Build a condensed transcript of recent messages for agent context.
   * Uses ChatStorage to fetch stored messages.
   */
  private async buildTranscriptContext(
    storageSessionId: string,
    sinceTimestamp?: number,
  ): Promise<string | undefined> {
    if (!this.chatStorage) return undefined;

    try {
      const messages = await this.chatStorage.getMessages(storageSessionId, {
        ...(sinceTimestamp ? { after: sinceTimestamp } : {}),
        limit: 30,
      });

      if (!messages || messages.length === 0) return undefined;

      const lines = messages.map(msg => {
        const role = msg.agentName || msg.role;
        const content = typeof msg.content === 'string'
          ? msg.content.substring(0, 500)
          : String(msg.content).substring(0, 500);
        return `[${role}]: ${content}`;
      });

      return `[Context update — recent messages${sinceTimestamp ? ' since your last response' : ''}:]\n${lines.join('\n')}\n[End context update]`;
    } catch (error) {
      debugLog(`[AIServiceAdapter] Failed to build transcript context: ${error}`);
      return undefined;
    }
  }

  private handleCancelMessage(params: unknown): HandlerResult {
    const validation = validateECPParams(AISessionIdParamsSchema, params, AIErrorCodes.InvalidRequest);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    // Cancel the main session
    const cancelled = this.service.cancelMessage(p.sessionId);

    // Also cancel all active agent sessions for this chat
    if (this.agentSessionRegistry) {
      const agentSessions = this.agentSessionRegistry.listSessions(p.sessionId);
      for (const entry of agentSessions) {
        this.service.cancelMessage(entry.aiSessionId);
      }
    }

    return { result: { cancelled } };
  }

  private handleAddMessage(params: unknown): HandlerResult {
    const validation = validateECPParams(AIAddMessageParamsSchema, params, AIErrorCodes.InvalidRequest);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const added = this.service.addMessage(p.sessionId, p.message as unknown as ChatMessage);
    return { result: { added } };
  }

  private handleGetMessages(params: unknown): HandlerResult {
    const validation = validateECPParams(AISessionIdParamsSchema, params, AIErrorCodes.InvalidRequest);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const messages = this.service.getMessages(p.sessionId);
    if (messages === null) {
      return { error: { code: AIErrorCodes.SessionNotFound, message: 'Session not found' } };
    }

    return { result: { messages } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tool Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private handleGetTools(): HandlerResult {
    const tools = this.service.getAvailableTools();
    return { result: { tools } };
  }

  private handleGetECPTools(): HandlerResult {
    const tools = this.service.getECPTools();
    return { result: { tools } };
  }

  private async handleExecuteTool(params: unknown): Promise<HandlerResult> {
    const validation = validateECPParams(AIToolExecuteParamsSchema, params, AIErrorCodes.InvalidRequest);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const result = await this.service.executeTool({
      type: 'tool_use',
      id: p.id || `tool-${Date.now()}`,
      name: p.name,
      input: p.input,
    });

    return { result };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Permission Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private handleApprovePermission(params: unknown): HandlerResult {
    const validation = validateECPParams(AIPermissionApproveParamsSchema, params, AIErrorCodes.InvalidRequest);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    // Validate folder scope requires folderPath
    if (p.scope === 'folder' && !p.folderPath) {
      return {
        error: {
          code: AIErrorCodes.InvalidRequest,
          message: 'folderPath is required for folder scope',
        },
      };
    }

    const success = this.service.approveToolPermission(
      p.toolUseId,
      p.scope || 'once',
      p.folderPath,
      p.answers
    );
    return { result: { approved: success, scope: p.scope || 'once' } };
  }

  private handleDenyPermission(params: unknown): HandlerResult {
    const validation = validateECPParams(AIPermissionDenyParamsSchema, params, AIErrorCodes.InvalidRequest);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const success = this.service.denyToolPermission(p.toolUseId);
    return { result: { denied: success } };
  }

  private handleGetPendingPermissions(): HandlerResult {
    const permissions = this.service.getPendingPermissions();
    return { result: { permissions } };
  }

  private handleSetAutoApprovedTools(params: unknown): HandlerResult {
    const validation = validateECPParams(AIAutoApprovedToolsParamsSchema, params, AIErrorCodes.InvalidRequest);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    if (p.toolNames) {
      this.service.setAutoApprovedTools(p.toolNames);
      return { result: { success: true } };
    }

    if (p.add) {
      this.service.addAutoApprovedTool(p.add);
      return { result: { success: true } };
    }

    if (p.remove) {
      this.service.removeAutoApprovedTool(p.remove);
      return { result: { success: true } };
    }

    return {
      error: {
        code: AIErrorCodes.InvalidRequest,
        message: 'toolNames, add, or remove is required',
      },
    };
  }

  private handleGetSessionApprovals(params: unknown): HandlerResult {
    const validation = validateECPParams(AISessionIdParamsSchema, params, AIErrorCodes.InvalidRequest);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const approvals = this.service.getSessionApprovals(p.sessionId);
    return { result: { approvals } };
  }

  private handleGetFolderApprovals(): HandlerResult {
    const approvals = this.service.getFolderApprovals();
    return { result: { approvals } };
  }

  private handleGetGlobalApprovals(): HandlerResult {
    const approvals = this.service.getGlobalApprovals();
    return { result: { approvals } };
  }

  private handleClearSessionApprovals(params: unknown): HandlerResult {
    const validation = validateECPParams(AISessionIdParamsSchema, params, AIErrorCodes.InvalidRequest);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    this.service.clearSessionApprovals(p.sessionId);
    return { result: { success: true } };
  }

  private handleRemoveApproval(params: unknown): HandlerResult {
    const validation = validateECPParams(AIRemoveApprovalParamsSchema, params, AIErrorCodes.InvalidRequest);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    let success = false;

    switch (p.scope) {
      case 'session':
        if (!p.sessionId) {
          return {
            error: {
              code: AIErrorCodes.InvalidRequest,
              message: 'sessionId is required for session scope',
            },
          };
        }
        success = this.service.removeSessionApproval(p.sessionId, p.toolName);
        break;

      case 'folder':
        if (!p.folderPath) {
          return {
            error: {
              code: AIErrorCodes.InvalidRequest,
              message: 'folderPath is required for folder scope',
            },
          };
        }
        success = this.service.removeFolderApproval(p.folderPath, p.toolName);
        break;

      case 'global':
        this.service.removeAutoApprovedTool(p.toolName);
        success = true;
        break;
    }

    return { result: { success } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Middleware Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private handleGetMiddleware(): HandlerResult {
    const middleware = this.service.getMiddleware();
    return {
      result: {
        middleware: middleware.map((m) => ({
          name: m.name,
          description: m.description,
          stages: m.stages,
          priority: m.priority,
          enabled: m.enabled,
        })),
      },
    };
  }

  private handleSetMiddlewareEnabled(params: unknown): HandlerResult {
    const validation = validateECPParams(AIMiddlewareEnableParamsSchema, params, AIErrorCodes.InvalidRequest);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const success = this.service.setMiddlewareEnabled(p.name, p.enabled);
    return { result: { success } };
  }

  private handleGetPipelineConfig(): HandlerResult {
    const config = this.service.getPipelineConfig();
    return {
      result: {
        haltOnBlock: config.haltOnBlock,
        timeout: config.timeout,
        middlewareCount: config.middleware.length,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Todo Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private handleTodoWrite(params: unknown): HandlerResult {
    const validation = validateECPParams(AITodoWriteParamsSchema, params, AIErrorCodes.InvalidRequest);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    // Use provided sessionId or a default key for global todos
    const key = p.sessionId || 'global';
    this.sessionTodos.set(key, p.todos as AITodoItem[]);

    debugLog(`[AIServiceAdapter] Todo write: ${p.todos.length} todos for session ${key}`);

    // Send notification to clients about todo update
    this.sendNotification('ai/todo/updated', {
      sessionId: key,
      todos: p.todos,
    });

    return { result: { success: true, message: 'Todos updated' } };
  }

  private handleGetTodos(params: unknown): HandlerResult {
    const validation = validateECPParams(AITodoGetParamsSchema, params ?? {}, AIErrorCodes.InvalidRequest);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const key = p?.sessionId || 'global';
    const todos = this.sessionTodos.get(key) || [];

    return { result: { todos } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Agent Handlers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Convert a studio AgentInstance's role category to a chat AgentRole.
   */
  private mapRoleCategoryToAgentRole(roleType: string): AgentRole {
    // Common role type naming conventions from the role registry
    if (roleType.includes('orchestrat')) return 'orchestrator';
    if (roleType.includes('review') || roleType.includes('evaluat')) return 'reviewer';
    return 'specialist';
  }

  /**
   * Convert a studio AgentInstance to the chat agent info format.
   */
  private studioAgentToChatAgent(agent: AgentInstance, detail?: AgentDetail | null) {
    return {
      id: agent.id,
      name: agent.name,
      role: this.mapRoleCategoryToAgentRole(agent.roleType),
      description: agent.description || null,
      status: agent.status === 'completed' ? 'idle' : agent.status,
      model: detail?.config?.model || null,
      systemPrompt: detail?.config?.systemPrompt || null,
      allowedTools: null,
      deniedTools: null,
      triggerKeywords: [],
      // Mark as studio agent so the client can distinguish
      source: 'studio' as const,
    };
  }

  private async handleListAgents(): Promise<HandlerResult> {
    // Build chat agents from orchestrator or fallback config
    const chatAgentMap = new Map<string, Record<string, unknown>>();

    if (this.chatOrchestrator) {
      const agents = this.chatOrchestrator.agentManager.listAgents();
      for (const agent of agents) {
        chatAgentMap.set(agent.id, {
          id: agent.id,
          name: agent.name,
          role: agent.role,
          description: agent.description,
          status: agent.status,
          triggerKeywords: agent.triggerKeywords,
          model: agent.model || null,
          systemPrompt: agent.systemPrompt || null,
          allowedTools: agent.allowedTools || null,
          deniedTools: agent.deniedTools || null,
          personaId: (agent as { personaId?: string }).personaId || null,
          agency: (agent as { agency?: unknown }).agency || null,
          source: 'system' as const,
        });
      }
    } else {
      for (const agent of this.fallbackAgents.values()) {
        chatAgentMap.set(agent.id, {
          id: agent.id,
          name: agent.name,
          role: agent.role,
          description: agent.description,
          status: 'idle' as const,
          triggerKeywords: agent.triggerKeywords || [],
          model: agent.model || null,
          systemPrompt: agent.systemPrompt || null,
          allowedTools: agent.allowedTools || null,
          deniedTools: agent.deniedTools || null,
          source: 'system' as const,
        });
      }
    }

    // Merge studio agents from AgentService (if available)
    if (this.agentService) {
      try {
        const { agents: studioAgents } = await this.agentService.listAgents();
        for (const studioAgent of studioAgents) {
          // Studio agents override chat agents with the same ID
          chatAgentMap.set(studioAgent.id, this.studioAgentToChatAgent(studioAgent));
        }
      } catch (error) {
        debugLog(`[AIServiceAdapter] Failed to fetch studio agents: ${error}`);
        // Non-fatal — continue with chat agents only
      }
    }

    return {
      result: {
        agents: Array.from(chatAgentMap.values()),
      },
    };
  }

  private async handleGetAgent(params: unknown): Promise<HandlerResult> {
    const p = params as { agentId?: string };
    if (!p?.agentId) {
      return {
        error: {
          code: AIErrorCodes.InvalidRequest,
          message: 'agentId is required',
        },
      };
    }

    // Try orchestrator first, then fallback
    if (this.chatOrchestrator) {
      const agent = this.chatOrchestrator.agentManager.getAgent(p.agentId);
      if (agent) {
        return {
          result: {
            agent: {
              id: agent.id,
              name: agent.name,
              role: agent.role,
              description: agent.description,
              status: agent.status,
              triggerKeywords: agent.triggerKeywords,
              provider: agent.provider || null,
              model: agent.model,
              systemPrompt: agent.systemPrompt,
              allowedTools: agent.allowedTools,
              deniedTools: agent.deniedTools,
              source: 'system' as const,
            },
          },
        };
      }
    }

    // Fallback to stored agents
    const fallbackAgent = this.fallbackAgents.get(p.agentId);
    if (fallbackAgent) {
      return {
        result: {
          agent: {
            id: fallbackAgent.id,
            name: fallbackAgent.name,
            role: fallbackAgent.role,
            description: fallbackAgent.description,
            status: 'idle' as const,
            triggerKeywords: fallbackAgent.triggerKeywords || [],
            provider: fallbackAgent.provider || null,
            model: fallbackAgent.model || null,
            systemPrompt: fallbackAgent.systemPrompt || null,
            allowedTools: fallbackAgent.allowedTools || null,
            deniedTools: fallbackAgent.deniedTools || null,
            source: 'system' as const,
          },
        },
      };
    }

    // Fallback to studio agent service — fetch with detail to get systemPrompt
    if (this.agentService) {
      try {
        const studioAgent = await this.agentService.getAgent(p.agentId, true) as AgentDetail | AgentInstance | null;
        if (studioAgent) {
          const detail = 'config' in studioAgent ? studioAgent as AgentDetail : null;
          return {
            result: {
              agent: this.studioAgentToChatAgent(studioAgent, detail),
            },
          };
        }
      } catch (error) {
        debugLog(`[AIServiceAdapter] Failed to look up studio agent ${p.agentId}: ${error}`);
      }
    }

    return {
      error: {
        code: AIErrorCodes.InvalidRequest,
        message: `Agent not found: ${p.agentId}`,
      },
    };
  }

  private handleGetAgentStatus(params: unknown): HandlerResult {
    const p = params as { agentId?: string };
    if (!p?.agentId) {
      return {
        error: {
          code: AIErrorCodes.InvalidRequest,
          message: 'agentId is required',
        },
      };
    }

    if (!this.chatOrchestrator) {
      return {
        error: {
          code: AIErrorCodes.InternalError,
          message: 'Chat orchestrator not initialized',
        },
      };
    }

    const agent = this.chatOrchestrator.agentManager.getAgent(p.agentId);
    if (!agent) {
      return {
        error: {
          code: AIErrorCodes.InvalidRequest,
          message: `Agent not found: ${p.agentId}`,
        },
      };
    }

    return {
      result: {
        agentId: agent.id,
        status: agent.status,
        lastActiveAt: agent.lastActiveAt,
        messageCount: agent.messageCount,
        totalUsage: agent.totalUsage,
      },
    };
  }

  private async handleReloadAgents(): Promise<HandlerResult> {
    if (!this.chatOrchestrator) {
      return {
        error: {
          code: AIErrorCodes.InternalError,
          message: 'Chat orchestrator not initialized',
        },
      };
    }

    try {
      // Clear existing agents
      const existingAgents = this.chatOrchestrator.agentManager.listAgents();
      for (const agent of existingAgents) {
        this.chatOrchestrator.agentManager.unregisterAgent(agent.id);
      }

      // Reload from config
      this.agentsLoaded = false;
      await this.loadAgentsFromConfig();

      const agents = this.chatOrchestrator.agentManager.listAgents();
      return {
        result: {
          success: true,
          agentsLoaded: agents.length,
        },
      };
    } catch (error) {
      return {
        error: {
          code: AIErrorCodes.InternalError,
          message: error instanceof Error ? error.message : 'Failed to reload agents',
        },
      };
    }
  }

  private async handleUpdateAgent(params: unknown): Promise<HandlerResult> {
    const p = params as {
      agentId?: string;
      name?: string;
      description?: string;
      systemPrompt?: string;
      provider?: string;
      model?: string;
      allowedTools?: string[] | null;
      deniedTools?: string[] | null;
      triggerKeywords?: string[];
      scope?: 'global' | 'project';
      personaId?: string | null;
      agency?: Record<string, unknown> | null;
    };

    if (!p?.agentId) {
      return {
        error: {
          code: AIErrorCodes.InvalidRequest,
          message: 'agentId is required',
        },
      };
    }

    try {
      // Check if this is a system/config agent (exists in fallback or orchestrator)
      const isSystemAgent = this.fallbackAgents.has(p.agentId)
        || this.chatOrchestrator?.agentManager.getAgent(p.agentId) != null;

      if (isSystemAgent) {
        // Write to YAML config
        const updates: Record<string, unknown> = {};
        if (p.name !== undefined) updates.name = p.name;
        if (p.description !== undefined) updates.description = p.description;
        if (p.systemPrompt !== undefined) updates.systemPrompt = p.systemPrompt;
        if (p.provider !== undefined) updates.provider = p.provider;
        if (p.model !== undefined) updates.model = p.model;
        if (p.triggerKeywords !== undefined) updates.triggerKeywords = p.triggerKeywords;
        if (p.allowedTools !== undefined || p.deniedTools !== undefined) {
          updates.tools = {
            allowed: p.allowedTools ?? undefined,
            denied: p.deniedTools ?? undefined,
          };
        }

        const scope = p.scope || 'global';
        const updatedEntry = await updateAgentInConfig(
          p.agentId,
          updates as Parameters<typeof updateAgentInConfig>[1],
          scope,
          scope === 'project' ? this.getWorkspacePath() : undefined,
        );

        // Update the in-memory agent config
        const updatedConfig: IAgentConfig = {
          id: updatedEntry.id,
          name: updatedEntry.name,
          role: updatedEntry.role,
          description: updatedEntry.description,
          systemPrompt: updatedEntry.systemPrompt,
          provider: updatedEntry.provider,
          model: updatedEntry.model,
          triggerKeywords: updatedEntry.triggerKeywords,
          allowedTools: updatedEntry.tools?.allowed,
          deniedTools: updatedEntry.tools?.denied,
        };

        // Update fallback storage
        this.fallbackAgents.set(p.agentId, updatedConfig);

        // Re-register with orchestrator
        if (this.chatOrchestrator) {
          this.chatOrchestrator.agentManager.unregisterAgent(p.agentId);
          this.chatOrchestrator.registerAgent(updatedConfig);
        }

        // Persist personaId and agency via chatAgentService (DB-backed, not in YAML)
        if (this.chatAgentService && (p.personaId !== undefined || p.agency !== undefined)) {
          try {
            const dbUpdates: Record<string, unknown> = {};
            if (p.personaId !== undefined) dbUpdates.personaId = p.personaId;
            if (p.agency !== undefined) dbUpdates.agency = p.agency;
            this.chatAgentService.updateAgent(p.agentId, dbUpdates);
          } catch (err) {
            debugLog(`[AIServiceAdapter] Failed to persist persona/agency for ${p.agentId}: ${err}`);
          }
        }

        // Invalidate any existing agent sessions so they get recreated with new config
        if (this.agentSessionRegistry) {
          this.agentSessionRegistry.deleteAllSessionsForAgent(p.agentId);
        }

        return {
          result: {
            success: true,
            agent: {
              id: updatedConfig.id,
              name: updatedConfig.name,
              role: updatedConfig.role,
              description: updatedConfig.description,
              systemPrompt: updatedConfig.systemPrompt,
              provider: updatedConfig.provider,
              model: updatedConfig.model,
              personaId: p.personaId ?? null,
              agency: p.agency ?? null,
              source: 'system' as const,
            },
          },
        };
      }

      // Studio agent — delegate to agent service
      if (this.agentService) {
        // Get existing agent details first
        const existing = await this.agentService.getAgent(p.agentId, true) as AgentDetail | null;

        if (existing) {
          // Delete and recreate with updates
          try {
            await this.agentService.deleteAgent(p.agentId);
          } catch { /* ignore */ }

          const createRequest = {
            roleType: existing.roleType || 'custom',
            name: p.name || existing.name,
            description: p.description ?? existing.description,
            id: p.agentId,
            config: {
              systemPrompt: p.systemPrompt ?? existing.config?.systemPrompt,
              model: p.model ?? existing.config?.model,
            },
          };

          const newAgent = await this.agentService.createAgent(createRequest);
          if (newAgent) {
            // Invalidate agent sessions
            if (this.agentSessionRegistry) {
              this.agentSessionRegistry.deleteAllSessionsForAgent(p.agentId);
            }

            const detail = await this.agentService.getAgent(newAgent.id, true) as AgentDetail | null;
            return {
              result: {
                success: true,
                agent: this.studioAgentToChatAgent(newAgent, detail),
              },
            };
          }
        }
      }

      return {
        error: {
          code: AIErrorCodes.InvalidRequest,
          message: `Agent not found: ${p.agentId}`,
        },
      };
    } catch (error) {
      return {
        error: {
          code: AIErrorCodes.InternalError,
          message: error instanceof Error ? error.message : 'Failed to update agent',
        },
      };
    }
  }

  private async handleGetSessionAgents(params: unknown): Promise<HandlerResult> {
    const p = params as { sessionId?: string };
    if (!p?.sessionId) {
      return {
        error: {
          code: AIErrorCodes.InvalidRequest,
          message: 'sessionId is required',
        },
      };
    }

    // Read persisted session agents from database
    if (this.chatStorage) {
      const storedAgents = await this.chatStorage.getSessionAgents(p.sessionId);
      debugLog(`[AIServiceAdapter] getSessionAgents(${p.sessionId}): ${storedAgents.length} agents found`);

      // Enrich with current agent info from orchestrator/fallbacks
      const agents = storedAgents.map((sa) => {
        let name = sa.agentId;
        let description: string | undefined;
        let role = sa.role;

        if (this.chatOrchestrator) {
          const agent = this.chatOrchestrator.agentManager.getAgent(sa.agentId);
          if (agent) {
            name = agent.name;
            description = agent.description;
            role = agent.role;
          }
        }
        if (name === sa.agentId) {
          const fallback = this.fallbackAgents.get(sa.agentId);
          if (fallback) {
            name = fallback.name;
            role = fallback.role;
          }
        }

        return {
          id: sa.agentId,
          name,
          role,
          description,
        };
      });

      return {
        result: {
          sessionId: p.sessionId,
          agents,
        },
      };
    }

    return { result: { sessionId: p.sessionId, agents: [] } };
  }

  private async handleAddSessionAgent(params: unknown): Promise<HandlerResult> {
    const p = params as { sessionId?: string; agentId?: string };
    if (!p?.sessionId || !p?.agentId) {
      return {
        error: {
          code: AIErrorCodes.InvalidRequest,
          message: 'sessionId and agentId are required',
        },
      };
    }

    // Resolve the agent from orchestrator, fallback list, or studio
    let resolvedAgent: { id: string; name: string; role: string; description?: string } | null = null;

    // Try orchestrator first
    if (this.chatOrchestrator) {
      const agent = this.chatOrchestrator.agentManager.getAgent(p.agentId);
      if (agent) {
        resolvedAgent = { id: agent.id, name: agent.name, role: agent.role, description: agent.description };
      }
    }

    // Fallback to stored agents (for welcome mode without workspace)
    if (!resolvedAgent) {
      const fallbackAgent = this.fallbackAgents.get(p.agentId);
      if (fallbackAgent) {
        resolvedAgent = { id: fallbackAgent.id, name: fallbackAgent.name, role: fallbackAgent.role };
      }
    }

    // Fallback to studio agent service — look up and register dynamically
    if (!resolvedAgent && this.agentService) {
      try {
        // Fetch with detailed=true to get systemPrompt and model from config
        const studioAgent = await this.agentService.getAgent(p.agentId, true) as AgentDetail | AgentInstance | null;
        if (studioAgent) {
          const detail = 'config' in studioAgent ? studioAgent as AgentDetail : null;
          const chatInfo = this.studioAgentToChatAgent(studioAgent, detail);

          // Register with orchestrator dynamically so future lookups succeed
          if (this.chatOrchestrator) {
            this.chatOrchestrator.registerAgent({
              id: chatInfo.id,
              name: chatInfo.name,
              role: chatInfo.role as AgentRole,
              description: chatInfo.description || undefined,
              model: chatInfo.model || undefined,
              systemPrompt: chatInfo.systemPrompt || undefined,
              triggerKeywords: chatInfo.triggerKeywords,
            });
          }

          // Also store in fallback so AgentSessionRegistry can access the config
          this.fallbackAgents.set(chatInfo.id, {
            id: chatInfo.id,
            name: chatInfo.name,
            role: chatInfo.role as AgentRole,
            description: chatInfo.description || undefined,
            model: chatInfo.model || undefined,
            systemPrompt: chatInfo.systemPrompt || undefined,
            triggerKeywords: chatInfo.triggerKeywords,
          });

          resolvedAgent = { id: chatInfo.id, name: chatInfo.name, role: chatInfo.role };
        }
      } catch (error) {
        debugLog(`[AIServiceAdapter] Failed to look up studio agent ${p.agentId}: ${error}`);
      }
    }

    if (!resolvedAgent) {
      return {
        error: {
          code: AIErrorCodes.InvalidRequest,
          message: `Agent not found: ${p.agentId}`,
        },
      };
    }

    // Persist to database
    if (this.chatStorage) {
      try {
        await this.chatStorage.addSessionAgent(p.sessionId, resolvedAgent.id, resolvedAgent.role as AgentRole, resolvedAgent.name);
        debugLog(`[AIServiceAdapter] Persisted session agent: ${resolvedAgent.id} → session ${p.sessionId}`);
      } catch (err) {
        console.error(`[AIServiceAdapter] Failed to persist session agent ${resolvedAgent.id} to session ${p.sessionId}:`, err);
      }
    } else {
      debugLog(`[AIServiceAdapter] No chatStorage — session agent ${resolvedAgent.id} NOT persisted`);
    }

    // Notify about agent joining
    this.sendNotification('ai/agent/joined', {
      sessionId: p.sessionId,
      agentId: resolvedAgent.id,
      agentName: resolvedAgent.name,
      agentRole: resolvedAgent.role,
    });

    return {
      result: {
        success: true,
        agent: {
          id: resolvedAgent.id,
          name: resolvedAgent.name,
          role: resolvedAgent.role,
        },
      },
    };
  }

  private async handleRemoveSessionAgent(params: unknown): Promise<HandlerResult> {
    const p = params as { sessionId?: string; agentId?: string };
    if (!p?.sessionId || !p?.agentId) {
      return {
        error: {
          code: AIErrorCodes.InvalidRequest,
          message: 'sessionId and agentId are required',
        },
      };
    }

    // Persist removal to database
    if (this.chatStorage) {
      try {
        await this.chatStorage.removeSessionAgent(p.sessionId, p.agentId);
      } catch (err) {
        debugLog(`[AIServiceAdapter] Failed to persist agent removal: ${err}`);
      }
    }

    // Resolve agent name for notification
    let agentName = p.agentId;
    if (this.chatOrchestrator) {
      const agent = this.chatOrchestrator.agentManager.getAgent(p.agentId);
      if (agent) agentName = agent.name;
    } else {
      const fallbackAgent = this.fallbackAgents.get(p.agentId);
      if (fallbackAgent) agentName = fallbackAgent.name;
    }

    // Notify about agent leaving
    this.sendNotification('ai/agent/left', {
      sessionId: p.sessionId,
      agentId: p.agentId,
      agentName,
    });

    return {
      result: {
        success: true,
      },
    };
  }

  private handleMentionSuggest(params: unknown): HandlerResult {
    const p = params as { query?: string; sessionId?: string };
    const query = p?.query || '';

    if (!this.chatOrchestrator) {
      return { result: { suggestions: [] } };
    }

    // Find agents matching the query
    const agents = this.chatOrchestrator.agentManager.findAgents(query);

    return {
      result: {
        suggestions: agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          role: agent.role,
          description: agent.description,
          triggerKeywords: agent.triggerKeywords,
        })),
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Persona Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private handleListPersonas(params: unknown): HandlerResult {
    if (!this.personaService) {
      return { error: { code: AIErrorCodes.InternalError, message: 'PersonaService not initialized' } };
    }

    const p = params as { status?: string; includeSystem?: boolean; limit?: number; offset?: number } | null;
    const personas = this.personaService.listPersonas({
      status: p?.status as import('../chat/types/workflow-schema.ts').PersonaPipelineStatus | undefined,
      includeSystem: p?.includeSystem,
      limit: p?.limit,
      offset: p?.offset,
    });

    return { result: { personas } };
  }

  private handleGetPersona(params: unknown): HandlerResult {
    if (!this.personaService) {
      return { error: { code: AIErrorCodes.InternalError, message: 'PersonaService not initialized' } };
    }

    const p = params as { id?: string };
    if (!p?.id) {
      return { error: { code: AIErrorCodes.InvalidRequest, message: 'id is required' } };
    }

    const persona = this.personaService.getPersona(p.id);
    if (!persona) {
      return { error: { code: AIErrorCodes.InvalidRequest, message: `Persona not found: ${p.id}` } };
    }

    return { result: { persona } };
  }

  private handleCreatePersona(params: unknown): HandlerResult {
    if (!this.personaService) {
      return { error: { code: AIErrorCodes.InternalError, message: 'PersonaService not initialized' } };
    }

    const p = params as Record<string, unknown>;
    if (!p?.name || typeof p.name !== 'string') {
      return { error: { code: AIErrorCodes.InvalidRequest, message: 'name is required' } };
    }

    const persona = this.personaService.createPersona(p as unknown as import('../chat/types/workflow-schema.ts').CreatePersonaOptions);

    this.sendNotification('ai/persona/created', { persona });

    return { result: { persona } };
  }

  private handleUpdatePersona(params: unknown): HandlerResult {
    if (!this.personaService) {
      return { error: { code: AIErrorCodes.InternalError, message: 'PersonaService not initialized' } };
    }

    const p = params as { id?: string; [key: string]: unknown };
    if (!p?.id) {
      return { error: { code: AIErrorCodes.InvalidRequest, message: 'id is required' } };
    }

    const { id, ...updates } = p;
    const persona = this.personaService.updatePersona(id, updates as unknown as import('../chat/types/workflow-schema.ts').UpdatePersonaOptions);

    if (!persona) {
      return { error: { code: AIErrorCodes.InvalidRequest, message: `Persona not found: ${id}` } };
    }

    this.sendNotification('ai/persona/updated', { persona });

    return { result: { persona } };
  }

  private async handleCompressPersona(params: unknown): Promise<HandlerResult> {
    if (!this.personaService) {
      return { error: { code: AIErrorCodes.InternalError, message: 'PersonaService not initialized' } };
    }

    const p = params as { id?: string };
    if (!p?.id) {
      return { error: { code: AIErrorCodes.InvalidRequest, message: 'id is required' } };
    }

    const persona = this.personaService.getPersona(p.id);
    if (!persona) {
      return { error: { code: AIErrorCodes.InvalidRequest, message: `Persona not found: ${p.id}` } };
    }

    // Build compression prompt from all pipeline stages
    const parts: string[] = [];
    if (persona.problemSpace) {
      parts.push(`Domain: ${persona.problemSpace.domain}\nChallenges: ${persona.problemSpace.challenges.join(', ')}\nAudience: ${persona.problemSpace.targetAudience}\nContext: ${persona.problemSpace.context}`);
    }
    if (persona.highLevel) {
      parts.push(`Identity: ${persona.highLevel.identity}\nExpertise: ${persona.highLevel.expertise.join(', ')}\nStyle: ${persona.highLevel.communicationStyle}\nValues: ${persona.highLevel.values.join(', ')}`);
    }
    if (persona.archetype) {
      parts.push(`Archetype: ${persona.archetype.name} — ${persona.archetype.description}\nStrengths: ${persona.archetype.strengths.join(', ')}\nBlind spots: ${persona.archetype.blindSpots.join(', ')}`);
    }
    if (persona.principles) {
      parts.push(`Principles: ${persona.principles.principles.join('; ')}\nAssumptions: ${persona.principles.assumptions.join('; ')}\nPhilosophy: ${persona.principles.philosophy}\nAnti-patterns: ${persona.principles.antiPatterns.join('; ')}`);
    }
    if (persona.taste) {
      parts.push(`Tone: ${persona.taste.tone}\nVerbosity: ${persona.taste.verbosity}\nFormatting: ${persona.taste.formatting}\nPersonality: ${persona.taste.personality}`);
    }

    if (parts.length === 0) {
      return { error: { code: AIErrorCodes.InvalidRequest, message: 'No pipeline stages to compress. Fill in at least one stage first.' } };
    }

    const compressionPrompt = `You are compressing a persona definition into a concise system prompt fragment (200-400 words). The compressed text will be injected into an AI agent's system prompt to define who it is.\n\nHere are the persona's pipeline stages:\n\n${parts.join('\n\n---\n\n')}\n\nGenerate a concise, direct persona definition in second person ("You are..."). Focus on identity, expertise, communication style, principles, and behavioral guidelines. Do NOT include any meta-commentary.`;

    try {
      const model = this.getDefaultModel?.() || undefined;
      const session = await this.service.createSession({
        provider: { type: 'claude', name: 'Claude', model },
        systemPrompt: 'You are a concise writer. Output only the compressed persona text, nothing else.',
        cwd: this.getWorkspacePath(),
      });

      const response = await this.service.sendMessage({
        sessionId: session.id,
        content: compressionPrompt,
      });

      const compressed = response.message.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map(c => c.text)
        .join('\n');

      // Save the compressed text
      this.personaService.updatePersona(p.id, {
        compressed,
        pipelineStatus: 'compressed',
      });

      // Cleanup temp session
      this.service.deleteSession(session.id);

      const updatedPersona = this.personaService.getPersona(p.id);
      this.sendNotification('ai/persona/updated', { persona: updatedPersona });

      return { result: { compressed } };
    } catch (error) {
      return {
        error: {
          code: AIErrorCodes.InternalError,
          message: `Compression failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }

  private handleDeletePersona(params: unknown): HandlerResult {
    if (!this.personaService) {
      return { error: { code: AIErrorCodes.InternalError, message: 'PersonaService not initialized' } };
    }

    const p = params as { id?: string };
    if (!p?.id) {
      return { error: { code: AIErrorCodes.InvalidRequest, message: 'id is required' } };
    }

    const deleted = this.personaService.deletePersona(p.id);
    if (!deleted) {
      return { error: { code: AIErrorCodes.InvalidRequest, message: `Persona not found or cannot be deleted: ${p.id}` } };
    }

    this.sendNotification('ai/persona/deleted', { id: p.id });

    return { result: { success: true } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Event Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private setupEventHandlers(): void {
    // Forward session events as notifications
    // Skip stream_event since those are sent directly via the streaming handler
    this.service.onSessionEvent((event) => {
      if (event.type === 'stream_event') return;

      this.sendNotification(`ai/${event.type}`, {
        sessionId: event.sessionId,
        data: event.data,
        timestamp: event.timestamp,
      });
    });
  }

  private sendNotification(method: string, params: unknown): void {
    if (this.notificationHandler) {
      this.notificationHandler({
        jsonrpc: '2.0',
        method,
        params,
      });
    }
  }
}
