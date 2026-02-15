/**
 * AI Permission Service
 *
 * Manages tool use approvals at different scopes:
 * - Once: Single use approval (handled by pending permission flow)
 * - Session: Approved for the duration of an AI session
 * - Folder: Approved for operations within a specific folder
 * - Global: Always approved (read-only tools, user-configured)
 */

import { debugLog, isDebugEnabled } from '../../debug.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Approval scope.
 */
export type ApprovalScope = 'once' | 'session' | 'folder' | 'global';

/**
 * A recorded approval.
 */
export interface Approval {
  /** Tool name (e.g., 'Edit', 'Bash', 'Write') */
  toolName: string;
  /** Approval scope */
  scope: ApprovalScope;
  /** Session ID (for session-scoped approvals) */
  sessionId?: string;
  /** Folder path (for folder-scoped approvals) */
  folderPath?: string;
  /** When the approval was granted */
  grantedAt: number;
  /** Optional expiration time */
  expiresAt?: number;
  /** Description of what was approved */
  description?: string;
}

/**
 * Permission check result.
 */
export interface PermissionCheckResult {
  /** Whether the action is allowed */
  allowed: boolean;
  /** The approval that granted permission (if allowed) */
  approval?: Approval;
  /** Reason for denial (if not allowed) */
  reason?: string;
}

/**
 * Options for checking permission.
 */
export interface PermissionCheckOptions {
  /** Tool name */
  toolName: string;
  /** Session ID */
  sessionId: string;
  /** File or folder path being operated on */
  targetPath?: string;
  /** Tool input parameters */
  input?: Record<string, unknown>;
}

/**
 * Permission service event types.
 */
export type PermissionEventType =
  | 'approval_added'
  | 'approval_removed'
  | 'approvals_cleared';

/**
 * Permission service event.
 */
export interface PermissionEvent {
  type: PermissionEventType;
  approval?: Approval;
  sessionId?: string;
  timestamp: number;
}

/**
 * Permission event callback.
 */
export type PermissionEventCallback = (event: PermissionEvent) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Permission Service
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Service for managing AI tool use permissions.
 */
export class PermissionService {
  /** Session-scoped approvals: Map<sessionId, Map<toolName, Approval>> */
  private sessionApprovals: Map<string, Map<string, Approval>> = new Map();

  /** Folder-scoped approvals: Map<folderPath, Map<toolName, Approval>> */
  private folderApprovals: Map<string, Map<string, Approval>> = new Map();

  /** Global approvals (always approved tools) */
  private globalApprovals: Map<string, Approval> = new Map();

  /** Event listeners */
  private eventListeners: Set<PermissionEventCallback> = new Set();

  /** Default tools that are auto-approved (read-only + planning/document tools) */
  private static readonly DEFAULT_AUTO_APPROVED = [
    // Read-only file tools
    'Read', 'Glob', 'Grep', 'LS', 'LSP',
    // Todo CRUD (non-destructive, user can review in UI)
    'TodoWrite', 'TodoRead',
    // Plan CRUD
    'PlanCreate', 'PlanUpdate', 'PlanRead', 'PlanGet',
    // Spec CRUD
    'SpecCreate', 'SpecRead', 'SpecUpdate',
    // Document CRUD
    'DocumentCreate', 'DocumentUpdate', 'DocumentList', 'DocumentGet', 'DocumentSearch',
    // Chat history search (read-only)
    'SearchChatHistory',
    // Builder tools (scoped to agent-builder via allowedTools, non-destructive)
    'CreatePersona', 'UpdatePersonaField', 'UpdateAgencyField', 'CompressPersona',
  ];

  constructor() {
    // Initialize with default auto-approved tools
    for (const toolName of PermissionService.DEFAULT_AUTO_APPROVED) {
      this.addGlobalApproval(toolName, 'Read-only tool');
    }
  }

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[PermissionService] ${msg}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Permission Checking
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Check if an action is permitted.
   * Checks in order: global -> session -> folder
   */
  checkPermission(options: PermissionCheckOptions): PermissionCheckResult {
    const { toolName, sessionId, targetPath } = options;

    // 1. Check global approvals
    const globalApproval = this.globalApprovals.get(toolName);
    if (globalApproval) {
      this.log(`Global approval found for ${toolName}`);
      return { allowed: true, approval: globalApproval };
    }

    // 2. Check session approvals
    const sessionMap = this.sessionApprovals.get(sessionId);
    if (sessionMap) {
      const sessionApproval = sessionMap.get(toolName);
      if (sessionApproval) {
        // Check expiration
        if (!sessionApproval.expiresAt || sessionApproval.expiresAt > Date.now()) {
          this.log(`Session approval found for ${toolName} in session ${sessionId}`);
          return { allowed: true, approval: sessionApproval };
        } else {
          // Expired, remove it
          sessionMap.delete(toolName);
          this.log(`Session approval expired for ${toolName}`);
        }
      }
    }

    // 3. Check folder approvals
    if (targetPath) {
      const folderApproval = this.findFolderApproval(toolName, targetPath);
      if (folderApproval) {
        this.log(`Folder approval found for ${toolName} in ${folderApproval.folderPath}`);
        return { allowed: true, approval: folderApproval };
      }
    }

    // No approval found
    this.log(`No approval found for ${toolName}`);
    return { allowed: false, reason: 'No approval found' };
  }

