/**
 * AI Service Interface
 *
 * The AI Service manages AI chat sessions including:
 * - Creating and managing chat sessions
 * - Sending messages to AI providers
 * - Handling tool calls via ECP
 * - Running middleware pipelines for validation/processing
 *
 * This service coordinates between AI providers, the ECP for tool execution,
 * and the middleware pipeline for request/response processing.
 */

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
  MiddlewareDefinition,
  PipelineConfig,
  SessionEvent,
  SessionEventCallback,
  Unsubscribe,
} from './types.ts';

/**
 * AI Service interface.
 *
 * Implementations:
 * - LocalAIService: Local AI service using CLI tools
 * - (Future) RemoteAIService: Proxy to remote AI service
 */
export interface AIService {
  // ─────────────────────────────────────────────────────────────────────────
  // Provider Management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get available AI providers.
   *
   * @returns List of available provider types
   */
  getAvailableProviders(): AIProviderType[];

  /**
   * Get capabilities for a provider.
   *
   * @param provider - Provider type
   * @returns Provider capabilities
   */
  getProviderCapabilities(provider: AIProviderType): AIProviderCapabilities;

  /**
   * Check if a provider is available (CLI installed, API key set, etc.).
   *
   * @param provider - Provider type
   * @returns Whether the provider is available
   */
  isProviderAvailable(provider: AIProviderType): Promise<boolean>;

  /**
   * Get available models for a provider.
   *
   * @param provider - Provider type
   * @returns List of available model identifiers
   */
  getAvailableModels(provider: AIProviderType): Promise<string[]>;

  // ─────────────────────────────────────────────────────────────────────────
  // Session Management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a new chat session.
   *
   * @param options - Session creation options
   * @returns Created session
   */
  createSession(options: CreateSessionOptions): Promise<ChatSession>;

  /**
   * Get a session by ID.
   *
   * @param sessionId - Session ID
   * @returns Session or null if not found
   */
  getSession(sessionId: string): ChatSession | null;

  /**
   * List all active sessions.
   *
   * @returns List of sessions
   */
  listSessions(): ChatSession[];

  /**
   * Delete a session.
   *
   * @param sessionId - Session ID
   * @returns Whether the session was deleted
   */
  deleteSession(sessionId: string): boolean;

  /**
   * Clear all messages in a session.
   *
   * @param sessionId - Session ID
   * @returns Whether the operation succeeded
   */
  clearSession(sessionId: string): boolean;

  // ─────────────────────────────────────────────────────────────────────────
  // Messaging
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Send a message to the AI.
   * This runs through the middleware pipeline before and after the AI call.
   *
   * @param options - Send message options
   * @returns AI response
   */
  sendMessage(options: SendMessageOptions): Promise<AIResponse>;

  /**
   * Send a message and stream the response.
   * This runs through the middleware pipeline before and after the AI call.
   *
   * @param options - Send message options
   * @param onEvent - Callback for streaming events
   * @returns Final AI response
   */
  sendMessageStreaming(
    options: SendMessageOptions,
    onEvent: (event: StreamEvent) => void
  ): Promise<AIResponse>;

  /**
   * Cancel an in-progress message.
   *
   * @param sessionId - Session ID
   * @returns Whether the cancellation succeeded
   */
  cancelMessage(sessionId: string): boolean;

  /**
   * Add a message to a session without sending to AI.
   * Useful for adding system messages or restoring history.
   *
   * @param sessionId - Session ID
   * @param message - Message to add
   * @returns Whether the operation succeeded
   */
  addMessage(sessionId: string, message: ChatMessage): boolean;

  /**
   * Get messages in a session.
   *
   * @param sessionId - Session ID
   * @returns List of messages or null if session not found
   */
  getMessages(sessionId: string): ChatMessage[] | null;

  // ─────────────────────────────────────────────────────────────────────────
  // Tool Management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get available tools.
   * These are tools that can be used by AI providers.
   *
   * @returns List of available tools
   */
  getAvailableTools(): ToolDefinition[];

  /**
   * Get ECP-based tools.
   * These map to ECP methods that the AI can call.
   *
   * @returns List of ECP tools
   */
  getECPTools(): ToolDefinition[];

