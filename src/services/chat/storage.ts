/**
 * Chat Session Storage
 *
 * SQLite-based storage for AI chat sessions and messages.
 * Scoped per project for shared context across models.
 */

import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { debugLog, isDebugEnabled } from '../../debug.ts';
import { withTransaction } from './transactions.ts';

// ============================================
// Types
// ============================================

/**
 * Chat session record.
 */
export interface StoredChatSession {
  id: string;
  title: string | null;
  systemPrompt: string | null;
  provider: string;
  model: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Chat message record.
 */
export interface StoredChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model: string | null;
  /** Token usage for this message (if available) */
  inputTokens: number | null;
  outputTokens: number | null;
  /** Duration in ms for AI response */
  durationMs: number | null;
  /** Agent that generated this message (for multi-agent chats) */
  agentId: string | null;
  /** Display name of the agent that generated this message */
  agentName: string | null;
  /** Role of the agent that generated this message */
  agentRole: string | null;
  createdAt: number;
}

/**
 * Tool call record (for tracking AI tool usage).
 */
export interface StoredToolCall {
  id: string;
  messageId: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  output: unknown | null;
  status: 'pending' | 'approved' | 'denied' | 'success' | 'error';
  errorMessage: string | null;
  startedAt: number;
  completedAt: number | null;
}

/**
 * Agent role in a chat session.
 */
export type AgentRole = 'primary' | 'specialist' | 'reviewer' | 'orchestrator';

/**
 * Session agent record - tracks which agents are in each session.
 */
export interface StoredSessionAgent {
  sessionId: string;
  agentId: string;
  joinedAt: number;
  leftAt: number | null;
  role: AgentRole;
}

/**
 * Permission scope levels.
 */
export type PermissionScope = 'once' | 'session' | 'project' | 'global';

/**
 * Permission record for AI actions.
 */
export interface StoredPermission {
  id: string;
  sessionId: string | null;  // null for project/global scope
  toolName: string;
  scope: PermissionScope;
  pattern: string | null;    // regex pattern for matching inputs
  description: string | null;
  grantedAt: number;
  expiresAt: number | null;
}

/**
 * Activity log entry types.
 */
export type ActivityType =
  | 'session_created'
  | 'session_updated'
  | 'message_added'
  | 'tool_call_started'
  | 'tool_call_completed'
  | 'permission_requested'
  | 'permission_granted'
  | 'permission_denied';

/**
 * Activity log entry for real-time updates.
 */
export interface StoredActivityEntry {
  id: number;
  sessionId: string | null;
  activityType: ActivityType;
  entityType: 'session' | 'message' | 'tool_call' | 'permission';
  entityId: string;
  summary: string;
  details: unknown | null;
  createdAt: number;
}

/**
 * Compaction record - represents a summary of older messages.
 * Original messages are preserved in the database; this record tracks
 * which messages were compacted and the summary that replaces them in context.
 */
export interface StoredCompaction {
  id: string;
  sessionId: string;
  summary: string;
  /** First message ID in the compacted range */
  startMessageId: string;
  /** Last message ID in the compacted range */
  endMessageId: string;
  /** Number of messages this summary replaces */
  messageCount: number;
  /** Estimated tokens before compaction */
  tokensBefore: number | null;
  /** Estimated tokens after compaction (summary tokens) */
  tokensAfter: number | null;
  createdAt: number;
  /** Whether this compaction is currently active (false = expanded) */
  isActive: boolean;
  /** When this compaction was expanded (if applicable) */
  expandedAt: number | null;
}

/**
 * Todo item for task tracking.
 */
