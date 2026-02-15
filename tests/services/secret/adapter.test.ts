/**
 * Secret Service Adapter Unit Tests
 *
 * Tests for the ECP adapter that maps JSON-RPC methods to SecretService operations.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { SecretServiceAdapter } from '../../../src/services/secret/adapter.ts';
import type { SecretService } from '../../../src/services/secret/interface.ts';
import type { SecretInfo, SecretProvider, SecretChangeCallback, Unsubscribe } from '../../../src/services/secret/types.ts';

/**
 * Create a mock SecretService for testing the adapter.
 */
function createMockSecretService(): SecretService & {
  storage: Map<string, { value: string; info?: SecretInfo }>;
  providers: Array<{ id: string; name: string; priority: number; isReadOnly: boolean }>;
} {
  const storage = new Map<string, { value: string; info?: SecretInfo }>();
  const providers = [
    { id: 'mock', name: 'Mock Provider', priority: 10, isReadOnly: false },
  ];

  return {
    storage,
    providers,

    async get(key: string): Promise<string | null> {
      const entry = storage.get(key);
      return entry?.value ?? null;
    },

    async set(key: string, value: string): Promise<void> {
      storage.set(key, {
        value,
        info: {
          key,
          provider: 'mock',
          createdAt: new Date(),
        },
      });
    },

    async delete(key: string): Promise<boolean> {
      return storage.delete(key);
    },

    async list(prefix?: string): Promise<string[]> {
      const keys = Array.from(storage.keys());
      if (prefix) {
        return keys.filter((k) => k.startsWith(prefix));
      }
      return keys;
    },

    async has(key: string): Promise<boolean> {
      return storage.has(key);
    },

    async getInfo(key: string): Promise<SecretInfo | null> {
      const entry = storage.get(key);
      return entry?.info ?? null;
    },

    addProvider(_provider: SecretProvider, _priority: number): void {
      // Mock implementation
    },

    removeProvider(_providerId: string): boolean {
      return false;
    },

    getProviders() {
      return providers;
    },

    getProvider(_providerId: string): SecretProvider | null {
      return null;
    },

    onChange(_callback: SecretChangeCallback): Unsubscribe {
      return () => {};
    },

    async init(): Promise<void> {},

    async shutdown(): Promise<void> {},
  };
}

