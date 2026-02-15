/**
 * WorkflowExecutionService - Execution Management
 *
 * Manages workflow execution lifecycle: start, pause, resume, cancel.
 * Handles the execution state machine and persistence.
 */

import { Database } from 'bun:sqlite';
import type {
  WorkflowExecution,
  StoredWorkflowExecution,
  NodeExecution,
  StoredNodeExecution,
  ExecutionStatus,
  NodeExecutionStatus,
  NodeType,
  StartExecutionOptions,
} from '../types/workflow-schema.ts';

/**
 * Options for listing executions.
 */
export interface ListExecutionsOptions {
  /** Filter by workflow ID */
  workflowId?: string;
  /** Filter by status */
  status?: ExecutionStatus | ExecutionStatus[];
  /** Filter by chat session ID */
  chatSessionId?: string;
  /** Limit number of results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Order by field */
  orderBy?: 'created_at' | 'updated_at';
  /** Order direction */
  orderDir?: 'ASC' | 'DESC';
}

/**
 * Options for listing node executions.
 */
export interface ListNodeExecutionsOptions {
  /** Filter by status */
  status?: NodeExecutionStatus | NodeExecutionStatus[];
  /** Filter by node type */
  nodeType?: NodeType;
  /** Filter by iteration number */
  iterationNumber?: number;
  /** Limit number of results */
  limit?: number;
}

/**
 * Result of starting an execution.
 */
export interface StartExecutionResult {
  execution: WorkflowExecution;
  /** First node to execute (if workflow has nodes) */
  firstNodeId?: string;
}

/**
 * WorkflowExecutionService manages execution lifecycle.
 */
export class WorkflowExecutionService {
  constructor(private db: Database) {}

