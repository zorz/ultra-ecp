/**
 * ContextBuilder - Context Window Management
 *
 * Builds context windows for AI conversations, managing message history,
 * system prompts, and token budget constraints.
 */

import type { IAgent } from '../types/agents.ts';
import type { IContentBlock } from '../types/messages.ts';
import type { MessageStore, IStoredMessage } from '../stores/MessageStore.ts';
import type { SessionStore } from '../stores/SessionStore.ts';

/**
 * Context message for API calls.
 * Simplified structure matching Claude API format.
 */
export interface IContextMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | IContentBlock[];
}

/**
 * Built context ready for API call.
 */
export interface IBuiltContext {
  /** System prompt (if any) */
  systemPrompt?: string;
  /** Messages in chronological order */
  messages: IContextMessage[];
  /** Estimated token count */
  estimatedTokens: number;
  /** Number of messages included */
  messageCount: number;
  /** Whether messages were truncated to fit budget */
  wasTruncated: boolean;
  /** IDs of messages included (for tracking) */
  includedMessageIds: string[];
}

/**
 * Options for building context.
 */
export interface IBuildContextOptions {
  /** Session ID to build context for */
  sessionId: string;
  /** Agent to build context for (uses agent's system prompt if set) */
  agent?: IAgent;
  /** Maximum tokens for the context (default: 100000) */
  maxTokens?: number;
  /** Custom system prompt (overrides session/agent prompts) */
  systemPrompt?: string;
  /** Include system messages in context */
  includeSystemMessages?: boolean;
  /** Additional context to prepend */
  additionalContext?: string;
  /** Messages to append after history */
  appendMessages?: IContextMessage[];
}

/**
 * Rough token estimation.
 * Uses ~4 characters per token as a simple heuristic.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate tokens for a content block array.
 */
function estimateContentTokens(content: string | IContentBlock[]): number {
  if (typeof content === 'string') {
    return estimateTokens(content);
  }

  let total = 0;
  for (const block of content) {
    if (block.type === 'text') {
      total += estimateTokens(block.text);
    } else if (block.type === 'tool_use') {
      total += estimateTokens(JSON.stringify(block.input)) + 50; // overhead for tool structure
    } else if (block.type === 'tool_result') {
      const resultContent = typeof block.content === 'string'
        ? block.content
        : block.content.map((c) => c.text).join('');
      total += estimateTokens(resultContent) + 30;
    } else if (block.type === 'image') {
      total += 1000; // rough estimate for image tokens
    }
  }
  return total;
}

/**
 * ContextBuilder class.
 */
export class ContextBuilder {
  constructor(
    private messageStore: MessageStore,
    private sessionStore: SessionStore
  ) {}

