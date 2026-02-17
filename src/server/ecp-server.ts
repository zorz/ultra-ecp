/**
 * ECP Server
 *
 * The Editor Command Protocol server that routes requests to service adapters.
 */

import { debugLog as globalDebugLog } from '../debug.ts';

// Service imports
import { LocalDocumentService } from '../services/document/local.ts';
import { DocumentServiceAdapter } from '../services/document/adapter.ts';
import { FileServiceImpl } from '../services/file/service.ts';
import { FileServiceAdapter } from '../services/file/adapter.ts';
import { GitCliService } from '../services/git/cli.ts';
import { GitServiceAdapter } from '../services/git/adapter.ts';
import { LocalSessionService } from '../services/session/local.ts';
import { SessionServiceAdapter } from '../services/session/adapter.ts';
import { LocalLSPService } from '../services/lsp/service.ts';
import { LSPServiceAdapter } from '../services/lsp/adapter.ts';
import { LocalSyntaxService } from '../services/syntax/service.ts';
import { SyntaxServiceAdapter } from '../services/syntax/adapter.ts';
import { LocalTerminalService } from '../services/terminal/service.ts';
import { TerminalServiceAdapter } from '../services/terminal/adapter.ts';
import { LocalSecretService } from '../services/secret/local.ts';
import { SecretServiceAdapter } from '../services/secret/adapter.ts';
import { LocalDatabaseService } from '../services/database/local.ts';
import { DatabaseServiceAdapter } from '../services/database/adapter.ts';
import { LocalAIService } from '../services/ai/local.ts';
import { AIServiceAdapter } from '../services/ai/adapter.ts';
import { loadModels, refreshModels } from '../services/ai/model-registry.ts';
import { ChatServiceAdapter } from '../services/chat/adapter.ts';
import { ChatOrchestrator } from '../services/chat/services/ChatOrchestrator.ts';
import { WorkflowServiceAdapter } from '../services/chat/workflow-adapter.ts';
import { LocalAgentService } from '../services/agents/local.ts';
import { AgentServiceAdapter } from '../services/agents/adapter.ts';
import { AuthServiceAdapter } from '../services/auth/adapter.ts';
import { delegateToAgentTool, builderTools } from '../services/ai/tools/definitions.ts';
import { PersonaService } from '../services/chat/services/PersonaService.ts';
import { AgentService as ChatAgentService } from '../services/chat/services/AgentService.ts';
import { buildWorkflowAgentSystemPrompt } from '../services/ai/system-prompt.ts';

// Types
import {
  type ECPServerOptions,
  type ECPServerState,
  type ECPResponse,
  type ECPNotification,
  type NotificationListener,
  type Unsubscribe,
  type HandlerResult,
  ECPErrorCodes,
  createErrorResponse,
  createSuccessResponse,
} from '../protocol/types.ts';

// Middleware
import {
  MiddlewareChain,
  createMiddlewareChain,
  type ECPMiddleware,
} from './middleware/index.ts';
import { createValidationMiddleware } from './middleware/validation-middleware.ts';
import { createSettingsSnapshotMiddleware } from './middleware/settings-snapshot-middleware.ts';
import { createWorkingSetMiddleware } from './middleware/working-set-middleware.ts';
import { createCallerTelemetryMiddleware } from './middleware/caller-telemetry-middleware.ts';

/**
 * Layout state reported by the frontend.
 * Used for layout/getLayout queries and agent-controlled UX.
 */
interface LayoutState {
  /** Current layout preset ID */
  presetId: string;
  /** Focused tile ID */
  focusedTileId: string;
  /** Active tabs per tile (tileId -> tabId) */
  activeTabs: Record<string, string>;
  /** Open files in editor (file paths) */
  openFiles: string[];
  /** Currently active file in editor */
  activeFileId: string | null;
  /** Visible tiles in current preset */
  visibleTiles: string[];
  /** Timestamp when state was last updated */
  timestamp: number;
}

/**
 * ECP Server.
 *
 * Routes JSON-RPC requests to the appropriate service adapters.
 * Provides a simple `request(method, params)` API for clients.
 */
export class ECPServer {
  private _debugName = 'ECPServer';
  private _state: ECPServerState = 'uninitialized';
  private workspaceRoot: string;

  // Services
  private documentService: LocalDocumentService;
  private fileService: FileServiceImpl;
  private gitService: GitCliService;
  private sessionService: LocalSessionService;
  private lspService: LocalLSPService;
  private syntaxService: LocalSyntaxService;
  private terminalService: LocalTerminalService;
  private secretService: LocalSecretService;
  private databaseService: LocalDatabaseService;
  private aiService: LocalAIService;

  // Adapters
  private documentAdapter: DocumentServiceAdapter;
  private fileAdapter: FileServiceAdapter;
  private gitAdapter: GitServiceAdapter;
  private sessionAdapter: SessionServiceAdapter;
  private lspAdapter: LSPServiceAdapter;
  private syntaxAdapter: SyntaxServiceAdapter;
  private terminalAdapter: TerminalServiceAdapter;
  private secretAdapter: SecretServiceAdapter;
  private databaseAdapter: DatabaseServiceAdapter;
  private aiAdapter: AIServiceAdapter;
  private chatAdapter: ChatServiceAdapter;
  private chatOrchestrator: ChatOrchestrator | null = null;
  private workflowAdapter: WorkflowServiceAdapter;
  private agentService!: LocalAgentService;
  private agentAdapter!: AgentServiceAdapter;
  private authAdapter!: AuthServiceAdapter;

  // Notification listeners
  private notificationListeners: Set<NotificationListener> = new Set();

  // Request ID counter for internal requests
  private requestIdCounter = 0;

  // Middleware chain
  private middleware: MiddlewareChain = createMiddlewareChain();

  // Cached layout state from frontend (for layout/getLayout queries)
  private cachedLayoutState: LayoutState | null = null;

