/**
 * Shared Message Types
 *
 * Common message types used across ECP and clients.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Message Role Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Message role in chat context.
 */
export type MessageRole = 'user' | 'assistant' | 'system';

/**
 * Extended message role including tool messages.
 */
export type ExtendedMessageRole = MessageRole | 'tool';

// ─────────────────────────────────────────────────────────────────────────────
// Chat Message Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Base chat message structure.
 */
export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp?: number;
}

/**
 * User message with optional images.
 */
export interface UserMessage extends ChatMessage {
  role: 'user';
  images?: Array<{
    data: string;
    mediaType: string;
  }>;
}

/**
 * Assistant message with usage and model info.
 */
export interface AssistantMessage extends ChatMessage {
  role: 'assistant';
  model?: string;
  durationMs?: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  isComplete?: boolean;
}

/**
 * System message for context/instructions.
 */
export interface SystemMessage extends ChatMessage {
  role: 'system';
}

/**
 * Union type for all message types.
 */
export type AnyMessage = UserMessage | AssistantMessage | SystemMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Session Message (API-compatible)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Session message for context restoration (matches ECP schema).
 */
export interface SessionMessage {
  id: string;
  role: ExtendedMessageRole;
  content: string;
  timestamp?: number;
}
