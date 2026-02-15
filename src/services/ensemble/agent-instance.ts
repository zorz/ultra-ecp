/**
 * Agent Instance
 *
 * Wrapper around an AI provider for a specific agent in an ensemble.
 * Manages conversation context, tool execution, and state.
 */

import type {
  AgentDefinition,
  AgentStatus,
  AgentRole,
  Unsubscribe,
} from './types.ts';
import type {
  AIProviderConfig,
  ChatMessage,
  ToolDefinition,
  MessageContent,
  ToolUseContent,
} from '../ai/types.ts';
import { createTextMessage } from '../ai/types.ts';
import { debugLog, isDebugEnabled } from '../../debug.ts';

/**
 * Conversation context for an agent.
 */
export interface ConversationContext {
  /** Conversation messages */
  messages: ChatMessage[];
  /** System prompt */
  systemPrompt: string;
  /** Available tools */
  tools: ToolDefinition[];
  /** Context metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Agent response after processing.
 */
export interface AgentResponse {
  /** Response message */
  message: ChatMessage;
  /** Tool calls to execute */
  toolCalls: ToolUseContent[];
  /** Stop reason */
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'error';
  /** Token usage */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Tool execution result.
 */
export interface ToolExecutionResult {
  /** Tool use ID */
  toolUseId: string;
  /** Whether execution succeeded */
  success: boolean;
  /** Result content */
  result: string | Record<string, unknown>;
  /** Error message if failed */
  error?: string;
}

/**
 * Agent state change callback.
 */
export type AgentStateCallback = (state: AgentStatus['state'], activity?: string) => void;

/**
 * Options for creating an agent instance.
 */
export interface AgentInstanceOptions {
  /** Agent definition */
  definition: AgentDefinition;
  /** Tool definitions */
  tools: ToolDefinition[];
  /** Initial context (optional) */
  initialContext?: Partial<ConversationContext>;
  /** State change callback */
  onStateChange?: AgentStateCallback;
}

/**
 * Represents a single agent in an ensemble.
 */
export class AgentInstance {
  readonly definition: AgentDefinition;
  private context: ConversationContext;
  private state: AgentStatus['state'] = 'idle';
  private lastActivity: number = Date.now();
  private currentActivity?: string;
  private stateCallbacks: Set<AgentStateCallback> = new Set();

  constructor(options: AgentInstanceOptions) {
    this.definition = options.definition;

    // Initialize context
    this.context = {
      messages: options.initialContext?.messages ?? [],
      systemPrompt: options.initialContext?.systemPrompt ?? options.definition.systemPrompt,
      tools: options.tools,
      metadata: options.initialContext?.metadata,
    };

    if (options.onStateChange) {
      this.stateCallbacks.add(options.onStateChange);
    }
  }

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[Agent:${this.definition.id}] ${msg}`);
    }
  }

  /**
   * Get agent ID.
   */
  get id(): string {
    return this.definition.id;
  }

  /**
   * Get agent role.
   */
  get role(): AgentRole {
    return this.definition.role;
  }

  /**
   * Get provider configuration.
   */
  getProviderConfig(): AIProviderConfig {
    return {
      type: this.definition.provider,
      name: `${this.definition.role}-${this.definition.id}`,
      model: this.definition.model,
      apiKey: this.definition.apiKey,
      baseUrl: this.definition.baseUrl,
      options: this.definition.options,
    };
  }

  /**
   * Get current status.
   */
  getStatus(): AgentStatus {
    return {
      id: this.definition.id,
      role: this.definition.role,
      state: this.state,
      lastActivity: this.lastActivity,
      currentActivity: this.currentActivity,
    };
  }

  /**
   * Get conversation context.
   */
  getContext(): ConversationContext {
    return { ...this.context };
  }

  /**
   * Set conversation context.
   */
  setContext(context: Partial<ConversationContext>): void {
    this.context = {
      ...this.context,
      ...context,
    };
    this.log('Context updated');
  }

  /**
   * Add a message to the context.
   */
  addMessage(message: ChatMessage): void {
    this.context.messages.push(message);
    this.lastActivity = Date.now();
    this.log(`Added message: ${message.role}`);
  }

  /**
   * Send a message to the agent and get a response.
   * This is a placeholder - actual implementation requires provider integration.
   */
  async send(content: string | MessageContent[]): Promise<AgentResponse> {
    this.setState('thinking', 'Processing message');
    this.log(`Sending message`);

    try {
      // Add user message to context
      const userMessage = typeof content === 'string'
        ? createTextMessage('user', content)
        : {
            id: `msg-${Date.now()}`,
            role: 'user' as const,
            content,
            timestamp: Date.now(),
          };

      this.addMessage(userMessage);

      // This is a stub - actual implementation will call the provider
      // For now, return a placeholder response
      const assistantMessage = createTextMessage(
        'assistant',
        `[Agent ${this.definition.id} would respond here]`
      );

      this.addMessage(assistantMessage);
      this.setState('idle');

      return {
        message: assistantMessage,
        toolCalls: [],
        stopReason: 'end_turn',
      };
    } catch (error) {
      this.setState('error', `Error: ${error}`);
      throw error;
    }
  }

  /**
   * Execute a tool call.
   * This is a placeholder - actual implementation requires tool executor integration.
   */
  async executeToolCall(toolCall: ToolUseContent): Promise<ToolExecutionResult> {
    this.setState('executing', `Executing tool: ${toolCall.name}`);
    this.log(`Executing tool: ${toolCall.name}`);

    try {
      // This is a stub - actual implementation will call the tool executor
      const result: ToolExecutionResult = {
        toolUseId: toolCall.id,
        success: true,
        result: `[Tool ${toolCall.name} result would be here]`,
      };

      this.setState('idle');
      return result;
    } catch (error) {
      this.setState('error', `Tool error: ${error}`);
      return {
        toolUseId: toolCall.id,
        success: false,
        result: '',
        error: String(error),
      };
    }
  }

  /**
   * Set agent state.
   */
  private setState(state: AgentStatus['state'], activity?: string): void {
    this.state = state;
    this.currentActivity = activity;
    this.lastActivity = Date.now();

    // Notify callbacks
    for (const callback of this.stateCallbacks) {
      try {
        callback(state, activity);
      } catch (error) {
        this.log(`State callback error: ${error}`);
      }
    }
  }

  /**
   * Subscribe to state changes.
   */
  onStateChange(callback: AgentStateCallback): Unsubscribe {
    this.stateCallbacks.add(callback);
    return () => {
      this.stateCallbacks.delete(callback);
    };
  }

  /**
   * Clear conversation history.
   */
  clearHistory(): void {
    this.context.messages = [];
    this.log('History cleared');
  }

  /**
   * Get message count.
   */
  getMessageCount(): number {
    return this.context.messages.length;
  }

  /**
   * Get the last N messages.
   */
  getRecentMessages(count: number): ChatMessage[] {
    return this.context.messages.slice(-count);
  }

  /**
   * Check if agent is busy.
   */
  isBusy(): boolean {
    return this.state === 'thinking' || this.state === 'executing';
  }

  /**
   * Wait for agent to become idle.
   */
  async waitForIdle(timeoutMs: number = 60000): Promise<void> {
    const startTime = Date.now();

    while (this.isBusy()) {
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(`Agent ${this.id} timeout waiting for idle`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/**
 * Create a new agent instance.
 */
export function createAgentInstance(options: AgentInstanceOptions): AgentInstance {
  return new AgentInstance(options);
}
