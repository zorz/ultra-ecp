/**
 * ContextItemService - Unified Message/Feedback Storage
 *
 * Manages context items which are the unified representation of
 * messages, tool calls, feedback, and other content in workflows.
 */

import { Database } from 'bun:sqlite';
import type {
  ContextItem,
  StoredContextItem,
  ContextItemType,
  MessageRole,
  FeedbackVote,
  FeedbackStatus,
  CreateContextItemOptions,
} from '../types/workflow-schema.ts';

/**
 * Options for listing context items.
 */
export interface ListContextItemsOptions {
  /** Filter by item type */
  itemType?: ContextItemType | ContextItemType[];
  /** Filter by agent ID */
  agentId?: string;
  /** Filter by iteration number */
  iterationNumber?: number;
  /** Only active items */
  activeOnly?: boolean;
  /** Include compacted items */
  includeCompacted?: boolean;
  /** Limit results */
  limit?: number;
  /** Order direction */
  orderDir?: 'ASC' | 'DESC';
}

/**
 * ContextItemService manages unified context storage.
 */
export class ContextItemService {
  constructor(private db: Database) {}

  /**
   * Create a context item.
   */
  createContextItem(options: CreateContextItemOptions): ContextItem {
    const now = Date.now();
    const id = `ctx-${crypto.randomUUID()}`;

    const stored: StoredContextItem = {
      id,
      execution_id: options.executionId,
      node_execution_id: options.nodeExecutionId ?? null,
      item_type: options.itemType,
      role: options.role ?? null,
      content: options.content,
      agent_id: options.agentId ?? null,
      agent_name: options.agentName ?? null,
      agent_role: options.agentRole ?? null,
      feedback_source_agent_id: options.feedbackSourceAgentId ?? null,
      feedback_target_agent_id: options.feedbackTargetAgentId ?? null,
      feedback_vote: options.feedbackVote ?? null,
      feedback_status: options.feedbackStatus ?? null,
      iteration_number: options.iterationNumber ?? 0,
      is_active: 1,
      compacted_into_id: null,
      tokens: options.tokens ?? null,
      is_complete: options.isComplete !== false ? 1 : 0,
      created_at: now,
    };

    this.db.run(
      `INSERT INTO messages (
        id, session_id, node_execution_id, role, content,
        agent_id, agent_name, agent_role, feedback_source_agent_id,
        feedback_target_agent_id, feedback_vote, feedback_status,
        iteration_number, is_active, compacted_into_id, tokens, is_complete, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stored.id,
        stored.execution_id,
        stored.node_execution_id,
        this.mapItemTypeToRole(stored.item_type),
        stored.content,
        stored.agent_id,
        stored.agent_name,
        stored.agent_role,
        stored.feedback_source_agent_id,
        stored.feedback_target_agent_id,
        stored.feedback_vote,
        stored.feedback_status,
        stored.iteration_number,
        stored.is_active,
        stored.compacted_into_id,
        stored.tokens,
        stored.is_complete,
        stored.created_at,
      ]
    );

    return this.mapStoredToContextItem(stored);
  }

  /**
   * Get a context item by ID.
   */
  getContextItem(id: string): ContextItem | null {
    const row = this.db.query(
      `SELECT id, session_id, node_execution_id, role, content,
              agent_id, agent_name, agent_role, feedback_source_agent_id,
              feedback_target_agent_id, feedback_vote, feedback_status,
              iteration_number, is_active, compacted_into_id, tokens, is_complete, created_at
       FROM messages WHERE id = ?`
    ).get(id) as StoredContextItem | null;

    if (!row) return null;
    return this.mapStoredToContextItem(row);
  }

  /**
   * List context items for an execution.
   */
  listContextItems(executionId: string, options: ListContextItemsOptions = {}): ContextItem[] {
    const {
      itemType,
      agentId,
      iterationNumber,
      activeOnly = false,
      includeCompacted = false,
      limit = 1000,
      orderDir = 'ASC',
    } = options;

    let query = `
      SELECT id, session_id, node_execution_id, role, content,
             agent_id, agent_name, agent_role, feedback_source_agent_id,
             feedback_target_agent_id, feedback_vote, feedback_status,
             iteration_number, is_active, compacted_into_id, tokens, is_complete, created_at
      FROM messages
      WHERE session_id = ?
    `;
    const params: (string | number)[] = [executionId];

    if (itemType) {
      if (Array.isArray(itemType)) {
        const mappedTypes = itemType.map((t) => this.mapItemTypeToRole(t));
        query += ` AND role IN (${mappedTypes.map(() => '?').join(', ')})`;
        params.push(...mappedTypes);
      } else {
        query += ' AND role = ?';
        params.push(this.mapItemTypeToRole(itemType));
      }
    }

    if (agentId) {
      query += ' AND agent_id = ?';
      params.push(agentId);
    }

    if (iterationNumber !== undefined) {
      query += ' AND iteration_number = ?';
      params.push(iterationNumber);
    }

    if (activeOnly) {
      query += ' AND is_active = 1';
    }

    if (!includeCompacted) {
      query += ' AND compacted_into_id IS NULL';
    }

    query += ` ORDER BY created_at ${orderDir} LIMIT ?`;
    params.push(limit);

    const rows = this.db.query(query).all(...params) as StoredContextItem[];
    return rows.map((row) => this.mapStoredToContextItem(row));
  }

  /**
   * Get active context for building prompts.
   */
  getActiveContext(executionId: string): ContextItem[] {
    return this.listContextItems(executionId, {
      activeOnly: true,
      includeCompacted: false,
      orderDir: 'ASC',
    });
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
   * Mark content as complete.
   */
  markComplete(id: string): boolean {
    const result = this.db.run(
      'UPDATE messages SET is_complete = 1 WHERE id = ?',
      [id]
    );
    return result.changes > 0;
  }

  /**
   * Update feedback status.
   */
  updateFeedbackStatus(id: string, status: FeedbackStatus): boolean {
    const result = this.db.run(
      'UPDATE messages SET feedback_status = ? WHERE id = ?',
      [status, id]
    );
    return result.changes > 0;
  }

  /**
   * Mark items as compacted.
   */
  compactItems(itemIds: string[], compactionId: string): number {
    if (itemIds.length === 0) return 0;

    const result = this.db.run(
      `UPDATE messages
       SET is_active = 0, compacted_into_id = ?
       WHERE id IN (${itemIds.map(() => '?').join(', ')})`,
      [compactionId, ...itemIds]
    );
    return result.changes;
  }

  /**
   * Expand compacted items.
   */
  expandCompaction(compactionId: string): number {
    const result = this.db.run(
      `UPDATE messages
       SET is_active = 1, compacted_into_id = NULL
       WHERE compacted_into_id = ?`,
      [compactionId]
    );
    return result.changes;
  }

  /**
   * Get feedback items for an execution.
   */
  getFeedbackItems(
    executionId: string,
    options: { status?: FeedbackStatus; targetAgentId?: string } = {}
  ): ContextItem[] {
    const { status, targetAgentId } = options;

    let query = `
      SELECT id, session_id, node_execution_id, role, content,
             agent_id, agent_name, agent_role, feedback_source_agent_id,
             feedback_target_agent_id, feedback_vote, feedback_status,
             iteration_number, is_active, compacted_into_id, tokens, is_complete, created_at
      FROM messages
      WHERE session_id = ? AND role = 'feedback'
    `;
    const params: (string | number)[] = [executionId];

    if (status) {
      query += ' AND feedback_status = ?';
      params.push(status);
    }

    if (targetAgentId) {
      query += ' AND feedback_target_agent_id = ?';
      params.push(targetAgentId);
    }

    query += ' ORDER BY created_at ASC';

    const rows = this.db.query(query).all(...params) as StoredContextItem[];
    return rows.map((row) => this.mapStoredToContextItem(row));
  }

  /**
   * Count tokens in active context.
   */
  countActiveTokens(executionId: string): number {
    const result = this.db.query(
      `SELECT COALESCE(SUM(tokens), 0) as total
       FROM messages
       WHERE session_id = ? AND is_active = 1 AND compacted_into_id IS NULL`
    ).get(executionId) as { total: number };
    return result.total;
  }

  /**
   * Delete a context item.
   */
  deleteContextItem(id: string): boolean {
    const result = this.db.run('DELETE FROM messages WHERE id = ?', [id]);
    return result.changes > 0;
  }

  /**
   * Delete all context items for an execution.
   */
  deleteAllContextItems(executionId: string): number {
    const result = this.db.run('DELETE FROM messages WHERE session_id = ?', [executionId]);
    return result.changes;
  }

  /**
   * Map stored row to domain type.
   * The DB now uses `session_id` and unified `role` column,
   * so we read from the raw row accordingly.
   */
  private mapStoredToContextItem(stored: StoredContextItem): ContextItem {
    // The DB row has `session_id` (not `execution_id`) and `role` (not `item_type`)
    const raw = stored as any;
    const sessionId = raw.session_id ?? stored.execution_id;
    const role = raw.role ?? stored.item_type;

    return {
      id: stored.id,
      executionId: sessionId,
      nodeExecutionId: stored.node_execution_id,
      itemType: this.mapRoleToItemType(role) as ContextItemType,
      role: role,
      content: stored.content,
      agentId: stored.agent_id,
      agentName: stored.agent_name,
      agentRole: stored.agent_role,
      feedbackSourceAgentId: stored.feedback_source_agent_id,
      feedbackTargetAgentId: stored.feedback_target_agent_id,
      feedbackVote: stored.feedback_vote,
      feedbackStatus: stored.feedback_status,
      iterationNumber: stored.iteration_number,
      isActive: stored.is_active === 1,
      compactedIntoId: stored.compacted_into_id,
      tokens: stored.tokens,
      isComplete: stored.is_complete === 1,
      createdAt: stored.created_at,
    };
  }

  /**
   * Map item_type values to the new unified role column values.
   */
  private mapItemTypeToRole(itemType: string): string {
    const mapping: Record<string, string> = {
      'user_input': 'user',
      'agent_output': 'assistant',
      'system': 'system',
      'tool_call': 'tool_call',
      'tool_result': 'tool_result',
      'feedback': 'feedback',
      'compaction': 'system',
    };
    return mapping[itemType] ?? itemType;
  }

  /**
   * Map role values back to item_type for domain objects.
   */
  private mapRoleToItemType(role: string): string {
    const mapping: Record<string, string> = {
      'user': 'user_input',
      'assistant': 'agent_output',
      'system': 'system',
      'tool_call': 'tool_call',
      'tool_result': 'tool_result',
      'feedback': 'feedback',
    };
    return mapping[role] ?? role;
  }
}

/**
 * Create a new ContextItemService instance.
 */
export function createContextItemService(db: Database): ContextItemService {
  return new ContextItemService(db);
}
