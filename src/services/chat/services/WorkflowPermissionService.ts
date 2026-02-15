/**
 * WorkflowPermissionService - Permission Handling for Workflows
 *
 * Manages permissions scoped to workflow executions, workflows,
 * projects, or globally. Supports pattern matching for file paths.
 */

import { Database } from 'bun:sqlite';
import type {
  StoredWorkflowPermission,
  PermissionScope,
  PermissionDecision,
} from '../types/workflow-schema.ts';

/**
 * Permission check context.
 */
export interface PermissionContext {
  /** Tool being checked */
  toolName: string;
  /** Optional file/path pattern */
  pattern?: string;
  /** Current execution ID (for execution scope) */
  executionId?: string;
  /** Current workflow ID (for workflow scope) */
  workflowId?: string;
}

/**
 * Permission grant options.
 */
export interface GrantPermissionOptions {
  /** Tool name */
  toolName: string;
  /** Permission scope */
  scope: PermissionScope;
  /** Optional pattern */
  pattern?: string;
  /** Execution ID (required for execution scope) */
  executionId?: string;
  /** Workflow ID (required for workflow scope) */
  workflowId?: string;
  /** Expiration timestamp (optional) */
  expiresAt?: number;
}

/**
 * Permission record with parsed fields.
 */
export interface WorkflowPermission {
  id: string;
  executionId: string | null;
  workflowId: string | null;
  toolName: string;
  pattern: string | null;
  scope: PermissionScope;
  decision: PermissionDecision;
  grantedAt: number;
  expiresAt: number | null;
}

/**
 * Result of a permission check.
 */
export interface PermissionCheckResult {
  /** Whether permission is granted */
  granted: boolean;
  /** The permission that matched (if any) */
  permission?: WorkflowPermission;
  /** Reason for the decision */
  reason: 'approved' | 'denied' | 'not_found' | 'expired';
}

/**
 * WorkflowPermissionService handles permission checks and grants.
 */
export class WorkflowPermissionService {
  constructor(private db: Database) {}

  /**
   * Check if a tool operation is permitted.
   * Checks permissions in order: once > execution > workflow > project > global
   */
  checkPermission(context: PermissionContext): PermissionCheckResult {
    const now = Date.now();
    const { toolName, pattern, executionId, workflowId } = context;

    // Build query to find matching permissions
    // Order by scope specificity: once, execution, workflow, project, global
    let query = `
      SELECT id, session_id, workflow_id, tool_name, pattern, scope,
             decision, granted_at, expires_at
      FROM permissions
      WHERE tool_name = ?
        AND (expires_at IS NULL OR expires_at > ?)
    `;
    const params: (string | number | null)[] = [toolName, now];

    // Build scope conditions
    const scopeConditions: string[] = [];

    if (executionId) {
      scopeConditions.push('(scope = ? AND session_id = ?)');
      params.push('execution', executionId);
    }

    if (workflowId) {
      scopeConditions.push('(scope = ? AND workflow_id = ?)');
      params.push('workflow', workflowId);
    }

    // Project and global scopes
    scopeConditions.push("scope = 'project'");
    scopeConditions.push("scope = 'global'");

    if (scopeConditions.length > 0) {
      query += ` AND (${scopeConditions.join(' OR ')})`;
    }

    // Match pattern if provided
    if (pattern) {
      query += ' AND (pattern IS NULL OR pattern = ? OR ? GLOB pattern)';
      params.push(pattern, pattern);
    } else {
      query += ' AND pattern IS NULL';
    }

    // Order by specificity (most specific first)
    query += `
      ORDER BY
        CASE scope
          WHEN 'once' THEN 1
          WHEN 'execution' THEN 2
          WHEN 'workflow' THEN 3
          WHEN 'project' THEN 4
          WHEN 'global' THEN 5
        END ASC,
        granted_at DESC
      LIMIT 1
    `;

    const row = this.db.query(query).get(...params) as StoredWorkflowPermission | null;

    if (!row) {
      return { granted: false, reason: 'not_found' };
    }

    const permission = this.mapStoredToPermission(row);

    // Check if expired
    if (permission.expiresAt && permission.expiresAt <= now) {
      return { granted: false, permission, reason: 'expired' };
    }

    // 'once' scope permissions should be consumed after use
    if (permission.scope === 'once' && permission.decision === 'approved') {
      this.deletePermission(permission.id);
    }

    return {
      granted: permission.decision === 'approved',
      permission,
      reason: permission.decision,
    };
  }

  /**
   * Grant a permission.
   */
  grantPermission(options: GrantPermissionOptions): WorkflowPermission {
    return this.createPermission(options, 'approved');
  }

  /**
   * Deny a permission (explicit deny).
   */
  denyPermission(options: GrantPermissionOptions): WorkflowPermission {
    return this.createPermission(options, 'denied');
  }

