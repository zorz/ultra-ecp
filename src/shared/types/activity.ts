/**
 * Shared Activity Types
 *
 * Common activity log types used across services and clients.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Activity Type Definitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Types of activities that can be logged.
 */
export type ActivityType =
  // Message activities
  | 'message_sent'
  | 'message_received'
  | 'message_streaming'
  // Tool activities
  | 'tool_started'
  | 'tool_completed'
  | 'tool_error'
  // Permission activities
  | 'permission_requested'
  | 'permission_granted'
  | 'permission_denied'
  // Session activities
  | 'session_created'
  | 'session_updated'
  | 'session_archived'
  // Workflow activities
  | 'workflow_started'
  | 'workflow_step'
  | 'workflow_completed'
  | 'workflow_error'
  | 'iteration_start'
  | 'iteration_complete'
  // Agent activities
  | 'agent_status'
  | 'agent_handoff';

/**
 * Entity types that activities relate to.
 */
export type ActivityEntityType =
  | 'message'
  | 'tool_call'
  | 'permission'
  | 'session'
  | 'workflow'
  | 'agent';

// ─────────────────────────────────────────────────────────────────────────────
// Activity Entry Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Activity log entry.
 */
export interface ActivityEntry {
  id: number | string;
  sessionId?: string;
  activityType: ActivityType;
  entityType: ActivityEntityType;
  entityId: string;
  summary: string;
  details?: Record<string, unknown>;
  createdAt: number;
}

/**
 * Activity log query options.
 */
export interface ActivityQueryOptions {
  sessionId?: string;
  types?: ActivityType[];
  entityTypes?: ActivityEntityType[];
  since?: number;
  limit?: number;
}