export interface StoredTodo {
  id: string;
  sessionId: string | null;
  /** Parent plan (if part of a plan) */
  planId: string | null;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** Present continuous form for spinner display */
  activeForm: string | null;
  /** Order index for sorting */
  orderIndex: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

/**
 * Specification - top-level organizing concept for projects.
 * A specification can contain multiple plans, and each plan can have multiple todos.
 */
export interface StoredSpecification {
  id: string;
  title: string;
  description: string | null;
  /** Criteria for verifying the specification is complete */
  validationCriteria: string | null;
  status: 'draft' | 'active' | 'completed' | 'archived';
  /** Path to the spec file in .ultra/specs/ */
  filePath: string | null;
  /** Additional context for AI */
  context: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Plan document for tracking implementation plans.
 */
export interface StoredPlan {
  id: string;
  sessionId: string | null;
  /** Parent specification (if part of a spec) */
  specificationId: string | null;
  title: string;
  /** Path to the plan file in .ultra/plans/ */
  filePath: string;
  status: 'draft' | 'active' | 'completed' | 'archived';
  /** Brief description/summary */
  summary: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Session with message count for listing.
 */
export interface ChatSessionSummary {
  id: string;
  title: string | null;
  provider: string;
  model: string;
  messageCount: number;
  lastMessageAt: number | null;
  createdAt: number;
}

// ============================================
// Schema
// ============================================

const SCHEMA = `
-- Chat sessions table
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  system_prompt TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_provider ON chat_sessions(provider);

-- Chat messages table
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL,
  agent_id TEXT,
  agent_name TEXT,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_agent ON chat_messages(agent_id);

-- Tool calls table
CREATE TABLE IF NOT EXISTS chat_tool_calls (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input JSON,
  output JSON,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_tool_calls_session ON chat_tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_tool_calls_message ON chat_tool_calls(message_id);
CREATE INDEX IF NOT EXISTS idx_chat_tool_calls_tool ON chat_tool_calls(tool_name);

-- Permissions table
CREATE TABLE IF NOT EXISTS chat_permissions (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  tool_name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('once', 'session', 'project', 'global')),
  pattern TEXT,
  description TEXT,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_permissions_tool ON chat_permissions(tool_name);
CREATE INDEX IF NOT EXISTS idx_chat_permissions_scope ON chat_permissions(scope);
CREATE INDEX IF NOT EXISTS idx_chat_permissions_session ON chat_permissions(session_id);

-- Unique constraint for UPSERT support (tool+scope+session+pattern combination)
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_permissions_unique
  ON chat_permissions(tool_name, scope, COALESCE(session_id, ''), COALESCE(pattern, ''));

-- Activity log for real-time updates
CREATE TABLE IF NOT EXISTS chat_activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  activity_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  details JSON,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_activity_created ON chat_activity_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_activity_session ON chat_activity_log(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_activity_type ON chat_activity_log(activity_type);

-- Compactions table - tracks message summaries for context management
CREATE TABLE IF NOT EXISTS chat_compactions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  start_message_id TEXT NOT NULL,
  end_message_id TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  tokens_before INTEGER,
  tokens_after INTEGER,
  created_at INTEGER NOT NULL,
  is_active INTEGER DEFAULT 1,
  expanded_at INTEGER,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_compactions_session ON chat_compactions(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_compactions_active ON chat_compactions(session_id, is_active);

-- Specifications table - top-level organizing concept
CREATE TABLE IF NOT EXISTS chat_specifications (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  validation_criteria TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'active', 'completed', 'archived')),
  file_path TEXT,
  context TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_specs_status ON chat_specifications(status);
CREATE INDEX IF NOT EXISTS idx_chat_specs_updated ON chat_specifications(updated_at DESC);

-- Plans table - implementation plan tracking
CREATE TABLE IF NOT EXISTS chat_plans (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  specification_id TEXT,
  title TEXT NOT NULL,
  file_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'active', 'completed', 'archived')),
  summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE SET NULL,
  FOREIGN KEY (specification_id) REFERENCES chat_specifications(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_plans_session ON chat_plans(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_plans_spec ON chat_plans(specification_id);
CREATE INDEX IF NOT EXISTS idx_chat_plans_status ON chat_plans(status);
CREATE INDEX IF NOT EXISTS idx_chat_plans_updated ON chat_plans(updated_at DESC);

-- Todos table - persistent task tracking
CREATE TABLE IF NOT EXISTS chat_todos (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  plan_id TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed')),
  active_form TEXT,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id) REFERENCES chat_plans(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_todos_session ON chat_todos(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_todos_plan ON chat_todos(plan_id);
CREATE INDEX IF NOT EXISTS idx_chat_todos_status ON chat_todos(status);
CREATE INDEX IF NOT EXISTS idx_chat_todos_order ON chat_todos(session_id, order_index);

-- Session agents table - tracks which agents are in each session
CREATE TABLE IF NOT EXISTS chat_session_agents (
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  left_at INTEGER,
  role TEXT NOT NULL CHECK(role IN ('primary', 'specialist', 'reviewer', 'orchestrator')),
  PRIMARY KEY (session_id, agent_id),
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_session_agents_session ON chat_session_agents(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_session_agents_agent ON chat_session_agents(agent_id);
CREATE INDEX IF NOT EXISTS idx_chat_session_agents_active ON chat_session_agents(session_id, left_at);

-- Full-text search for message content
CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
  content,
  content=chat_messages,
  content_rowid=rowid
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS chat_messages_ai AFTER INSERT ON chat_messages BEGIN
  INSERT INTO chat_messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS chat_messages_ad AFTER DELETE ON chat_messages BEGIN
  INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content)
  VALUES('delete', OLD.rowid, OLD.content);
END;

CREATE TRIGGER IF NOT EXISTS chat_messages_au AFTER UPDATE OF content ON chat_messages BEGIN
  INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content)
  VALUES('delete', OLD.rowid, OLD.content);
  INSERT INTO chat_messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;
`;

// ============================================
// Storage Class
// ============================================

/**
 * Chat Session Storage using SQLite.
 *
 * @deprecated This class is deprecated. Use the new store classes instead:
 * - {@link SessionStore} for session operations
 * - {@link MessageStore} for message operations
 * - {@link PermissionStore} for permission operations
 * - {@link TodoStore} for todo operations
 *
 * Or use {@link ChatOrchestrator} for a high-level API that coordinates all stores.
 *
 * Migration example:
 * ```typescript
 * // Old way
 * const storage = await getChatStorage();
 * storage.createSession({ id, provider, model });
 *
 * // New way
 * import { createChatOrchestrator } from './services/chat';
 * const orchestrator = createChatOrchestrator({ db });
 * orchestrator.createSession({ id, provider, model });
 * ```
 */
export class ChatStorage {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.initSchema();
  }

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[ChatStorage] ${msg}`);
    }
  }

  private initSchema(): void {
    // Run migrations BEFORE schema execution for existing databases
    // This ensures new columns exist before CREATE INDEX statements run
    this.runMigrations();

    // exec is correct for multi-statement schema (deprecation warning is incorrect)
    this.db.exec(SCHEMA);
  }

  private runMigrations(): void {
    // Check if tables exist (indicating an existing database that needs migration)
    const tablesExist = this.tableExists('chat_plans') && this.tableExists('chat_todos');

    if (tablesExist) {
      // Migration: Add specification_id to chat_plans if it doesn't exist
      this.addColumnIfNotExists('chat_plans', 'specification_id', 'TEXT');

      // Migration: Add plan_id to chat_todos if it doesn't exist
      this.addColumnIfNotExists('chat_todos', 'plan_id', 'TEXT');

      this.log('Migrations complete');
    }

    // Check if messages table exists for agent columns migration
    if (this.tableExists('chat_messages')) {
      // Migration: Add agent_id, agent_name, and agent_role columns to chat_messages
      this.addColumnIfNotExists('chat_messages', 'agent_id', 'TEXT');
      this.addColumnIfNotExists('chat_messages', 'agent_name', 'TEXT');
      this.addColumnIfNotExists('chat_messages', 'agent_role', 'TEXT');
    }

    // Check if tool_calls table exists for agent_id column migration
    if (this.tableExists('chat_tool_calls')) {
      // Migration: Add agent_id to chat_tool_calls for attribution
      this.addColumnIfNotExists('chat_tool_calls', 'agent_id', 'TEXT');
    }
  }

  private tableExists(table: string): boolean {
    try {
      const result = this.db.query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
      ).get(table) as { name: string } | null;
      return result !== null;
    } catch {
      return false;
    }
  }

  private addColumnIfNotExists(table: string, column: string, type: string): void {
    try {
      // Check if column exists by querying table info
      const columns = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      const columnExists = columns.some(c => c.name === column);

      if (!columnExists) {
        this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        this.log(`Added column ${column} to ${table}`);
      }
    } catch (error) {
      this.log(`Migration error for ${table}.${column}: ${error}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Session Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a new chat session.
   * @deprecated Use {@link SessionStore.create} instead.
   */
  createSession(session: Omit<StoredChatSession, 'createdAt' | 'updatedAt'>): StoredChatSession {
    const now = Date.now();
    const stored: StoredChatSession = {
      ...session,
      createdAt: now,
      updatedAt: now,
    };

    console.log('[ChatStorage.createSession] Creating session:', stored.id);
    console.log('[ChatStorage.createSession] Database path:', (this.db as unknown as { filename?: string }).filename || 'unknown');

    this.db.run(
      `INSERT INTO chat_sessions (id, title, system_prompt, provider, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        stored.id,
        stored.title,
        stored.systemPrompt,
        stored.provider,
        stored.model,
        stored.createdAt,
        stored.updatedAt,
      ]
    );

    // Verify the insert worked
    const verifyResult = this.db.query('SELECT COUNT(*) as count FROM chat_sessions WHERE id = ?').get(stored.id) as { count: number };
    console.log('[ChatStorage.createSession] Verify insert - found:', verifyResult?.count);

    this.log(`Created session: ${stored.id}`);
    return stored;
  }

  /**
   * Get a session by ID.
   * @deprecated Use {@link SessionStore.get} instead.
   */
  getSession(id: string): StoredChatSession | null {
    const row = this.db.query(
      `SELECT id, title, system_prompt, provider, model, created_at, updated_at
       FROM chat_sessions WHERE id = ?`
    ).get(id) as Record<string, unknown> | null;

    if (!row) return null;

    return {
      id: row.id as string,
      title: row.title as string | null,
      systemPrompt: row.system_prompt as string | null,
      provider: row.provider as string,
      model: row.model as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  /**
   * Update a session.
   * @deprecated Use {@link SessionStore.update} instead.
   */
  updateSession(id: string, updates: Partial<Pick<StoredChatSession, 'title' | 'systemPrompt' | 'model'>>): void {
    const sets: string[] = ['updated_at = ?'];
    const values: SQLQueryBindings[] = [Date.now()];

    if (updates.title !== undefined) {
      sets.push('title = ?');
      values.push(updates.title);
    }
    if (updates.systemPrompt !== undefined) {
      sets.push('system_prompt = ?');
      values.push(updates.systemPrompt);
    }
    if (updates.model !== undefined) {
      sets.push('model = ?');
      values.push(updates.model);
    }

    values.push(id);
    this.db.run(`UPDATE chat_sessions SET ${sets.join(', ')} WHERE id = ?`, values);
    this.log(`Updated session: ${id}`);
  }

  /**
   * Delete a session and all its messages.
   * DISABLED: Session deletion is disabled to prevent accidental data loss.
   * The CASCADE foreign keys would delete all messages, tool calls, activity logs, etc.
   */
  deleteSession(id: string): void {
    // Deletion disabled - log warning instead
    console.warn(`[ChatStorage] Session deletion is disabled to prevent data loss. Attempted to delete: ${id}`);
    this.log(`BLOCKED: Attempted to delete session: ${id}`);
    // Don't actually delete - just return
  }

  /**
   * List sessions with message counts.
   */
  listSessions(options: {
    provider?: string;
    limit?: number;
    offset?: number;
  } = {}): ChatSessionSummary[] {
    const { provider, limit = 50, offset = 0 } = options;

    let query = `
      SELECT
        s.id, s.title, s.provider, s.model, s.created_at,
        COUNT(m.id) as message_count,
        MAX(m.created_at) as last_message_at
      FROM chat_sessions s
      LEFT JOIN chat_messages m ON m.session_id = s.id
    `;
    const values: SQLQueryBindings[] = [];

    if (provider) {
      query += ' WHERE s.provider = ?';
      values.push(provider);
    }

    query += `
      GROUP BY s.id
      ORDER BY COALESCE(MAX(m.created_at), s.created_at) DESC
      LIMIT ? OFFSET ?
    `;
    values.push(limit, offset);

    const rows = this.db.query(query).all(...values) as Array<Record<string, unknown>>;

    return rows.map(row => ({
      id: row.id as string,
      title: row.title as string | null,
      provider: row.provider as string,
      model: row.model as string,
      messageCount: row.message_count as number,
      lastMessageAt: row.last_message_at as number | null,
      createdAt: row.created_at as number,
    }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Message Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Add a message to a session (or update if it already exists).
   * @deprecated Use {@link MessageStore.create} instead.
   */
  addMessage(message: Omit<StoredChatMessage, 'createdAt'>): StoredChatMessage {
    const now = Date.now();
    const stored: StoredChatMessage = {
      ...message,
      createdAt: now,
    };

    this.db.run(
      `INSERT OR REPLACE INTO chat_messages (id, session_id, role, content, model, input_tokens, output_tokens, duration_ms, agent_id, agent_name, agent_role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stored.id,
        stored.sessionId,
        stored.role,
        stored.content,
        stored.model,
        stored.inputTokens,
        stored.outputTokens,
        stored.durationMs,
        stored.agentId,
        stored.agentName,
        stored.agentRole,
        stored.createdAt,
      ]
    );

    // Update session's updated_at
    this.db.run('UPDATE chat_sessions SET updated_at = ? WHERE id = ?', [now, stored.sessionId]);

    this.log(`Added/updated message ${stored.id} to session ${stored.sessionId}`);
    return stored;
  }

