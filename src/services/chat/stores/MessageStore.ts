/**
 * MessageStore - Chat Message Management
 *
 * Handles CRUD operations for chat messages with transactional support.
 */

import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { withTransaction, maybeTransaction } from '../transactions.ts';
import type {
  ISessionMessage,
  IUserMessage,
  IAssistantMessage,
  IUsageStats,
} from '../types/messages.ts';

/**
 * Message record as stored in the database.
 * Uses a flattened structure for SQLite storage.
 */
export interface IStoredMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  createdAt: number;
  /** ID of the agent that sent this message (for multi-agent chats) */
  agentId: string | null;
  /** Display name of the agent */
  agentName: string | null;
}

/**
 * Options for creating a message.
 */
export interface ICreateMessageOptions {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  durationMs?: number | null;
  /** ID of the agent that sent this message */
  agentId?: string | null;
  /** Display name of the agent */
  agentName?: string | null;
}

/**
 * Options for listing messages.
 */
export interface IListMessagesOptions {
  limit?: number;
  offset?: number;
  after?: number;
  before?: number;
}

/**
 * MessageStore - manages chat messages in the database.
 */
export class MessageStore {
  constructor(private db: Database) {}

  /**
   * Create a new message (or update if it already exists).
   */
  create(options: ICreateMessageOptions): IStoredMessage {
    const now = Date.now();
    const message: IStoredMessage = {
      id: options.id,
      sessionId: options.sessionId,
      role: options.role,
      content: options.content,
      model: options.model ?? null,
      inputTokens: options.inputTokens ?? null,
      outputTokens: options.outputTokens ?? null,
      durationMs: options.durationMs ?? null,
      createdAt: now,
      agentId: options.agentId ?? null,
      agentName: options.agentName ?? null,
    };

    return maybeTransaction(this.db, () => {
      this.db.run(
        `INSERT OR REPLACE INTO messages (id, session_id, role, content, model, input_tokens, output_tokens, duration_ms, created_at, agent_id, agent_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          message.id,
          message.sessionId,
          message.role,
          message.content,
          message.model,
          message.inputTokens,
          message.outputTokens,
          message.durationMs,
          message.createdAt,
          message.agentId,
          message.agentName,
        ]
      );

      // Update session's updated_at
      this.db.run(
        'UPDATE sessions SET updated_at = ? WHERE id = ?',
        [now, message.sessionId]
      );

      return message;
    });
  }

  /**
   * Get a message by ID.
   */
  get(id: string): IStoredMessage | null {
    const row = this.db.query(
      `SELECT id, session_id, role, content, model, input_tokens, output_tokens, duration_ms, created_at, agent_id, agent_name
       FROM messages WHERE id = ?`
    ).get(id) as Record<string, unknown> | null;

    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * Delete a message by ID.
   */
  delete(id: string): boolean {
    const result = this.db.run('DELETE FROM messages WHERE id = ?', [id]);
    return (result as { changes?: number })?.changes === 1;
  }

  /**
   * Get messages for a session.
   * Returns most recent messages while preserving chronological order.
   */
  listBySession(sessionId: string, options: IListMessagesOptions = {}): IStoredMessage[] {
    const { limit = 100, offset = 0, after, before } = options;

    let baseQuery = `
      SELECT id, session_id, role, content, model, input_tokens, output_tokens, duration_ms, created_at, agent_id, agent_name
      FROM messages
      WHERE session_id = ?
    `;
    const values: SQLQueryBindings[] = [sessionId];

    if (after !== undefined) {
      baseQuery += ' AND created_at > ?';
      values.push(after);
    }

    if (before !== undefined) {
      baseQuery += ' AND created_at < ?';
      values.push(before);
    }

    // Subquery to get most recent N messages, then re-order chronologically
    const query = `
      SELECT * FROM (
        ${baseQuery} ORDER BY created_at DESC LIMIT ? OFFSET ?
      ) sub ORDER BY created_at ASC
    `;
    values.push(limit, offset);

    const rows = this.db.query(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Get recent messages across all sessions.
   */
  listRecent(options: { limit?: number; provider?: string } = {}): IStoredMessage[] {
    const { limit = 50, provider } = options;

    let query = `
      SELECT m.id, m.session_id, m.role, m.content, m.model, m.input_tokens, m.output_tokens, m.duration_ms, m.created_at, m.agent_id, m.agent_name
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
    `;
    const values: SQLQueryBindings[] = [];

    if (provider) {
      query += ' WHERE s.provider = ?';
      values.push(provider);
    }

    query += ' ORDER BY m.created_at DESC LIMIT ?';
    values.push(limit);

    const rows = this.db.query(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Search messages using full-text search.
   */
  search(query: string, options: { sessionId?: string; limit?: number } = {}): IStoredMessage[] {
    const { sessionId, limit = 50 } = options;

    let sql = `
      SELECT m.id, m.session_id, m.role, m.content, m.model, m.input_tokens, m.output_tokens, m.duration_ms, m.created_at, m.agent_id, m.agent_name
      FROM messages m
      JOIN messages_fts fts ON m.rowid = fts.rowid
      WHERE messages_fts MATCH ?
    `;
    const values: SQLQueryBindings[] = [query];

    if (sessionId) {
      sql += ' AND m.session_id = ?';
      values.push(sessionId);
    }

    sql += ' ORDER BY rank LIMIT ?';
    values.push(limit);

    const rows = this.db.query(sql).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Get message count for a session.
   */
  countBySession(sessionId: string): number {
    const result = this.db.query(
      'SELECT COUNT(*) as count FROM messages WHERE session_id = ?'
    ).get(sessionId) as { count: number };
    return result.count;
  }

  /**
   * Delete all messages for a session.
   */
  deleteBySession(sessionId: string): number {
    const result = this.db.run(
      'DELETE FROM messages WHERE session_id = ?',
      [sessionId]
    );
    return (result as { changes?: number })?.changes ?? 0;
  }

  /**
   * Batch create messages within a transaction.
   */
  createBatch(messages: ICreateMessageOptions[]): IStoredMessage[] {
    if (messages.length === 0) return [];

    return withTransaction(this.db, () => {
      const now = Date.now();
      const results: IStoredMessage[] = [];

      const stmt = this.db.prepare(
        `INSERT OR REPLACE INTO messages (id, session_id, role, content, model, input_tokens, output_tokens, duration_ms, created_at, agent_id, agent_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const options of messages) {
        const message: IStoredMessage = {
          id: options.id,
          sessionId: options.sessionId,
          role: options.role,
          content: options.content,
          model: options.model ?? null,
          inputTokens: options.inputTokens ?? null,
          outputTokens: options.outputTokens ?? null,
          durationMs: options.durationMs ?? null,
          createdAt: now,
          agentId: options.agentId ?? null,
          agentName: options.agentName ?? null,
        };

        stmt.run(
          message.id,
          message.sessionId,
          message.role,
          message.content,
          message.model,
          message.inputTokens,
          message.outputTokens,
          message.durationMs,
          message.createdAt,
          message.agentId,
          message.agentName
        );

        results.push(message);
      }

      // Update session timestamps for all affected sessions
      const sessionIds = [...new Set(messages.map((m) => m.sessionId))];
      const updateStmt = this.db.prepare(
        'UPDATE sessions SET updated_at = ? WHERE id = ?'
      );
      for (const sessionId of sessionIds) {
        updateStmt.run(now, sessionId);
      }

      return results;
    });
  }

  /**
   * Get token usage statistics for a session.
   */
  getUsageStats(sessionId: string): IUsageStats {
    const result = this.db.query(
      `SELECT
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens
       FROM messages
       WHERE session_id = ?`
    ).get(sessionId) as { input_tokens: number; output_tokens: number };

    return {
      inputTokens: result.input_tokens,
      outputTokens: result.output_tokens,
    };
  }

  /**
   * Convert a stored message to a typed session message.
   */
  toSessionMessage(stored: IStoredMessage): ISessionMessage {
    const base = {
      id: stored.id,
      sessionId: stored.sessionId,
      role: stored.role,
      content: stored.content,
      timestamp: stored.createdAt,
    };

    if (stored.role === 'assistant') {
      return {
        ...base,
        role: 'assistant',
        model: stored.model ?? undefined,
        durationMs: stored.durationMs ?? undefined,
        usage: stored.inputTokens !== null || stored.outputTokens !== null
          ? {
              inputTokens: stored.inputTokens ?? 0,
              outputTokens: stored.outputTokens ?? 0,
            }
          : undefined,
      } as IAssistantMessage;
    }

    return base as IUserMessage;
  }

  /**
   * Map a database row to a stored message object.
   */
  private mapRow(row: Record<string, unknown>): IStoredMessage {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      role: row.role as 'user' | 'assistant' | 'system',
      content: row.content as string,
      model: row.model as string | null,
      inputTokens: row.input_tokens as number | null,
      outputTokens: row.output_tokens as number | null,
      durationMs: row.duration_ms as number | null,
      createdAt: row.created_at as number,
      agentId: row.agent_id as string | null,
      agentName: row.agent_name as string | null,
    };
  }

