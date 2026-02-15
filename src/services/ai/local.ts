/**
 * Local AI Service
 *
 * Implementation of the AI Service interface.
 * Coordinates between AI providers, the ECP for tool execution,
 * and the middleware pipeline for request/response processing.
 */

import type { AIService } from './interface.ts';
import type {
  AIProviderType,
  AIProviderConfig,
  AIProviderCapabilities,
  ChatSession,
  ChatMessage,
  CreateSessionOptions,
  SendMessageOptions,
  AIResponse,
  ToolDefinition,
  ToolExecutionResult,
  ToolUseContent,
  StreamEvent,
  ToolUseRequestEvent,
  MiddlewareDefinition,
  PipelineConfig,
  SessionEvent,
  SessionEventCallback,
  Unsubscribe,
  TextContent,
  ToolResultContent,
} from './types.ts';
import {
  generateSessionId,
  generateMessageId,
  createTextMessage,
  getToolUses,
} from './types.ts';
import {
  type AIProvider,
  createProvider,
  getRegisteredProviders,
} from './providers/index.ts';
import { Pipeline, createPipeline } from './framework/index.ts';
import {
  ToolExecutor,
  createToolExecutor,
  getToolTranslator,
  type ToolTranslator,
} from './tools/index.ts';
import { debugLog, isDebugEnabled } from '../../debug.ts';
import {
  PermissionService,
  getPermissionService,
  type ApprovalScope,
} from './permissions.ts';
import { localSecretService } from '../secret/local.ts';

// Import providers to register them
import './providers/claude.ts';
import './providers/openai.ts';
import './providers/gemini.ts';
import './providers/ollama.ts';

/**
 * Pending permission request.
 */
interface PendingPermission {
  /** Tool use content */
  toolUse: ToolUseContent;
  /** Session ID */
  sessionId: string;
  /** Resolve function for the promise */
  resolve: (approved: boolean) => void;
  /** Timestamp when request was made */
  timestamp: number;
}

/**
 * Local AI Service implementation.
 */
export class LocalAIService implements AIService {
  private sessions: Map<string, ChatSession> = new Map();
  private providers: Map<string, AIProvider> = new Map();
  private pipeline: Pipeline;
  private toolExecutor: ToolExecutor;
  private eventListeners: Set<SessionEventCallback> = new Set();
  private sessionEventListeners: Map<string, Set<SessionEventCallback>> = new Map();
  private initialized = false;

  /** Pending permission requests (tool use ID -> pending request) */
  private pendingPermissions: Map<string, PendingPermission> = new Map();

  /** Permission service for approval management */
  private permissionService: PermissionService;

  /** Cached tool translators per provider */
  private translators: Map<string, ToolTranslator> = new Map();

  constructor() {
    this.pipeline = createPipeline();
    this.toolExecutor = createToolExecutor();
    this.permissionService = getPermissionService();
  }

  /**
   * Get the tool translator for a provider type.
   * Caches translators for reuse.
   */
  private getTranslator(providerType: AIProviderType): ToolTranslator {
    let translator = this.translators.get(providerType);
    if (!translator) {
      translator = getToolTranslator(providerType);
      this.translators.set(providerType, translator);
      this.log(`Created tool translator for provider: ${providerType}`);
    }
    return translator;
  }

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[LocalAIService] ${msg}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    if (this.initialized) return;
    this.log('Initializing AI service');

    // Initialize secret service for API key access from keychain
    await localSecretService.init();

    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    this.log('Shutting down AI service');

    // Cancel any active providers
    for (const provider of this.providers.values()) {
      provider.cancel();
    }