  /**
   * Delete a message by ID.
   */
  deleteMessage(id: string): boolean {
    const result = this.db.run('DELETE FROM chat_messages WHERE id = ?', [id]);
    const deleted = (result as { changes?: number })?.changes === 1;
    if (deleted) {
      this.log(`Deleted message ${id}`);
    }
    return deleted;
  }

  /**
   * Get messages for a session.
   * @deprecated Use {@link MessageStore.listBySession} instead.
   */
  getMessages(sessionId: string, options: {
    limit?: number;
    offset?: number;
    after?: number;
  } = {}): StoredChatMessage[] {
    const { limit = 100, offset = 0, after } = options;

    let query = `
      SELECT id, session_id, role, content, model, input_tokens, output_tokens, duration_ms, agent_id, agent_name, agent_role, created_at
      FROM chat_messages
      WHERE session_id = ?
    `;
    const values: SQLQueryBindings[] = [sessionId];

    if (after !== undefined) {
      query += ' AND created_at > ?';
      values.push(after);
    }

    // To get the most recent messages while preserving chronological order:
    // 1. Use a subquery to get the most recent N messages (DESC)
    // 2. Re-order them ASC for chronological display
    // This ensures limit cuts off OLD messages, not NEW ones
    query = `
      SELECT * FROM (
        ${query} ORDER BY created_at DESC LIMIT ? OFFSET ?
      ) sub ORDER BY created_at ASC
    `;
    values.push(limit, offset);

    const rows = this.db.query(query).all(...values) as Array<Record<string, unknown>>;

    return rows.map(row => ({
      id: row.id as string,
      sessionId: row.session_id as string,
      role: row.role as StoredChatMessage['role'],
      content: row.content as string,
      model: row.model as string | null,
      inputTokens: row.input_tokens as number | null,
      outputTokens: row.output_tokens as number | null,
      durationMs: row.duration_ms as number | null,
      agentId: row.agent_id as string | null,
      agentName: row.agent_name as string | null,
      agentRole: row.agent_role as string | null,
      createdAt: row.created_at as number,
    }));
  }

  /**
   * Get the most recent messages across all sessions (for context).
   */
  getRecentMessages(options: {
    limit?: number;
    provider?: string;
  } = {}): StoredChatMessage[] {
    const { limit = 50, provider } = options;

    let query = `
      SELECT m.id, m.session_id, m.role, m.content, m.model, m.input_tokens, m.output_tokens, m.duration_ms, m.agent_id, m.agent_name, m.agent_role, m.created_at
      FROM chat_messages m
      JOIN chat_sessions s ON s.id = m.session_id
    `;
    const values: SQLQueryBindings[] = [];

    if (provider) {
      query += ' WHERE s.provider = ?';
      values.push(provider);
    }

    query += ' ORDER BY m.created_at DESC LIMIT ?';
    values.push(limit);

    const rows = this.db.query(query).all(...values) as Array<Record<string, unknown>>;

    return rows.map(row => ({
      id: row.id as string,
      sessionId: row.session_id as string,
      role: row.role as StoredChatMessage['role'],
      content: row.content as string,
      model: row.model as string | null,
      inputTokens: row.input_tokens as number | null,
      outputTokens: row.output_tokens as number | null,
      durationMs: row.duration_ms as number | null,
      agentId: row.agent_id as string | null,
      agentName: row.agent_name as string | null,
      agentRole: row.agent_role as string | null,
      createdAt: row.created_at as number,
    }));
  }