  /**
   * Get messages by agent for a session.
   * Useful for agent-aware compaction.
   */
  listByAgent(sessionId: string, agentId: string, options: IListMessagesOptions = {}): IStoredMessage[] {
    const { limit = 100, offset = 0 } = options;

    const query = `
      SELECT id, session_id, role, content, model, input_tokens, output_tokens, duration_ms, created_at, agent_id, agent_name
      FROM messages
      WHERE session_id = ? AND agent_id = ?
      ORDER BY created_at ASC
      LIMIT ? OFFSET ?
    `;

    const rows = this.db.query(query).all(sessionId, agentId, limit, offset) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Get distinct agents that have messages in a session.
   */
  getAgentsInSession(sessionId: string): Array<{ agentId: string; agentName: string; messageCount: number }> {
    const rows = this.db.query(`
      SELECT agent_id, agent_name, COUNT(*) as message_count
      FROM messages
      WHERE session_id = ? AND agent_id IS NOT NULL
      GROUP BY agent_id
      ORDER BY MIN(created_at)
    `).all(sessionId) as Array<{ agent_id: string; agent_name: string; message_count: number }>;

    return rows.map((row) => ({
      agentId: row.agent_id,
      agentName: row.agent_name,
      messageCount: row.message_count,
    }));
  }
}
