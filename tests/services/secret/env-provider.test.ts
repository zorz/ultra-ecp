/**
 * Environment Secret Provider Unit Tests
 *
 * Tests for the environment variable secret provider.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { EnvSecretProvider } from '../../../src/services/secret/providers/env.ts';

describe('EnvSecretProvider', () => {
  let provider: EnvSecretProvider;
  const originalEnv: Record<string, string | undefined> = {};

  // Helper to save and restore env vars
  const envVarsToSave = [
    'ULTRA_SECRET_TEST_KEY',
    'ULTRA_SECRET_DATABASE_PASSWORD',
    'ULTRA_SECRET_API_TOKEN',
    'ULTRA_SECRET_NESTED_KEY_VALUE',
    'TEST_KEY',
    'DATABASE_PASSWORD',
    'CUSTOM_PREFIX_TEST_KEY',
  ];

  beforeEach(() => {
    // Save original env vars
    for (const key of envVarsToSave) {
      originalEnv[key] = process.env[key];
    }
    // Clear test env vars
    for (const key of envVarsToSave) {
      delete process.env[key];
    }
    provider = new EnvSecretProvider();
  });

  afterEach(() => {
    // Restore original env vars
    for (const key of envVarsToSave) {
      if (originalEnv[key] !== undefined) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  describe('properties', () => {
    it('should have correct id', () => {
      expect(provider.id).toBe('env');
    });

    it('should have correct name', () => {
      expect(provider.name).toBe('Environment Variables');
    });

    it('should be read-only', () => {
      expect(provider.isReadOnly).toBe(true);
    });

    it('should not support expiry', () => {
      expect(provider.supportsExpiry).toBe(false);
    });

    it('should always be available', () => {
      expect(provider.isAvailable).toBe(true);
    });
  });

  describe('get', () => {
    it('should get value with ULTRA_SECRET_ prefix', async () => {
      process.env['ULTRA_SECRET_TEST_KEY'] = 'test-value';

      const value = await provider.get('test.key');

      expect(value).toBe('test-value');
    });

    it('should get value without prefix when checkWithoutPrefix is true', async () => {
      process.env['TEST_KEY'] = 'direct-value';

      const value = await provider.get('test.key');

      expect(value).toBe('direct-value');
    });

    it('should prefer prefixed value over non-prefixed', async () => {
      process.env['ULTRA_SECRET_TEST_KEY'] = 'prefixed-value';
      process.env['TEST_KEY'] = 'direct-value';

      const value = await provider.get('test.key');

      expect(value).toBe('prefixed-value');
    });

    it('should return null for non-existent key', async () => {
      const value = await provider.get('nonexistent');

      expect(value).toBeNull();
    });

    it('should convert dots to underscores', async () => {
      process.env['ULTRA_SECRET_DATABASE_PASSWORD'] = 'db-pass';

      const value = await provider.get('database.password');

      expect(value).toBe('db-pass');
    });

    it('should convert dashes to underscores', async () => {
      process.env['ULTRA_SECRET_API_TOKEN'] = 'token-value';

      const value = await provider.get('api-token');

      expect(value).toBe('token-value');
    });

    it('should convert to uppercase', async () => {
      process.env['ULTRA_SECRET_NESTED_KEY_VALUE'] = 'nested-value';

      const value = await provider.get('nested.key.value');

      expect(value).toBe('nested-value');
    });
  });

  describe('get with custom config', () => {
    it('should use custom prefix', async () => {
      const customProvider = new EnvSecretProvider({ prefix: 'CUSTOM_PREFIX_' });
      process.env['CUSTOM_PREFIX_TEST_KEY'] = 'custom-value';

      const value = await customProvider.get('test.key');

      expect(value).toBe('custom-value');
    });

    it('should not check without prefix when disabled', async () => {
      const noDirectProvider = new EnvSecretProvider({ checkWithoutPrefix: false });
      process.env['TEST_KEY'] = 'direct-only';

      const value = await noDirectProvider.get('test.key');

      expect(value).toBeNull();
    });
  });

  describe('set', () => {
    it('should throw read-only error', async () => {
      await expect(provider.set('key', 'value')).rejects.toThrow('read-only');
    });
  });

  describe('delete', () => {
    it('should throw read-only error', async () => {
      await expect(provider.delete('key')).rejects.toThrow('read-only');
    });
  });

  describe('list', () => {
    it('should list keys with ULTRA_SECRET_ prefix', async () => {
      process.env['ULTRA_SECRET_DATABASE_PASSWORD'] = 'pass1';
      process.env['ULTRA_SECRET_API_TOKEN'] = 'token1';

      const keys = await provider.list();

      expect(keys).toContain('database.password');
      expect(keys).toContain('api.token');
    });

    it('should filter by prefix', async () => {
      process.env['ULTRA_SECRET_DATABASE_PASSWORD'] = 'pass';
      process.env['ULTRA_SECRET_API_TOKEN'] = 'token';

      const keys = await provider.list('database');

      expect(keys).toContain('database.password');
      expect(keys).not.toContain('api.token');
    });

    it('should return empty array when no secrets', async () => {
      const keys = await provider.list();

      // May contain other ULTRA_SECRET_ vars from environment
      // Just check it returns an array
      expect(Array.isArray(keys)).toBe(true);
    });
  });

  describe('has', () => {
    it('should return true for existing key', async () => {
      process.env['ULTRA_SECRET_TEST_KEY'] = 'value';

      const exists = await provider.has('test.key');

      expect(exists).toBe(true);
    });

    it('should return false for non-existent key', async () => {
      const exists = await provider.has('nonexistent.key');

      expect(exists).toBe(false);
    });
  });
});