  /**
   * Find a folder approval that covers the target path.
   */
  private findFolderApproval(toolName: string, targetPath: string): Approval | undefined {
    // Normalize path
    const normalizedTarget = this.normalizePath(targetPath);

    // Check each folder approval to see if it covers this path
    for (const [folderPath, approvalMap] of this.folderApprovals) {
      const normalizedFolder = this.normalizePath(folderPath);

      // Check if target is within the approved folder
      if (normalizedTarget.startsWith(normalizedFolder)) {
        const approval = approvalMap.get(toolName);
        if (approval) {
          // Check expiration
          if (!approval.expiresAt || approval.expiresAt > Date.now()) {
            return approval;
          } else {
            // Expired, remove it
            approvalMap.delete(toolName);
          }
        }
      }
    }

    return undefined;
  }

  /**
   * Normalize a path for comparison.
   */
  private normalizePath(path: string): string {
    // Ensure path ends with / for proper prefix matching
    let normalized = path.replace(/\\/g, '/');
    if (!normalized.endsWith('/')) {
      normalized += '/';
    }
    return normalized;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Approval Management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Add a session-scoped approval.
   */
  addSessionApproval(
    sessionId: string,
    toolName: string,
    description?: string,
    expiresAt?: number
  ): Approval {
    let sessionMap = this.sessionApprovals.get(sessionId);
    if (!sessionMap) {
      sessionMap = new Map();
      this.sessionApprovals.set(sessionId, sessionMap);
    }

    const approval: Approval = {
      toolName,
      scope: 'session',
      sessionId,
      grantedAt: Date.now(),
      expiresAt,
      description,
    };

    sessionMap.set(toolName, approval);
    this.log(`Added session approval: ${toolName} for session ${sessionId}`);

    this.emitEvent({
      type: 'approval_added',
      approval,
      sessionId,
      timestamp: Date.now(),
    });

    return approval;
  }

  /**
   * Add a folder-scoped approval.
   */
  addFolderApproval(
    folderPath: string,
    toolName: string,
    description?: string,
    expiresAt?: number
  ): Approval {
    const normalizedPath = this.normalizePath(folderPath).slice(0, -1); // Remove trailing /

    let folderMap = this.folderApprovals.get(normalizedPath);
    if (!folderMap) {
      folderMap = new Map();
      this.folderApprovals.set(normalizedPath, folderMap);
    }

    const approval: Approval = {
      toolName,
      scope: 'folder',
      folderPath: normalizedPath,
      grantedAt: Date.now(),
      expiresAt,
      description,
    };

    folderMap.set(toolName, approval);
    this.log(`Added folder approval: ${toolName} for folder ${normalizedPath}`);

    this.emitEvent({
      type: 'approval_added',
      approval,
      timestamp: Date.now(),
    });

    return approval;
  }

  /**
   * Add a global approval (always approved).
   */
  addGlobalApproval(toolName: string, description?: string): Approval {
    const approval: Approval = {
      toolName,
      scope: 'global',
      grantedAt: Date.now(),
      description,
    };

    this.globalApprovals.set(toolName, approval);
    this.log(`Added global approval: ${toolName}`);

    this.emitEvent({
      type: 'approval_added',
      approval,
      timestamp: Date.now(),
    });

    return approval;
  }

  /**
   * Remove a session approval.
   */
  removeSessionApproval(sessionId: string, toolName: string): boolean {
    const sessionMap = this.sessionApprovals.get(sessionId);
    if (!sessionMap) return false;

    const approval = sessionMap.get(toolName);
    if (!approval) return false;

    sessionMap.delete(toolName);
    this.log(`Removed session approval: ${toolName} from session ${sessionId}`);

    this.emitEvent({
      type: 'approval_removed',
      approval,
      sessionId,
      timestamp: Date.now(),
    });

    return true;
  }

  /**
   * Remove a folder approval.
   */
  removeFolderApproval(folderPath: string, toolName: string): boolean {
    const normalizedPath = this.normalizePath(folderPath).slice(0, -1);
    const folderMap = this.folderApprovals.get(normalizedPath);
    if (!folderMap) return false;

    const approval = folderMap.get(toolName);
    if (!approval) return false;

    folderMap.delete(toolName);
    this.log(`Removed folder approval: ${toolName} from folder ${normalizedPath}`);

    this.emitEvent({
      type: 'approval_removed',
      approval,
      timestamp: Date.now(),
    });

    return true;
  }

  /**
   * Remove a global approval.
   */
  removeGlobalApproval(toolName: string): boolean {
    const approval = this.globalApprovals.get(toolName);
    if (!approval) return false;

    this.globalApprovals.delete(toolName);
    this.log(`Removed global approval: ${toolName}`);

    this.emitEvent({
      type: 'approval_removed',
      approval,
      timestamp: Date.now(),
    });

    return true;
  }

  /**
   * Clear all approvals for a session.
   */
  clearSessionApprovals(sessionId: string): void {
    this.sessionApprovals.delete(sessionId);
    this.log(`Cleared all session approvals for ${sessionId}`);

    this.emitEvent({
      type: 'approvals_cleared',
      sessionId,
      timestamp: Date.now(),
    });
  }

  /**
   * Clear all folder approvals.
   */
  clearFolderApprovals(): void {
    this.folderApprovals.clear();
    this.log(`Cleared all folder approvals`);

    this.emitEvent({
      type: 'approvals_cleared',
      timestamp: Date.now(),
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Query Methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get all approvals for a session.
   */
  getSessionApprovals(sessionId: string): Approval[] {
    const sessionMap = this.sessionApprovals.get(sessionId);
    if (!sessionMap) return [];
    return Array.from(sessionMap.values());
  }

  /**
   * Get all folder approvals.
   */
  getFolderApprovals(): Approval[] {
    const approvals: Approval[] = [];
    for (const folderMap of this.folderApprovals.values()) {
      approvals.push(...folderMap.values());
    }
    return approvals;
  }

  /**
   * Get all global approvals.
   */
  getGlobalApprovals(): Approval[] {
    return Array.from(this.globalApprovals.values());
  }

  /**
   * Get all approvals.
   */
  getAllApprovals(): Approval[] {
    const approvals: Approval[] = [];

    // Global
    approvals.push(...this.globalApprovals.values());

    // Session
    for (const sessionMap of this.sessionApprovals.values()) {
      approvals.push(...sessionMap.values());
    }

    // Folder
    for (const folderMap of this.folderApprovals.values()) {
      approvals.push(...folderMap.values());
    }

    return approvals;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Serialization
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Export approvals for persistence.
   * Only exports folder and global approvals (session approvals are transient).
   */
  exportApprovals(): { folder: Approval[]; global: Approval[] } {
    return {
      folder: this.getFolderApprovals(),
      global: this.getGlobalApprovals().filter(
        a => !PermissionService.DEFAULT_AUTO_APPROVED.includes(a.toolName)
      ),
    };
  }

  /**
   * Import approvals from persistence.
   */
  importApprovals(data: { folder?: Approval[]; global?: Approval[] }): void {
    if (data.folder) {
      for (const approval of data.folder) {
        if (approval.folderPath) {
          this.addFolderApproval(
            approval.folderPath,
            approval.toolName,
            approval.description,
            approval.expiresAt
          );
        }
      }
    }

    if (data.global) {
      for (const approval of data.global) {
        this.addGlobalApproval(approval.toolName, approval.description);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Events
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Subscribe to permission events.
   */
  onEvent(callback: PermissionEventCallback): () => void {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  /**
   * Emit a permission event.
   */
  private emitEvent(event: PermissionEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        this.log(`Error in event listener: ${error}`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton Instance
// ─────────────────────────────────────────────────────────────────────────────

/** Global permission service instance */
let permissionServiceInstance: PermissionService | null = null;

/**
 * Get the global permission service instance.
 */
export function getPermissionService(): PermissionService {
  if (!permissionServiceInstance) {
    permissionServiceInstance = new PermissionService();
  }
  return permissionServiceInstance;
}

/**
 * Reset the permission service (for testing).
 */
export function resetPermissionService(): void {
  permissionServiceInstance = null;
}