  /**
   * Build a context window for an API call.
   */
  build(options: IBuildContextOptions): IBuiltContext {
    const {
      sessionId,
      agent,
      maxTokens = 100000,
      systemPrompt: customSystemPrompt,
      includeSystemMessages = false,
      additionalContext,
      appendMessages = [],
    } = options;

    // Get session for its system prompt
    const session = this.sessionStore.get(sessionId);

    // Determine system prompt (priority: custom > agent > session)
    let systemPrompt = customSystemPrompt;
    if (!systemPrompt && agent?.systemPrompt) {
      systemPrompt = agent.systemPrompt;
    }
    if (!systemPrompt && session?.systemPrompt) {
      systemPrompt = session.systemPrompt;
    }

    // Add additional context to system prompt
    if (additionalContext) {
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n${additionalContext}`
        : additionalContext;
    }

    // Calculate token budget (reserve space for response)
    const responseReserve = Math.min(maxTokens * 0.25, 4000);
    let remainingTokens = maxTokens - responseReserve;

    // Account for system prompt
    if (systemPrompt) {
      remainingTokens -= estimateTokens(systemPrompt);
    }

    // Account for append messages
    for (const msg of appendMessages) {
      remainingTokens -= estimateContentTokens(msg.content);
    }

    // Get messages from store (most recent first in internal ordering, but returned chronologically)
    const storedMessages = this.messageStore.listBySession(sessionId, {
      limit: 1000, // Get plenty, we'll filter by tokens
    });

    // Filter out system messages if not wanted
    const filteredMessages = includeSystemMessages
      ? storedMessages
      : storedMessages.filter((m) => m.role !== 'system');

    // Build context from most recent messages that fit in budget
    const contextMessages: IContextMessage[] = [];
    const includedMessageIds: string[] = [];
    let totalTokens = 0;
    let wasTruncated = false;

    // Process messages from oldest to newest (they come in chronological order)
    // But we want to prioritize recent messages, so process in reverse
    const reversedMessages = [...filteredMessages].reverse();

    for (const msg of reversedMessages) {
      const msgTokens = estimateTokens(msg.content);

      if (totalTokens + msgTokens > remainingTokens) {
        wasTruncated = true;
        break;
      }

      // Prepend to maintain chronological order
      contextMessages.unshift({
        role: msg.role,
        content: msg.content,
      });
      includedMessageIds.unshift(msg.id);
      totalTokens += msgTokens;
    }

    // Ensure conversation starts with user message (Claude requirement)
    while (contextMessages.length > 0 && contextMessages[0]?.role === 'assistant') {
      contextMessages.shift();
      includedMessageIds.shift();
    }

    // Append any additional messages
    for (const msg of appendMessages) {
      contextMessages.push(msg);
      totalTokens += estimateContentTokens(msg.content);
    }

    // Calculate final token estimate
    const estimatedTokens = totalTokens + (systemPrompt ? estimateTokens(systemPrompt) : 0);

    return {
      systemPrompt,
      messages: contextMessages,
      estimatedTokens,
      messageCount: contextMessages.length,
      wasTruncated,
      includedMessageIds,
    };
  }

  /**
   * Build context with a new user message appended.
   */
  buildWithUserMessage(
    sessionId: string,
    userMessage: string,
    options: Omit<IBuildContextOptions, 'sessionId' | 'appendMessages'> = {}
  ): IBuiltContext {
    return this.build({
      ...options,
      sessionId,
      appendMessages: [{ role: 'user', content: userMessage }],
    });
  }

  /**
   * Estimate how many tokens a message would use.
   */
  estimateMessageTokens(content: string | IContentBlock[]): number {
    return estimateContentTokens(content);
  }

  /**
   * Check if a session has enough context for a meaningful conversation.
   */
  hasMinimalContext(sessionId: string, minMessages: number = 1): boolean {
    const count = this.messageStore.countBySession(sessionId);
    return count >= minMessages;
  }

  /**
   * Get a summary of the context for a session.
   */
  getContextSummary(sessionId: string): {
    messageCount: number;
    estimatedTokens: number;
    oldestMessageAt: number | null;
    newestMessageAt: number | null;
  } {
    const messages = this.messageStore.listBySession(sessionId, { limit: 1000 });

    if (messages.length === 0) {
      return {
        messageCount: 0,
        estimatedTokens: 0,
        oldestMessageAt: null,
        newestMessageAt: null,
      };
    }

    let totalTokens = 0;
    for (const msg of messages) {
      totalTokens += estimateTokens(msg.content);
    }

    return {
      messageCount: messages.length,
      estimatedTokens: totalTokens,
      oldestMessageAt: messages[0]?.createdAt ?? null,
      newestMessageAt: messages[messages.length - 1]?.createdAt ?? null,
    };
  }

  /**
   * Convert a stored message to a context message.
   */
  toContextMessage(stored: IStoredMessage): IContextMessage {
    return {
      role: stored.role,
      content: stored.content,
    };
  }

  /**
   * Build a minimal context for quick operations (e.g., title generation).
   */
  buildMinimal(
    sessionId: string,
    options: { maxMessages?: number; systemPrompt?: string } = {}
  ): IBuiltContext {
    const { maxMessages = 5, systemPrompt } = options;

    const messages = this.messageStore.listBySession(sessionId, {
      limit: maxMessages,
    });

    const contextMessages = messages.map((m) => this.toContextMessage(m));
    const estimatedTokens = messages.reduce(
      (sum, m) => sum + estimateTokens(m.content),
      systemPrompt ? estimateTokens(systemPrompt) : 0
    );

    return {
      systemPrompt,
      messages: contextMessages,
      estimatedTokens,
      messageCount: contextMessages.length,
      wasTruncated: false,
      includedMessageIds: messages.map((m) => m.id),
    };
  }
}

/**
 * Create a new ContextBuilder instance.
 */
export function createContextBuilder(
  messageStore: MessageStore,
  sessionStore: SessionStore
): ContextBuilder {
  return new ContextBuilder(messageStore, sessionStore);
}
