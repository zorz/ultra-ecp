/**
 * ExecutionMessageService - Unified Chat Message Storage
 *
 * Manages execution messages which form the unified chat model.
 * All user inputs and agent outputs are stored as messages in this service.
 * This enables the "all chats are workflows" architecture.
 */

import { Database } from 'bun:sqlite';
import type {
  ExecutionMessage,
  StoredExecutionMessage,
  ExecutionMessageRole,
  CreateExecutionMessageOptions,
} from '../types/workflow-schema.ts';

/**
 * Options for listing execution messages.
 */
export interface ListExecutionMessagesOptions {
  /** Filter by role */
  role?: ExecutionMessageRole | ExecutionMessageRole[];
  /** Filter by agent ID */
  agentId?: string;
  /** Only complete messages (exclude streaming) */
  completeOnly?: boolean;
  /** Limit results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Order direction */
  orderDir?: 'ASC' | 'DESC';
}

/**
 * ExecutionMessageService manages unified execution messages.
 */
export class ExecutionMessageService {
  constructor(private db: Database) {}

  /**
   * Create an execution message.
   */
  createMessage(options: CreateExecutionMessageOptions): ExecutionMessage {
    const now = Date.now();
    const id = `msg-${crypto.randomUUID()}`;

    const stored: StoredExecutionMessage = {
      id,
      execution_id: options.executionId,
      role: options.role,
      agent_id: options.agentId ?? null,
      agent_name: options.agentName ?? null,
      content: options.content,
      node_execution_id: options.nodeExecutionId ?? null,
      is_complete: options.isComplete !== false ? 1 : 0,
      created_at: now,
    };

    this.db.run(
      `INSERT INTO messages (
        id, session_id, role, agent_id, agent_name,
        content, node_execution_id, is_complete, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stored.id,
        stored.execution_id,
        stored.role === 'agent' ? 'assistant' : stored.role,
        stored.agent_id,
        stored.agent_name,
        stored.content,
        stored.node_execution_id,
        stored.is_complete,
        stored.created_at,
      ]
    );

    return this.mapStoredToMessage(stored);
  }

  /**
   * Get a message by ID.
   */
  getMessage(id: string): ExecutionMessage | null {
    const row = this.db.query(
      `SELECT id, session_id, role, agent_id, agent_name,
              content, node_execution_id, is_complete, created_at
       FROM messages WHERE id = ?`
    ).get(id) as StoredExecutionMessage | null;

    if (!row) return null;
    return this.mapStoredToMessage(row);
  }

  /**
   * List messages for an execution.
   */
  listMessages(executionId: string, options: ListExecutionMessagesOptions = {}): ExecutionMessage[] {
    const {
      role,
      agentId,
      completeOnly = false,
      limit = 1000,
      offset = 0,
      orderDir = 'ASC',
    } = options;

    let query = `
      SELECT id, session_id, role, agent_id, agent_name,
             content, node_execution_id, is_complete, created_at
      FROM messages
      WHERE session_id = ?
    `;
    const params: (string | number)[] = [executionId];

    if (role) {
      if (Array.isArray(role)) {
        query += ` AND role IN (${role.map(() => '?').join(', ')})`;
        params.push(...role);
      } else {
        query += ' AND role = ?';
        params.push(role);
      }
    }

    if (agentId) {
      query += ' AND agent_id = ?';
      params.push(agentId);
    }

    if (completeOnly) {
      query += ' AND is_complete = 1';
    }

    query += ` ORDER BY created_at ${orderDir}`;

    if (limit > 0) {
      query += ' LIMIT ?';
      params.push(limit);
    }

    if (offset > 0) {
      query += ' OFFSET ?';
      params.push(offset);
    }

    const rows = this.db.query(query).all(...params) as StoredExecutionMessage[];
    return rows.map((row) => this.mapStoredToMessage(row));
  }

  /**
   * Get the latest message in an execution.
   */
  getLatestMessage(executionId: string): ExecutionMessage | null {
    const row = this.db.query(
      `SELECT id, session_id, role, agent_id, agent_name,
              content, node_execution_id, is_complete, created_at
       FROM messages
       WHERE session_id = ?
       ORDER BY created_at DESC
       LIMIT 1`
    ).get(executionId) as StoredExecutionMessage | null;

    if (!row) return null;
    return this.mapStoredToMessage(row);
  }

  /**
   * Get streaming (incomplete) messages for an execution.
   */
  getStreamingMessages(executionId: string): ExecutionMessage[] {
    const rows = this.db.query(
      `SELECT id, session_id, role, agent_id, agent_name,
              content, node_execution_id, is_complete, created_at
       FROM messages
       WHERE session_id = ? AND is_complete = 0
       ORDER BY created_at ASC`
    ).all(executionId) as StoredExecutionMessage[];

    return rows.map((row) => this.mapStoredToMessage(row));
  }

  /**
   * Update content (for streaming).
   */
  updateContent(id: string, content: string, isComplete?: boolean): boolean {
    let query = 'UPDATE messages SET content = ?';
    const params: (string | number)[] = [content];

    if (isComplete !== undefined) {
      query += ', is_complete = ?';
      params.push(isComplete ? 1 : 0);
    }

    query += ' WHERE id = ?';
    params.push(id);

    const result = this.db.run(query, params);
    return result.changes > 0;
  }

  /**
   * Append to content (for streaming).
   */
  appendContent(id: string, chunk: string): boolean {
    const result = this.db.run(
      'UPDATE messages SET content = content || ? WHERE id = ?',
      [chunk, id]
    );
    return result.changes > 0;
  }

  /**
   * Mark message as complete (streaming finished).
   */
  markComplete(id: string): boolean {
    const result = this.db.run(
      'UPDATE messages SET is_complete = 1 WHERE id = ?',
      [id]
    );
    return result.changes > 0;
  }

  /**
   * Count messages in an execution.
   */
  countMessages(executionId: string): number {
    const result = this.db.query(
      'SELECT COUNT(*) as count FROM messages WHERE session_id = ?'
    ).get(executionId) as { count: number };
    return result.count;
  }

  /**
   * Get messages by agent.
   */
  getAgentMessages(executionId: string, agentId: string): ExecutionMessage[] {
    return this.listMessages(executionId, { agentId, orderDir: 'ASC' });
  }

  /**
   * Get user messages.
   */
  getUserMessages(executionId: string): ExecutionMessage[] {
    return this.listMessages(executionId, { role: 'user', orderDir: 'ASC' });
  }

  /**
   * Delete a message.
   */
  deleteMessage(id: string): boolean {
    const result = this.db.run('DELETE FROM messages WHERE id = ?', [id]);
    return result.changes > 0;
  }

  /**
   * Delete all messages for an execution.
   */
  deleteAllMessages(executionId: string): number {
    const result = this.db.run('DELETE FROM messages WHERE session_id = ?', [executionId]);
    return result.changes;
  }

  /**
   * Map stored row to domain type.
   */
  private mapStoredToMessage(stored: StoredExecutionMessage): ExecutionMessage {
    // Map 'assistant' role from DB back to 'agent' for domain type
    const role = ((stored.role as string) === 'assistant' ? 'agent' : stored.role) as ExecutionMessageRole;
    return {
      id: stored.id,
      executionId: (stored as any).session_id ?? stored.execution_id,
      role,
      agentId: stored.agent_id,
      agentName: stored.agent_name,
      content: stored.content,
      nodeExecutionId: stored.node_execution_id,
      isComplete: stored.is_complete === 1,
      createdAt: stored.created_at,
    };
  }
}

/**
 * Create a new ExecutionMessageService instance.
 */
export function createExecutionMessageService(db: Database): ExecutionMessageService {
  return new ExecutionMessageService(db);
}