  /**
   * Start a new workflow execution.
   */
  startExecution(options: StartExecutionOptions): WorkflowExecution {
    const now = Date.now();
    const id = `exec-${crypto.randomUUID()}`;

    const stored: StoredWorkflowExecution = {
      id,
      workflow_id: options.workflowId,
      chat_session_id: options.chatSessionId ?? null,
      status: 'pending',
      current_node_id: null,
      iteration_count: 0,
      max_iterations: options.maxIterations ?? 10,
      initial_input: options.initialInput ? JSON.stringify(options.initialInput) : null,
      final_output: null,
      error_message: null,
      created_at: now,
      updated_at: null,
      completed_at: null,
    };

    this.db.run(
      `INSERT INTO sessions (
        id, workflow_id, status, current_node_id,
        iteration_count, max_iterations, initial_input, final_output,
        error_message, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stored.id,
        stored.workflow_id,
        stored.status,
        stored.current_node_id,
        stored.iteration_count,
        stored.max_iterations,
        stored.initial_input,
        stored.final_output,
        stored.error_message,
        stored.created_at,
        stored.updated_at,
        stored.completed_at,
      ]
    );

    // Fetch the execution with workflow name from the join query
    return this.getExecution(id)!;
  }

  /**
   * Get an execution by ID.
   */
  getExecution(id: string): WorkflowExecution | null {
    const row = this.db.query(
      `SELECT e.id, e.workflow_id, w.name as workflow_name, e.status, e.current_node_id,
              e.iteration_count, e.max_iterations, e.initial_input, e.final_output,
              e.error_message, e.created_at, e.updated_at, e.completed_at
       FROM sessions e
       LEFT JOIN workflows w ON e.workflow_id = w.id
       WHERE e.id = ?`
    ).get(id) as StoredWorkflowExecution | null;

    if (!row) return null;
    return this.mapStoredToExecution(row);
  }

  /**
   * List executions with optional filtering.
   */
  listExecutions(options: ListExecutionsOptions = {}): WorkflowExecution[] {
    const {
      workflowId,
      status,
      limit = 100,
      offset = 0,
      orderBy = 'created_at',
      orderDir = 'DESC',
    } = options;

    // Join with workflows table to get workflow_name
    let query = `
      SELECT e.id, e.workflow_id, w.name as workflow_name, e.status, e.current_node_id,
             e.iteration_count, e.max_iterations, e.initial_input, e.final_output,
             e.error_message, e.created_at, e.updated_at, e.completed_at
      FROM sessions e
      LEFT JOIN workflows w ON e.workflow_id = w.id
      WHERE 1=1
    `;
    const params: (string | number)[] = [];

    if (workflowId) {
      query += ' AND e.workflow_id = ?';
      params.push(workflowId);
    }

    if (status) {
      if (Array.isArray(status)) {
        query += ` AND e.status IN (${status.map(() => '?').join(', ')})`;
        params.push(...status);
      } else {
        query += ' AND e.status = ?';
        params.push(status);
      }
    }

    query += ` ORDER BY e.${orderBy} ${orderDir} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.db.query(query).all(...params) as StoredWorkflowExecution[];
    return rows.map((row) => this.mapStoredToExecution(row));
  }

  /**
   * Update execution status.
   */
  updateStatus(id: string, status: ExecutionStatus, errorMessage?: string): boolean {
    const now = Date.now();
    const completedAt = ['completed', 'failed', 'cancelled'].includes(status) ? now : null;

    const result = this.db.run(
      `UPDATE sessions
       SET status = ?, error_message = ?, updated_at = ?, completed_at = COALESCE(?, completed_at)
       WHERE id = ?`,
      [status, errorMessage ?? null, now, completedAt, id]
    );

    return result.changes > 0;
  }

  /**
   * Set the current node for an execution.
   */
  setCurrentNode(id: string, nodeId: string | null): boolean {
    const now = Date.now();
    const result = this.db.run(
      'UPDATE sessions SET current_node_id = ?, updated_at = ? WHERE id = ?',
      [nodeId, now, id]
    );
    return result.changes > 0;
  }

  /**
   * Increment iteration count.
   */
  incrementIteration(id: string): number {
    const now = Date.now();
    this.db.run(
      'UPDATE sessions SET iteration_count = iteration_count + 1, updated_at = ? WHERE id = ?',
      [now, id]
    );

    const execution = this.getExecution(id);
    return execution?.iterationCount ?? 0;
  }

  /**
   * Set final output.
   */
  setFinalOutput(id: string, output: unknown): boolean {
    const now = Date.now();
    const result = this.db.run(
      'UPDATE sessions SET final_output = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(output), now, id]
    );
    return result.changes > 0;
  }

  /**
   * Pause an execution.
   */
  pauseExecution(id: string): boolean {
    return this.updateStatus(id, 'paused');
  }

  /**
   * Resume a paused execution.
   */
  resumeExecution(id: string): boolean {
    return this.updateStatus(id, 'running');
  }

  /**
   * Cancel an execution.
   */
  cancelExecution(id: string): boolean {
    return this.updateStatus(id, 'cancelled');
  }

  /**
   * Mark execution as awaiting input.
   */
  awaitInput(id: string): boolean {
    return this.updateStatus(id, 'awaiting_input');
  }

  /**
   * Complete an execution successfully.
   */
  completeExecution(id: string, output?: unknown): boolean {
    if (output !== undefined) {
      this.setFinalOutput(id, output);
    }
    return this.updateStatus(id, 'completed');
  }

  /**
   * Fail an execution with an error.
   */
  failExecution(id: string, error: string): boolean {
    return this.updateStatus(id, 'failed', error);
  }

  /**
   * Delete an execution and all related data.
   */
  deleteExecution(id: string): boolean {
    const result = this.db.run('DELETE FROM sessions WHERE id = ?', [id]);
    return result.changes > 0;
  }

  /**
   * Check if execution has reached max iterations.
   */
  hasReachedMaxIterations(id: string): boolean {
    const execution = this.getExecution(id);
    if (!execution) return false;
    return execution.iterationCount >= execution.maxIterations;
  }

  /**
   * Get active executions (running or paused).
   */
  getActiveExecutions(): WorkflowExecution[] {
    return this.listExecutions({
      status: ['running', 'paused', 'awaiting_input'],
      orderBy: 'updated_at',
      orderDir: 'DESC',
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Node Execution Methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a node execution record.
   */
  createNodeExecution(options: {
    executionId: string;
    nodeId: string;
    nodeType: NodeType;
    iterationNumber?: number;
    input?: unknown;
    agentId?: string;
    agentName?: string;
  }): NodeExecution {
    const now = Date.now();
    const id = `node-${crypto.randomUUID()}`;

    const stored: StoredNodeExecution = {
      id,
      execution_id: options.executionId,
      node_id: options.nodeId,
      node_type: options.nodeType,
      status: 'pending',
      iteration_number: options.iterationNumber ?? 0,
      input: options.input ? JSON.stringify(options.input) : null,
      output: null,
      agent_id: options.agentId ?? null,
      agent_name: options.agentName ?? null,
      started_at: null,
      completed_at: null,
      duration_ms: null,
      tokens_in: null,
      tokens_out: null,
    };

    this.db.run(
      `INSERT INTO node_executions (
        id, session_id, node_id, node_type, status, iteration_number,
        input, output, agent_id, agent_name, started_at, completed_at,
        duration_ms, tokens_in, tokens_out
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stored.id,
        stored.execution_id,
        stored.node_id,
        stored.node_type,
        stored.status,
        stored.iteration_number,
        stored.input,
        stored.output,
        stored.agent_id,
        stored.agent_name,
        stored.started_at,
        stored.completed_at,
        stored.duration_ms,
        stored.tokens_in,
        stored.tokens_out,
      ]
    );

    return this.mapStoredToNodeExecution(stored);
  }

  /**
   * Get a node execution by ID.
   */
  getNodeExecution(id: string): NodeExecution | null {
    const row = this.db.query(
      `SELECT id, session_id as execution_id, node_id, node_type, status, iteration_number,
              input, output, agent_id, agent_name, started_at, completed_at,
              duration_ms, tokens_in, tokens_out
       FROM node_executions WHERE id = ?`
    ).get(id) as StoredNodeExecution | null;

    if (!row) return null;
    return this.mapStoredToNodeExecution(row);
  }

  /**
   * List node executions for a workflow execution.
   */
  listNodeExecutions(executionId: string, options: ListNodeExecutionsOptions = {}): NodeExecution[] {
    const { status, nodeType, iterationNumber, limit = 100 } = options;

    let query = `
      SELECT id, session_id as execution_id, node_id, node_type, status, iteration_number,
             input, output, agent_id, agent_name, started_at, completed_at,
             duration_ms, tokens_in, tokens_out
      FROM node_executions
      WHERE session_id = ?
    `;
    const params: (string | number)[] = [executionId];

    if (status) {
      if (Array.isArray(status)) {
        query += ` AND status IN (${status.map(() => '?').join(', ')})`;
        params.push(...status);
      } else {
        query += ' AND status = ?';
        params.push(status);
      }
    }

    if (nodeType) {
      query += ' AND node_type = ?';
      params.push(nodeType);
    }

    if (iterationNumber !== undefined) {
      query += ' AND iteration_number = ?';
      params.push(iterationNumber);
    }

    query += ' ORDER BY started_at ASC, id ASC LIMIT ?';
    params.push(limit);

    const rows = this.db.query(query).all(...params) as StoredNodeExecution[];
    return rows.map((row) => this.mapStoredToNodeExecution(row));
  }

  /**
   * Start a node execution.
   */
  startNodeExecution(id: string): boolean {
    const now = Date.now();
    const result = this.db.run(
      'UPDATE node_executions SET status = ?, started_at = ? WHERE id = ?',
      ['running', now, id]
    );
    return result.changes > 0;
  }

  /**
   * Complete a node execution.
   */
  completeNodeExecution(
    id: string,
    output: unknown,
    metrics?: { tokensIn?: number; tokensOut?: number }
  ): boolean {
    const node = this.getNodeExecution(id);
    if (!node) return false;

    const now = Date.now();
    const durationMs = node.startedAt ? now - node.startedAt : null;

    const result = this.db.run(
      `UPDATE node_executions
       SET status = ?, output = ?, completed_at = ?, duration_ms = ?, tokens_in = ?, tokens_out = ?
       WHERE id = ?`,
      ['completed', JSON.stringify(output), now, durationMs, metrics?.tokensIn ?? null, metrics?.tokensOut ?? null, id]
    );
    return result.changes > 0;
  }

  /**
   * Fail a node execution.
   */
  failNodeExecution(id: string, error: unknown): boolean {
    const node = this.getNodeExecution(id);
    if (!node) return false;

    const now = Date.now();
    const durationMs = node.startedAt ? now - node.startedAt : null;

    const result = this.db.run(
      'UPDATE node_executions SET status = ?, output = ?, completed_at = ?, duration_ms = ? WHERE id = ?',
      ['failed', JSON.stringify({ error }), now, durationMs, id]
    );
    return result.changes > 0;
  }

  /**
   * Skip a node execution.
   */
  skipNodeExecution(id: string, reason?: string): boolean {
    const now = Date.now();
    const result = this.db.run(
      'UPDATE node_executions SET status = ?, output = ?, completed_at = ? WHERE id = ?',
      ['skipped', reason ? JSON.stringify({ reason }) : null, now, id]
    );
    return result.changes > 0;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Mapping Methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Map a stored execution row to the domain type.
   */
  private mapStoredToExecution(stored: StoredWorkflowExecution): WorkflowExecution {
    return {
      id: stored.id,
      workflowId: stored.workflow_id,
      workflowName: stored.workflow_name ?? null,
      chatSessionId: stored.chat_session_id ?? null,
      status: stored.status,
      currentNodeId: stored.current_node_id,
      iterationCount: stored.iteration_count,
      maxIterations: stored.max_iterations,
      initialInput: stored.initial_input ? JSON.parse(stored.initial_input) : null,
      finalOutput: stored.final_output ? JSON.parse(stored.final_output) : null,
      errorMessage: stored.error_message,
      createdAt: stored.created_at,
      updatedAt: stored.updated_at,
      completedAt: stored.completed_at,
    };
  }

  /**
   * Map a stored node execution row to the domain type.
   */
  private mapStoredToNodeExecution(stored: StoredNodeExecution): NodeExecution {
    return {
      id: stored.id,
      executionId: stored.execution_id,
      nodeId: stored.node_id,
      nodeType: stored.node_type,
      status: stored.status,
      iterationNumber: stored.iteration_number,
      input: stored.input ? JSON.parse(stored.input) : null,
      output: stored.output ? JSON.parse(stored.output) : null,
      agentId: stored.agent_id,
      agentName: stored.agent_name,
      startedAt: stored.started_at,
      completedAt: stored.completed_at,
      durationMs: stored.duration_ms,
      tokensIn: stored.tokens_in,
      tokensOut: stored.tokens_out,
    };
  }
}

/**
 * Create a new WorkflowExecutionService instance.
 */
export function createWorkflowExecutionService(db: Database): WorkflowExecutionService {
  return new WorkflowExecutionService(db);
}
