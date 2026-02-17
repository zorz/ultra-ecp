/**
 * AI Service Types
 *
 * Core type definitions for the AI chat framework.
 * Supports multiple providers, tool use, and middleware pipelines.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Provider Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Supported AI providers.
 */
export type AIProviderType = 'claude' | 'openai' | 'gemini' | 'ollama' | 'agent-sdk';

/**
 * Provider configuration.
 */
export interface AIProviderConfig {
  /** Provider type */
  type: AIProviderType;
  /** Display name */
  name: string;
  /** Model identifier (e.g., 'claude-3-opus', 'gpt-4', 'gemini-pro') */
  model?: string;
  /** API key (if using HTTP API) */
  apiKey?: string;
  /** Base URL for API (for custom endpoints) */
  baseUrl?: string;
  /** Use HTTP API instead of CLI (default: true) */
  useHttp?: boolean;
  /** Additional provider-specific options */
  options?: Record<string, unknown>;
}

/**
 * Provider capabilities.
 */
export interface AIProviderCapabilities {
  /** Supports tool/function calling */
  toolUse: boolean;
  /** Supports streaming responses */
  streaming: boolean;
  /** Supports vision/images */
  vision: boolean;
  /** Supports system messages */
  systemMessages: boolean;
  /** Maximum context window in tokens */
  maxContextTokens: number;
  /** Maximum output tokens */
  maxOutputTokens: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Message Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Message role.
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * Text content block.
 */
export interface TextContent {
  type: 'text';
  text: string;
}

/**
 * Image content block.
 */
export interface ImageContent {
  type: 'image';
  /** Base64-encoded image data */
  data: string;
  /** MIME type (e.g., 'image/png', 'image/jpeg') */
  mediaType: string;
}

/**
 * Tool use content block (assistant requesting tool call).
 */
export interface ToolUseContent {
  type: 'tool_use';
  /** Unique ID for this tool use */
  id: string;
  /** Tool name */
  name: string;
  /** Tool input parameters */
  input: Record<string, unknown>;
  /** Gemini thought signature (required for Gemini 3+ models) */
  thoughtSignature?: string;
}

/**
 * Tool result content block (result of tool execution).
 */
export interface ToolResultContent {
  type: 'tool_result';
  /** ID of the tool use this is a result for */
  toolUseId: string;
  /** Tool output (can be text, JSON, or error) */
  content: string | Record<string, unknown>;
  /** Whether the tool execution failed */
  isError?: boolean;
}

/**
 * Message content (can be text, images, tool use, or tool results).
 */
export type MessageContent = TextContent | ImageContent | ToolUseContent | ToolResultContent;

/**
 * A chat message.
 */
export interface ChatMessage {
  /** Unique message ID */
  id: string;
  /** Message role */
  role: MessageRole;
  /** Message content blocks */
  content: MessageContent[];
  /** Timestamp when message was created */
  timestamp: number;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Helper to create a simple text message.
 */
export function createTextMessage(
  role: MessageRole,
  text: string,
  id?: string
): ChatMessage {
  return {
    id: id ?? generateMessageId(),
    role,
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  };
}

/**
 * Helper to extract text from a message.
 */
export function getMessageText(message: ChatMessage): string {
  return message.content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

/**
 * Helper to get tool uses from a message.
 */
export function getToolUses(message: ChatMessage): ToolUseContent[] {
  return message.content.filter((c): c is ToolUseContent => c.type === 'tool_use');
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * JSON Schema type for tool parameters.
 */
export interface JSONSchema {
  type: 'object' | 'string' | 'number' | 'boolean' | 'array' | 'null';
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  default?: unknown;
}

/**
 * Tool definition.
 */
export interface ToolDefinition {
  /** Tool name (should match ECP method name for ECP tools) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Input parameter schema */
  inputSchema: JSONSchema;
  /** Whether this tool maps to an ECP method */
  ecpMethod?: string;
}

/**
 * Tool execution result.
 */
export interface ToolExecutionResult {
  /** Whether execution succeeded */
  success: boolean;
  /** Result data (if successful) */
  result?: unknown;
  /** Error message (if failed) */
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat Session Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chat session state.
 */
export type ChatSessionState = 'idle' | 'waiting' | 'streaming' | 'tool_use' | 'error';

/**
 * Chat session.
 */
export interface ChatSession {
  /** Unique session ID */
  id: string;
  /** Provider configuration */
  provider: AIProviderConfig;
  /** Conversation messages */
  messages: ChatMessage[];
  /** Current session state */
  state: ChatSessionState;
  /** Available tools */
  tools: ToolDefinition[];
  /** System prompt */
  systemPrompt?: string;
  /** Session metadata */
  metadata?: Record<string, unknown>;
  /** CLI session ID for resume (claude --resume, gemini --session, etc.) */
  cliSessionId?: string;
  /** Working directory for tool execution */
  cwd?: string;
  /** When session was created */
  createdAt: number;
  /** When session was last updated */
  updatedAt: number;
}

/**
 * Options for creating a new chat session.
 */
export interface CreateSessionOptions {
  /** Provider configuration */
  provider: AIProviderConfig;
  /** System prompt */
  systemPrompt?: string;
  /** Available tools */
  tools?: ToolDefinition[];
  /** Initial messages */
  messages?: ChatMessage[];
  /** Session metadata */
  metadata?: Record<string, unknown>;
  /** CLI session ID for resume (claude --resume, gemini --session, etc.) */
  cliSessionId?: string;
  /** Working directory for tool execution */
  cwd?: string;
}

/**
 * Options for sending a message.
 */
export interface SendMessageOptions {
  /** Session ID */
  sessionId: string;
  /** Message content (text or content blocks) */
  content: string | MessageContent[];
  /** Whether to stream the response */
  stream?: boolean;
  /** Override tools for this request */
  tools?: ToolDefinition[];
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Temperature for response generation */
  temperature?: number;
  /** Target agent ID for routing (from @mention or sticky target) */
  targetAgentId?: string;
  /** Storage session ID for transcript context (from client's persistent session) */
  storageSessionId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Session Types
// ─────────────────────────────────────────────────────────────────────────────

/** Tracks a per-agent AI session within a chat. */
export interface AgentSessionEntry {
  /** The LocalAIService session ID */
  aiSessionId: string;
  /** The agent ID */
  agentId: string;
  /** The parent AI session ID from client */
  chatSessionId: string;
  /** When the agent session was created */
  createdAt: number;
  /** When the agent session was last used */
  lastUsedAt: number;
  /** Number of messages in the agent session */
  messageCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Streaming event types.
 */
export type StreamEventType =
  | 'message_start'
  | 'content_block_start'
  | 'content_block_delta'
  | 'content_block_stop'
  | 'message_delta'
  | 'message_stop'
  | 'tool_use'
  | 'tool_use_started'
  | 'loop_complete'
  | 'iteration_start'
  | 'iteration_complete'
  | 'error'
  | 'agent_status'
  | 'agent_joined'
  | 'agent_left';

/**
 * Agent role for multi-agent events.
 */
export type StreamAgentRole = 'primary' | 'specialist' | 'reviewer' | 'orchestrator';

/**
 * Agent status for status events.
 */
export type StreamAgentStatus = 'idle' | 'thinking' | 'executing' | 'waiting' | 'error';

/**
 * Base streaming event.
 */
export interface StreamEventBase {
  type: StreamEventType;
  /** Agent ID that generated this event (for multi-agent chats) */
  agentId?: string;
  /** Display name of the agent */
  agentName?: string;
  /** Role of the agent */
  agentRole?: StreamAgentRole;
}

/**
 * Message start event.
 */
export interface MessageStartEvent extends StreamEventBase {
  type: 'message_start';
  message: {
    id: string;
    role: 'assistant';
  };
}

/**
 * Content block start event.
 */
export interface ContentBlockStartEvent extends StreamEventBase {
  type: 'content_block_start';
  index: number;
  contentBlock: {
    type: 'text' | 'tool_use';
    id?: string;
    name?: string;
  };
}

/**
 * Content block delta event (streaming text or tool input).
 */
export interface ContentBlockDeltaEvent extends StreamEventBase {
  type: 'content_block_delta';
  index: number;
  delta: {
    type: 'text_delta' | 'input_json_delta';
    text?: string;
    partialJson?: string;
  };
}

/**
 * Content block stop event.
 */
export interface ContentBlockStopEvent extends StreamEventBase {
  type: 'content_block_stop';
  index: number;
}

/**
 * Message delta event (e.g., stop reason).
 */
export interface MessageDeltaEvent extends StreamEventBase {
  type: 'message_delta';
  delta: {
    stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  };
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Message stop event.
 */
export interface MessageStopEvent extends StreamEventBase {
  type: 'message_stop';
}

/**
 * Error event.
 */
export interface StreamErrorEvent extends StreamEventBase {
  type: 'error';
  error: {
    type: string;
    message: string;
  };
}

/**
 * Tool use event (AI is calling a tool - emitted when tool use content block starts).
 */
export interface ToolUseEvent {
  type: 'tool_use';
  /** Unique ID for this tool use */
  id: string;
  /** Tool name (e.g., 'Edit', 'Bash', 'Read') */
  name: string;
}

/**
 * Tool use request event (AI wants to use a tool that needs permission).
 */
export interface ToolUseRequestEvent {
  type: 'tool_use_request';
  /** Unique ID for this tool use */
  id: string;
  /** Tool name (e.g., 'Edit', 'Bash', 'Read') */
  name: string;
  /** Tool input parameters */
  input: Record<string, unknown>;
  /** Human-readable description of what the tool will do */
  description?: string;
  /** Whether this requires user approval */
  requiresApproval: boolean;
}

/**
 * Tool use result event (tool execution completed).
 */
export interface ToolUseResultEvent {
  type: 'tool_use_result';
  /** Tool use ID this is a result for */
  toolUseId: string;
  /** Whether the tool succeeded */
  success: boolean;
  /** Result content or error message */
  result: string;
}

/**
 * Tool use started event (tool execution is starting, including auto-approved tools).
 */
export interface ToolUseStartedEvent {
  type: 'tool_use_started';
  /** Tool use ID */
  toolUseId: string;
  /** Tool name */
  toolName: string;
  /** Tool input parameters */
  input: unknown;
  /** Whether this tool was auto-approved (vs requiring user approval) */
  autoApproved: boolean;
  /** Approval scope if auto-approved */
  approvalScope?: string;
}

/**
 * Tool use complete event (emitted when tool_use content block finishes streaming, includes parsed input).
 */
export interface ToolUseCompleteEvent {
  type: 'tool_use_complete';
  /** Unique ID for this tool use */
  id: string;
  /** Tool name (e.g., 'Edit', 'Bash', 'Read') */
  name: string;
  /** Parsed input parameters */
  input: Record<string, unknown>;
}

/**
 * Permission request event (user needs to approve an action).
 */
export interface PermissionRequestEvent {
  type: 'permission_request';
  /** Unique request ID */
  requestId: string;
  /** Tool use ID if related to a tool */
  toolUseId?: string;
  /** Action type (e.g., 'file_edit', 'bash_command', 'file_read') */
  actionType: string;
  /** Human-readable description of what will happen */
  description: string;
  /** The action details (file path, command, etc.) */
  details: Record<string, unknown>;
}

/**
 * Loop complete event - emitted when the agentic tool loop finishes.
 */
export interface LoopCompleteEvent {
  type: 'loop_complete';
}

/**
 * Iteration start event - emitted at the start of a new iteration in the agentic loop.
 * This signals that a new AI response is about to be generated (after tool use).
 */
export interface IterationStartEvent {
  type: 'iteration_start';
  /** Iteration number (1-based) */
  iteration: number;
  /** Text content from the previous iteration (before tool use) */
  previousIterationContent?: string;
}

/**
 * Iteration complete event - emitted when an iteration finishes with tool use.
 * This signals that the current iteration's AI response is complete and tools are being executed.
 */
export interface IterationCompleteEvent {
  type: 'iteration_complete';
  /** Iteration number (1-based) */
  iteration: number;
  /** Text content from this iteration */
  iterationContent: string;
  /** Whether this iteration ended with tool use */
  hasToolUse: boolean;
}

/**
 * Agent status change event - emitted when an agent's status changes.
 */
export interface AgentStatusEvent extends StreamEventBase {
  type: 'agent_status';
  agentId: string;
  agentName: string;
  agentRole: StreamAgentRole;
  status: StreamAgentStatus;
  previousStatus?: StreamAgentStatus;
}

/**
 * Agent joined event - emitted when an agent joins a chat session.
 */
export interface AgentJoinedEvent extends StreamEventBase {
  type: 'agent_joined';
  agentId: string;
  agentName: string;
  agentRole: StreamAgentRole;
}

/**
 * Agent left event - emitted when an agent leaves a chat session.
 */
export interface AgentLeftEvent extends StreamEventBase {
  type: 'agent_left';
  agentId: string;
  agentName: string;
}

/**
 * All streaming event types.
 */
export type StreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent
  | ToolUseEvent
  | ToolUseStartedEvent
  | ToolUseCompleteEvent
  | StreamErrorEvent
  | ToolUseRequestEvent
  | ToolUseResultEvent
  | PermissionRequestEvent
  | LoopCompleteEvent
  | IterationStartEvent
  | IterationCompleteEvent
  | AgentStatusEvent
  | AgentJoinedEvent
  | AgentLeftEvent;

// ─────────────────────────────────────────────────────────────────────────────
// Response Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stop reason for AI response.
 */
export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error';

/**
 * AI response.
 */
export interface AIResponse {
  /** Response message */
  message: ChatMessage;
  /** Why the response stopped */
  stopReason: StopReason;
  /** Token usage */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Middleware/Pipeline Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pipeline stage types.
 */
export type PipelineStage = 'pre_request' | 'post_response' | 'tool_execution';

/**
 * Middleware context.
 */
export interface MiddlewareContext {
  /** Current session */
  session: ChatSession;
  /** Current request (for pre_request stage) */
  request?: SendMessageOptions;
  /** Current response (for post_response stage) */
  response?: AIResponse;
  /** Tool call (for tool_execution stage) */
  toolCall?: ToolUseContent;
  /** Tool result (for tool_execution stage, after execution) */
  toolResult?: ToolExecutionResult;
  /** Arbitrary data that can be passed between middleware */
  data: Record<string, unknown>;
}

/**
 * Middleware action result.
 */
export type MiddlewareAction =
  | { type: 'continue' }
  | { type: 'modify'; context: Partial<MiddlewareContext> }
  | { type: 'block'; reason: string }
  | { type: 'require_approval'; message: string; onApprove: () => void; onReject: () => void };

/**
 * Middleware function.
 */
export type MiddlewareFunction = (
  context: MiddlewareContext,
  stage: PipelineStage
) => Promise<MiddlewareAction>;

/**
 * Middleware definition.
 */
export interface MiddlewareDefinition {
  /** Middleware name */
  name: string;
  /** Human-readable description */
  description: string;
  /** Which stages this middleware runs at */
  stages: PipelineStage[];
  /** Priority (lower runs first) */
  priority: number;
  /** Whether middleware is enabled */
  enabled: boolean;
  /** Middleware function */
  execute: MiddlewareFunction;
}

/**
 * Pipeline configuration.
 */
export interface PipelineConfig {
  /** Middleware to run */
  middleware: MiddlewareDefinition[];
  /** Whether to halt on first block */
  haltOnBlock: boolean;
  /** Timeout for middleware execution (ms) */
  timeout: number;
}

/**
 * Pipeline execution result.
 */
export interface PipelineResult {
  /** Whether pipeline completed successfully */
  success: boolean;
  /** Final context after all middleware */
  context: MiddlewareContext;
  /** Actions taken by middleware */
  actions: Array<{ middleware: string; action: MiddlewareAction }>;
  /** Error if pipeline failed */
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Session event types.
 */
export type SessionEventType =
  | 'session_created'
  | 'session_updated'
  | 'session_deleted'
  | 'message_added'
  | 'message_updated'
  | 'state_changed'
  | 'stream_event';

/**
 * Session event.
 */
export interface SessionEvent {
  type: SessionEventType;
  sessionId: string;
  data?: unknown;
  timestamp: number;
}

/**
 * Session event callback.
 */
export type SessionEventCallback = (event: SessionEvent) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Utility Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unsubscribe function.
 */
export type Unsubscribe = () => void;

/**
 * Generate a unique message ID.
 */
export function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Generate a unique session ID.
 */
export function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Generate a unique tool use ID.
 */
export function generateToolUseId(): string {
  return `toolu-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}