  constructor(options: ECPServerOptions = {}) {
    // Use provided workspace, or empty string for "no workspace" mode, or cwd as last resort
    // Empty string means the app was opened without a folder (welcome mode)
    this.workspaceRoot = options.workspaceRoot !== undefined ? options.workspaceRoot : process.cwd();

    // Initialize services
    this.documentService = new LocalDocumentService();
    this.fileService = new FileServiceImpl();
    this.gitService = new GitCliService();
    this.sessionService = new LocalSessionService();

    // Configure session paths for persistence
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const sessionsDir = options.sessionsDir || `${homeDir}/.ultra/sessions`;
    this.sessionService.setSessionPaths({
      sessionsDir,
      workspaceSessionsDir: `${sessionsDir}/workspaces`,
      namedSessionsDir: `${sessionsDir}/named`,
      lastSessionFile: `${sessionsDir}/last-session.json`,
    });

    this.lspService = new LocalLSPService();
    this.lspService.setWorkspaceRoot(this.workspaceRoot);
    this.syntaxService = new LocalSyntaxService();
    this.terminalService = new LocalTerminalService();
    this.secretService = new LocalSecretService();
    this.databaseService = new LocalDatabaseService();
    this.aiService = new LocalAIService();

    // Initialize adapters
    this.documentAdapter = new DocumentServiceAdapter(this.documentService);
    this.fileAdapter = new FileServiceAdapter(this.fileService, this.workspaceRoot);
    this.gitAdapter = new GitServiceAdapter(this.gitService);
    this.sessionAdapter = new SessionServiceAdapter(this.sessionService);
    // Set up workspace change handler to reinitialize services when workspace changes
    this.sessionAdapter.setWorkspaceChangeHandler((path: string) => {
      console.log('[ECPServer] Workspace change handler triggered for:', path);
      this.workspaceRoot = path;
      this.fileAdapter.setWorkspaceRoot(path);
      this.terminalAdapter.setWorkspaceRoot(path);
      this.lspService.setWorkspaceRoot(path);
      // Reinitialize chat storage and related services
      this.reinitializeChatForWorkspace(path).catch((err: unknown) => {
        console.error('[ECPServer] Failed to reinitialize chat for workspace:', err);
      });
    });
    this.lspAdapter = new LSPServiceAdapter(this.lspService);
    this.syntaxAdapter = new SyntaxServiceAdapter(this.syntaxService);
    this.terminalAdapter = new TerminalServiceAdapter(this.terminalService);
    this.terminalAdapter.setWorkspaceRoot(this.workspaceRoot);
    this.secretAdapter = new SecretServiceAdapter(this.secretService);
    this.databaseAdapter = new DatabaseServiceAdapter(this.databaseService);
    this.aiAdapter = new AIServiceAdapter(this.aiService, this.workspaceRoot);
    this.aiAdapter.setDefaultModelGetter(() => this.sessionService.getSetting('ultra.ai.model') as string);
    this.chatAdapter = new ChatServiceAdapter(this.workspaceRoot);
    this.workflowAdapter = new WorkflowServiceAdapter(this.workspaceRoot);
    this.agentService = new LocalAgentService(this.workspaceRoot);
    this.agentAdapter = new AgentServiceAdapter(this.agentService);
    this.authAdapter = new AuthServiceAdapter(this.secretService);

    // Configure AI service with ECP request function
    this.aiService.setECPRequest(this.request.bind(this));

    // Configure AI adapter with ECP request for recording tool calls to chat DB
    this.aiAdapter.setECPRequest(this.request.bind(this));

    // Set up notification forwarding
    this.setupNotificationHandlers();

    // Initialize middleware chain
    this.middleware = createMiddlewareChain();
    this.middleware.use(createSettingsSnapshotMiddleware({
      getAll: () => this.sessionService.getAllSettings() as unknown as Record<string, unknown>,
    }));
    this.middleware.use(createCallerTelemetryMiddleware());
    this.middleware.use(createWorkingSetMiddleware());
    this.middleware.use(createValidationMiddleware());

    this._state = 'running';
    this.debugLog('Initialized');
  }

  protected debugLog(msg: string): void {
    globalDebugLog(`[${this._debugName}] ${msg}`);
  }

  private assertCaller(method: string): { type: 'human' } | { type: 'agent'; agentId: string; executionId?: string; roleType?: string } {
    // For now, anything under ai/* is considered agent-driven.
    // This is a coarse boundary but prevents spoofing by putting caller in params.
    if (method.startsWith('ai/')) {
      return { type: 'agent', agentId: 'local-ai-service' };
    }

    // Default: treat as human/UI call.
    return { type: 'human' };
  }

  private attachCallerParam(params: unknown, caller: unknown): unknown {
    const p = (params ?? {}) as Record<string, unknown>;

    // Strip any user-supplied caller and attach asserted caller.
    return { ...p, caller };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get the current server state.
   */
  get state(): ECPServerState {
    return this._state;
  }

  /**
   * Send a request and get the result.
   *
   * @param method The method name (e.g., "document/open")
   * @param params The request parameters
   * @returns The result
   * @throws Error if the request fails
   */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const response = await this.requestRaw(method, params);

    if ('error' in response) {
      throw new Error(`ECP Error [${response.error.code}]: ${response.error.message}`);
    }

    return response.result as T;
  }

