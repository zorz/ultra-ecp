/**
 * Permission Service Unit Tests
 *
 * Tests for AI tool use permission management.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  PermissionService,
  getPermissionService,
  resetPermissionService,
  type PermissionEvent,
} from '../../../src/services/ai/permissions.ts';

describe('PermissionService', () => {
  let service: PermissionService;

  beforeEach(() => {
    resetPermissionService();
    service = new PermissionService();
  });

  afterEach(() => {
    resetPermissionService();
  });

  describe('construction', () => {
    it('should have default auto-approved tools', () => {
      const globalApprovals = service.getGlobalApprovals();
      const toolNames = globalApprovals.map((a) => a.toolName);

      // Read-only file tools
      expect(toolNames).toContain('Read');
      expect(toolNames).toContain('Glob');
      expect(toolNames).toContain('Grep');
      expect(toolNames).toContain('LS');
      expect(toolNames).toContain('LSP');
      // Todo CRUD
      expect(toolNames).toContain('TodoWrite');
      expect(toolNames).toContain('TodoRead');
      // Plan CRUD
      expect(toolNames).toContain('PlanCreate');
      expect(toolNames).toContain('PlanUpdate');
      expect(toolNames).toContain('PlanRead');
      expect(toolNames).toContain('PlanGet');
      // Spec CRUD
      expect(toolNames).toContain('SpecCreate');
      expect(toolNames).toContain('SpecRead');
      expect(toolNames).toContain('SpecUpdate');
      // Document CRUD
      expect(toolNames).toContain('DocumentCreate');
      expect(toolNames).toContain('DocumentUpdate');
      expect(toolNames).toContain('DocumentList');
      expect(toolNames).toContain('DocumentGet');
      expect(toolNames).toContain('DocumentSearch');
      // Chat history search
      expect(toolNames).toContain('SearchChatHistory');
    });
  });

  describe('checkPermission', () => {
    it('should allow globally approved tools', () => {
      const result = service.checkPermission({
        toolName: 'Read',
        sessionId: 'session-123',
      });

      expect(result.allowed).toBe(true);
      expect(result.approval).toBeDefined();
      expect(result.approval!.scope).toBe('global');
    });

    it('should deny non-approved tools', () => {
      const result = service.checkPermission({
        toolName: 'Bash',
        sessionId: 'session-123',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it('should allow session-approved tools', () => {
      service.addSessionApproval('session-123', 'Bash');

      const result = service.checkPermission({
        toolName: 'Bash',
        sessionId: 'session-123',
      });

      expect(result.allowed).toBe(true);
      expect(result.approval!.scope).toBe('session');
    });

    it('should not allow session approval for different session', () => {
      service.addSessionApproval('session-123', 'Bash');

      const result = service.checkPermission({
        toolName: 'Bash',
        sessionId: 'session-456',
      });

      expect(result.allowed).toBe(false);
    });

    it('should allow folder-approved tools', () => {
      service.addFolderApproval('/home/user/project', 'Edit');

      const result = service.checkPermission({
        toolName: 'Edit',
        sessionId: 'session-123',
        targetPath: '/home/user/project/src/file.ts',
      });

      expect(result.allowed).toBe(true);
      expect(result.approval!.scope).toBe('folder');
    });

    it('should not allow folder approval for different folder', () => {
      service.addFolderApproval('/home/user/project', 'Edit');

      const result = service.checkPermission({
        toolName: 'Edit',
        sessionId: 'session-123',
        targetPath: '/home/other/file.ts',
      });

      expect(result.allowed).toBe(false);
    });

    it('should handle expired session approvals', async () => {
      // Add approval that expires in 10ms
      service.addSessionApproval('session-123', 'Bash', undefined, Date.now() + 10);

      // Should be allowed immediately
      let result = service.checkPermission({
        toolName: 'Bash',
        sessionId: 'session-123',
      });
      expect(result.allowed).toBe(true);

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Should be denied after expiration
      result = service.checkPermission({
        toolName: 'Bash',
        sessionId: 'session-123',
      });
      expect(result.allowed).toBe(false);
    });
  });

  describe('addSessionApproval', () => {
    it('should add session approval', () => {
      const approval = service.addSessionApproval('session-123', 'Write', 'Write files');

      expect(approval.toolName).toBe('Write');
      expect(approval.scope).toBe('session');
      expect(approval.sessionId).toBe('session-123');
      expect(approval.description).toBe('Write files');
    });

    it('should override existing approval for same tool', () => {
      service.addSessionApproval('session-123', 'Bash', 'First');
      service.addSessionApproval('session-123', 'Bash', 'Second');

      const approvals = service.getSessionApprovals('session-123');
      expect(approvals.length).toBe(1);
      expect(approvals[0]!.description).toBe('Second');
    });
  });

  describe('addFolderApproval', () => {
    it('should add folder approval', () => {
      const approval = service.addFolderApproval('/project', 'Edit', 'Edit project files');

      expect(approval.toolName).toBe('Edit');
      expect(approval.scope).toBe('folder');
      expect(approval.folderPath).toBe('/project');
    });

    it('should normalize folder paths', () => {
      service.addFolderApproval('/project/', 'Edit');

      // Should match with or without trailing slash
      const result = service.checkPermission({
        toolName: 'Edit',
        sessionId: 'session-123',
        targetPath: '/project/file.ts',
      });

      expect(result.allowed).toBe(true);
    });
  });

  describe('addGlobalApproval', () => {
    it('should add global approval', () => {
      const approval = service.addGlobalApproval('CustomTool', 'Custom tool');

      expect(approval.toolName).toBe('CustomTool');
      expect(approval.scope).toBe('global');
    });

    it('should make tool always approved', () => {
      service.addGlobalApproval('AlwaysOK');

      const result = service.checkPermission({
        toolName: 'AlwaysOK',
        sessionId: 'any-session',
      });

      expect(result.allowed).toBe(true);
    });
  });

  describe('removeSessionApproval', () => {
    it('should remove session approval', () => {
      service.addSessionApproval('session-123', 'Bash');

      const removed = service.removeSessionApproval('session-123', 'Bash');

      expect(removed).toBe(true);

      const result = service.checkPermission({
        toolName: 'Bash',
        sessionId: 'session-123',
      });
      expect(result.allowed).toBe(false);
    });

    it('should return false for non-existent approval', () => {
      const removed = service.removeSessionApproval('session-123', 'NonExistent');

      expect(removed).toBe(false);
    });
  });

  describe('removeFolderApproval', () => {
    it('should remove folder approval', () => {
      service.addFolderApproval('/project', 'Edit');

      const removed = service.removeFolderApproval('/project', 'Edit');

      expect(removed).toBe(true);
    });

    it('should return false for non-existent approval', () => {
      const removed = service.removeFolderApproval('/nonexistent', 'Edit');

      expect(removed).toBe(false);
    });
  });

  describe('removeGlobalApproval', () => {
    it('should remove global approval', () => {
      service.addGlobalApproval('CustomTool');

      const removed = service.removeGlobalApproval('CustomTool');

      expect(removed).toBe(true);

      const result = service.checkPermission({
        toolName: 'CustomTool',
        sessionId: 'session-123',
      });
      expect(result.allowed).toBe(false);
    });
  });

  describe('clearSessionApprovals', () => {
    it('should clear all session approvals', () => {
      service.addSessionApproval('session-123', 'Bash');
      service.addSessionApproval('session-123', 'Write');

      service.clearSessionApprovals('session-123');

      const approvals = service.getSessionApprovals('session-123');
      expect(approvals.length).toBe(0);
    });
  });

  describe('clearFolderApprovals', () => {
    it('should clear all folder approvals', () => {
      service.addFolderApproval('/project1', 'Edit');
      service.addFolderApproval('/project2', 'Write');

      service.clearFolderApprovals();

      const approvals = service.getFolderApprovals();
      expect(approvals.length).toBe(0);
    });
  });

  describe('query methods', () => {
    it('should get session approvals', () => {
      service.addSessionApproval('session-123', 'Bash');
      service.addSessionApproval('session-123', 'Write');

      const approvals = service.getSessionApprovals('session-123');

      expect(approvals.length).toBe(2);
    });

    it('should get folder approvals', () => {
      service.addFolderApproval('/project', 'Edit');

      const approvals = service.getFolderApprovals();

      expect(approvals.length).toBe(1);
      expect(approvals[0]!.toolName).toBe('Edit');
    });

    it('should get global approvals', () => {
      const approvals = service.getGlobalApprovals();

      // Should include all 20 default auto-approved tools
      expect(approvals.length).toBeGreaterThanOrEqual(20);
    });

    it('should get all approvals', () => {
      service.addSessionApproval('session-123', 'Bash');
      service.addFolderApproval('/project', 'Edit');

      const allApprovals = service.getAllApprovals();

      // Should include global (20) + session (1) + folder (1) approvals
      expect(allApprovals.length).toBeGreaterThanOrEqual(22);
    });
  });

  describe('serialization', () => {
    it('should export approvals', () => {
      service.addFolderApproval('/project', 'Edit');
      service.addGlobalApproval('CustomTool');

      const exported = service.exportApprovals();

      expect(exported.folder.length).toBe(1);
      // Should not include default auto-approved tools
      expect(exported.global.length).toBe(1);
      expect(exported.global[0]!.toolName).toBe('CustomTool');
    });

    it('should import approvals', () => {
      const data = {
        folder: [
          {
            toolName: 'Edit',
            scope: 'folder' as const,
            folderPath: '/imported',
            grantedAt: Date.now(),
          },
        ],
        global: [
          {
            toolName: 'ImportedTool',
            scope: 'global' as const,
            grantedAt: Date.now(),
          },
        ],
      };

      service.importApprovals(data);

      const folderApprovals = service.getFolderApprovals();
      expect(folderApprovals.some((a) => a.folderPath === '/imported')).toBe(true);

      const result = service.checkPermission({
        toolName: 'ImportedTool',
        sessionId: 'session-123',
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe('events', () => {
    it('should emit approval_added event', () => {
      const events: PermissionEvent[] = [];
      service.onEvent((e) => events.push(e));

      service.addSessionApproval('session-123', 'Bash');

      expect(events.length).toBeGreaterThanOrEqual(1);
      const addEvent = events.find((e) => e.type === 'approval_added' && e.approval?.toolName === 'Bash');
      expect(addEvent).toBeDefined();
    });

    it('should emit approval_removed event', () => {
      service.addSessionApproval('session-123', 'Bash');

      const events: PermissionEvent[] = [];
      service.onEvent((e) => events.push(e));

      service.removeSessionApproval('session-123', 'Bash');

      const removeEvent = events.find((e) => e.type === 'approval_removed');
      expect(removeEvent).toBeDefined();
    });

    it('should emit approvals_cleared event', () => {
      service.addSessionApproval('session-123', 'Bash');

      const events: PermissionEvent[] = [];
      service.onEvent((e) => events.push(e));

      service.clearSessionApprovals('session-123');

      const clearEvent = events.find((e) => e.type === 'approvals_cleared');
      expect(clearEvent).toBeDefined();
    });

    it('should allow unsubscribing from events', () => {
      const events: PermissionEvent[] = [];
      const unsubscribe = service.onEvent((e) => events.push(e));

      service.addSessionApproval('session-1', 'Bash');
      unsubscribe();
      service.addSessionApproval('session-2', 'Write');

      // Should only have events from before unsubscribe
      const bashEvents = events.filter((e) => e.approval?.toolName === 'Bash');
      const writeEvents = events.filter((e) => e.approval?.toolName === 'Write');

      expect(bashEvents.length).toBeGreaterThan(0);
      expect(writeEvents.length).toBe(0);
    });
  });

  describe('singleton', () => {
    it('should return same instance', () => {
      resetPermissionService();

      const instance1 = getPermissionService();
      const instance2 = getPermissionService();

      expect(instance1).toBe(instance2);
    });

    it('should reset instance', () => {
      const instance1 = getPermissionService();
      instance1.addSessionApproval('session-123', 'Bash');

      resetPermissionService();

      const instance2 = getPermissionService();

      // Should be a new instance
      expect(instance1).not.toBe(instance2);

      // Should not have the approval from old instance
      const approvals = instance2.getSessionApprovals('session-123');
      expect(approvals.length).toBe(0);
    });
  });
});
