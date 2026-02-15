/**
 * PermissionStore - Permission Management
 *
 * Handles CRUD operations for AI tool permissions with UPSERT support
 * to prevent TOCTOU race conditions.
 */

import { Database, type SQLQueryBindings } from 'bun:sqlite';
import type {
  IPermission,
  PermissionScope,
  PermissionDecision,
  IPermissionCheckResult,
  IGrantPermissionOptions,
  IPermissionStore,
} from '../types/permissions.ts';

/**
 * Permission record as stored in the database.
 */
export interface IStoredPermission {
  id: string;
  sessionId: string | null;
  toolName: string;
  scope: PermissionScope;
  pattern: string | null;
  decision: string;
  grantedAt: number;
  expiresAt: number | null;
}

/**
 * Options for listing permissions.
 */
export interface IListPermissionsOptions {
  sessionId?: string;
  toolName?: string;
  scope?: PermissionScope;
  includeExpired?: boolean;
}

/**
 * PermissionStore - manages AI tool permissions in the database.
 * Uses UPSERT pattern to prevent race conditions.
 */
export class PermissionStore implements IPermissionStore {
  constructor(private db: Database) {}

  /**
   * Check if a tool action is permitted.
   * Returns the matching permission if found, with proper priority ordering.
   */
  checkPermission(
    toolName: string,
    input: string,
    sessionId?: string
  ): IPermissionCheckResult {
    const now = Date.now();

    // Query permissions ordered by specificity (once > session > project > global)
    const query = `
      SELECT id, session_id, tool_name, scope, pattern, decision, granted_at, expires_at
      FROM permissions
      WHERE tool_name = ?
        AND (expires_at IS NULL OR expires_at > ?)
        AND (
          (scope = 'global')
          OR (scope = 'project')
          OR (scope = 'session' AND session_id = ?)
          OR (scope = 'once' AND session_id = ?)
        )
      ORDER BY
        CASE scope
          WHEN 'once' THEN 1
          WHEN 'session' THEN 2
          WHEN 'project' THEN 3
          WHEN 'global' THEN 4
        END
      LIMIT 1
    `;

    const row = this.db.query(query).get(
      toolName,
      now,
      sessionId ?? null,
      sessionId ?? null
    ) as Record<string, unknown> | null;

    if (!row) {
      return { allowed: false, reason: 'No matching permission found' };
    }

    const permission = this.mapRow(row);

    // Check pattern match if specified
    if (permission.pattern) {
      try {
        const regex = new RegExp(permission.pattern);
        if (!regex.test(input)) {
          return {
            allowed: false,
            reason: `Input does not match pattern: ${permission.pattern}`,
          };
        }
      } catch {
        return {
          allowed: false,
          reason: `Invalid permission pattern: ${permission.pattern}`,
        };
      }
    }

    // If scope is 'once', delete the permission after use
    if (permission.scope === 'once') {
      this.db.run('DELETE FROM permissions WHERE id = ?', [permission.id]);
    }

    return {
      allowed: true,
      permission: this.toIPermission(permission),
      reason: `Allowed by ${permission.scope} permission`,
    };
  }

  /**
   * Grant a permission using UPSERT to prevent race conditions.
   */
  grantPermission(options: IGrantPermissionOptions): IPermission {
    const now = Date.now();
    const id = crypto.randomUUID();

    const stored: IStoredPermission = {
      id,
      sessionId: options.sessionId ?? null,
      toolName: options.toolName,
      scope: options.scope,
      pattern: options.pattern ?? null,
      decision: 'approved',
      grantedAt: now,
      expiresAt: options.expiresAt ?? null,
    };

    // Use UPSERT to atomically handle concurrent grants
    this.db.run(
      `INSERT INTO permissions (id, session_id, tool_name, scope, pattern, decision, granted_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tool_name, scope, COALESCE(session_id, ''), COALESCE(workflow_id, ''), COALESCE(pattern, ''))
       DO UPDATE SET
         decision = excluded.decision,
         granted_at = excluded.granted_at,
         expires_at = excluded.expires_at`,
      [
        stored.id,
        stored.sessionId,
        stored.toolName,
        stored.scope,
        stored.pattern,
        'approved',
        stored.grantedAt,
        stored.expiresAt,
      ]
    );

    return this.toIPermission(stored);
  }

  /**
   * Revoke a permission by ID.
   */
  revokePermission(id: string): void {
    this.db.run('DELETE FROM permissions WHERE id = ?', [id]);
  }

