/**
 * SessionStore - Chat Session Management
 *
 * Handles CRUD operations for chat sessions with proper typing.
 */

import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { withTransaction } from '../transactions.ts';

/**
 * Session record as stored in the database.
 */
export interface ISession {
  id: string;
  title: string | null;
  systemPrompt: string | null;
  provider: string;
  model: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Session with message count for listing.
 */
export interface ISessionSummary extends ISession {
  messageCount: number;
  lastMessageAt: number | null;
}

/**
 * Options for creating a session.
 */
export interface ICreateSessionOptions {
  id: string;
  title?: string | null;
  systemPrompt?: string | null;
  provider: string;
  model: string;
}

/**
 * Options for updating a session.
 */
export interface IUpdateSessionOptions {
  title?: string | null;
  systemPrompt?: string | null;
  model?: string;
}

/**
 * Options for listing sessions.
 */
export interface IListSessionsOptions {
  provider?: string;
  limit?: number;
  offset?: number;
}

/**
 * SessionStore - manages chat sessions in the database.
 */
export class SessionStore {
  constructor(private db: Database) {}

  /**
   * Create a new chat session.
   */
  create(options: ICreateSessionOptions): ISession {
    const now = Date.now();
    const session: ISession = {
      id: options.id,
      title: options.title ?? null,
      systemPrompt: options.systemPrompt ?? null,
      provider: options.provider,
      model: options.model,
      createdAt: now,
      updatedAt: now,
    };

    this.db.run(
      `INSERT INTO sessions (id, title, system_prompt, provider, model, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        session.id,
        session.title,
        session.systemPrompt,
        session.provider,
        session.model,
        session.createdAt,
        session.updatedAt,
      ]
    );

    return session;
  }

  /**
   * Get a session by ID.
   */
  get(id: string): ISession | null {
    const row = this.db.query(
      `SELECT id, title, system_prompt, provider, model, created_at, updated_at
       FROM sessions WHERE id = ?`
    ).get(id) as Record<string, unknown> | null;

    if (!row) return null;

    return this.mapRow(row);
  }

  /**
   * Update a session.
   */
  update(id: string, updates: IUpdateSessionOptions): ISession | null {
    const existing = this.get(id);
    if (!existing) return null;

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
    this.db.run(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`, values);

    return this.get(id);
  }

  /**
   * Delete a session and all related data.
   * CASCADE foreign keys will delete related messages, tool calls, activity logs, etc.
   */
  delete(id: string): boolean {
    const result = this.db.run('DELETE FROM sessions WHERE id = ?', [id]);
    return result.changes > 0;
  }

  /**
   * List sessions with message counts.
   */
  list(options: IListSessionsOptions = {}): ISessionSummary[] {
    const { provider, limit = 50, offset = 0 } = options;

    let query = `
      SELECT
        s.id, s.title, s.system_prompt, s.provider, s.model, s.created_at, s.updated_at,
        COUNT(m.id) as message_count,
        MAX(m.created_at) as last_message_at
      FROM sessions s
      LEFT JOIN messages m ON m.session_id = s.id
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

    return rows.map((row) => ({
      ...this.mapRow(row),
      messageCount: row.message_count as number,
      lastMessageAt: row.last_message_at as number | null,
    }));
  }

  /**
   * Check if a session exists.
   */
  exists(id: string): boolean {
    const result = this.db.query(
      'SELECT 1 FROM sessions WHERE id = ? LIMIT 1'
    ).get(id);
    return result !== null;
  }

  /**
   * Get session count.
   */
  count(provider?: string): number {
    if (provider) {
      const result = this.db.query(
        'SELECT COUNT(*) as count FROM sessions WHERE provider = ?'
      ).get(provider) as { count: number };
      return result.count;
    }
    const result = this.db.query(
      'SELECT COUNT(*) as count FROM sessions'
    ).get() as { count: number };
    return result.count;
  }

  /**
   * Delete all sessions (use with caution).
   * DISABLED: Bulk session deletion is disabled to prevent accidental data loss.
   */
  deleteAll(): number {
    console.warn('[SessionStore] Bulk session deletion is disabled to prevent data loss.');
    return 0;
  }

  /**
   * Map a database row to a session object.
   */
  private mapRow(row: Record<string, unknown>): ISession {
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
}