  /**
   * Register a custom tool.
   *
   * @param tool - Tool definition
   * @param executor - Function to execute the tool
   */
  registerTool(
    tool: ToolDefinition,
    executor: (input: Record<string, unknown>) => Promise<ToolExecutionResult>
  ): void;

  /**
   * Register a tool executor without adding its definition to the tool list.
   * The tool will be executable but not advertised in getAvailableTools().
   *
   * @param name - Tool name
   * @param executor - Function to execute the tool
   */
  registerToolExecutor(
    name: string,
    executor: (input: Record<string, unknown>) => Promise<ToolExecutionResult>
  ): void;

  /**
   * Unregister a custom tool.
   *
   * @param toolName - Tool name
   * @returns Whether the tool was unregistered
   */
  unregisterTool(toolName: string): boolean;

  /**
   * Execute a tool call.
   * For ECP tools, this routes to the appropriate ECP method.
   *
   * @param toolCall - Tool use content from AI response
   * @returns Tool execution result
   */
  executeTool(toolCall: ToolUseContent): Promise<ToolExecutionResult>;

  /**
   * Set tools for a session.
   *
   * @param sessionId - Session ID
   * @param tools - Tools to make available
   * @returns Whether the operation succeeded
   */
  setSessionTools(sessionId: string, tools: ToolDefinition[]): boolean;

  // ─────────────────────────────────────────────────────────────────────────
  // Permission Management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Approve a pending tool permission request.
   *
   * @param toolUseId - Tool use ID
   * @returns Whether the approval succeeded
   */
  approveToolPermission(toolUseId: string): boolean;

  /**
   * Deny a pending tool permission request.
   *
   * @param toolUseId - Tool use ID
   * @returns Whether the denial succeeded
   */
  denyToolPermission(toolUseId: string): boolean;

  /**
   * Get all pending permission requests.
   *
   * @returns List of pending permission requests
   */
  getPendingPermissions(): Array<{ id: string; toolUse: ToolUseContent; sessionId: string }>;

  /**
   * Set which tools are auto-approved (don't require user confirmation).
   *
   * @param toolNames - List of tool names
   */
  setAutoApprovedTools(toolNames: string[]): void;

  /**
   * Add a tool to the auto-approved list.
   *
   * @param toolName - Tool name
   */
  addAutoApprovedTool(toolName: string): void;

  /**
   * Remove a tool from the auto-approved list.
   *
   * @param toolName - Tool name
   */
  removeAutoApprovedTool(toolName: string): void;

  // ─────────────────────────────────────────────────────────────────────────
  // Middleware/Pipeline Management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Register middleware.
   *
   * @param middleware - Middleware definition
   */
  registerMiddleware(middleware: MiddlewareDefinition): void;

  /**
   * Unregister middleware.
   *
   * @param name - Middleware name
   * @returns Whether the middleware was unregistered
   */
  unregisterMiddleware(name: string): boolean;

  /**
   * Get registered middleware.
   *
   * @returns List of middleware
   */
  getMiddleware(): MiddlewareDefinition[];

  /**
   * Enable or disable middleware.
   *
   * @param name - Middleware name
   * @param enabled - Whether to enable
   * @returns Whether the operation succeeded
   */
  setMiddlewareEnabled(name: string, enabled: boolean): boolean;

  /**
   * Get pipeline configuration.
   *
   * @returns Pipeline config
   */
  getPipelineConfig(): PipelineConfig;

  /**
   * Set pipeline configuration.
   *
   * @param config - Pipeline config
   */
  setPipelineConfig(config: Partial<PipelineConfig>): void;

  // ─────────────────────────────────────────────────────────────────────────
  // Events
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Subscribe to session events.
   *
   * @param callback - Event callback
   * @returns Unsubscribe function
   */
  onSessionEvent(callback: SessionEventCallback): Unsubscribe;

  /**
   * Subscribe to events for a specific session.
   *
   * @param sessionId - Session ID
   * @param callback - Event callback
   * @returns Unsubscribe function
   */
  onSessionEventFor(sessionId: string, callback: SessionEventCallback): Unsubscribe;

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Initialize the service.
   * Call this before using the service.
   */
  init(): Promise<void>;

  /**
   * Shutdown the service.
   * Cleans up resources and cancels any in-progress operations.
   */
  shutdown(): Promise<void>;
}
