/**
 * CheckpointService - User Input/Approval Points
 *
 * Manages checkpoints where workflow execution pauses for user input,
 * approval, or arbiter decisions.
 */

import { Database } from 'bun:sqlite';
import type {
  Checkpoint,
  StoredCheckpoint,
  CheckpointType,
  CreateCheckpointOptions,
} from '../types/workflow-schema.ts';

/**
 * Options for listing checkpoints.
 */
export interface ListCheckpointsOptions {
  /** Filter by checkpoint type */
  checkpointType?: CheckpointType;
  /** Only pending (undecided) checkpoints */
  pendingOnly?: boolean;
  /** Limit results */
  limit?: number;
}

/**
 * CheckpointService manages user input/approval points.
 */
export class CheckpointService {
  constructor(private db: Database) {}

  /**
   * Create a checkpoint.
   */
  createCheckpoint(options: CreateCheckpointOptions): Checkpoint {
    const now = Date.now();
    const id = `chkpt-${crypto.randomUUID()}`;

    const stored: StoredCheckpoint = {
      id,
      execution_id: options.executionId,
      node_execution_id: options.nodeExecutionId ?? null,
      checkpoint_type: options.checkpointType,
      prompt_message: options.promptMessage ?? null,
      options: options.options ? JSON.stringify(options.options) : null,
      decision: null,
      feedback: null,
      created_at: now,
      decided_at: null,
    };

    this.db.run(
      `INSERT INTO checkpoints (
        id, session_id, node_execution_id, checkpoint_type,
        prompt_message, options, decision, feedback, created_at, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stored.id,
        stored.execution_id,
        stored.node_execution_id,
        stored.checkpoint_type,
        stored.prompt_message,
        stored.options,
        stored.decision,
        stored.feedback,
        stored.created_at,
        stored.decided_at,
      ]
    );

    return this.mapStoredToCheckpoint(stored);
  }

  /**
   * Get a checkpoint by ID.
   */
  getCheckpoint(id: string): Checkpoint | null {
    const row = this.db.query(
      `SELECT id, session_id, node_execution_id, checkpoint_type,
              prompt_message, options, decision, feedback, created_at, decided_at
       FROM checkpoints WHERE id = ?`
    ).get(id) as StoredCheckpoint | null;

    if (!row) return null;
    return this.mapStoredToCheckpoint(row);
  }

  /**
   * List checkpoints for an execution.
   */
  listCheckpoints(executionId: string, options: ListCheckpointsOptions = {}): Checkpoint[] {
    const { checkpointType, pendingOnly = false, limit = 100 } = options;

    let query = `
      SELECT id, session_id, node_execution_id, checkpoint_type,
             prompt_message, options, decision, feedback, created_at, decided_at
      FROM checkpoints
      WHERE session_id = ?
    `;
    const params: (string | number)[] = [executionId];

    if (checkpointType) {
      query += ' AND checkpoint_type = ?';
      params.push(checkpointType);
    }

    if (pendingOnly) {
      query += ' AND decided_at IS NULL';
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.query(query).all(...params) as StoredCheckpoint[];
    return rows.map((row) => this.mapStoredToCheckpoint(row));
  }

  /**
   * Get the current pending checkpoint for an execution.
   */
  getPendingCheckpoint(executionId: string): Checkpoint | null {
    const row = this.db.query(
      `SELECT id, session_id, node_execution_id, checkpoint_type,
              prompt_message, options, decision, feedback, created_at, decided_at
       FROM checkpoints
       WHERE session_id = ? AND decided_at IS NULL
       ORDER BY created_at DESC LIMIT 1`
    ).get(executionId) as StoredCheckpoint | null;

    if (!row) return null;
    return this.mapStoredToCheckpoint(row);
  }

  /**
   * Record a decision for a checkpoint.
   */
  recordDecision(id: string, decision: string, feedback?: string): boolean {
    const now = Date.now();
    const result = this.db.run(
      `UPDATE checkpoints
       SET decision = ?, feedback = ?, decided_at = ?
       WHERE id = ?`,
      [decision, feedback ?? null, now, id]
    );
    return result.changes > 0;
  }

  /**
   * Check if execution has a pending checkpoint.
   */
  hasPendingCheckpoint(executionId: string): boolean {
    const result = this.db.query(
      `SELECT 1 FROM checkpoints
       WHERE session_id = ? AND decided_at IS NULL
       LIMIT 1`
    ).get(executionId);
    return result !== null;
  }

  /**
   * Delete a checkpoint.
   */
  deleteCheckpoint(id: string): boolean {
    const result = this.db.run('DELETE FROM checkpoints WHERE id = ?', [id]);
    return result.changes > 0;
  }

  /**
   * Delete all checkpoints for an execution.
   */
  deleteAllCheckpoints(executionId: string): number {
    const result = this.db.run('DELETE FROM checkpoints WHERE session_id = ?', [executionId]);
    return result.changes;
  }

  /**
   * Map stored row to domain type.
   */
  private mapStoredToCheckpoint(stored: StoredCheckpoint): Checkpoint {
    return {
      id: stored.id,
      executionId: (stored as any).session_id ?? stored.execution_id,
      nodeExecutionId: stored.node_execution_id,
      checkpointType: stored.checkpoint_type,
      promptMessage: stored.prompt_message,
      options: stored.options ? JSON.parse(stored.options) : null,
      decision: stored.decision,
      feedback: stored.feedback,
      createdAt: stored.created_at,
      decidedAt: stored.decided_at,
    };
  }
}

/**
 * Create a new CheckpointService instance.
 */
export function createCheckpointService(db: Database): CheckpointService {
  return new CheckpointService(db);
}