  /**
   * Create a permission record.
   */
  private createPermission(
    options: GrantPermissionOptions,
    decision: PermissionDecision
  ): WorkflowPermission {
    const now = Date.now();
    const id = `perm-${crypto.randomUUID()}`;

    const stored: StoredWorkflowPermission = {
      id,
      execution_id: options.executionId ?? null,
      workflow_id: options.workflowId ?? null,
      tool_name: options.toolName,
      pattern: options.pattern ?? null,
      scope: options.scope,
      decision,
      granted_at: now,
      expires_at: options.expiresAt ?? null,
    };

    // Use INSERT OR REPLACE to handle unique constraint
    this.db.run(
      `INSERT OR REPLACE INTO permissions (
        id, session_id, workflow_id, tool_name, pattern, scope,
        decision, granted_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stored.id,
        stored.execution_id,
        stored.workflow_id,
        stored.tool_name,
        stored.pattern,
        stored.scope,
        stored.decision,
        stored.granted_at,
        stored.expires_at,
      ]
    );

    return this.mapStoredToPermission(stored);
  }

  /**
   * Get a permission by ID.
   */
  getPermission(id: string): WorkflowPermission | null {
    const row = this.db.query(
      `SELECT id, session_id, workflow_id, tool_name, pattern, scope,
              decision, granted_at, expires_at
       FROM permissions WHERE id = ?`
    ).get(id) as StoredWorkflowPermission | null;

    if (!row) return null;
    return this.mapStoredToPermission(row);
  }

  /**
   * List permissions for a scope.
   */
  getPermissions(options: {
    scope?: PermissionScope;
    executionId?: string;
    workflowId?: string;
    toolName?: string;
    includeExpired?: boolean;
  } = {}): WorkflowPermission[] {
    const { scope, executionId, workflowId, toolName, includeExpired = false } = options;
    const now = Date.now();

    let query = `
      SELECT id, session_id, workflow_id, tool_name, pattern, scope,
             decision, granted_at, expires_at
      FROM permissions
      WHERE 1=1
    `;
    const params: (string | number)[] = [];

    if (scope) {
      query += ' AND scope = ?';
      params.push(scope);
    }

    if (executionId) {
      query += ' AND session_id = ?';
      params.push(executionId);
    }

    if (workflowId) {
      query += ' AND workflow_id = ?';
      params.push(workflowId);
    }

    if (toolName) {
      query += ' AND tool_name = ?';
      params.push(toolName);
    }

    if (!includeExpired) {
      query += ' AND (expires_at IS NULL OR expires_at > ?)';
      params.push(now);
    }

    query += ' ORDER BY granted_at DESC';

    const rows = this.db.query(query).all(...params) as StoredWorkflowPermission[];
    return rows.map((row) => this.mapStoredToPermission(row));
  }

  /**
   * Revoke a permission by ID.
   */
  revokePermission(id: string): boolean {
    return this.deletePermission(id);
  }

  /**
   * Delete a permission.
   */
  deletePermission(id: string): boolean {
    const result = this.db.run('DELETE FROM permissions WHERE id = ?', [id]);
    return result.changes > 0;
  }

  /**
   * Revoke all permissions for an execution.
   */
  revokeExecutionPermissions(executionId: string): number {
    const result = this.db.run(
      'DELETE FROM permissions WHERE session_id = ?',
      [executionId]
    );
    return result.changes;
  }

  /**
   * Revoke all permissions for a workflow.
   */
  revokeWorkflowPermissions(workflowId: string): number {
    const result = this.db.run(
      'DELETE FROM permissions WHERE workflow_id = ?',
      [workflowId]
    );
    return result.changes;
  }

  /**
   * Clean up expired permissions.
   */
  cleanupExpired(): number {
    const now = Date.now();
    const result = this.db.run(
      'DELETE FROM permissions WHERE expires_at IS NOT NULL AND expires_at <= ?',
      [now]
    );
    return result.changes;
  }

  /**
   * Check if any permission exists for a tool (regardless of decision).
   */
  hasPermissionRecord(context: PermissionContext): boolean {
    const result = this.checkPermission(context);
    return result.reason !== 'not_found';
  }

  /**
   * Map stored row to domain type.
   */
  private mapStoredToPermission(stored: StoredWorkflowPermission): WorkflowPermission {
    return {
      id: stored.id,
      executionId: (stored as any).session_id ?? stored.execution_id,
      workflowId: stored.workflow_id,
      toolName: stored.tool_name,
      pattern: stored.pattern,
      scope: stored.scope,
      decision: stored.decision,
      grantedAt: stored.granted_at,
      expiresAt: stored.expires_at,
    };
  }
}

/**
 * Create a new WorkflowPermissionService instance.
 */
export function createWorkflowPermissionService(db: Database): WorkflowPermissionService {
  return new WorkflowPermissionService(db);
}