  /**
   * Send a request and get the full response (including errors).
   *
   * @param method The method name
   * @param params The request parameters
   * @returns The full response
   */
  async requestRaw(method: string, params?: unknown): Promise<ECPResponse> {
    if (this._state === 'shutdown') {
      return createErrorResponse(
        null,
        ECPErrorCodes.ServerShuttingDown,
        'Server is shutting down'
      );
    }

    if (this._state === 'uninitialized') {
      return createErrorResponse(
        null,
        ECPErrorCodes.ServerNotInitialized,
        'Server is not initialized'
      );
    }

    const id = ++this.requestIdCounter;

    try {
      // Assert caller identity at the server boundary.
      // Never trust request params for caller attribution.
      const assertedCaller = this.assertCaller(method);
      const paramsWithCaller = this.attachCallerParam(params, assertedCaller);

      // Run middleware chain before routing
      const middlewareResult = await this.middleware.run(method, paramsWithCaller);

      if (!middlewareResult.allowed) {
        return createErrorResponse(
          id,
          (middlewareResult.errorData as { code?: number })?.code ?? ECPErrorCodes.ServerError,
          middlewareResult.feedback ?? 'Request blocked by middleware',
          middlewareResult.errorData
        );
      }

      // Use potentially modified params from middleware
      const result = await this.routeRequest(method, middlewareResult.finalParams);

      if ('error' in result) {
        return {
          jsonrpc: '2.0',
          id,
          error: result.error,
        };
      }

      // Run post-execution hooks
      await this.middleware.runAfterExecute(method, middlewareResult.finalParams, result.result);

      return createSuccessResponse(id, result.result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return createErrorResponse(id, ECPErrorCodes.InternalError, message);
    }
  }

  /**
   * Subscribe to notifications.
   *
   * @param listener Notification callback
   * @returns Unsubscribe function
   */
  onNotification(listener: NotificationListener): Unsubscribe {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  /**
   * Initialize async services.
   * Call this before using session-related methods.
   */
  async initialize(): Promise<void> {
    await this.sessionService.init(this.workspaceRoot);
    await this.secretService.init();
    await this.databaseService.init(this.workspaceRoot);
    await this.aiService.init();
    await this.chatAdapter.init();
    await this.workflowAdapter.init();

    // Initialize ChatOrchestrator and agent service with shared database
    const chatDb = this.chatAdapter.getDb();
    if (chatDb) {
      // Initialize agent service with database for project agent persistence
      this.agentService.setDatabase(chatDb);
      this.agentService.setProjectPath(this.workspaceRoot);

      // Wire AI service for LLM integration - agents can make real LLM calls
      this.agentService.setAIService(this.aiService);

      await this.agentService.initialize();

      // Initialize ChatOrchestrator
      this.chatOrchestrator = new ChatOrchestrator({ db: chatDb });
      await this.chatOrchestrator.initialize();

      // Wire ChatOrchestrator into AIServiceAdapter
      this.aiAdapter.setChatOrchestrator(this.chatOrchestrator);

      // Wire ChatServiceAdapter as ChatStorage shim for transcript context
      // ChatServiceAdapter provides getMessages, getSessionAgents, addSessionAgent, removeSessionAgent
      this.aiAdapter.setChatStorage(this.chatAdapter as any);

      // Wire AgentService into AIServiceAdapter for unified agent registry
      this.aiAdapter.setAgentService(this.agentService);

      // Initialize PersonaService and ChatAgentService for persona resolution
      const personaService = new PersonaService(chatDb);
      const chatAgentSvc = new ChatAgentService(chatDb);
      this.aiAdapter.setPersonaService(personaService);
      this.aiAdapter.setChatAgentService(chatAgentSvc);

      this.debugLog('ChatOrchestrator and agent service initialized with database and LLM integration');
    } else {
      // Fallback: Initialize agent service without database (file-based only)
      this.agentService.setProjectPath(this.workspaceRoot);
      // Still wire AI service for LLM integration even without database
      this.agentService.setAIService(this.aiService);
      await this.agentService.initialize();

      // Wire AgentService into AIServiceAdapter for unified agent registry
      this.aiAdapter.setAgentService(this.agentService);

      this.debugLog('Agent service initialized with file-based storage and LLM integration');
    }

    // Load agents from config (works with or without orchestrator)
    // Agents come from ~/.ultra/agents.yaml or built-in defaults
    await this.aiAdapter.loadAgentsFromConfig();

    // Wire AI executor into workflow adapter for agent node execution
    this.wireWorkflowAIExecutor();

    // Initialize middleware
    await this.middleware.init(this.workspaceRoot);

    // Configure browse root from settings
    const browseRoot = this.sessionService.getSetting('files.browseRoot');
    if (browseRoot) {
      this.fileAdapter.setBrowseRootPath(browseRoot);
    }

    this.debugLog('Async initialization complete');
  }

  /**
   * Wire the AI executor into the workflow adapter.
   * This enables workflow agent nodes to make actual AI calls.
   *
   * Uses an agentic loop pattern: keeps sending messages until the AI
   * completes without requesting tool use.
   */
  private wireWorkflowAIExecutor(): void {
    // Register DelegateToAgent globally so it's available in all AI sessions.
    // In workflow mode, the bridge detects __handoff markers.
    // In direct chat mode, the adapter detects handoff and emits a notification.
    this.aiService.registerTool(delegateToAgentTool, async (input: Record<string, unknown>) => {
      const agentId = input.agentId as string;
      const message = input.message as string;
      const context = input.context as string | undefined;

      if (!agentId || !message) {
        return { success: false, error: 'agentId and message are required' };
      }

      // Validate target agent exists in workflow executor's registry or fallback agents
      const executor = this.workflowAdapter.getExecutor();
      const workflowAgent = executor?.getAgent(agentId);
      let agentName = agentId;

      if (workflowAgent) {
        agentName = workflowAgent.name || agentId;
      } else {
        // Check AI adapter's agent list (fallback/orchestrator agents)
        const agentResult = await this.aiAdapter.handleRequest('ai/agent/get', { agentId });
        if ('error' in agentResult) {
          return { success: false, error: `Agent not found: ${agentId}` };
        }
        const agentData = (agentResult.result as { agent?: { name?: string } })?.agent;
        agentName = agentData?.name || agentId;
      }

      // Return marker that the bridge will detect
      return {
        success: true,
        result: JSON.stringify({
          __handoff: { targetAgentId: agentId, targetAgentName: agentName, message, context },
        }),
      };
    });

    // Register builder tools globally. They are filtered by agent's allowedTools
    // so only the agent-builder agent will have access to them.
    for (const tool of builderTools) {
      this.aiService.registerTool(tool, async (input: Record<string, unknown>) => {
        const chatDb = this.chatAdapter.getDb();
        if (!chatDb) {
          return { success: false, error: 'Database not initialized' };
        }

        if (tool.name === 'CreatePersona') {
          const personaService = new PersonaService(chatDb);
          const name = (input.name as string) || 'New Persona';
          const description = input.description as string | undefined;

          const persona = personaService.createPersona({ name, description });
          this.emitNotification('ai/persona/created', { persona });
          return { success: true, result: JSON.stringify(persona) };
        }

        if (tool.name === 'UpdatePersonaField') {
          const personaService = new PersonaService(chatDb);
          const personaId = input.personaId as string;
          const field = input.field as string;
          const value = input.value;

          if (!personaId || !field) {
            return { success: false, error: 'personaId and field are required' };
          }

          if (value === undefined || value === null) {
            return { success: false, error: `value is required. For field "${field}", provide the structured object or string value to save.` };
          }

          const updates: Record<string, unknown> = { [field]: value };
          const persona = personaService.updatePersona(personaId, updates as any);
          if (!persona) {
            return { success: false, error: `Persona not found: ${personaId}` };
          }

          // Send notification so the editor updates live
          this.emitNotification('ai/persona/updated', { persona });
          return { success: true, result: JSON.stringify(persona) };
        }

        if (tool.name === 'UpdateAgencyField') {
          const chatAgentSvc = new ChatAgentService(chatDb);
          const agentId = input.agentId as string;
          const field = input.field as string;
          const value = input.value;

          if (!agentId || !field) {
            return { success: false, error: 'agentId and field are required' };
          }

          // Get existing agency, merge the field update
          const agent = chatAgentSvc.getAgent(agentId);
          if (!agent) {
            return { success: false, error: `Agent not found: ${agentId}` };
          }

          const existingAgency = agent.agency || {
            roleDescription: '',
            responsibilities: [],
            expectedOutputs: [],
            constraints: [],
            delegationRules: { canDelegate: false, delegationCriteria: [], preferredDelegates: [], escalationPolicy: '' },
          };
          const updatedAgency = { ...existingAgency, [field]: value };
          const updated = chatAgentSvc.updateAgent(agentId, { agency: updatedAgency });

          this.emitNotification('ai/agent/updated', { agent: updated });
          return { success: true, result: JSON.stringify(updated) };
        }

        if (tool.name === 'CompressPersona') {
          const personaService = new PersonaService(chatDb);
          const personaId = input.personaId as string;

          if (!personaId) {
            return { success: false, error: 'personaId is required' };
          }

          const persona = personaService.getPersona(personaId);
          if (!persona) {
            return { success: false, error: `Persona not found: ${personaId}` };
          }

          // Build compression prompt from all stages
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
            return { success: false, error: 'No pipeline stages to compress. Fill in at least one stage first.' };
          }

          // Use a one-shot AI call to compress
          const compressionPrompt = `You are compressing a persona definition into a concise system prompt fragment (200-400 words). The compressed text will be injected into an AI agent's system prompt to define who it is.\n\nHere are the persona's pipeline stages:\n\n${parts.join('\n\n---\n\n')}\n\nGenerate a concise, direct persona definition in second person ("You are..."). Focus on identity, expertise, communication style, principles, and behavioral guidelines. Do NOT include any meta-commentary.`;

          try {
            // Create a temporary session for the compression call
            const model = this.sessionService.getSetting('ultra.ai.model') as string;
            const session = await this.aiService.createSession({
              provider: { type: 'claude', name: 'Claude', model },
              systemPrompt: 'You are a concise writer. Output only the compressed persona text, nothing else.',
              cwd: this.workspaceRoot,
            });

            const response = await this.aiService.sendMessage({
              sessionId: session.id,
              content: compressionPrompt,
            });

            const compressed = response.message.content
              .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
              .map(c => c.text)
              .join('\n');

            // Save the compressed text
            personaService.updatePersona(personaId, {
              compressed,
              pipelineStatus: 'compressed',
            });

            // Cleanup temp session
            this.aiService.deleteSession(session.id);

            const updatedPersona = personaService.getPersona(personaId);
            this.emitNotification('ai/persona/updated', { persona: updatedPersona });

            return { success: true, result: compressed };
          } catch (error) {
            return { success: false, error: `Compression failed: ${error instanceof Error ? error.message : String(error)}` };
          }
        }

        return { success: false, error: `Unknown builder tool: ${tool.name}` };
      });
    }

    this.workflowAdapter.setAIExecutor(async (request, onStream) => {
      this.debugLog(`[WorkflowAI] Starting execution for agent: ${request.agentId}`);

      // Build agent roster for DelegateToAgent system prompt augmentation
      const workflowExec = this.workflowAdapter.getExecutor();
      const availableAgents: Array<{ id: string; name: string; role?: string; description?: string }> = [];

      // Gather agents from workflow executor's agent pool
      if (workflowExec) {
        const agents = workflowExec.listAgents({ includeSystem: true });
        for (const agent of agents) {
          availableAgents.push({
            id: agent.id,
            name: agent.name,
            role: agent.role,
            description: agent.description ?? undefined,
          });
        }
      }

      // If no workflow agents, fall back to AI adapter's agent list
      if (availableAgents.length === 0) {
        const agentListResult = await this.aiAdapter.handleRequest('ai/agent/list', {});
        if ('result' in agentListResult) {
          const agentList = (agentListResult.result as { agents?: Array<{ id: string; name: string; role?: string; description?: string }> })?.agents || [];
          for (const agent of agentList) {
            availableAgents.push({
              id: agent.id,
              name: agent.name,
              role: agent.role,
              description: agent.description,
            });
          }
        }
      }

      // Augment system prompt with agent roster if there are other agents
      let augmentedSystemPrompt = request.systemPrompt || '';
      const otherAgents = availableAgents.filter(a => a.id !== request.agentId);
      if (otherAgents.length > 0) {
        // Build a roster-only block from the helper
        const fullPrompt = buildWorkflowAgentSystemPrompt(
          undefined, // agentConfig already baked into request.systemPrompt
          undefined, // workspaceRoot already baked in
          availableAgents,
          request.agentId,
        );
        // Extract just the roster section (after the last ---) and append to original
        const rosterSection = fullPrompt.split('---').pop() || '';
        if (rosterSection.trim()) {
          augmentedSystemPrompt = `${augmentedSystemPrompt}\n\n---\n\n${rosterSection.trim()}`;
        }
      }

      // Create a temporary session for this workflow execution
      const sessionResult = await this.aiAdapter.handleRequest('ai/session/create', {
        provider: 'claude',
        model: 'claude-sonnet-4-20250514',
        systemPrompt: augmentedSystemPrompt,
      });

      if ('error' in sessionResult) {
        this.debugLog(`[WorkflowAI] Failed to create session: ${sessionResult.error.message}`);
        throw new Error(`Failed to create session: ${sessionResult.error.message}`);
      }

      const session = sessionResult.result as { id: string; tools?: Array<{ name: string }> };
      this.debugLog(`[WorkflowAI] Created session: ${session.id}`);

      // Get workflow and node to determine allowed tools
      const workflowId = request.metadata?.workflowId;
      const nodeId = request.metadata?.nodeId;
      const executor = this.workflowAdapter.getExecutor();
      const workflow = workflowId ? executor?.workflows.getWorkflow(workflowId) : null;

      // Determine allowed tools from workflow definition and node settings
      const workflowAllowedTools = workflow?.definition?.defaultAllowedTools || [];
      const workflowDeniedTools = new Set(workflow?.definition?.defaultDeniedTools || []);

      // Find the current node for node-specific permissions
      const currentNode = nodeId && workflow?.definition?.steps
        ? workflow.definition.steps.find(s => s.id === nodeId)
        : null;
      const nodeAllowedTools = currentNode?.allowedTools || [];
      const nodeDeniedTools = new Set(currentNode?.deniedTools || []);

      // Combine allowed tools (workflow defaults + node-specific)
      const allAllowedTools = new Set([...workflowAllowedTools, ...nodeAllowedTools]);

      // Get the session to access its tools (which have provider-specific names)
      const sessionDetails = await this.aiAdapter.handleRequest('ai/session/get', {
        sessionId: session.id,
      });

      // Only approve tools that are explicitly allowed in workflow/node definition
      // OR that have been previously approved and saved in WorkflowPermissionService
      const permissionService = this.aiService.getPermissionService();
      const workflowPermissionService = executor?.permissions;
      const executionId = request.metadata?.executionId;
      let approvedCount = 0;

      if ('result' in sessionDetails && sessionDetails.result) {
        const fullSession = sessionDetails.result as { tools?: Array<{ name: string }> };
        if (fullSession.tools && Array.isArray(fullSession.tools)) {
          for (const tool of fullSession.tools) {
            if (!tool.name) continue;

            // Check if tool is denied at workflow or node level
            if (workflowDeniedTools.has(tool.name) || nodeDeniedTools.has(tool.name)) {
              this.debugLog(`[WorkflowAI] Tool ${tool.name} denied by workflow/node definition`);
              continue;
            }

            // Check if tool is explicitly allowed by workflow definition
            if (allAllowedTools.has(tool.name)) {
              permissionService.addSessionApproval(
                session.id,
                tool.name,
                'Workflow-defined permission'
              );
              approvedCount++;
              continue;
            }

            // Check if tool was previously approved and saved to WorkflowPermissionService
            if (workflowPermissionService) {
              const savedPermission = workflowPermissionService.checkPermission({
                toolName: tool.name,
                executionId,
                workflowId,
              });
              if (savedPermission.granted) {
                permissionService.addSessionApproval(
                  session.id,
                  tool.name,
                  `Previously approved (${savedPermission.permission?.scope} scope)`
                );
                approvedCount++;
                this.debugLog(`[WorkflowAI] Tool ${tool.name} auto-approved from saved permission (${savedPermission.permission?.scope})`);
              }
            }
            // Tools not approved will trigger normal permission prompts
          }
        }
      }

      // Auto-approve DelegateToAgent since it's a coordination tool, not a system action
      permissionService.addSessionApproval(
        session.id,
        'DelegateToAgent',
        'Workflow agent delegation tool (auto-approved)'
      );
      approvedCount++;

      this.debugLog(`[WorkflowAI] Pre-approved ${approvedCount} tools for session ${session.id}`);
      if (allAllowedTools.size === 0 && approvedCount === 0) {
        this.debugLog(`[WorkflowAI] No pre-approved tools - all tools will require user approval`);
      }

      let totalTokensIn = 0;
      let totalTokensOut = 0;
      let currentIteration = 1;
      let finalIterationContent = '';
      let pendingHandoff: { targetAgentId: string; targetAgentName: string; message: string; context?: string } | null = null;

      try {
        this.debugLog(`[WorkflowAI] Sending message with streaming...`);

        // Use streaming method with callback for real-time updates
        // The AI service's internal agentic loop handles all tool use iterations
        const response = await this.aiAdapter.sendMessageWithStreaming(
          {
            sessionId: session.id,
            content: request.prompt,
          },
          // Forward streaming deltas for current iteration
          (delta: string, accumulated: string) => {
            if (onStream) {
              onStream({
                type: 'delta',
                delta,
                content: accumulated,
                iteration: currentIteration,
              });
            }
          },
          // Forward permission requests to the workflow system
          (permissionRequest) => {
            this.debugLog(`[WorkflowAI] Permission request for tool: ${permissionRequest.toolName} (id: ${permissionRequest.id})`);
            // Emit notification to frontend for permission UI
            if (onStream) {
              onStream({
                type: 'permission_request',
                toolId: permissionRequest.id,
                toolName: permissionRequest.toolName,
                input: permissionRequest.input,
                description: permissionRequest.description,
                sessionId: session.id,
                iteration: currentIteration,
              });
            }
            // Also emit via workflow notification system for ToolPanel
            this.workflowAdapter.emitPermissionRequest({
              toolId: permissionRequest.id,
              toolName: permissionRequest.toolName,
              input: permissionRequest.input,
              description: permissionRequest.description,
              sessionId: session.id,
              executionId: request.metadata?.executionId,
              nodeId: request.metadata?.nodeId,
              workflowId: request.metadata?.workflowId,
            });
          },
          // Forward tool execution events (including auto-approved tools)
          (toolEvent) => {
            this.debugLog(`[WorkflowAI] Tool execution event: ${toolEvent.type} for ${toolEvent.toolName} (id: ${toolEvent.toolId}), autoApproved: ${toolEvent.autoApproved}`);

            // Detect DelegateToAgent handoff marker in completed tool results
            if (
              toolEvent.type === 'completed' &&
              toolEvent.toolName === 'DelegateToAgent' &&
              toolEvent.success &&
              toolEvent.output
            ) {
              try {
                const outputStr = typeof toolEvent.output === 'string'
                  ? toolEvent.output
                  : JSON.stringify(toolEvent.output);
                const parsed = JSON.parse(outputStr);
                if (parsed?.__handoff) {
                  pendingHandoff = parsed.__handoff;
                  this.debugLog(`[WorkflowAI] Detected handoff to agent: ${pendingHandoff!.targetAgentId}`);
                }
              } catch {
                // Not JSON or no handoff marker — ignore
              }
            }

            // Emit tool execution notification for ToolPanel to show all tools
            this.workflowAdapter.emitToolExecution({
              type: toolEvent.type,
              toolId: toolEvent.toolId,
              toolName: toolEvent.toolName,
              input: toolEvent.input,
              output: toolEvent.output,
              success: toolEvent.success,
              error: toolEvent.error,
              autoApproved: toolEvent.autoApproved,
              approvalScope: toolEvent.approvalScope,
              executionId: request.metadata?.executionId,
              nodeId: request.metadata?.nodeId,
              workflowId: request.metadata?.workflowId,
            });
          },
          // Forward iteration boundary events from the AI service's internal agentic loop
          (iterationEvent) => {
            this.debugLog(`[WorkflowAI] Iteration event: ${iterationEvent.type}, iteration ${iterationEvent.iteration}, hasToolUse: ${iterationEvent.hasToolUse}`);
            if (iterationEvent.type === 'complete' && iterationEvent.hasToolUse) {
              // Iteration completed with tool use - emit tool_use event to finalize current message
              this.debugLog(`[WorkflowAI] STREAMING: Emitting 'tool_use' event for iteration ${currentIteration}`);
              if (onStream) {
                onStream({
                  type: 'tool_use',
                  iteration: currentIteration,
                  iterationContent: iterationEvent.iterationContent || '',
                });
              }
            } else if (iterationEvent.type === 'start') {
              // New iteration starting - emit iteration event to create new message
              currentIteration = iterationEvent.iteration;
              this.debugLog(`[WorkflowAI] STREAMING: Emitting 'iteration' event for iteration ${currentIteration}`);
              if (onStream) {
                onStream({
                  type: 'iteration',
                  iteration: currentIteration,
                });
              }
            } else if (iterationEvent.type === 'complete' && !iterationEvent.hasToolUse) {
              // Final iteration completed - save content for response
              finalIterationContent = iterationEvent.iterationContent || '';
              this.debugLog(`[WorkflowAI] STREAMING: Emitting 'complete' event for iteration ${currentIteration}`);
              if (onStream) {
                onStream({
                  type: 'complete',
                  content: finalIterationContent,
                  iteration: currentIteration,
                  iterationContent: finalIterationContent,
                });
              }
            }
          }
        );

        // Accumulate token usage
        if (response.usage?.inputTokens) totalTokensIn += response.usage.inputTokens;
        if (response.usage?.outputTokens) totalTokensOut += response.usage.outputTokens;

        // Extract final text content from response (in case iteration events didn't capture it)
        if (!finalIterationContent) {
          finalIterationContent = response.message.content
            .filter((block: { type: string; text?: string }) => block.type === 'text' && block.text)
            .map((block: { type: string; text?: string }) => block.text)
            .join('\n');
        }

        this.debugLog(`[WorkflowAI] Final: ${finalIterationContent.length} chars, ${totalTokensIn} in, ${totalTokensOut} out`);

        return {
          content: finalIterationContent,
          tokensIn: totalTokensIn,
          tokensOut: totalTokensOut,
          agentId: request.agentId,
          agentName: request.agentId,
          handoff: pendingHandoff ?? undefined,
        };
      } finally {
        await this.aiAdapter.handleRequest('ai/session/delete', {
          sessionId: session.id,
        });
        this.debugLog(`[WorkflowAI] Cleaned up session: ${session.id}`);
      }
    });

    this.debugLog('Workflow AI executor wired');
  }

  /**
   * Reinitialize chat storage and ChatOrchestrator when workspace changes.
   * This ensures multi-agent features work after switching workspaces.
   */
  private async reinitializeChatForWorkspace(workspacePath: string): Promise<void> {
    console.log('[ECPServer] reinitializeChatForWorkspace called with:', workspacePath);

    // Update chat adapter with new workspace (reinitializes storage)
    await this.chatAdapter.setWorkspacePath(workspacePath);

    // Update workflow adapter with new workspace
    await this.workflowAdapter.setWorkspacePath(workspacePath);

    // Get the new database and reinitialize ChatOrchestrator
    const chatDb = this.chatAdapter.getDb();
    console.log('[ECPServer] chatDb after reinit:', chatDb ? 'EXISTS' : 'NULL');
    if (chatDb) {
      this.chatOrchestrator = new ChatOrchestrator({ db: chatDb });
      await this.chatOrchestrator.initialize();

      // Wire new ChatOrchestrator into AIServiceAdapter
      this.aiAdapter.setChatOrchestrator(this.chatOrchestrator);

      // Re-wire AI executor for workflows
      this.wireWorkflowAIExecutor();

      this.debugLog('ChatOrchestrator reinitialized for new workspace');
    } else {
      this.debugLog('No chat database available for workspace');
    }
  }

  /**
   * Shutdown the server and clean up resources.
   */
  async shutdown(): Promise<void> {
    if (this._state === 'shutdown') {
      return;
    }

    this._state = 'shutdown';
    this.debugLog('Shutting down...');

    // Shutdown middleware
    await this.middleware.shutdown();

    // Close all open documents
    const documents = this.documentService.listOpen();
    for (const doc of documents) {
      await this.documentService.close(doc.documentId);
    }

    // Dispose file service resources
    this.fileService.dispose();
    this.fileAdapter.dispose();

    // Shutdown LSP service
    await this.lspService.shutdown();

    // Close all terminals
    this.terminalService.closeAll();

    // Shutdown secret and database services
    await this.secretService.shutdown();
    await this.databaseService.shutdown();

    // Shutdown AI service
    await this.aiService.shutdown();

    // Shutdown chat storage
    this.chatAdapter.shutdown();

    // Clear listeners
    this.notificationListeners.clear();

    this.debugLog('Shutdown complete');
  }

  /**
   * Register a middleware.
   * Middleware are executed in priority order (lower runs first).
   */
  use(middleware: ECPMiddleware): void {
    this.middleware.use(middleware);
  }

  /**
   * Get registered middleware names.
   */
  getMiddlewareNames(): string[] {
    return this.middleware.getMiddlewareNames();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Service Access (for advanced use cases)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get a service directly.
   * Use this sparingly - prefer using request() for most operations.
   */
  getService<T>(
    name: 'document' | 'file' | 'git' | 'session' | 'lsp' | 'syntax' | 'terminal' | 'secret' | 'database' | 'ai'
  ): T {
    switch (name) {
      case 'document':
        return this.documentService as unknown as T;
      case 'file':
        return this.fileService as unknown as T;
      case 'git':
        return this.gitService as unknown as T;
      case 'session':
        return this.sessionService as unknown as T;
      case 'lsp':
        return this.lspService as unknown as T;
      case 'syntax':
        return this.syntaxService as unknown as T;
      case 'terminal':
        return this.terminalService as unknown as T;
      case 'secret':
        return this.secretService as unknown as T;
      case 'database':
        return this.databaseService as unknown as T;
      case 'ai':
        return this.aiService as unknown as T;
      default:
        throw new Error(`Unknown service: ${name}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal Methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Route a request to the appropriate adapter.
   */
  private async routeRequest(
    method: string,
    params: unknown
  ): Promise<HandlerResult> {
    // Document service
    if (method.startsWith('document/')) {
      return this.handleDocumentRequest(method, params);
    }

    // File service
    if (method.startsWith('file/')) {
      return this.handleFileRequest(method, params);
    }

    // Shell service - system operations like reveal in finder
    if (method.startsWith('shell/')) {
      return this.handleShellRequest(method, params);
    }

    // Layout service - programmatic layout control (for AI agents)
    if (method.startsWith('layout/')) {
      return this.handleLayoutRequest(method, params);
    }

    // Git service
    if (method.startsWith('git/')) {
      return this.gitAdapter.handleRequest(method, params);
    }

    // Session service (includes config/, session/, keybindings/, commands/, theme/, workspace/, systemPrompt/)
    if (
      method.startsWith('config/') ||
      method.startsWith('session/') ||
      method.startsWith('keybindings/') ||
      method.startsWith('commands/') ||
      method.startsWith('theme/') ||
      method.startsWith('workspace/') ||
      method.startsWith('systemPrompt/')
    ) {
      return this.sessionAdapter.handleRequest(method, params);
    }

    // LSP service
    if (method.startsWith('lsp/')) {
      return this.lspAdapter.handleRequest(method, params);
    }

    // Syntax service
    if (method.startsWith('syntax/')) {
      return this.syntaxAdapter.handleRequest(method, params);
    }

    // Terminal service
    if (method.startsWith('terminal/')) {
      return this.terminalAdapter.handleRequest(method, params);
    }

    // Secret service
    if (method.startsWith('secret/')) {
      return { result: await this.secretAdapter.handleRequest(method, params) };
    }

    // Database service
    if (method.startsWith('database/')) {
      return { result: await this.databaseAdapter.handleRequest(method, params) };
    }

    // AI service
    if (method.startsWith('ai/')) {
      // Intercept todo operations to use persistent storage
      if (method === 'ai/todo/write') {
        const p = params as { sessionId?: string; todos?: Array<{ content: string; status: string; activeForm?: string }> };
        if (p.todos) {
          const sessionId = p.sessionId || null;
          const todosWithIds = p.todos.map((t, i) => ({
            id: `todo-${Date.now()}-${i}`,
            content: t.content,
            status: t.status as 'pending' | 'in_progress' | 'completed',
            activeForm: t.activeForm || null,
            orderIndex: i,
            completedAt: t.status === 'completed' ? Date.now() : null,
          }));

          // Persist to chat storage
          const chatResult = await this.chatAdapter.handleRequest('chat/todo/replace', {
            sessionId,
            todos: todosWithIds,
          });

          // Also update in-memory cache in AI adapter
          this.aiAdapter.handleRequest(method, params);

          // Return the persisted todos
          const resultTodos = (chatResult as { result?: { todos?: unknown[] } }).result?.todos;
          return { result: { success: true, message: 'Todos updated', todos: resultTodos } };
        }
      }

      if (method === 'ai/todo/get') {
        // Load from persistent storage
        const p = params as { sessionId?: string };
        const chatResult = await this.chatAdapter.handleRequest('chat/todo/list', {
          sessionId: p?.sessionId || null,
        });

        // chat/todo/list returns an array directly, not { todos: [...] }
        type TodoItem = { content: string; status: string; activeForm: string | null };
        const resultArray = (chatResult as { result?: TodoItem[] }).result || [];
        const todos = resultArray.map(t => ({
          content: t.content,
          status: t.status,
          activeForm: t.activeForm,
        }));

        return { result: { todos } };
      }

      return this.aiAdapter.handleRequest(method, params);
    }

    // Chat storage service
    if (method.startsWith('chat/')) {
      return this.chatAdapter.handleRequest(method, params);
    }

    // Workflow service
    if (method.startsWith('workflow/')) {
      return this.workflowAdapter.handleRequest(method, params);
    }

    // Agent service
    if (method.startsWith('agent/')) {
      return this.agentAdapter.handleRequest(method, params);
    }

    // Auth service
    if (method.startsWith('auth/')) {
      return this.authAdapter.handleRequest(method, params);
    }

    // Models service
    if (method.startsWith('models/')) {
      return this.handleModelsRequest(method);
    }

    // Method not found
    return {
      error: {
        code: ECPErrorCodes.MethodNotFound,
        message: `Method not found: ${method}`,
      },
    };
  }

  /**
   * Handle document service requests.
   * DocumentServiceAdapter has a different interface (takes full ECPRequest).
   */
  private async handleDocumentRequest(
    method: string,
    params: unknown
  ): Promise<HandlerResult> {
    const request = {
      jsonrpc: '2.0' as const,
      id: this.requestIdCounter,
      method,
      params,
    };

    const response = await this.documentAdapter.handleRequest(request);

    if ('error' in response && response.error) {
      return { error: response.error };
    }

    return { result: (response as { result: unknown }).result };
  }

  /**
   * Handle file service requests.
   * FileServiceAdapter has a different interface (takes full ECPRequest).
   */
  private async handleFileRequest(
    method: string,
    params: unknown
  ): Promise<HandlerResult> {
    const request = {
      jsonrpc: '2.0' as const,
      id: this.requestIdCounter,
      method,
      params,
    };

    const response = await this.fileAdapter.handleRequest(request);

    if ('error' in response && response.error) {
      return { error: response.error };
    }

    return { result: (response as { result: unknown }).result };
  }

  /**
   * Handle shell service requests (system operations).
   */
  private async handleShellRequest(
    method: string,
    params: unknown
  ): Promise<HandlerResult> {
    const p = params as { path?: string };

    switch (method) {
      case 'shell/reveal': {
        // Reveal file/folder in system file manager (Finder on macOS)
        if (!p.path) {
          return { error: { code: -32602, message: 'Path is required' } };
        }
        const path = p.path;
        try {
          // Use 'open -R' on macOS to reveal in Finder
          const proc = Bun.spawn(['open', '-R', path], {
            stdout: 'pipe',
            stderr: 'pipe',
          });
          await proc.exited;
          return { result: { success: true } };
        } catch (error) {
          return { error: { code: -32000, message: `Failed to reveal: ${error}` } };
        }
      }

      case 'shell/openExternal': {
        // Open file/URL with default application
        if (!p.path) {
          return { error: { code: -32602, message: 'Path is required' } };
        }
        const path = p.path;
        try {
          const proc = Bun.spawn(['open', path], {
            stdout: 'pipe',
            stderr: 'pipe',
          });
          await proc.exited;
          return { result: { success: true } };
        } catch (error) {
          return { error: { code: -32000, message: `Failed to open: ${error}` } };
        }
      }

      case 'shell/rebuild': {
        // Exit with code 75 to signal the launcher script to rebuild and restart.
        // Respond first so the client knows it's happening, then exit.
        setTimeout(() => process.exit(75), 100);
        return { result: { success: true } };
      }

      default:
        return {
          error: { code: -32601, message: `Unknown shell method: ${method}` },
        };
    }
  }

  /**
   * Handle layout service requests (for AI agent control of UI).
   * These commands send notifications to the frontend to manipulate the tile layout.
   */
  private async handleLayoutRequest(
    method: string,
    params: unknown
  ): Promise<HandlerResult> {
    // Forward layout commands as notifications to the frontend
    // The frontend will handle the actual layout changes
    switch (method) {
      case 'layout/addTab': {
        // Add a component as a new tab in a tile
        const p = params as { tileId: string; componentId: string; props?: Record<string, unknown>; focus?: boolean };
        if (!p.tileId || !p.componentId) {
          return { error: { code: -32602, message: 'tileId and componentId are required' } };
        }
        this.emitNotification('layout/didRequestAddTab', {
          tileId: p.tileId,
          componentId: p.componentId,
          props: p.props || {},
          focus: p.focus !== false,
        });
        return { result: { success: true, action: 'addTab' } };
      }

      case 'layout/splitTile': {
        // Split a tile and add content to the new pane
        const p = params as { tileId: string; direction: 'horizontal' | 'vertical'; componentId: string; props?: Record<string, unknown> };
        if (!p.tileId || !p.direction || !p.componentId) {
          return { error: { code: -32602, message: 'tileId, direction, and componentId are required' } };
        }
        this.emitNotification('layout/didRequestSplit', {
          tileId: p.tileId,
          direction: p.direction,
          componentId: p.componentId,
          props: p.props || {},
        });
        return { result: { success: true, action: 'splitTile' } };
      }

      case 'layout/focusTile': {
        // Bring a tile into focus
        const p = params as { tileId: string };
        if (!p.tileId) {
          return { error: { code: -32602, message: 'tileId is required' } };
        }
        this.emitNotification('layout/didRequestFocus', { tileId: p.tileId });
        return { result: { success: true, action: 'focusTile' } };
      }

      case 'layout/openFile': {
        // Open a file in the best location (or specified tile)
        const p = params as { path: string; tileId?: string; split?: boolean };
        if (!p.path) {
          return { error: { code: -32602, message: 'path is required' } };
        }
        this.emitNotification('layout/didRequestOpenFile', {
          path: p.path,
          tileId: p.tileId,
          split: p.split || false,
        });
        return { result: { success: true, action: 'openFile' } };
      }

      case 'layout/setPreset': {
        // Switch to a named layout preset
        const p = params as { presetId: string };
        if (!p.presetId) {
          return { error: { code: -32602, message: 'presetId is required' } };
        }
        this.emitNotification('layout/didRequestPreset', { presetId: p.presetId });
        return { result: { success: true, action: 'setPreset' } };
      }

      case 'layout/closeTile': {
        // Close a tile
        const p = params as { tileId: string };
        if (!p.tileId) {
          return { error: { code: -32602, message: 'tileId is required' } };
        }
        this.emitNotification('layout/didRequestClose', { tileId: p.tileId });
        return { result: { success: true, action: 'closeTile' } };
      }

      case 'layout/getLayout': {
        // Return cached layout state from frontend
        // If no cached state, request it and return what we have
        if (!this.cachedLayoutState) {
          this.emitNotification('layout/didRequestState', {});
          return { result: { state: null, stale: true, message: 'Layout state requested from frontend' } };
        }

        // Check if state is stale (older than 30 seconds)
        const isStale = Date.now() - this.cachedLayoutState.timestamp > 30000;
        if (isStale) {
          this.emitNotification('layout/didRequestState', {});
        }

        return { result: { state: this.cachedLayoutState, stale: isStale } };
      }

      case 'layout/reportState': {
        // Frontend reports its current layout state
        const p = params as Partial<LayoutState>;
        this.cachedLayoutState = {
          presetId: p.presetId || '',
          focusedTileId: p.focusedTileId || '',
          activeTabs: p.activeTabs || {},
          openFiles: p.openFiles || [],
          activeFileId: p.activeFileId || null,
          visibleTiles: p.visibleTiles || [],
          timestamp: Date.now(),
        };
        this.debugLog('Layout state updated');
        return { result: { success: true } };
      }

      case 'layout/closeTab': {
        // Close a specific tab in a tile
        const p = params as { tileId: string; tabId: string };
        if (!p.tileId || !p.tabId) {
          return { error: { code: -32602, message: 'tileId and tabId are required' } };
        }
        this.emitNotification('layout/didRequestCloseTab', {
          tileId: p.tileId,
          tabId: p.tabId,
        });
        return { result: { success: true, action: 'closeTab' } };
      }

      case 'layout/activateTab': {
        // Activate a specific tab in a tile
        const p = params as { tileId: string; tabId: string };
        if (!p.tileId || !p.tabId) {
          return { error: { code: -32602, message: 'tileId and tabId are required' } };
        }
        this.emitNotification('layout/didRequestActivateTab', {
          tileId: p.tileId,
          tabId: p.tabId,
        });
        return { result: { success: true, action: 'activateTab' } };
      }

      default:
        return {
          error: { code: -32601, message: `Unknown layout method: ${method}` },
        };
    }
  }

  /**
   * Emit a notification to all listeners.
   */
  private emitNotification(method: string, params: unknown): void {
    for (const listener of this.notificationListeners) {
      try {
        listener(method, params);
      } catch (error) {
        this.debugLog(`Notification listener error: ${error}`);
      }
    }
  }

  /**
   * Handle models service requests.
   */
  private async handleModelsRequest(method: string): Promise<HandlerResult> {
    switch (method) {
      case 'models/list': {
        const config = await loadModels();
        return { result: config };
      }
      case 'models/refresh': {
        const result = await refreshModels();
        return { result };
      }
      default:
        return {
          error: {
            code: ECPErrorCodes.MethodNotFound,
            message: `Method not found: ${method}`,
          },
        };
    }
  }

  /**
   * Set up notification handlers for all adapters.
   */
  private setupNotificationHandlers(): void {
    const forwardNotification = (notification: ECPNotification | { method: string; params: unknown }) => {
      for (const listener of this.notificationListeners) {
        try {
          listener(notification.method, notification.params);
        } catch (error) {
          this.debugLog(`Notification listener error: ${error}`);
        }
      }

      // Handle workspace change - update adapters' workspace root
      if (notification.method === 'workspace/didChangeRoot') {
        const params = notification.params as { path: string };
        if (params?.path) {
          this.workspaceRoot = params.path;
          this.fileAdapter.setWorkspaceRoot(params.path);
          this.terminalAdapter.setWorkspaceRoot(params.path);
          this.lspService.setWorkspaceRoot(params.path);

          // Reinitialize chat storage and ChatOrchestrator for new workspace
          this.reinitializeChatForWorkspace(params.path).catch((err: unknown) => {
            this.debugLog(`Failed to reinitialize chat for workspace: ${err}`);
          });

          this.debugLog(`Workspace root changed to: ${params.path}`);
        }
      }
    };

    // Document adapter
    this.documentAdapter.setNotificationHandler(forwardNotification);

    // File adapter
    this.fileAdapter.setNotificationHandler(forwardNotification);

    // LSP adapter
    this.lspAdapter.setNotificationHandler(forwardNotification);

    // Terminal adapter
    this.terminalAdapter.setNotificationHandler(forwardNotification);

    // AI adapter
    this.aiAdapter.setNotificationHandler(forwardNotification);

    // Session adapter
    this.sessionAdapter.setNotificationHandler(forwardNotification);

    // Chat adapter
    this.chatAdapter.setNotificationHandler(forwardNotification);

    // Workflow adapter
    this.workflowAdapter.setNotificationHandler(forwardNotification);

    // Agent adapter
    this.agentAdapter.setNotificationHandler(forwardNotification);
  }
}

/**
 * Create an ECP server instance.
 */
export function createECPServer(options?: ECPServerOptions): ECPServer {
  return new ECPServer(options);
}
