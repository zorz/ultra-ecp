/**
 * Shared Permission Types
 *
 * Common permission types used across services and clients.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Permission Scope and Status
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scope of a permission grant.
 */
export type PermissionScope = 'once' | 'session' | 'folder' | 'global';

/**
 * Status of a permission request.
 */
export type PermissionStatus = 'pending' | 'approved' | 'denied';

// ─────────────────────────────────────────────────────────────────────────────
// Permission Request Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pending permission request awaiting user decision.
 */
export interface PendingPermission {
  /** Tool use ID for correlation */
  toolUseId: string;
  /** Name of the tool requesting permission */
  toolName: string;
  /** Tool input parameters (for display) */
  input: Record<string, unknown>;
  /** When the request was created */
  timestamp: number;
  /** Optional description of what the tool will do */
  description?: string;
}

/**
 * Permission decision from user.
 */
export interface PermissionDecision {
  toolUseId: string;
  approved: boolean;
  scope?: PermissionScope;
  folderPath?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Permission Grant Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stored permission grant.
 */
export interface PermissionGrant {
  id: string;
  toolName: string;
  scope: PermissionScope;
  pattern?: string;
  folderPath?: string;
  grantedAt: number;
  expiresAt?: number;
}