    // Clear sessions
    this.sessions.clear();
    this.providers.clear();
    this.eventListeners.clear();
    this.sessionEventListeners.clear();
    this.initialized = false;
  }

  /**
   * Set the ECP request function for tool execution.
   */
  setECPRequest(requestFn: <T>(method: string, params?: unknown) => Promise<T>): void {
    this.toolExecutor.setECPRequest(requestFn);
    // Default: tool executions are agent-originated.
    // Caller identity is asserted server-side at the ECP boundary.
    this.toolExecutor.setCaller({ type: 'agent', agentId: 'local-ai-service' });
    this.log('ECP request function configured');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Provider Management
  // ─────────────────────────────────────────────────────────────────────────

  getAvailableProviders(): AIProviderType[] {
    return getRegisteredProviders();
  }

  getProviderCapabilities(providerType: AIProviderType): AIProviderCapabilities {
    // Get or create a temporary provider to check capabilities
    const config: AIProviderConfig = { type: providerType, name: providerType };
    const provider = createProvider(config);

    if (!provider) {
      return {
        toolUse: false,
        streaming: false,
        vision: false,
        systemMessages: true,
        maxContextTokens: 0,
        maxOutputTokens: 0,
      };
    }

    return provider.getCapabilities();
  }

  async isProviderAvailable(providerType: AIProviderType): Promise<boolean> {
    const config: AIProviderConfig = { type: providerType, name: providerType };
    const provider = createProvider(config);

    if (!provider) return false;
    return provider.isAvailable();
  }

  async getAvailableModels(providerType: AIProviderType): Promise<string[]> {
    const config: AIProviderConfig = { type: providerType, name: providerType };
    const provider = createProvider(config);

    if (!provider) return [];
    return provider.getAvailableModels();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Session Management
  // ─────────────────────────────────────────────────────────────────────────

  async createSession(options: CreateSessionOptions): Promise<ChatSession> {
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    this.log(`Creating session: ${sessionId}`);

    // Create provider
    const provider = createProvider(options.provider);
    if (!provider) {
      throw new Error(`Unknown provider: ${options.provider.type}`);
    }

    // Check if provider is available
    const isAvailable = await provider.isAvailable();
    if (!isAvailable) {
      throw new Error(`Provider ${options.provider.type} is not available`);
    }

    // If resuming a CLI session, set the session ID on the provider
    if (options.cliSessionId && 'setSessionId' in provider) {
      (provider as { setSessionId: (id: string) => void }).setSessionId(options.cliSessionId);
      this.log(`Resuming CLI session: ${options.cliSessionId}`);
    }

    this.providers.set(sessionId, provider);

    const session: ChatSession = {
      id: sessionId,
      provider: options.provider,
      messages: options.messages || [],
      state: 'idle',
      tools: options.tools || this.getToolsForProvider(options.provider.type),
      systemPrompt: options.systemPrompt,
      metadata: options.metadata,
      cliSessionId: options.cliSessionId,
      cwd: options.cwd,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.sessions.set(sessionId, session);

    // Fix any orphaned tool_use blocks in the restored history
    // This can happen if history was saved mid-tool-use
    if (options.messages && options.messages.length > 0) {
      this.fixOrphanedToolUses(session);
    }

    this.emitEvent({ type: 'session_created', sessionId, timestamp: Date.now() });

    return session;
  }

  getSession(sessionId: string): ChatSession | null {
    return this.sessions.get(sessionId) || null;
  }

  listSessions(): ChatSession[] {
    return Array.from(this.sessions.values());
  }

  deleteSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Cancel any active provider
    const provider = this.providers.get(sessionId);
    if (provider) {
      provider.cancel();
    }

    this.sessions.delete(sessionId);
    this.providers.delete(sessionId);
    this.sessionEventListeners.delete(sessionId);
    this.emitEvent({ type: 'session_deleted', sessionId, timestamp: Date.now() });

    return true;
  }

  clearSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.messages = [];
    session.updatedAt = Date.now();
    this.emitEvent({ type: 'session_updated', sessionId, timestamp: Date.now() });

    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Messaging
  // ─────────────────────────────────────────────────────────────────────────

  async sendMessage(options: SendMessageOptions): Promise<AIResponse> {
    const session = this.sessions.get(options.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${options.sessionId}`);
    }

    const provider = this.providers.get(options.sessionId);
    if (!provider) {
      throw new Error(`Provider not found for session: ${options.sessionId}`);
    }

    // Create user message
    const userMessage = this.createUserMessage(options.content);
    session.messages.push(userMessage);
    session.state = 'waiting';
    session.updatedAt = Date.now();
    this.emitEvent({
      type: 'message_added',
      sessionId: session.id,
      data: userMessage,
      timestamp: Date.now(),
    });

    // Run pre-request pipeline
    const preResult = await this.pipeline.executePreRequest(session, options);
    if (!preResult.success) {
      session.state = 'error';
      throw new Error(`Pre-request pipeline failed: ${preResult.error}`);
    }

    // Send to AI provider
    // Default to 8192 tokens if not specified - enough for most responses
    const maxTokens = options.maxTokens ?? 16384;
    try {
      const response = await provider.chat({
        messages: session.messages,
        systemPrompt: session.systemPrompt,
        tools: options.tools || session.tools,
        maxTokens,
        temperature: options.temperature,
        cwd: session.cwd,
      });

      // Run post-response pipeline
      const postResult = await this.pipeline.executePostResponse(session, response);
      if (!postResult.success) {
        session.state = 'error';
        throw new Error(`Post-response pipeline failed: ${postResult.error}`);
      }

      // Use potentially modified response
      const finalResponse = postResult.context.response || response;

      // Add assistant message
      session.messages.push(finalResponse.message);
      session.updatedAt = Date.now();
      this.emitEvent({
        type: 'message_added',
        sessionId: session.id,
        data: finalResponse.message,
        timestamp: Date.now(),
      });

      // Capture CLI session ID for resume support
      if ('getSessionId' in provider) {
        const cliSessionId = (provider as { getSessionId: () => string | null }).getSessionId();
        if (cliSessionId && cliSessionId !== session.cliSessionId) {
          session.cliSessionId = cliSessionId;
          this.log(`Captured CLI session ID: ${cliSessionId}`);
        }
      }

      // Handle tool use
      if (finalResponse.stopReason === 'tool_use') {
        session.state = 'tool_use';
        await this.handleToolUse(session, finalResponse);
      } else {
        session.state = 'idle';
      }

      return finalResponse;
    } catch (error) {
      session.state = 'error';
      throw error;
    }
  }

  async sendMessageStreaming(
    options: SendMessageOptions,
    onEvent: (event: StreamEvent) => void
  ): Promise<AIResponse> {
    const session = this.sessions.get(options.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${options.sessionId}`);
    }

    const provider = this.providers.get(options.sessionId);
    if (!provider) {
      throw new Error(`Provider not found for session: ${options.sessionId}`);
    }

    // Create user message
    const userMessage = this.createUserMessage(options.content);
    session.messages.push(userMessage);
    session.state = 'streaming';
    session.updatedAt = Date.now();
    this.emitEvent({
      type: 'message_added',
      sessionId: session.id,
      data: userMessage,
      timestamp: Date.now(),
    });

    // Run pre-request pipeline
    const preResult = await this.pipeline.executePreRequest(session, options);
    if (!preResult.success) {
      session.state = 'error';
      throw new Error(`Pre-request pipeline failed: ${preResult.error}`);
    }

    // Forward stream events
    const wrappedOnEvent = (event: StreamEvent) => {
      this.emitEvent({
        type: 'stream_event',
        sessionId: session.id,
        data: event,
        timestamp: Date.now(),
      });
      onEvent(event);
    };

    try {
      let finalResponse: AIResponse;
      let continueLoop = true;
      let iterations = 0;
      let previousIterationContent = '';

      while (continueLoop) {
        // Check if cancelled
        if (session.state === 'idle') {
          this.log(`Session cancelled, stopping tool use loop`);
          break;
        }

        iterations++;

        // Emit iteration_start for iterations after the first
        if (iterations > 1) {
          wrappedOnEvent({
            type: 'iteration_start',
            iteration: iterations,
            previousIterationContent,
          } as StreamEvent);
        }

        // Fix any orphaned tool_use blocks before making the API call
        // This prevents the "tool_use without tool_result" API error
        this.fixOrphanedToolUses(session);

        // Default to 8192 tokens if not specified
        const maxTokens = options.maxTokens ?? 16384;
        const tools = options.tools || session.tools;

        const response = await provider.chatStream(
          {
            messages: session.messages,
            systemPrompt: session.systemPrompt,
            tools,
            maxTokens,
            temperature: options.temperature,
            stream: true,
            cwd: session.cwd,
          },
          wrappedOnEvent
        );

        // Run post-response pipeline
        const postResult = await this.pipeline.executePostResponse(session, response);
        if (!postResult.success) {
          session.state = 'error';
          throw new Error(`Post-response pipeline failed: ${postResult.error}`);
        }

        finalResponse = postResult.context.response || response;

        // Extract text content from this iteration's response
        const iterationTextContent = finalResponse.message.content
          .filter((block: { type: string; text?: string }) => block.type === 'text' && block.text)
          .map((block: { type: string; text?: string }) => block.text)
          .join('\n');

        // Add assistant message
        session.messages.push(finalResponse.message);
        session.updatedAt = Date.now();
        this.emitEvent({
          type: 'message_added',
          sessionId: session.id,
          data: finalResponse.message,
          timestamp: Date.now(),
        });

        // Capture CLI session ID for resume support
        if ('getSessionId' in provider) {
          const cliSessionId = (provider as { getSessionId: () => string | null }).getSessionId();
          if (cliSessionId && cliSessionId !== session.cliSessionId) {
            session.cliSessionId = cliSessionId;
            this.log(`Captured CLI session ID: ${cliSessionId}`);
          }
        }

        // Handle tool use - if there are tool calls, execute them and continue the loop
        if (finalResponse.stopReason === 'tool_use') {
          session.state = 'tool_use';

          wrappedOnEvent({
            type: 'iteration_complete',
            iteration: iterations,
            iterationContent: iterationTextContent,
            hasToolUse: true,
          } as StreamEvent);

          await this.handleToolUse(session, finalResponse, wrappedOnEvent);

          // Save content for next iteration's start event
          previousIterationContent = iterationTextContent;
        } else {
          // No more tool use, exit the loop
          session.state = 'idle';
          continueLoop = false;

          wrappedOnEvent({
            type: 'iteration_complete',
            iteration: iterations,
            iterationContent: iterationTextContent,
            hasToolUse: false,
          } as StreamEvent);

          // Emit loop_complete event so client knows the agentic loop is done
          wrappedOnEvent({
            type: 'loop_complete',
          } as StreamEvent);
        }
      }

      // If the loop exited via cancellation (break), continueLoop is still true.
      // Emit loop_complete so the frontend knows to finalize the message.
      // Normal exit (continueLoop=false) already emitted loop_complete inside the loop.
      if (continueLoop) {
        wrappedOnEvent({ type: 'loop_complete' } as StreamEvent);
      }

      return finalResponse!;
    } catch (error) {
      session.state = 'error';
      throw error;
    }
  }

  cancelMessage(sessionId: string): boolean {
    const provider = this.providers.get(sessionId);
    if (!provider) return false;

    provider.cancel();

    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = 'idle';

      // Fix orphaned tool_use blocks by adding cancelled tool_results
      // Claude API requires every tool_use to have a corresponding tool_result
      this.fixOrphanedToolUses(session);
    }

    return true;
  }

  /**
   * Find and fix orphaned tool_use blocks that don't have corresponding tool_results.
   * This happens when a message is cancelled mid-tool-use.
   */
  private fixOrphanedToolUses(session: ChatSession): void {
    // Collect all tool_use IDs and tool_result IDs
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();

    this.log(`[FIX_ORPHANS] Checking ${session.messages.length} messages for orphaned tool_use blocks`);

    for (const message of session.messages) {
      for (const content of message.content) {
        if (content.type === 'tool_use') {
          const toolUse = content as ToolUseContent;
          toolUseIds.add(toolUse.id);
          this.log(`[FIX_ORPHANS] Found tool_use: ${toolUse.id} (${toolUse.name})`);
        } else if (content.type === 'tool_result') {
          const toolResult = content as ToolResultContent;
          toolResultIds.add(toolResult.toolUseId);
          this.log(`[FIX_ORPHANS] Found tool_result for: ${toolResult.toolUseId}`);
        }
      }
    }

    // Find orphaned tool_use IDs (have tool_use but no tool_result)
    const orphanedIds = [...toolUseIds].filter(id => !toolResultIds.has(id));

    this.log(`[FIX_ORPHANS] Summary: ${toolUseIds.size} tool_uses, ${toolResultIds.size} tool_results, ${orphanedIds.length} orphaned`);

    // Add cancelled tool_results for each orphaned tool_use
    for (const toolUseId of orphanedIds) {
      this.log(`[FIX_ORPHANS] Adding cancelled tool_result for orphaned tool_use: ${toolUseId}`);
      this.addToolResult(session, toolUseId, false, 'Operation cancelled by user');
    }
  }

  addMessage(sessionId: string, message: ChatMessage): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.messages.push(message);
    session.updatedAt = Date.now();
    this.emitEvent({
      type: 'message_added',
      sessionId,
      data: message,
      timestamp: Date.now(),
    });

    return true;
  }

  getMessages(sessionId: string): ChatMessage[] | null {
    const session = this.sessions.get(sessionId);
    return session ? [...session.messages] : null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tool Management
  // ─────────────────────────────────────────────────────────────────────────

  getAvailableTools(): ToolDefinition[] {
    return this.toolExecutor.getAvailableTools();
  }

  /**
   * Get tools formatted for a specific provider.
   * Uses the tool translator to convert canonical ECP tools to provider format.
   */
  getToolsForProvider(providerType: AIProviderType): ToolDefinition[] {
    const translator = this.getTranslator(providerType);
    this.toolExecutor.setTranslator(translator);
    const tools = this.toolExecutor.getAvailableTools();
    this.log(`Got ${tools.length} tools for provider: ${providerType}`);
    return tools;
  }

  getECPTools(): ToolDefinition[] {
    return this.toolExecutor.getECPTools();
  }

  registerTool(
    tool: ToolDefinition,
    executor: (input: Record<string, unknown>) => Promise<ToolExecutionResult>
  ): void {
    this.toolExecutor.registerTool(tool, executor);
  }

  registerToolExecutor(
    name: string,
    executor: (input: Record<string, unknown>) => Promise<ToolExecutionResult>
  ): void {
    this.toolExecutor.registerToolExecutor(name, executor);
  }

  unregisterTool(toolName: string): boolean {
    return this.toolExecutor.unregisterTool(toolName);
  }

  async executeTool(toolCall: ToolUseContent): Promise<ToolExecutionResult> {
    return this.toolExecutor.execute(toolCall);
  }

  /**
   * Execute a tool call with provider-specific translation.
   * The translator maps the provider's tool format to ECP format.
   * @param toolCall The tool call to execute
   * @param providerType The provider type for translation
   * @param sessionCwd Optional working directory to inject for terminal commands
   */
  async executeToolForProvider(
    toolCall: ToolUseContent,
    providerType: AIProviderType,
    sessionCwd?: string
  ): Promise<ToolExecutionResult> {
    const translator = this.getTranslator(providerType);
    this.toolExecutor.setTranslator(translator);

    // Inject session cwd for terminal commands if not already specified
    let modifiedToolCall = toolCall;
    if (sessionCwd && this.isTerminalTool(toolCall.name, providerType) && !toolCall.input.cwd) {
      modifiedToolCall = {
        ...toolCall,
        input: {
          ...toolCall.input,
          cwd: sessionCwd,
        },
      };
      this.log(`Injected cwd "${sessionCwd}" into ${toolCall.name} tool call`);
    }

    this.log(`Executing tool ${toolCall.name} with translator for ${providerType}`);
    return this.toolExecutor.execute(modifiedToolCall);
  }

  /**
   * Check if a tool is a terminal/bash tool that should have cwd injected.
   */
  private isTerminalTool(toolName: string, providerType: AIProviderType): boolean {
    // Claude uses 'Bash', OpenAI uses 'execute_command', Gemini uses 'executeCommand'
    const terminalToolNames: Record<AIProviderType, string[]> = {
      claude: ['Bash', 'spawn_process'],
      openai: ['execute_command'],
      gemini: ['executeCommand'],
      ollama: ['Bash', 'execute_command'], // fallback to common names
    };

    const names = terminalToolNames[providerType];
    return names.includes(toolName);
  }

  setSessionTools(sessionId: string, tools: ToolDefinition[]): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.tools = tools;
    session.updatedAt = Date.now();
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Middleware/Pipeline Management
  // ─────────────────────────────────────────────────────────────────────────

  registerMiddleware(middleware: MiddlewareDefinition): void {
    this.pipeline.registerMiddleware(middleware);
  }

  unregisterMiddleware(name: string): boolean {
    return this.pipeline.unregisterMiddleware(name);
  }

  getMiddleware(): MiddlewareDefinition[] {
    return this.pipeline.getMiddleware();
  }

  setMiddlewareEnabled(name: string, enabled: boolean): boolean {
    return this.pipeline.setMiddlewareEnabled(name, enabled);
  }

  getPipelineConfig(): PipelineConfig {
    return this.pipeline.getConfig();
  }

  setPipelineConfig(config: Partial<PipelineConfig>): void {
    this.pipeline.setConfig(config);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Events
  // ─────────────────────────────────────────────────────────────────────────

  onSessionEvent(callback: SessionEventCallback): Unsubscribe {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  onSessionEventFor(sessionId: string, callback: SessionEventCallback): Unsubscribe {
    let listeners = this.sessionEventListeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.sessionEventListeners.set(sessionId, listeners);
    }
    listeners.add(callback);
    return () => listeners?.delete(callback);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────────────────

  private createUserMessage(content: string | Array<{ type: string; text?: string }>): ChatMessage {
    const id = `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    if (typeof content === 'string') {
      return {
        id,
        role: 'user',
        content: [{ type: 'text', text: content }],
        timestamp: Date.now(),
      };
    }

    return {
      id,
      role: 'user',
      content: content.map((c) => {
        if (c.type === 'text') {
          return { type: 'text' as const, text: c.text || '' };
        }
        return c as TextContent;
      }),
      timestamp: Date.now(),
    };
  }

  private async handleToolUse(
    session: ChatSession,
    response: AIResponse,
    onEvent?: (event: StreamEvent) => void
  ): Promise<void> {
    const toolUses = getToolUses(response.message);
    this.log(`[TOOL_USE] handleToolUse called with ${toolUses.length} tool(s)`);

    for (const toolUse of toolUses) {
      this.log(`[TOOL_USE] Processing tool: ${toolUse.name} (id: ${toolUse.id})`);
      this.log(`[TOOL_USE] Tool input: ${JSON.stringify(toolUse.input).substring(0, 200)}...`);

      // Run tool execution pipeline (before)
      const preResult = await this.pipeline.executeToolExecution(session, toolUse);
      if (!preResult.success) {
        this.log(`[TOOL_USE] Tool blocked by pipeline: ${preResult.error}`);
        this.addToolResult(session, toolUse.id, false, `Blocked: ${preResult.error}`);
        continue;
      }

      // Extract target path from tool input for permission checking
      const targetPath = this.extractTargetPath(toolUse);
      this.log(`[TOOL_USE] Extracted target path: ${targetPath || '(none)'}`);

      // Check if this tool is already approved (global, session, or folder scope)
      // Terminal tools are *never* auto-approved for now (governance hardening).
      const isTerminalTool = toolUse.name === 'Bash' || toolUse.name === 'terminal_execute' || toolUse.name === 'terminal_spawn';

      this.log(`[TOOL_USE] Checking permission for ${toolUse.name} in session ${session.id}`);
      const permissionCheck = isTerminalTool
        ? { allowed: false, reason: 'terminal_requires_approval' as const }
        : this.permissionService.checkPermission({
            toolName: toolUse.name,
            sessionId: session.id,
            targetPath,
            input: toolUse.input,
          });
      this.log(`[TOOL_USE] Permission check result: allowed=${permissionCheck.allowed}, reason=${(permissionCheck as any).reason || 'approved'}`);

      if (!permissionCheck.allowed) {
        // Not pre-approved, request user approval
        this.log(`[TOOL_USE] Requesting user approval for ${toolUse.name}...`);
        const approvalResult = await this.requestToolPermission(session, toolUse, onEvent);
        this.log(`[TOOL_USE] User approval result: ${approvalResult}`);

        if (!approvalResult) {
          this.log(`[TOOL_USE] Tool execution denied by user: ${toolUse.name}`);
          this.addToolResult(session, toolUse.id, false, 'User denied permission');
          continue;
        }
        this.log(`[TOOL_USE] User approved tool: ${toolUse.name}`);
      } else {
        this.log(`[TOOL_USE] Tool ${toolUse.name} pre-approved via ${(permissionCheck as any).approval?.scope} scope`);
      }

      // Emit tool_use_started event (for tracking auto-approved and all tool executions)
      if (onEvent) {
        this.log(`[TOOL_USE] Emitting tool_use_started event for ${toolUse.name}`);
        onEvent({
          type: 'tool_use_started',
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          input: toolUse.input,
          autoApproved: permissionCheck.allowed,
          approvalScope: (permissionCheck as any).approval?.scope,
        });
      }

      // Execute the tool through ECP with provider-specific translation
      // Pass session.cwd so terminal commands run in the correct directory
      this.log(`[TOOL_USE] Executing tool: ${toolUse.name} for provider: ${session.provider.type}, cwd: ${session.cwd || '(default)'}`);
      const result = await this.executeToolForProvider(toolUse, session.provider.type, session.cwd);
      this.log(`[TOOL_USE] Tool execution result: success=${result.success}, error=${result.error || 'none'}`);
      if (result.success) {
        const resultStr = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
        this.log(`[TOOL_USE] Tool result preview: ${resultStr.substring(0, 200)}...`);
      }

      // Run tool execution pipeline (after)
      await this.pipeline.executeToolExecution(session, toolUse, result);

      // Format result for display
      const resultContent = result.success
        ? (typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2))
        : (result.error || 'Unknown error');

      // Emit tool result event to UI
      if (onEvent) {
        this.log(`[TOOL_USE] Emitting tool_use_result event for ${toolUse.name}`);
        onEvent({
          type: 'tool_use_result',
          toolUseId: toolUse.id,
          success: result.success,
          result: resultContent,
        });
      }

      // Add tool result to messages
      this.log(`[TOOL_USE] Adding tool result to session messages`);
      this.addToolResult(
        session,
        toolUse.id,
        result.success,
        result.success ? result.result : result.error
      );
      this.log(`[TOOL_USE] Session now has ${session.messages.length} messages`);
    }

    this.log(`[TOOL_USE] handleToolUse complete`);
    session.updatedAt = Date.now();
    // Don't set state to 'idle' here - let the chat loop manage state
    // Setting to 'idle' would trigger the cancellation check in the loop
  }

  /**
   * Request permission to execute a tool.
   * Returns a promise that resolves to true if approved, false if denied.
   */
  private requestToolPermission(
    session: ChatSession,
    toolUse: ToolUseContent,
    onEvent?: (event: StreamEvent) => void
  ): Promise<boolean> {
    this.log(`[PERMISSION] requestToolPermission called for ${toolUse.name} (id: ${toolUse.id})`);

    return new Promise((resolve) => {
      // Store the pending permission
      const pending: PendingPermission = {
        toolUse,
        sessionId: session.id,
        resolve,
        timestamp: Date.now(),
      };
      this.pendingPermissions.set(toolUse.id, pending);
      this.log(`[PERMISSION] Stored pending permission, total pending: ${this.pendingPermissions.size}`);

      // Emit the permission request event
      const event: ToolUseRequestEvent = {
        type: 'tool_use_request',
        id: toolUse.id,
        name: toolUse.name,
        input: toolUse.input,
        description: this.getToolDescription(toolUse),
        requiresApproval: true,
      };

      // Emit via session events for any listeners
      this.log(`[PERMISSION] Emitting tool_use_request event via session events`);
      this.emitEvent({
        type: 'stream_event',
        sessionId: session.id,
        data: event,
        timestamp: Date.now(),
      });

      // Also emit via the stream callback so the UI receives it
      if (onEvent) {
        this.log(`[PERMISSION] Emitting tool_use_request event via stream callback`);
        onEvent(event);
      } else {
        this.log(`[PERMISSION] WARNING: No onEvent callback provided!`);
      }

      this.log(`[PERMISSION] Now waiting for user approval (promise pending)...`);
    });
  }

  /**
   * Generate a human-readable description of what the tool will do.
   */
  private getToolDescription(toolUse: ToolUseContent): string {
    const { name, input } = toolUse;

    switch (name) {
      case 'Edit':
        return `Edit file: ${input.file_path}`;
      case 'Write':
        return `Write file: ${input.file_path}`;
      case 'Bash':
        return `Run command: ${input.command}`;
      case 'Read':
        return `Read file: ${input.file_path}`;
      case 'Glob':
        return `Search files: ${input.pattern}`;
      case 'Grep':
        return `Search content: ${input.pattern}`;
      case 'Delete':
        return `Delete file: ${input.file_path}`;
      default:
        return `Execute ${name}`;
    }
  }

  /**
   * Extract the target file/folder path from a tool use for permission checking.
   */
  private extractTargetPath(toolUse: ToolUseContent): string | undefined {
    const { name, input } = toolUse;

    // File operation tools
    if (input.file_path && typeof input.file_path === 'string') {
      return input.file_path;
    }

    // Glob/Grep with path
    if (input.path && typeof input.path === 'string') {
      return input.path;
    }

    // Bash commands - try to extract path from common patterns
    if (name === 'Bash' && input.command && typeof input.command === 'string') {
      // Very basic extraction - just return undefined for now
      // Could be enhanced to parse commands for file paths
      return undefined;
    }

    return undefined;
  }

  /**
   * Add a tool result to the session.
   */
  private addToolResult(
    session: ChatSession,
    toolUseId: string,
    success: boolean,
    result: unknown
  ): void {
    const toolResultMessage: ChatMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          toolUseId,
          content: success ? result : { error: result },
          isError: !success,
        } as ToolResultContent,
      ],
      timestamp: Date.now(),
    };

    session.messages.push(toolResultMessage);
    this.emitEvent({
      type: 'message_added',
      sessionId: session.id,
      data: toolResultMessage,
      timestamp: Date.now(),
    });
  }

  /**
   * Approve a pending tool permission request.
   * @param toolUseId - The tool use ID
   * @param scope - The approval scope (once, session, folder)
   * @param folderPath - Required for folder scope, the folder to approve for
   */
  approveToolPermission(
    toolUseId: string,
    scope: ApprovalScope = 'once',
    folderPath?: string
  ): boolean {
    this.log(`[PERMISSION] approveToolPermission called: toolUseId=${toolUseId}, scope=${scope}, folderPath=${folderPath || '(none)'}`);
    this.log(`[PERMISSION] Current pending permissions: ${Array.from(this.pendingPermissions.keys()).join(', ') || '(none)'}`);

    const pending = this.pendingPermissions.get(toolUseId);
    if (!pending) {
      this.log(`[PERMISSION] ERROR: No pending permission found for: ${toolUseId}`);
      return false;
    }

    this.log(`[PERMISSION] Found pending permission for tool: ${pending.toolUse.name}`);

    // Record the approval based on scope
    if (scope === 'session') {
      this.log(`[PERMISSION] Adding session approval for ${pending.toolUse.name} in session ${pending.sessionId}`);
      this.permissionService.addSessionApproval(
        pending.sessionId,
        pending.toolUse.name,
        `Approved for session`
      );
      this.log(`[PERMISSION] Session approval added for tool: ${pending.toolUse.name}`);
    } else if (scope === 'folder' && folderPath) {
      this.permissionService.addFolderApproval(
        folderPath,
        pending.toolUse.name,
        `Approved for folder: ${folderPath}`
      );
      this.log(`[PERMISSION] Folder approval added for tool: ${pending.toolUse.name} in ${folderPath}`);
    } else {
      this.log(`[PERMISSION] One-time approval (no persistent record)`);
    }

    this.log(`[PERMISSION] Removing pending permission and resolving promise with true`);
    this.pendingPermissions.delete(toolUseId);
    pending.resolve(true);
    this.log(`[PERMISSION] Permission approved for tool: ${pending.toolUse.name} (scope: ${scope})`);
    this.log(`[PERMISSION] Remaining pending permissions: ${this.pendingPermissions.size}`);
    return true;
  }

  /**
   * Deny a pending tool permission request.
   */
  denyToolPermission(toolUseId: string): boolean {
    const pending = this.pendingPermissions.get(toolUseId);
    if (!pending) {
      this.log(`No pending permission found for: ${toolUseId}`);
      return false;
    }

    this.pendingPermissions.delete(toolUseId);
    pending.resolve(false);
    this.log(`Permission denied for tool: ${pending.toolUse.name}`);
    return true;
  }

  /**
   * Get all pending permission requests.
   */
  getPendingPermissions(): Array<{ id: string; toolUse: ToolUseContent; sessionId: string }> {
    return Array.from(this.pendingPermissions.entries()).map(([id, pending]) => ({
      id,
      toolUse: pending.toolUse,
      sessionId: pending.sessionId,
    }));
  }

  /**
   * Set which tools are auto-approved (don't require user confirmation).
   * This adds them as global approvals in the permission service.
   */
  setAutoApprovedTools(toolNames: string[]): void {
    // Clear existing non-default global approvals and add new ones
    const currentGlobal = this.permissionService.getGlobalApprovals();
    for (const approval of currentGlobal) {
      // Only remove non-default approvals
      if (!['Read', 'Glob', 'Grep', 'LSP'].includes(approval.toolName)) {
        this.permissionService.removeGlobalApproval(approval.toolName);
      }
    }
    for (const toolName of toolNames) {
      this.permissionService.addGlobalApproval(toolName, 'User auto-approved');
    }
    this.log(`Auto-approved tools set to: ${toolNames.join(', ')}`);
  }

  /**
   * Add a tool to the auto-approved list.
   */
  addAutoApprovedTool(toolName: string): void {
    this.permissionService.addGlobalApproval(toolName, 'User auto-approved');
    this.log(`Added auto-approved tool: ${toolName}`);
  }

  /**
   * Remove a tool from the auto-approved list.
   */
  removeAutoApprovedTool(toolName: string): void {
    this.permissionService.removeGlobalApproval(toolName);
    this.log(`Removed auto-approved tool: ${toolName}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Permission Management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get the permission service for direct access to approval management.
   */
  getPermissionService(): PermissionService {
    return this.permissionService;
  }

  /**
   * Get all session approvals for a specific session.
   */
  getSessionApprovals(sessionId: string): import('./permissions.ts').Approval[] {
    return this.permissionService.getSessionApprovals(sessionId);
  }

  /**
   * Get all folder approvals.
   */
  getFolderApprovals(): import('./permissions.ts').Approval[] {
    return this.permissionService.getFolderApprovals();
  }

  /**
   * Get all global approvals.
   */
  getGlobalApprovals(): import('./permissions.ts').Approval[] {
    return this.permissionService.getGlobalApprovals();
  }

  /**
   * Clear all session approvals for a session.
   */
  clearSessionApprovals(sessionId: string): void {
    this.permissionService.clearSessionApprovals(sessionId);
    this.log(`Cleared session approvals for: ${sessionId}`);
  }

  /**
   * Remove a specific session approval.
   */
  removeSessionApproval(sessionId: string, toolName: string): boolean {
    return this.permissionService.removeSessionApproval(sessionId, toolName);
  }

  /**
   * Remove a specific folder approval.
   */
  removeFolderApproval(folderPath: string, toolName: string): boolean {
    return this.permissionService.removeFolderApproval(folderPath, toolName);
  }

  private emitEvent(event: SessionEvent): void {
    // Global listeners
    for (const callback of this.eventListeners) {
      try {
        callback(event);
      } catch (error) {
        this.log(`Event listener error: ${error}`);
      }
    }

    // Session-specific listeners
    const sessionListeners = this.sessionEventListeners.get(event.sessionId);
    if (sessionListeners) {
      for (const callback of sessionListeners) {
        try {
          callback(event);
        } catch (error) {
          this.log(`Session event listener error: ${error}`);
        }
      }
    }
  }
}

/**
 * Create a new Local AI Service instance.
 */
export function createLocalAIService(): LocalAIService {
  return new LocalAIService();
}