describe('SecretServiceAdapter', () => {
  let adapter: SecretServiceAdapter;
  let mockService: ReturnType<typeof createMockSecretService>;

  beforeEach(() => {
    mockService = createMockSecretService();
    adapter = new SecretServiceAdapter(mockService);
  });

  describe('getMethods', () => {
    it('should return all supported methods', () => {
      const methods = adapter.getMethods();

      expect(methods).toContain('secret/get');
      expect(methods).toContain('secret/set');
      expect(methods).toContain('secret/delete');
      expect(methods).toContain('secret/list');
      expect(methods).toContain('secret/has');
      expect(methods).toContain('secret/info');
      expect(methods).toContain('secret/providers');
    });
  });

  describe('handleRequest', () => {
    describe('secret/get', () => {
      it('should return value for existing key', async () => {
        mockService.storage.set('test.key', { value: 'test-value' });

        const result = await adapter.handleRequest('secret/get', { key: 'test.key' });

        expect(result).toEqual({ value: 'test-value' });
      });

      it('should return null for non-existent key', async () => {
        const result = await adapter.handleRequest('secret/get', { key: 'nonexistent' });

        expect(result).toEqual({ value: null });
      });
    });

    describe('secret/set', () => {
      it('should store secret', async () => {
        const result = await adapter.handleRequest('secret/set', {
          key: 'new.key',
          value: 'new-value',
        });

        expect(result).toEqual({ success: true });
        expect(mockService.storage.get('new.key')?.value).toBe('new-value');
      });

      it('should accept options', async () => {
        const result = await adapter.handleRequest('secret/set', {
          key: 'key.with.options',
          value: 'value',
          options: {
            description: 'Test description',
            expiresAt: '2025-12-31T23:59:59Z',
          },
        });

        expect(result).toEqual({ success: true });
      });
    });

    describe('secret/delete', () => {
      it('should delete existing key', async () => {
        mockService.storage.set('to.delete', { value: 'value' });

        const result = await adapter.handleRequest('secret/delete', { key: 'to.delete' });

        expect(result).toEqual({ deleted: true });
        expect(mockService.storage.has('to.delete')).toBe(false);
      });

      it('should return false for non-existent key', async () => {
        const result = await adapter.handleRequest('secret/delete', { key: 'nonexistent' });

        expect(result).toEqual({ deleted: false });
      });
    });

    describe('secret/list', () => {
      it('should list all keys', async () => {
        mockService.storage.set('key1', { value: 'value1' });
        mockService.storage.set('key2', { value: 'value2' });

        const result = await adapter.handleRequest('secret/list', {});

        expect(result).toEqual({ keys: ['key1', 'key2'] });
      });

      it('should filter by prefix', async () => {
        mockService.storage.set('api.key', { value: 'value1' });
        mockService.storage.set('db.key', { value: 'value2' });

        const result = await adapter.handleRequest('secret/list', { prefix: 'api' });

        expect(result).toEqual({ keys: ['api.key'] });
      });

      it('should return empty array when no keys', async () => {
        const result = await adapter.handleRequest('secret/list', {});

        expect(result).toEqual({ keys: [] });
      });
    });

    describe('secret/has', () => {
      it('should return true for existing key', async () => {
        mockService.storage.set('existing', { value: 'value' });

        const result = await adapter.handleRequest('secret/has', { key: 'existing' });

        expect(result).toEqual({ exists: true });
      });

      it('should return false for non-existent key', async () => {
        const result = await adapter.handleRequest('secret/has', { key: 'nonexistent' });

        expect(result).toEqual({ exists: false });
      });
    });

    describe('secret/info', () => {
      it('should return info for existing key', async () => {
        const createdAt = new Date('2025-01-01T00:00:00Z');
        mockService.storage.set('test.key', {
          value: 'value',
          info: {
            key: 'test.key',
            provider: 'mock',
            createdAt,
            description: 'Test secret',
          },
        });

        const result = await adapter.handleRequest('secret/info', { key: 'test.key' }) as {
          info: { key: string; provider: string; createdAt?: string; description?: string } | null;
        };

        expect(result.info).not.toBeNull();
        expect(result.info!.key).toBe('test.key');
        expect(result.info!.provider).toBe('mock');
        expect(result.info!.createdAt).toBe('2025-01-01T00:00:00.000Z');
        expect(result.info!.description).toBe('Test secret');
      });

      it('should return null for non-existent key', async () => {
        const result = await adapter.handleRequest('secret/info', { key: 'nonexistent' });

        expect(result).toEqual({ info: null });
      });

      it('should include expiresAt if set', async () => {
        const expiresAt = new Date('2025-12-31T23:59:59Z');
        mockService.storage.set('expiring', {
          value: 'value',
          info: {
            key: 'expiring',
            provider: 'mock',
            expiresAt,
          },
        });

        const result = await adapter.handleRequest('secret/info', { key: 'expiring' }) as {
          info: { expiresAt?: string } | null;
        };

        expect(result.info!.expiresAt).toBe('2025-12-31T23:59:59.000Z');
      });
    });

    describe('secret/providers', () => {
      it('should return list of providers', async () => {
        const result = await adapter.handleRequest('secret/providers', {});

        expect(result).toEqual({
          providers: [
            { id: 'mock', name: 'Mock Provider', priority: 10, isReadOnly: false },
          ],
        });
      });
    });

    describe('unknown method', () => {
      it('should throw for unknown method', async () => {
        await expect(adapter.handleRequest('secret/unknown', {})).rejects.toThrow('Unknown method');
      });
    });
  });
});