  /**
   * Search messages using full-text search.
   */
  searchMessages(query: string, options: {
    sessionId?: string;
    limit?: number;
  } = {}): StoredChatMessage[] {
    const { sessionId, limit = 50 } = options;

    let sql = `
      SELECT m.id, m.session_id, m.role, m.content, m.model, m.input_tokens, m.output_tokens, m.duration_ms, m.agent_id, m.agent_name, m.agent_role, m.created_at
      FROM chat_messages m
      JOIN chat_messages_fts fts ON m.rowid = fts.rowid
      WHERE chat_messages_fts MATCH ?
    `;
    const values: SQLQueryBindings[] = [query];

    if (sessionId) {
      sql += ' AND m.session_id = ?';
      values.push(sessionId);
    }

    sql += ' ORDER BY rank LIMIT ?';
    values.push(limit);

    const rows = this.db.query(sql).all(...values) as Array<Record<string, unknown>>;

    return rows.map(row => ({
      id: row.id as string,
      sessionId: row.session_id as string,
      role: row.role as StoredChatMessage['role'],
      content: row.content as string,
      model: row.model as string | null,
      inputTokens: row.input_tokens as number | null,
      outputTokens: row.output_tokens as number | null,
      durationMs: row.duration_ms as number | null,
      agentId: row.agent_id as string | null,
      agentName: row.agent_name as string | null,
      agentRole: row.agent_role as string | null,
      createdAt: row.created_at as number,
    }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Session Agent Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Add an agent to a session.
   */
  addSessionAgent(sessionId: string, agentId: string, role: AgentRole, _agentName?: string): StoredSessionAgent {
    const now = Date.now();
    const stored: StoredSessionAgent = {
      sessionId,
      agentId,
      joinedAt: now,
      leftAt: null,
      role,
    };

    this.db.run(
      `INSERT OR REPLACE INTO chat_session_agents (session_id, agent_id, joined_at, left_at, role)
       VALUES (?, ?, ?, ?, ?)`,
      [stored.sessionId, stored.agentId, stored.joinedAt, stored.leftAt, stored.role]
    );

    this.log(`Added agent ${agentId} to session ${sessionId}`);
    return stored;
  }

  /**
   * Remove an agent from a session (marks as left, doesn't delete).
   */
  removeSessionAgent(sessionId: string, agentId: string): void {
    const now = Date.now();
    this.db.run(
      'UPDATE chat_session_agents SET left_at = ? WHERE session_id = ? AND agent_id = ?',
      [now, sessionId, agentId]
    );
    this.log(`Removed agent ${agentId} from session ${sessionId}`);
  }

  /**
   * Get agents currently in a session (not left).
   */
  getSessionAgents(sessionId: string, options: { includeLeft?: boolean } = {}): StoredSessionAgent[] {
    const { includeLeft = false } = options;

    let query = `
      SELECT session_id, agent_id, joined_at, left_at, role
      FROM chat_session_agents
      WHERE session_id = ?
    `;
    const values: SQLQueryBindings[] = [sessionId];

    if (!includeLeft) {
      query += ' AND left_at IS NULL';
    }

    query += ' ORDER BY joined_at ASC';

    const rows = this.db.query(query).all(...values) as Array<Record<string, unknown>>;

    return rows.map(row => ({
      sessionId: row.session_id as string,
      agentId: row.agent_id as string,
      joinedAt: row.joined_at as number,
      leftAt: row.left_at as number | null,
      role: row.role as AgentRole,
    }));
  }

  /**
   * Check if an agent is in a session.
   */
  isAgentInSession(sessionId: string, agentId: string): boolean {
    const row = this.db.query(
      'SELECT 1 FROM chat_session_agents WHERE session_id = ? AND agent_id = ? AND left_at IS NULL'
    ).get(sessionId, agentId);
    return row !== null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tool Call Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Record a tool call.
   */
  addToolCall(toolCall: Omit<StoredToolCall, 'startedAt' | 'completedAt' | 'status' | 'output' | 'errorMessage'>): StoredToolCall {
    const now = Date.now();
    const stored: StoredToolCall = {
      ...toolCall,
      status: 'pending',
      output: null,
      errorMessage: null,
      startedAt: now,
      completedAt: null,
    };

    this.db.run(
      `INSERT INTO chat_tool_calls (id, message_id, session_id, tool_name, input, output, status, error_message, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stored.id,
        stored.messageId,
        stored.sessionId,
        stored.toolName,
        JSON.stringify(stored.input),
        null,
        stored.status,
        null,
        stored.startedAt,
        null,
      ]
    );

    this.log(`Added tool call: ${stored.toolName} (${stored.id})`);
    return stored;
  }

  /**
   * Update a tool call with result.
   */
  completeToolCall(id: string, result: { output?: unknown; errorMessage?: string }): void {
    const status = result.errorMessage ? 'error' : 'success';
    const now = Date.now();

    this.db.run(
      `UPDATE chat_tool_calls SET status = ?, output = ?, error_message = ?, completed_at = ? WHERE id = ?`,
      [status, result.output ? JSON.stringify(result.output) : null, result.errorMessage ?? null, now, id]
    );

    this.log(`Completed tool call: ${id} (${status})`);
  }

  /**
   * Update a tool call's input after streaming completes.
   * This is needed because tool_use events are initially emitted without input.
   */
  updateToolCallInput(id: string, input: unknown): void {
    this.db.run(
      `UPDATE chat_tool_calls SET input = ? WHERE id = ?`,
      [JSON.stringify(input), id]
    );

    this.log(`Updated tool call input: ${id}`);
  }

  /**
   * Get tool calls for a session.
   */
  getToolCalls(sessionId: string): StoredToolCall[] {
    const rows = this.db.query(
      `SELECT id, message_id, session_id, tool_name, input, output, status, error_message, started_at, completed_at
       FROM chat_tool_calls WHERE session_id = ? ORDER BY started_at ASC`
    ).all(sessionId) as Array<Record<string, unknown>>;

    return rows.map(row => ({
      id: row.id as string,
      messageId: row.message_id as string,
      sessionId: row.session_id as string,
      toolName: row.tool_name as string,
      input: row.input ? JSON.parse(row.input as string) : null,
      output: row.output ? JSON.parse(row.output as string) : null,
      status: row.status as StoredToolCall['status'],
      errorMessage: row.error_message as string | null,
      startedAt: row.started_at as number,
      completedAt: row.completed_at as number | null,
    }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Permission Operations (deprecated - use PermissionStore)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Grant a permission.
   * Uses UPSERT to safely handle concurrent requests for the same permission.
   * @deprecated Use {@link PermissionStore.grantPermission} instead.
   */
  grantPermission(permission: Omit<StoredPermission, 'grantedAt'>): StoredPermission {
    const now = Date.now();
    const stored: StoredPermission = {
      ...permission,
      grantedAt: now,
    };

    // Use INSERT OR REPLACE to atomically handle duplicates
    // This prevents TOCTOU races when multiple requests try to grant the same permission
    this.db.run(
      `INSERT INTO chat_permissions (id, session_id, tool_name, scope, pattern, description, granted_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tool_name, scope, COALESCE(session_id, ''), COALESCE(pattern, ''))
       DO UPDATE SET
         description = excluded.description,
         granted_at = excluded.granted_at,
         expires_at = excluded.expires_at`,
      [
        stored.id,
        stored.sessionId,
        stored.toolName,
        stored.scope,
        stored.pattern,
        stored.description,
        stored.grantedAt,
        stored.expiresAt,
      ]
    );

    this.log(`Granted permission: ${stored.toolName} (${stored.scope})`);
    return stored;
  }

  /**
   * Revoke a permission by ID.
   */
  revokePermission(id: string): void {
    this.db.run('DELETE FROM chat_permissions WHERE id = ?', [id]);
    this.log(`Revoked permission: ${id}`);
  }

  /**
   * Check if a tool action is permitted.
   * Returns the matching permission if found, null otherwise.
   */
  checkPermission(toolName: string, input: string, sessionId?: string): StoredPermission | null {
    const now = Date.now();

    // Check permissions in order of specificity: once (session) -> session -> project -> global
    // Also filter out expired permissions
    const query = `
      SELECT id, session_id, tool_name, scope, pattern, description, granted_at, expires_at
      FROM chat_permissions
      WHERE tool_name = ?
        AND (expires_at IS NULL OR expires_at > ?)
        AND (
          (scope = 'global')
          OR (scope = 'project')
          OR (scope = 'session' AND session_id = ?)
          OR (scope = 'once' AND session_id = ?)
        )
      ORDER BY
        CASE scope
          WHEN 'once' THEN 1
          WHEN 'session' THEN 2
          WHEN 'project' THEN 3
          WHEN 'global' THEN 4
        END
      LIMIT 1
    `;

    const row = this.db.query(query).get(toolName, now, sessionId ?? null, sessionId ?? null) as Record<string, unknown> | null;

    if (!row) return null;

    const permission: StoredPermission = {
      id: row.id as string,
      sessionId: row.session_id as string | null,
      toolName: row.tool_name as string,
      scope: row.scope as PermissionScope,
      pattern: row.pattern as string | null,
      description: row.description as string | null,
      grantedAt: row.granted_at as number,
      expiresAt: row.expires_at as number | null,
    };

    // If there's a pattern, check if the input matches
    if (permission.pattern) {
      try {
        const regex = new RegExp(permission.pattern);
        if (!regex.test(input)) {
          return null;
        }
      } catch {
        // Invalid regex pattern, skip this permission
        return null;
      }
    }

    // If scope is 'once', delete the permission after returning it
    if (permission.scope === 'once') {
      this.db.run('DELETE FROM chat_permissions WHERE id = ?', [permission.id]);
    }

    return permission;
  }

  /**
   * List all active permissions.
   */
  listPermissions(options: {
    sessionId?: string;
    toolName?: string;
    scope?: PermissionScope;
  } = {}): StoredPermission[] {
    const { sessionId, toolName, scope } = options;
    const now = Date.now();

    let query = `
      SELECT id, session_id, tool_name, scope, pattern, description, granted_at, expires_at
      FROM chat_permissions
      WHERE (expires_at IS NULL OR expires_at > ?)
    `;
    const values: SQLQueryBindings[] = [now];

    if (sessionId) {
      query += ' AND (session_id = ? OR session_id IS NULL)';
      values.push(sessionId);
    }
    if (toolName) {
      query += ' AND tool_name = ?';
      values.push(toolName);
    }
    if (scope) {
      query += ' AND scope = ?';
      values.push(scope);
    }

    query += ' ORDER BY granted_at DESC';

    const rows = this.db.query(query).all(...values) as Array<Record<string, unknown>>;

    return rows.map(row => ({
      id: row.id as string,
      sessionId: row.session_id as string | null,
      toolName: row.tool_name as string,
      scope: row.scope as PermissionScope,
      pattern: row.pattern as string | null,
      description: row.description as string | null,
      grantedAt: row.granted_at as number,
      expiresAt: row.expires_at as number | null,
    }));
  }

  /**
   * Clear expired permissions.
   */
  clearExpiredPermissions(): number {
    const now = Date.now();
    const result = this.db.run('DELETE FROM chat_permissions WHERE expires_at IS NOT NULL AND expires_at <= ?', [now]);
    return result.changes;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Compaction Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a compaction record.
   * Original messages are preserved; this just tracks the summary.
   */
  createCompaction(compaction: Omit<StoredCompaction, 'createdAt' | 'isActive' | 'expandedAt'>): StoredCompaction {
    const now = Date.now();
    const stored: StoredCompaction = {
      ...compaction,
      createdAt: now,
      isActive: true,
      expandedAt: null,
    };

    this.db.run(
      `INSERT INTO chat_compactions (id, session_id, summary, start_message_id, end_message_id, message_count, tokens_before, tokens_after, created_at, is_active, expanded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stored.id,
        stored.sessionId,
        stored.summary,
        stored.startMessageId,
        stored.endMessageId,
        stored.messageCount,
        stored.tokensBefore,
        stored.tokensAfter,
        stored.createdAt,
        stored.isActive ? 1 : 0,
        stored.expandedAt,
      ]
    );

    this.log(`Created compaction: ${stored.id} (${stored.messageCount} messages)`);
    return stored;
  }

  /**
   * Get a compaction by ID.
   */
  getCompaction(id: string): StoredCompaction | null {
    const row = this.db.query(
      `SELECT id, session_id, summary, start_message_id, end_message_id, message_count, tokens_before, tokens_after, created_at, is_active, expanded_at
       FROM chat_compactions WHERE id = ?`
    ).get(id) as Record<string, unknown> | null;

    if (!row) return null;

    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      summary: row.summary as string,
      startMessageId: row.start_message_id as string,
      endMessageId: row.end_message_id as string,
      messageCount: row.message_count as number,
      tokensBefore: row.tokens_before as number | null,
      tokensAfter: row.tokens_after as number | null,
      createdAt: row.created_at as number,
      isActive: Boolean(row.is_active),
      expandedAt: row.expanded_at as number | null,
    };
  }

  /**
   * Get all compactions for a session.
   */
  getCompactions(sessionId: string, options: { activeOnly?: boolean } = {}): StoredCompaction[] {
    const { activeOnly = false } = options;

    let query = `
      SELECT id, session_id, summary, start_message_id, end_message_id, message_count, tokens_before, tokens_after, created_at, is_active, expanded_at
      FROM chat_compactions
      WHERE session_id = ?
    `;
    const values: SQLQueryBindings[] = [sessionId];

    if (activeOnly) {
      query += ' AND is_active = 1';
    }

    query += ' ORDER BY created_at ASC';

    const rows = this.db.query(query).all(...values) as Array<Record<string, unknown>>;

    return rows.map(row => ({
      id: row.id as string,
      sessionId: row.session_id as string,
      summary: row.summary as string,
      startMessageId: row.start_message_id as string,
      endMessageId: row.end_message_id as string,
      messageCount: row.message_count as number,
      tokensBefore: row.tokens_before as number | null,
      tokensAfter: row.tokens_after as number | null,
      createdAt: row.created_at as number,
      isActive: Boolean(row.is_active),
      expandedAt: row.expanded_at as number | null,
    }));
  }

  /**
   * Expand a compaction (show original messages instead of summary).
   */
  expandCompaction(id: string): void {
    const now = Date.now();
    this.db.run(
      'UPDATE chat_compactions SET is_active = 0, expanded_at = ? WHERE id = ?',
      [now, id]
    );
    this.log(`Expanded compaction: ${id}`);
  }

  /**
   * Collapse a compaction (use summary again).
   */
  collapseCompaction(id: string): void {
    this.db.run(
      'UPDATE chat_compactions SET is_active = 1, expanded_at = NULL WHERE id = ?',
      [id]
    );
    this.log(`Collapsed compaction: ${id}`);
  }

  /**
   * Delete a compaction record.
   */
  deleteCompaction(id: string): void {
    this.db.run('DELETE FROM chat_compactions WHERE id = ?', [id]);
    this.log(`Deleted compaction: ${id}`);
  }

  /**
   * Get message IDs within a compaction range.
   */
  getCompactedMessageIds(sessionId: string, startMessageId: string, endMessageId: string): string[] {
    // Get the created_at timestamps for the boundary messages
    const startMsg = this.db.query(
      'SELECT created_at FROM chat_messages WHERE id = ?'
    ).get(startMessageId) as { created_at: number } | null;

    const endMsg = this.db.query(
      'SELECT created_at FROM chat_messages WHERE id = ?'
    ).get(endMessageId) as { created_at: number } | null;

    if (!startMsg || !endMsg) return [];

    // Get all message IDs in the range
    const rows = this.db.query(
      `SELECT id FROM chat_messages
       WHERE session_id = ? AND created_at >= ? AND created_at <= ?
       ORDER BY created_at ASC`
    ).all(sessionId, startMsg.created_at, endMsg.created_at) as Array<{ id: string }>;

    return rows.map(r => r.id);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Todo Operations (deprecated - use TodoStore)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create or update a todo item.
   * @deprecated Use {@link TodoStore.upsert} instead.
   */
  upsertTodo(todo: Omit<StoredTodo, 'createdAt' | 'updatedAt'>): StoredTodo {
    const now = Date.now();
    const existing = this.getTodo(todo.id);

    if (existing) {
      this.db.run(
        `UPDATE chat_todos SET content = ?, status = ?, active_form = ?, order_index = ?, plan_id = ?, updated_at = ?, completed_at = ?
         WHERE id = ?`,
        [
          todo.content,
          todo.status,
          todo.activeForm,
          todo.orderIndex,
          todo.planId,
          now,
          todo.completedAt,
          todo.id,
        ]
      );
      return { ...todo, createdAt: existing.createdAt, updatedAt: now };
    }

    this.db.run(
      `INSERT INTO chat_todos (id, session_id, plan_id, content, status, active_form, order_index, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        todo.id,
        todo.sessionId,
        todo.planId,
        todo.content,
        todo.status,
        todo.activeForm,
        todo.orderIndex,
        now,
        now,
        todo.completedAt,
      ]
    );

    this.log(`Created todo: ${todo.id}`);
    return { ...todo, createdAt: now, updatedAt: now };
  }

  /**
   * Get a todo by ID.
   */
  getTodo(id: string): StoredTodo | null {
    const row = this.db.query(
      `SELECT id, session_id, plan_id, content, status, active_form, order_index, created_at, updated_at, completed_at
       FROM chat_todos WHERE id = ?`
    ).get(id) as Record<string, unknown> | null;

    if (!row) return null;

    return {
      id: row.id as string,
      sessionId: row.session_id as string | null,
      planId: row.plan_id as string | null,
      content: row.content as string,
      status: row.status as 'pending' | 'in_progress' | 'completed',
      activeForm: row.active_form as string | null,
      orderIndex: row.order_index as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      completedAt: row.completed_at as number | null,
    };
  }

  /**
   * Get all todos, optionally filtered by session or plan.
   */
  getTodos(sessionId?: string | null, planId?: string | null): StoredTodo[] {
    let query = `
      SELECT id, session_id, plan_id, content, status, active_form, order_index, created_at, updated_at, completed_at
      FROM chat_todos
    `;
    const values: SQLQueryBindings[] = [];
    const conditions: string[] = [];

    if (sessionId !== undefined) {
      if (sessionId === null) {
        conditions.push('session_id IS NULL');
      } else {
        conditions.push('session_id = ?');
        values.push(sessionId);
      }
    }

    if (planId !== undefined) {
      if (planId === null) {
        conditions.push('plan_id IS NULL');
      } else {
        conditions.push('plan_id = ?');
        values.push(planId);
      }
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY order_index ASC, created_at ASC';

    const rows = this.db.query(query).all(...values) as Array<Record<string, unknown>>;

    return rows.map(row => ({
      id: row.id as string,
      sessionId: row.session_id as string | null,
      planId: row.plan_id as string | null,
      content: row.content as string,
      status: row.status as 'pending' | 'in_progress' | 'completed',
      activeForm: row.active_form as string | null,
      orderIndex: row.order_index as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      completedAt: row.completed_at as number | null,
    }));
  }

  /**
   * Update todo status.
   */
  updateTodoStatus(id: string, status: 'pending' | 'in_progress' | 'completed'): void {
    const now = Date.now();
    const completedAt = status === 'completed' ? now : null;

    this.db.run(
      'UPDATE chat_todos SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?',
      [status, now, completedAt, id]
    );
  }

  /**
   * Delete a todo.
   */
  deleteTodo(id: string): void {
    this.db.run('DELETE FROM chat_todos WHERE id = ?', [id]);
    this.log(`Deleted todo: ${id}`);
  }

  /**
   * Replace all todos for a session (bulk update from AI).
   * Uses a transaction to ensure atomic operation.
   * @deprecated Use {@link TodoStore.replaceForSession} instead.
   */
  replaceTodos(sessionId: string | null, todos: Array<Omit<StoredTodo, 'createdAt' | 'updatedAt'>>): StoredTodo[] {
    const now = Date.now();

    return withTransaction(this.db, () => {
      // Delete existing todos for this session
      if (sessionId === null) {
        this.db.run('DELETE FROM chat_todos WHERE session_id IS NULL');
      } else {
        this.db.run('DELETE FROM chat_todos WHERE session_id = ?', [sessionId]);
      }

      // Prepare the insert statement once for efficiency
      const insertStmt = this.db.prepare(
        `INSERT INTO chat_todos (id, session_id, plan_id, content, status, active_form, order_index, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      // Insert new todos
      const result: StoredTodo[] = [];
      for (const todo of todos) {
        insertStmt.run(
          todo.id,
          sessionId,
          todo.planId,
          todo.content,
          todo.status,
          todo.activeForm,
          todo.orderIndex,
          now,
          now,
          todo.completedAt,
        );
        result.push({ ...todo, sessionId, createdAt: now, updatedAt: now });
      }

      this.log(`Replaced todos for session ${sessionId}: ${todos.length} items`);
      return result;
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Plan Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a plan record.
   */
  createPlan(plan: Omit<StoredPlan, 'createdAt' | 'updatedAt'>): StoredPlan {
    const now = Date.now();
    const stored: StoredPlan = {
      ...plan,
      createdAt: now,
      updatedAt: now,
    };

    this.db.run(
      `INSERT INTO chat_plans (id, session_id, specification_id, title, file_path, status, summary, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stored.id,
        stored.sessionId,
        stored.specificationId,
        stored.title,
        stored.filePath,
        stored.status,
        stored.summary,
        stored.createdAt,
        stored.updatedAt,
      ]
    );

    this.log(`Created plan: ${stored.id} - ${stored.title}`);
    return stored;
  }

  /**
   * Get a plan by ID.
   */
  getPlan(id: string): StoredPlan | null {
    const row = this.db.query(
      `SELECT id, session_id, specification_id, title, file_path, status, summary, created_at, updated_at
       FROM chat_plans WHERE id = ?`
    ).get(id) as Record<string, unknown> | null;

    if (!row) return null;

    return {
      id: row.id as string,
      sessionId: row.session_id as string | null,
      specificationId: row.specification_id as string | null,
      title: row.title as string,
      filePath: row.file_path as string,
      status: row.status as 'draft' | 'active' | 'completed' | 'archived',
      summary: row.summary as string | null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  /**
   * Get all plans, optionally filtered by status or specification.
   */
  getPlans(options: { sessionId?: string; specificationId?: string; status?: string } = {}): StoredPlan[] {
    let query = `
      SELECT id, session_id, specification_id, title, file_path, status, summary, created_at, updated_at
      FROM chat_plans WHERE 1=1
    `;
    const values: SQLQueryBindings[] = [];

    if (options.sessionId) {
      query += ' AND session_id = ?';
      values.push(options.sessionId);
    }
    if (options.specificationId) {
      query += ' AND specification_id = ?';
      values.push(options.specificationId);
    }
    if (options.status) {
      query += ' AND status = ?';
      values.push(options.status);
    }

    query += ' ORDER BY updated_at DESC';

    const rows = this.db.query(query).all(...values) as Array<Record<string, unknown>>;

    return rows.map(row => ({
      id: row.id as string,
      sessionId: row.session_id as string | null,
      specificationId: row.specification_id as string | null,
      title: row.title as string,
      filePath: row.file_path as string,
      status: row.status as 'draft' | 'active' | 'completed' | 'archived',
      summary: row.summary as string | null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }));
  }

  /**
   * Update a plan.
   */
  updatePlan(id: string, updates: Partial<Pick<StoredPlan, 'title' | 'status' | 'summary' | 'specificationId'>>): void {
    const now = Date.now();
    const sets: string[] = ['updated_at = ?'];
    const values: SQLQueryBindings[] = [now];

    if (updates.title !== undefined) {
      sets.push('title = ?');
      values.push(updates.title);
    }
    if (updates.status !== undefined) {
      sets.push('status = ?');
      values.push(updates.status);
    }
    if (updates.summary !== undefined) {
      sets.push('summary = ?');
      values.push(updates.summary);
    }
    if (updates.specificationId !== undefined) {
      sets.push('specification_id = ?');
      values.push(updates.specificationId);
    }

    values.push(id);

    this.db.run(
      `UPDATE chat_plans SET ${sets.join(', ')} WHERE id = ?`,
      values
    );

    this.log(`Updated plan: ${id}`);
  }

  /**
   * Delete a plan.
   */
  deletePlan(id: string): void {
    this.db.run('DELETE FROM chat_plans WHERE id = ?', [id]);
    this.log(`Deleted plan: ${id}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Specification Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a specification.
   */
  createSpecification(spec: Omit<StoredSpecification, 'createdAt' | 'updatedAt'>): StoredSpecification {
    const now = Date.now();
    const stored: StoredSpecification = {
      ...spec,
      createdAt: now,
      updatedAt: now,
    };

    this.db.run(
      `INSERT INTO chat_specifications (id, title, description, validation_criteria, status, file_path, context, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stored.id,
        stored.title,
        stored.description,
        stored.validationCriteria,
        stored.status,
        stored.filePath,
        stored.context,
        stored.createdAt,
        stored.updatedAt,
      ]
    );

    this.log(`Created specification: ${stored.id} - ${stored.title}`);
    return stored;
  }

  /**
   * Get a specification by ID.
   */
  getSpecification(id: string): StoredSpecification | null {
    const row = this.db.query(
      `SELECT id, title, description, validation_criteria, status, file_path, context, created_at, updated_at
       FROM chat_specifications WHERE id = ?`
    ).get(id) as Record<string, unknown> | null;

    if (!row) return null;

    return {
      id: row.id as string,
      title: row.title as string,
      description: row.description as string | null,
      validationCriteria: row.validation_criteria as string | null,
      status: row.status as 'draft' | 'active' | 'completed' | 'archived',
      filePath: row.file_path as string | null,
      context: row.context as string | null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  /**
   * Get all specifications, optionally filtered by status.
   */
  getSpecifications(options: { status?: string } = {}): StoredSpecification[] {
    let query = `
      SELECT id, title, description, validation_criteria, status, file_path, context, created_at, updated_at
      FROM chat_specifications WHERE 1=1
    `;
    const values: SQLQueryBindings[] = [];

    if (options.status) {
      query += ' AND status = ?';
      values.push(options.status);
    }

    query += ' ORDER BY updated_at DESC';

    const rows = this.db.query(query).all(...values) as Array<Record<string, unknown>>;

    return rows.map(row => ({
      id: row.id as string,
      title: row.title as string,
      description: row.description as string | null,
      validationCriteria: row.validation_criteria as string | null,
      status: row.status as 'draft' | 'active' | 'completed' | 'archived',
      filePath: row.file_path as string | null,
      context: row.context as string | null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }));
  }

  /**
   * Update a specification.
   */
  updateSpecification(
    id: string,
    updates: Partial<Pick<StoredSpecification, 'title' | 'description' | 'validationCriteria' | 'status' | 'filePath' | 'context'>>
  ): void {
    const now = Date.now();
    const sets: string[] = ['updated_at = ?'];
    const values: SQLQueryBindings[] = [now];

    if (updates.title !== undefined) {
      sets.push('title = ?');
      values.push(updates.title);
    }
    if (updates.description !== undefined) {
      sets.push('description = ?');
      values.push(updates.description);
    }
    if (updates.validationCriteria !== undefined) {
      sets.push('validation_criteria = ?');
      values.push(updates.validationCriteria);
    }
    if (updates.status !== undefined) {
      sets.push('status = ?');
      values.push(updates.status);
    }
    if (updates.filePath !== undefined) {
      sets.push('file_path = ?');
      values.push(updates.filePath);
    }
    if (updates.context !== undefined) {
      sets.push('context = ?');
      values.push(updates.context);
    }

    values.push(id);

    this.db.run(
      `UPDATE chat_specifications SET ${sets.join(', ')} WHERE id = ?`,
      values
    );

    this.log(`Updated specification: ${id}`);
  }

  /**
   * Delete a specification.
   */
  deleteSpecification(id: string): void {
    this.db.run('DELETE FROM chat_specifications WHERE id = ?', [id]);
    this.log(`Deleted specification: ${id}`);
  }

  /**
   * Get the full hierarchy for a specification (spec → plans → todos).
   */
  getSpecificationHierarchy(specId: string): {
    specification: StoredSpecification;
    plans: Array<StoredPlan & { todos: StoredTodo[] }>;
  } | null {
    const spec = this.getSpecification(specId);
    if (!spec) return null;

    const plans = this.getPlans({ specificationId: specId });
    const plansWithTodos = plans.map(plan => ({
      ...plan,
      todos: this.getTodos(undefined, plan.id),
    }));

    return {
      specification: spec,
      plans: plansWithTodos,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Activity Log Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Add an activity log entry.
   */
  logActivity(entry: Omit<StoredActivityEntry, 'id' | 'createdAt'>): StoredActivityEntry {
    const now = Date.now();

    this.db.run(
      `INSERT INTO chat_activity_log (session_id, activity_type, entity_type, entity_id, summary, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.sessionId,
        entry.activityType,
        entry.entityType,
        entry.entityId,
        entry.summary,
        entry.details ? JSON.stringify(entry.details) : null,
        now,
      ]
    );

    // Get the inserted ID
    const row = this.db.query('SELECT last_insert_rowid() as id').get() as { id: number };

    return {
      id: row.id,
      ...entry,
      createdAt: now,
    };
  }

  /**
   * Get activity log entries.
   */
  getActivityLog(options: {
    sessionId?: string;
    activityType?: ActivityType;
    since?: number;
    limit?: number;
  } = {}): StoredActivityEntry[] {
    const { sessionId, activityType, since, limit = 100 } = options;

    let query = `
      SELECT id, session_id, activity_type, entity_type, entity_id, summary, details, created_at
      FROM chat_activity_log
      WHERE 1=1
    `;
    const values: SQLQueryBindings[] = [];

    if (sessionId) {
      query += ' AND session_id = ?';
      values.push(sessionId);
    }
    if (activityType) {
      query += ' AND activity_type = ?';
      values.push(activityType);
    }
    if (since !== undefined) {
      query += ' AND created_at > ?';
      values.push(since);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    values.push(limit);

    const rows = this.db.query(query).all(...values) as Array<Record<string, unknown>>;

    return rows.map(row => ({
      id: row.id as number,
      sessionId: row.session_id as string | null,
      activityType: row.activity_type as ActivityType,
      entityType: row.entity_type as StoredActivityEntry['entityType'],
      entityId: row.entity_id as string,
      summary: row.summary as string,
      details: row.details ? JSON.parse(row.details as string) : null,
      createdAt: row.created_at as number,
    }));
  }

  /**
   * Get activity log entries since a specific ID (for polling).
   */
  getActivitySince(lastId: number, limit = 50): StoredActivityEntry[] {
    const rows = this.db.query(
      `SELECT id, session_id, activity_type, entity_type, entity_id, summary, details, created_at
       FROM chat_activity_log
       WHERE id > ?
       ORDER BY id ASC
       LIMIT ?`
    ).all(lastId, limit) as Array<Record<string, unknown>>;

    return rows.map(row => ({
      id: row.id as number,
      sessionId: row.session_id as string | null,
      activityType: row.activity_type as ActivityType,
      entityType: row.entity_type as StoredActivityEntry['entityType'],
      entityId: row.entity_id as string,
      summary: row.summary as string,
      details: row.details ? JSON.parse(row.details as string) : null,
      createdAt: row.created_at as number,
    }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Stats
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get usage statistics.
   */
  getStats(): {
    sessionCount: number;
    messageCount: number;
    toolCallCount: number;
    activityCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    dbPath: string;
  } {
    const sessionCount = (this.db.query('SELECT COUNT(*) as count FROM chat_sessions').get() as { count: number }).count;
    const messageCount = (this.db.query('SELECT COUNT(*) as count FROM chat_messages').get() as { count: number }).count;
    const toolCallCount = (this.db.query('SELECT COUNT(*) as count FROM chat_tool_calls').get() as { count: number }).count;
    const activityCount = (this.db.query('SELECT COUNT(*) as count FROM chat_activity_log').get() as { count: number }).count;

    const tokens = this.db.query(
      'SELECT COALESCE(SUM(input_tokens), 0) as input, COALESCE(SUM(output_tokens), 0) as output FROM chat_messages'
    ).get() as { input: number; output: number };

    return {
      sessionCount,
      messageCount,
      toolCallCount,
      activityCount,
      totalInputTokens: tokens.input,
      totalOutputTokens: tokens.output,
      dbPath: this.db.filename,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get the underlying database instance.
   * Use this to pass the database to ChatOrchestrator for shared access.
   */
  getDatabase(): Database {
    return this.db;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
    this.log('Closed');
  }
}

// ============================================
// Instance Management
// ============================================

const storageInstances = new Map<string, ChatStorage>();

/**
 * Get the storage directory path for a project.
 */
function getStorageDir(projectPath: string): string {
  return join(projectPath, '.ultra');
}

/**
 * Get the database path for a project.
 */
function getDbPath(projectPath: string): string {
  return join(getStorageDir(projectPath), 'chat.db');
}

/**
 * Get or create the chat storage instance for a project.
 * Each project has its own database stored in {project}/.ultra/chat.db
 *
 * @deprecated Use {@link createChatOrchestrator} with a Database instance instead:
 * ```typescript
 * import { Database } from 'bun:sqlite';
 * import { createChatOrchestrator } from './services/chat';
 *
 * const db = new Database('.ultra/chat.db');
 * const orchestrator = createChatOrchestrator({ db });
 * ```
 */
export async function getChatStorage(workspacePath?: string): Promise<ChatStorage> {
  // Use provided path or current working directory
  const projectPath = workspacePath || process.cwd();

  console.log('[getChatStorage] workspacePath:', workspacePath);
  console.log('[getChatStorage] projectPath:', projectPath);

  // Skip storage creation for invalid paths (welcome mode / no folder)
  // This happens when launched from Finder without a workspace
  if (!projectPath || projectPath === '/' || projectPath === '') {
    throw new Error('Cannot create chat storage without a valid workspace path');
  }

  // Check if we already have an instance for this project
  const existing = storageInstances.get(projectPath);
  if (existing) {
    console.log('[getChatStorage] Returning existing instance for:', projectPath);
    return existing;
  }

  // Create .ultra directory in the project
  const storageDir = getStorageDir(projectPath);
  await mkdir(storageDir, { recursive: true });

  // Create storage instance
  const dbPath = getDbPath(projectPath);
  console.log('[getChatStorage] Creating new storage at:', dbPath);
  const storage = new ChatStorage(dbPath);
  storageInstances.set(projectPath, storage);

  // Add .ultra to .gitignore if it exists and doesn't already include it
  try {
    const gitignorePath = join(projectPath, '.gitignore');
    const { readFile, appendFile } = await import('fs/promises');
    try {
      const content = await readFile(gitignorePath, 'utf-8');
      if (!content.includes('.ultra/') && !content.includes('.ultra\n')) {
        await appendFile(gitignorePath, '\n# Ultra AI session data\n.ultra/\n');
      }
    } catch {
      // .gitignore doesn't exist, that's fine
    }
  } catch {
    // Ignore errors updating .gitignore
  }

  return storage;
}

/**
 * Close the chat storage instance for a project.
 */
export function closeChatStorage(workspacePath?: string): void {
  const projectPath = workspacePath || process.cwd();
  const storage = storageInstances.get(projectPath);
  if (storage) {
    storage.close();
    storageInstances.delete(projectPath);
  }
}

/**
 * Close all chat storage instances.
 */
export function closeAllChatStorage(): void {
  for (const [path, storage] of storageInstances) {
    storage.close();
    storageInstances.delete(path);
  }
}
