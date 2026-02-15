/**
 * Chat Service
 *
 * Unified SQLite-based storage for AI chat sessions, messages,
 * tool calls, documents, and workflow management.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Unified Database (new system)
// ─────────────────────────────────────────────────────────────────────────────

export {
  ChatDatabase,
  getChatDatabase,
  closeChatDatabase,
  closeAllChatDatabases,
} from './database.ts';

// Adapter (unified schema)
export { ChatServiceAdapter } from './adapter.ts';

// Workflow Adapter
export { WorkflowServiceAdapter } from './workflow-adapter.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Legacy Storage (kept for compatibility - used by AIServiceAdapter)
// ─────────────────────────────────────────────────────────────────────────────

export {
  ChatStorage,
  getChatStorage,
  closeChatStorage,
  closeAllChatStorage,
  type StoredChatSession,
  type StoredChatMessage,
  type StoredToolCall,
  type ChatSessionSummary,
  type StoredPermission,
  type PermissionScope,
  type StoredActivityEntry,
  type ActivityType,
} from './storage.ts';

// Transaction utilities
export { withTransaction, withTransactionAsync, maybeTransaction, isInTransaction } from './transactions.ts';

// New type system
export * from './types/index.ts';

// Store classes
export * from './stores/index.ts';

// Service classes
export * from './services/index.ts';
