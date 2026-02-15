/**
 * Permission Types
 *
 * Defines the permission system for AI tool usage.
 * Permissions can be scoped to different levels of persistence.
 */

/**
 * Permission scope levels - determines how long a permission lasts.
 *
 * - `once`: Single use, automatically revoked after first use
 * - `session`: Valid for the current chat session only
 * - `project`: Valid for the entire project (stored in .ultra/)
 * - `global`: Valid across all projects (stored in user config)
 */
export type PermissionScope = 'once' | 'session' | 'project' | 'global';

/**
 * Permission decision - what action to take.
 */
export type PermissionDecision = 'allow' | 'deny' | 'ask';

/**
 * Permission record for AI tool actions.
 */
export interface IPermission {
  /** Unique permission identifier */
  id: string;
  /** Session ID (for session-scoped permissions) */
  sessionId?: string | null;
  /** Tool name this permission applies to */
  toolName: string;
  /** Scope of this permission */
  scope: PermissionScope;
  /** Optional regex pattern for matching inputs */
  pattern?: string | null;
  /** Human-readable description of what this permission allows */
  description?: string | null;
  /** Decision for this permission */
  decision: PermissionDecision;
  /** When this permission was created */
  createdAt: number;
  /** When this permission was last updated */
  updatedAt?: number;
  /** When this permission expires (null = never) */
  expiresAt?: number | null;
}

/**
 * Permission request - when the AI wants to use a tool.
 */
export interface IPermissionRequest {
  /** Tool being requested */
  toolName: string;
  /** Input to the tool */
  input: unknown;
  /** Human-readable description of the action */
  description?: string;
  /** Session ID for context */
  sessionId?: string;
  /** Suggested scope if user grants permission */
  suggestedScope?: PermissionScope;
}

/**
 * Permission check result.
 */
export interface IPermissionCheckResult {
  /** Whether the action is allowed */
  allowed: boolean;
  /** The matching permission (if any) */
  permission?: IPermission;
  /** Reason for the decision */
  reason?: string;
}

/**
 * Options for granting a permission.
 */
export interface IGrantPermissionOptions {
  /** Tool name */
  toolName: string;
  /** Scope of the permission */
  scope: PermissionScope;
  /** Optional session ID (required for session scope) */
  sessionId?: string;
  /** Optional pattern for matching inputs */
  pattern?: string;
  /** Optional description */
  description?: string;
  /** Optional expiration time */
  expiresAt?: number;
}

/**
 * Permission storage interface.
 * Can be implemented by different backends (SQLite, memory, etc.).
 */
export interface IPermissionStore {
  /**
   * Check if a tool action is permitted.
   */
  checkPermission(
    toolName: string,
    input: string,
    sessionId?: string
  ): IPermissionCheckResult;

  /**
   * Grant a permission.
   */
  grantPermission(options: IGrantPermissionOptions): IPermission;

  /**
   * Revoke a permission by ID.
   */
  revokePermission(id: string): void;

  /**
   * List permissions matching criteria.
   */
  listPermissions(options?: {
    sessionId?: string;
    toolName?: string;
    scope?: PermissionScope;
  }): IPermission[];

  /**
   * Clear expired permissions.
   */
  clearExpired(): number;
}

/**
 * Priority order for permission scopes.
 * Lower number = higher priority (more specific).
 */
export const SCOPE_PRIORITY: Record<PermissionScope, number> = {
  once: 1,
  session: 2,
  project: 3,
  global: 4,
};

/**
 * Check if scope A is more specific than scope B.
 */
export function isMoreSpecific(a: PermissionScope, b: PermissionScope): boolean {
  return SCOPE_PRIORITY[a] < SCOPE_PRIORITY[b];
}

/**
 * Get the default expiration time for a scope.
 * Returns null for scopes that don't expire by default.
 */
export function getDefaultExpiration(scope: PermissionScope): number | null {
  switch (scope) {
    case 'once':
      // Once permissions don't expire (they're deleted after use)
      return null;
    case 'session':
      // Session permissions don't have a time-based expiration
      return null;
    case 'project':
      // Project permissions don't expire by default
      return null;
    case 'global':
      // Global permissions don't expire by default
      return null;
  }
}