  /**
   * Revoke permissions by tool name and optional scope/session.
   */
  revokeByTool(
    toolName: string,
    options?: { scope?: PermissionScope; sessionId?: string }
  ): number {
    let query = 'DELETE FROM permissions WHERE tool_name = ?';
    const values: SQLQueryBindings[] = [toolName];

    if (options?.scope) {
      query += ' AND scope = ?';
      values.push(options.scope);
    }

    if (options?.sessionId) {
      query += ' AND session_id = ?';
      values.push(options.sessionId);
    }

    const result = this.db.run(query, values);
    return (result as { changes?: number })?.changes ?? 0;
  }

  /**
   * List permissions matching criteria.
   */
  listPermissions(options: IListPermissionsOptions = {}): IPermission[] {
    const { sessionId, toolName, scope, includeExpired = false } = options;
    const now = Date.now();

    let query = `
      SELECT id, session_id, tool_name, scope, pattern, decision, granted_at, expires_at
      FROM permissions
      WHERE 1=1
    `;
    const values: SQLQueryBindings[] = [];

    if (!includeExpired) {
      query += ' AND (expires_at IS NULL OR expires_at > ?)';
      values.push(now);
    }

    if (sessionId) {
      query += ' AND (session_id = ? OR session_id IS NULL)';
      values.push(sessionId);
    }

    if (toolName) {
      query += ' AND tool_name = ?';
      values.push(toolName);
    }

    if (scope) {
      query += ' AND scope = ?';
      values.push(scope);
    }

    query += ' ORDER BY granted_at DESC';

    const rows = this.db.query(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.toIPermission(this.mapRow(row)));
  }

  /**
   * Clear expired permissions.
   */
  clearExpired(): number {
    const now = Date.now();
    const result = this.db.run(
      'DELETE FROM permissions WHERE expires_at IS NOT NULL AND expires_at <= ?',
      [now]
    );
    return (result as { changes?: number })?.changes ?? 0;
  }

  /**
   * Get a permission by ID.
   */
  get(id: string): IPermission | null {
    const row = this.db.query(
      `SELECT id, session_id, tool_name, scope, pattern, decision, granted_at, expires_at
       FROM permissions WHERE id = ?`
    ).get(id) as Record<string, unknown> | null;

    if (!row) return null;
    return this.toIPermission(this.mapRow(row));
  }

  /**
   * Check if any permission exists for a tool.
   */
  hasPermission(toolName: string, sessionId?: string): boolean {
    const now = Date.now();
    const result = this.db.query(
      `SELECT 1 FROM permissions
       WHERE tool_name = ?
         AND (expires_at IS NULL OR expires_at > ?)
         AND (
           scope IN ('global', 'project')
           OR (scope IN ('session', 'once') AND session_id = ?)
         )
       LIMIT 1`
    ).get(toolName, now, sessionId ?? null);
    return result !== null;
  }

  /**
   * Get permission count.
   */
  count(options?: { toolName?: string; scope?: PermissionScope }): number {
    let query = 'SELECT COUNT(*) as count FROM permissions WHERE 1=1';
    const values: SQLQueryBindings[] = [];

    if (options?.toolName) {
      query += ' AND tool_name = ?';
      values.push(options.toolName);
    }

    if (options?.scope) {
      query += ' AND scope = ?';
      values.push(options.scope);
    }

    const result = this.db.query(query).get(...values) as { count: number };
    return result.count;
  }

  /**
   * Map a database row to a stored permission object.
   */
  private mapRow(row: Record<string, unknown>): IStoredPermission {
    return {
      id: row.id as string,
      sessionId: row.session_id as string | null,
      toolName: row.tool_name as string,
      scope: row.scope as PermissionScope,
      pattern: row.pattern as string | null,
      decision: row.decision as string,
      grantedAt: row.granted_at as number,
      expiresAt: row.expires_at as number | null,
    };
  }

  /**
   * Convert stored permission to IPermission type.
   */
  private toIPermission(stored: IStoredPermission): IPermission {
    return {
      id: stored.id,
      sessionId: stored.sessionId,
      toolName: stored.toolName,
      scope: stored.scope,
      pattern: stored.pattern,
      decision: (stored.decision === 'approved' ? 'allow' : 'deny') as PermissionDecision,
      createdAt: stored.grantedAt,
      expiresAt: stored.expiresAt,
    };
  }
}
