/**
 * WorkflowToolCallService - Tool Call Management for Workflows
 *
 * Tracks tool calls within workflow executions, providing:
 * - CRUD operations for tool call records
 * - Queries by execution, node, or status
 * - Support for grouped (by node) and flat views
 */

import { Database } from 'bun:sqlite';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ToolCallStatus =
  | 'pending'
  | 'awaiting_permission'
  | 'approved'
  | 'denied'
  | 'running'
  | 'success'
  | 'error';

export interface StoredWorkflowToolCall {
  id: string;
  session_id: string;
  node_execution_id: string | null;
  message_id: string | null;
  tool_name: string;
  input: string | null;
  output: string | null;
  status: ToolCallStatus;
  error_message: string | null;
  started_at: number | null;
  completed_at: number | null;
}

export interface WorkflowToolCall {
  id: string;
  executionId: string;
  nodeExecutionId: string | null;
  contextItemId: string | null;
  toolName: string;
  input: unknown;
  output: unknown;
  status: ToolCallStatus;
  errorMessage: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

export interface CreateToolCallOptions {
  executionId: string;
  nodeExecutionId?: string;
  contextItemId?: string;
  toolName: string;
  input?: unknown;
}

export interface ListToolCallsOptions {
  nodeExecutionId?: string;
  status?: ToolCallStatus | ToolCallStatus[];
  limit?: number;
  offset?: number;
  orderBy?: 'started_at' | 'completed_at';
  orderDir?: 'ASC' | 'DESC';
}

export interface ToolCallWithNode extends WorkflowToolCall {
  nodeId: string | null;
  nodeType: string | null;
  agentId: string | null;
  agentName: string | null;
  iterationNumber: number | null;
}

export interface ToolCallsByNode {
  nodeId: string;
  nodeType: string;
  agentId: string | null;
  agentName: string | null;
  iterationNumber: number;
  toolCalls: WorkflowToolCall[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

export class WorkflowToolCallService {
  constructor(private db: Database) {}

  /**
   * Create a new tool call record.
   */
  createToolCall(options: CreateToolCallOptions): WorkflowToolCall {
    const now = Date.now();
    const id = `tool-${crypto.randomUUID()}`;

    const stored: StoredWorkflowToolCall = {
      id,
      session_id: options.executionId,
      node_execution_id: options.nodeExecutionId ?? null,
      message_id: options.contextItemId ?? null,
      tool_name: options.toolName,
      input: options.input ? JSON.stringify(options.input) : null,
      output: null,
      status: 'pending',
      error_message: null,
      started_at: now,
      completed_at: null,
    };

    this.db.run(
      `INSERT INTO tool_calls (
        id, session_id, node_execution_id, message_id,
        tool_name, input, output, status, error_message,
        started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stored.id,
        stored.session_id,
        stored.node_execution_id,
        stored.message_id,
        stored.tool_name,
        stored.input,
        stored.output,
        stored.status,
        stored.error_message,
        stored.started_at,
        stored.completed_at,
      ]
    );

    return this.mapStoredToToolCall(stored);
  }

  /**
   * Get a tool call by ID.
   */
  getToolCall(id: string): WorkflowToolCall | null {
    const row = this.db.query(
      `SELECT id, session_id, node_execution_id, message_id,
              tool_name, input, output, status, error_message,
              started_at, completed_at
       FROM tool_calls WHERE id = ?`
    ).get(id) as StoredWorkflowToolCall | null;

    if (!row) return null;
    return this.mapStoredToToolCall(row);
  }

  /**
   * List tool calls for an execution (flat list).
   */
  listToolCalls(executionId: string, options: ListToolCallsOptions = {}): WorkflowToolCall[] {
    const {
      nodeExecutionId,
      status,
      limit = 100,
      offset = 0,
      orderBy = 'started_at',
      orderDir = 'ASC',
    } = options;

    let query = `
      SELECT id, session_id, node_execution_id, message_id,
             tool_name, input, output, status, error_message,
             started_at, completed_at
      FROM tool_calls
      WHERE session_id = ?
    `;
    const params: (string | number)[] = [executionId];

    if (nodeExecutionId) {
      query += ' AND node_execution_id = ?';
      params.push(nodeExecutionId);
    }

    if (status) {
      if (Array.isArray(status)) {
        query += ` AND status IN (${status.map(() => '?').join(', ')})`;
        params.push(...status);
      } else {
        query += ' AND status = ?';
        params.push(status);
      }
    }

    query += ` ORDER BY ${orderBy} ${orderDir} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.db.query(query).all(...params) as StoredWorkflowToolCall[];
    return rows.map((row) => this.mapStoredToToolCall(row));
  }

  /**
   * List tool calls with node information (for display).
   */
  listToolCallsWithNodes(executionId: string, options: ListToolCallsOptions = {}): ToolCallWithNode[] {
    const {
      status,
      limit = 100,
      offset = 0,
      orderBy = 'started_at',
      orderDir = 'ASC',
    } = options;

    let query = `
      SELECT
        tc.id, tc.session_id, tc.node_execution_id, tc.message_id,
        tc.tool_name, tc.input, tc.output, tc.status, tc.error_message,
        tc.started_at, tc.completed_at,
        ne.node_id, ne.node_type, ne.agent_id, ne.agent_name, ne.iteration_number
      FROM tool_calls tc
      LEFT JOIN node_executions ne ON tc.node_execution_id = ne.id
      WHERE tc.session_id = ?
    `;
    const params: (string | number)[] = [executionId];

    if (status) {
      if (Array.isArray(status)) {
        query += ` AND tc.status IN (${status.map(() => '?').join(', ')})`;
        params.push(...status);
      } else {
        query += ' AND tc.status = ?';
        params.push(status);
      }
    }

    query += ` ORDER BY tc.${orderBy} ${orderDir} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.db.query(query).all(...params) as Array<
      StoredWorkflowToolCall & {
        node_id: string | null;
        node_type: string | null;
        agent_id: string | null;
        agent_name: string | null;
        iteration_number: number | null;
      }
    >;

    return rows.map((row) => ({
      ...this.mapStoredToToolCall(row),
      nodeId: row.node_id,
      nodeType: row.node_type,
      agentId: row.agent_id,
      agentName: row.agent_name,
      iterationNumber: row.iteration_number,
    }));
  }

  /**
   * List tool calls grouped by node execution.
   */
  listToolCallsGroupedByNode(executionId: string): ToolCallsByNode[] {
    // Get all tool calls with node info
    const toolCalls = this.listToolCallsWithNodes(executionId, {
      limit: 1000, // Higher limit for grouping
      orderBy: 'started_at',
      orderDir: 'ASC',
    });

    // Group by node execution
    const groups = new Map<string, ToolCallsByNode>();

    for (const tc of toolCalls) {
      const key = tc.nodeExecutionId || 'ungrouped';

      if (!groups.has(key)) {
        groups.set(key, {
          nodeId: tc.nodeId || 'unknown',
          nodeType: tc.nodeType || 'unknown',
          agentId: tc.agentId,
          agentName: tc.agentName,
          iterationNumber: tc.iterationNumber ?? 0,
          toolCalls: [],
        });
      }

      groups.get(key)!.toolCalls.push({
        id: tc.id,
        executionId: tc.executionId,
        nodeExecutionId: tc.nodeExecutionId,
        contextItemId: tc.contextItemId,
        toolName: tc.toolName,
        input: tc.input,
        output: tc.output,
        status: tc.status,
        errorMessage: tc.errorMessage,
        startedAt: tc.startedAt,
        completedAt: tc.completedAt,
      });
    }

    return Array.from(groups.values());
  }

  /**
   * Update tool call status.
   */
  updateStatus(id: string, status: ToolCallStatus, errorMessage?: string): boolean {
    const result = this.db.run(
      'UPDATE tool_calls SET status = ?, error_message = ? WHERE id = ?',
      [status, errorMessage ?? null, id]
    );
    return result.changes > 0;
  }

  /**
   * Start a tool call (set to running).
   */
  startToolCall(id: string): boolean {
    const now = Date.now();
    const result = this.db.run(
      'UPDATE tool_calls SET status = ?, started_at = COALESCE(started_at, ?) WHERE id = ?',
      ['running', now, id]
    );
    return result.changes > 0;
  }

  /**
   * Complete a tool call with output.
   */
  completeToolCall(id: string, output: unknown): boolean {
    const now = Date.now();
    const result = this.db.run(
      'UPDATE tool_calls SET status = ?, output = ?, completed_at = ? WHERE id = ?',
      ['success', JSON.stringify(output), now, id]
    );
    return result.changes > 0;
  }

  /**
   * Fail a tool call with error.
   */
  failToolCall(id: string, error: string): boolean {
    const now = Date.now();
    const result = this.db.run(
      'UPDATE tool_calls SET status = ?, error_message = ?, completed_at = ? WHERE id = ?',
      ['error', error, now, id]
    );
    return result.changes > 0;
  }

  /**
   * Set tool call as awaiting permission.
   */
  awaitPermission(id: string): boolean {
    return this.updateStatus(id, 'awaiting_permission');
  }

  /**
   * Approve a tool call (permission granted).
   */
  approveToolCall(id: string): boolean {
    return this.updateStatus(id, 'approved');
  }

  /**
   * Deny a tool call (permission denied).
   */
  denyToolCall(id: string): boolean {
    return this.updateStatus(id, 'denied');
  }

  /**
   * Get pending permission requests for an execution.
   */
  getPendingPermissionRequests(executionId: string): ToolCallWithNode[] {
    return this.listToolCallsWithNodes(executionId, {
      status: 'awaiting_permission',
    });
  }

  /**
   * Count tool calls by status for an execution.
   */
  countByStatus(executionId: string): Record<ToolCallStatus, number> {
    const rows = this.db.query(
      `SELECT status, COUNT(*) as count
       FROM tool_calls
       WHERE session_id = ?
       GROUP BY status`
    ).all(executionId) as Array<{ status: ToolCallStatus; count: number }>;

    const counts: Record<ToolCallStatus, number> = {
      pending: 0,
      awaiting_permission: 0,
      approved: 0,
      denied: 0,
      running: 0,
      success: 0,
      error: 0,
    };

    for (const row of rows) {
      counts[row.status] = row.count;
    }

    return counts;
  }

  /**
   * Delete all tool calls for an execution.
   */
  deleteByExecution(executionId: string): number {
    const result = this.db.run(
      'DELETE FROM tool_calls WHERE session_id = ?',
      [executionId]
    );
    return result.changes;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────────────────

  private mapStoredToToolCall(stored: StoredWorkflowToolCall): WorkflowToolCall {
    return {
      id: stored.id,
      executionId: stored.session_id,
      nodeExecutionId: stored.node_execution_id,
      contextItemId: stored.message_id,
      toolName: stored.tool_name,
      input: stored.input ? JSON.parse(stored.input) : null,
      output: stored.output ? JSON.parse(stored.output) : null,
      status: stored.status,
      errorMessage: stored.error_message,
      startedAt: stored.started_at,
      completedAt: stored.completed_at,
    };
  }
}

/**
 * Create a new WorkflowToolCallService instance.
 */
export function createWorkflowToolCallService(db: Database): WorkflowToolCallService {
  return new WorkflowToolCallService(db);
}
