/**
 * File Service Adapter Security Tests
 *
 * Tests for workspace root path validation and traversal protection.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { FileServiceAdapter } from '../../../src/services/file/adapter';
import { FileServiceImpl } from '../../../src/services/file/service';
import { FileErrorCode } from '../../../src/services/file/errors';

describe('FileServiceAdapter Security', () => {
  let adapter: FileServiceAdapter;
  let service: FileServiceImpl;

  beforeEach(() => {
    service = new FileServiceImpl();
    adapter = new FileServiceAdapter(service, '/workspace/project');
  });

  describe('Path Traversal Protection', () => {
    it('should reject path traversal attempts with ..', async () => {
      const request = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'file/read',
        params: { uri: 'file:///workspace/project/../../../etc/passwd' },
      };

      const response = await adapter.handleRequest(request);
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32101); // ACCESS_DENIED
      expect(response.error?.message).toContain('outside workspace root');
    });

    it('should reject absolute paths outside workspace', async () => {
      const request = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'file/read',
        params: { uri: 'file:///etc/passwd' },
      };

      const response = await adapter.handleRequest(request);
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32101); // ACCESS_DENIED
    });

    it('should allow paths within workspace', async () => {
      // This will fail with NOT_FOUND since the file doesn't exist,
      // but it should NOT fail with ACCESS_DENIED
      const request = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'file/read',
        params: { uri: 'file:///workspace/project/src/test.ts' },
      };

      const response = await adapter.handleRequest(request);
      // Should get NOT_FOUND, not ACCESS_DENIED
      if (response.error) {
        expect(response.error.code).not.toBe(-32101);
      }
    });

    it('should validate both source and target in copy operations', async () => {
      const request = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'file/copy',
        params: {
          sourceUri: 'file:///workspace/project/src/file.ts',
          targetUri: 'file:///tmp/stolen-file.ts',
        },
      };

      const response = await adapter.handleRequest(request);
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32101); // ACCESS_DENIED
    });

    it('should validate both source and target in rename operations', async () => {
      const request = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'file/rename',
        params: {
          oldUri: 'file:///etc/passwd',
          newUri: 'file:///workspace/project/passwd-copy',
        },
      };

      const response = await adapter.handleRequest(request);
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32101); // ACCESS_DENIED
    });
  });

  describe('Workspace Root Configuration', () => {
    it('should deny all paths when no workspace root is set', async () => {
      const unrestrictedAdapter = new FileServiceAdapter(service);

      const request = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'file/stat',
        params: { uri: 'file:///etc/passwd' },
      };

      const response = await unrestrictedAdapter.handleRequest(request);
      // Should get ACCESS_DENIED when no workspace root is configured
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32101);
    });

    it('should support setting workspace root after construction', async () => {
      const adapter = new FileServiceAdapter(service);
      adapter.setWorkspaceRoot('/restricted/path');

      const request = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'file/read',
        params: { uri: 'file:///etc/passwd' },
      };

      const response = await adapter.handleRequest(request);
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32101); // ACCESS_DENIED
    });
  });

  describe('Directory Operations', () => {
    it('should validate path in readDir', async () => {
      const request = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'file/readDir',
        params: { uri: 'file:///etc' },
      };

      const response = await adapter.handleRequest(request);
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32101); // ACCESS_DENIED
    });

    it('should validate path in createDir', async () => {
      const request = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'file/createDir',
        params: { uri: 'file:///tmp/malicious-dir' },
      };

      const response = await adapter.handleRequest(request);
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32101); // ACCESS_DENIED
    });

    it('should validate path in deleteDir', async () => {
      const request = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'file/deleteDir',
        params: { uri: 'file:///tmp', recursive: true },
      };

      const response = await adapter.handleRequest(request);
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32101); // ACCESS_DENIED
    });
  });

  describe('Write Operations', () => {
    it('should validate path in write', async () => {
      const request = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'file/write',
        params: {
          uri: 'file:///etc/cron.d/malicious',
          content: '* * * * * root /bin/bad-command',
        },
      };

      const response = await adapter.handleRequest(request);
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32101); // ACCESS_DENIED
    });

    it('should validate path in delete', async () => {
      const request = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'file/delete',
        params: { uri: 'file:///etc/passwd' },
      };

      const response = await adapter.handleRequest(request);
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32101); // ACCESS_DENIED
    });
  });

  describe('Glob Operations', () => {
    it('should validate baseUri in glob', async () => {
      const request = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'file/glob',
        params: {
          pattern: '**/*.ts',
          baseUri: 'file:///etc',
        },
      };

      const response = await adapter.handleRequest(request);
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32101); // ACCESS_DENIED
    });
  });

  describe('Watch Operations', () => {
    it('should validate path in watch', async () => {
      const request = {
        jsonrpc: '2.0' as const,
        id: 1,
        method: 'file/watch',
        params: { uri: 'file:///etc' },
      };

      const response = await adapter.handleRequest(request);
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32101); // ACCESS_DENIED
    });
  });
});
