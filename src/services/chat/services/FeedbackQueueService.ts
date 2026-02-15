/**
 * FeedbackQueueService - CCA Feedback Queue Management
 *
 * Manages the feedback queue for Coder-Critic-Arbiter (CCA) workflows.
 * Handles queuing, surfacing, and resolving feedback items.
 */

import { Database } from 'bun:sqlite';
import type {
  FeedbackQueueItem,
  StoredFeedbackQueueItem,
  FeedbackQueueStatus,
  SurfaceTrigger,
  QueueFeedbackOptions,
} from '../types/workflow-schema.ts';

/**
 * Options for listing feedback items.
 */
export interface ListFeedbackOptions {
  /** Filter by status */
  status?: FeedbackQueueStatus | FeedbackQueueStatus[];
  /** Filter by surface trigger */
  surfaceTrigger?: SurfaceTrigger;
  /** Minimum priority */
  minPriority?: number;
  /** Limit number of results */
  limit?: number;
}

/**
 * FeedbackQueueService manages CCA-style feedback queuing.
 */
export class FeedbackQueueService {
  constructor(private db: Database) {}

  /**
   * Queue a feedback item for later surfacing.
   */
  queueFeedback(options: QueueFeedbackOptions): FeedbackQueueItem {
    const now = Date.now();
    const id = `feedback-${crypto.randomUUID()}`;

    const stored: StoredFeedbackQueueItem = {
      id,
      execution_id: options.executionId,
      context_item_id: options.contextItemId,
      status: 'queued',
      priority: options.priority ?? 0,
      surface_trigger: options.surfaceTrigger ?? 'iteration_end',
      queued_at: now,
      surfaced_at: null,
      resolved_at: null,
    };

    this.db.run(
      `INSERT INTO feedback_queue (
        id, session_id, message_id, status, priority,
        surface_trigger, queued_at, surfaced_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stored.id,
        stored.execution_id,
        stored.context_item_id,
        stored.status,
        stored.priority,
        stored.surface_trigger,
        stored.queued_at,
        stored.surfaced_at,
        stored.resolved_at,
      ]
    );

    return this.mapStoredToFeedbackItem(stored);
  }

  /**
   * Get a feedback item by ID.
   */
  getFeedbackItem(id: string): FeedbackQueueItem | null {
    const row = this.db.query(
      `SELECT id, session_id, message_id, status, priority,
              surface_trigger, queued_at, surfaced_at, resolved_at
       FROM feedback_queue WHERE id = ?`
    ).get(id) as StoredFeedbackQueueItem | null;

    if (!row) return null;
    return this.mapStoredToFeedbackItem(row);
  }

  /**
   * Get queued feedback for an execution.
   */
  getQueuedFeedback(executionId: string, options: ListFeedbackOptions = {}): FeedbackQueueItem[] {
    const { status, surfaceTrigger, minPriority, limit = 100 } = options;

    let query = `
      SELECT id, session_id, message_id, status, priority,
             surface_trigger, queued_at, surfaced_at, resolved_at
      FROM feedback_queue
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

    if (surfaceTrigger) {
      query += ' AND surface_trigger = ?';
      params.push(surfaceTrigger);
    }

    if (minPriority !== undefined) {
      query += ' AND priority >= ?';
      params.push(minPriority);
    }

    query += ' ORDER BY priority DESC, queued_at ASC LIMIT ?';
    params.push(limit);

    const rows = this.db.query(query).all(...params) as StoredFeedbackQueueItem[];
    return rows.map((row) => this.mapStoredToFeedbackItem(row));
  }

  /**
   * Surface feedback items based on a trigger.
   * Marks items as 'pending_review' and returns them.
   */
  surfaceFeedback(executionId: string, trigger: SurfaceTrigger): FeedbackQueueItem[] {
    const now = Date.now();

    // Find items that should be surfaced for this trigger
    const toSurface = this.db.query(
      `SELECT id, session_id, message_id, status, priority,
              surface_trigger, queued_at, surfaced_at, resolved_at
       FROM feedback_queue
       WHERE session_id = ?
         AND status = 'queued'
         AND surface_trigger = ?
       ORDER BY priority DESC, queued_at ASC`
    ).all(executionId, trigger) as StoredFeedbackQueueItem[];

    if (toSurface.length === 0) {
      return [];
    }

    // Update their status to pending_review
    const ids = toSurface.map((f) => f.id);
    this.db.run(
      `UPDATE feedback_queue
       SET status = 'pending_review', surfaced_at = ?
       WHERE id IN (${ids.map(() => '?').join(', ')})`,
      [now, ...ids]
    );

    // Return updated items
    return toSurface.map((stored) => ({
      ...this.mapStoredToFeedbackItem(stored),
      status: 'pending_review' as FeedbackQueueStatus,
      surfacedAt: now,
    }));
  }

  /**
   * Surface all pending feedback for an execution.
   */
  surfaceAllFeedback(executionId: string): FeedbackQueueItem[] {
    const now = Date.now();

    // Get all queued feedback
    const toSurface = this.db.query(
      `SELECT id, session_id, message_id, status, priority,
              surface_trigger, queued_at, surfaced_at, resolved_at
       FROM feedback_queue
       WHERE session_id = ?
         AND status = 'queued'
       ORDER BY priority DESC, queued_at ASC`
    ).all(executionId) as StoredFeedbackQueueItem[];

    if (toSurface.length === 0) {
      return [];
    }

    // Update their status
    const ids = toSurface.map((f) => f.id);
    this.db.run(
      `UPDATE feedback_queue
       SET status = 'pending_review', surfaced_at = ?
       WHERE id IN (${ids.map(() => '?').join(', ')})`,
      [now, ...ids]
    );

    return toSurface.map((stored) => ({
      ...this.mapStoredToFeedbackItem(stored),
      status: 'pending_review' as FeedbackQueueStatus,
      surfacedAt: now,
    }));
  }

  /**
   * Mark feedback as addressed.
   */
  markAddressed(id: string): boolean {
    const now = Date.now();
    const result = this.db.run(
      `UPDATE feedback_queue
       SET status = 'addressed', resolved_at = ?
       WHERE id = ?`,
      [now, id]
    );
    return result.changes > 0;
  }

  /**
   * Mark feedback as dismissed.
   */
  markDismissed(id: string): boolean {
    const now = Date.now();
    const result = this.db.run(
      `UPDATE feedback_queue
       SET status = 'dismissed', resolved_at = ?
       WHERE id = ?`,
      [now, id]
    );
    return result.changes > 0;
  }

  /**
   * Mark all feedback for an execution as addressed.
   */
  markAllAddressed(executionId: string): number {
    const now = Date.now();
    const result = this.db.run(
      `UPDATE feedback_queue
       SET status = 'addressed', resolved_at = ?
       WHERE session_id = ? AND status IN ('queued', 'pending_review')`,
      [now, executionId]
    );
    return result.changes;
  }

  /**
   * Get count of pending feedback.
   */
  getPendingCount(executionId: string): number {
    const result = this.db.query(
      `SELECT COUNT(*) as count FROM feedback_queue
       WHERE session_id = ? AND status IN ('queued', 'pending_review')`
    ).get(executionId) as { count: number };
    return result.count;
  }

  /**
   * Check if there's any immediate feedback.
   */
  hasImmediateFeedback(executionId: string): boolean {
    const result = this.db.query(
      `SELECT 1 FROM feedback_queue
       WHERE session_id = ? AND status = 'queued' AND surface_trigger = 'immediate'
       LIMIT 1`
    ).get(executionId);
    return result !== null;
  }

  /**
   * Delete feedback item.
   */
  deleteFeedback(id: string): boolean {
    const result = this.db.run('DELETE FROM feedback_queue WHERE id = ?', [id]);
    return result.changes > 0;
  }

  /**
   * Delete all feedback for an execution.
   */
  deleteAllFeedback(executionId: string): number {
    const result = this.db.run('DELETE FROM feedback_queue WHERE session_id = ?', [executionId]);
    return result.changes;
  }

  /**
   * Map stored row to domain type.
   */
  private mapStoredToFeedbackItem(stored: StoredFeedbackQueueItem): FeedbackQueueItem {
    return {
      id: stored.id,
      executionId: (stored as any).session_id ?? stored.execution_id,
      contextItemId: (stored as any).message_id ?? stored.context_item_id,
      status: stored.status,
      priority: stored.priority,
      surfaceTrigger: stored.surface_trigger,
      queuedAt: stored.queued_at,
      surfacedAt: stored.surfaced_at,
      resolvedAt: stored.resolved_at,
    };
  }
}

/**
 * Create a new FeedbackQueueService instance.
 */
export function createFeedbackQueueService(db: Database): FeedbackQueueService {
  return new FeedbackQueueService(db);
}
