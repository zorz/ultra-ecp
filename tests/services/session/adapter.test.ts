/**
 * SessionServiceAdapter Unit Tests
 *
 * Tests for the ECP adapter that routes requests to the session service.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { SessionServiceAdapter } from '../../../src/services/session/adapter.ts';
import { LocalSessionService } from '../../../src/services/session/local.ts';

describe('SessionServiceAdapter', () => {
  let service: LocalSessionService;
  let adapter: SessionServiceAdapter;

  beforeEach(async () => {
    service = new LocalSessionService();
    await service.init('/test/workspace');
    adapter = new SessionServiceAdapter(service);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Commands
  // ─────────────────────────────────────────────────────────────────────────

  describe('commands/list', () => {
    test('returns command registry', async () => {
      const result = await adapter.handleRequest('commands/list', {});

      expect('result' in result).toBe(true);
      if ('result' in result) {
        const { commands } = result.result as { commands: Record<string, unknown> };
        expect(commands).toBeDefined();
        expect(typeof commands).toBe('object');
      }
    });

    test('includes file.save command', async () => {
      const result = await adapter.handleRequest('commands/list', {});

      expect('result' in result).toBe(true);
      if ('result' in result) {
        const { commands } = result.result as { commands: Record<string, { label: string; category: string }> };
        expect(commands['file.save']).toBeDefined();
        expect(commands['file.save'].label).toBe('Save');
        expect(commands['file.save'].category).toBe('File');
      }
    });

    test('includes git commands', async () => {
      const result = await adapter.handleRequest('commands/list', {});

      expect('result' in result).toBe(true);
      if ('result' in result) {
        const { commands } = result.result as { commands: Record<string, { label: string; category: string }> };
        expect(commands['git.push']).toBeDefined();
        expect(commands['git.pull']).toBeDefined();
        expect(commands['git.commit']).toBeDefined();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Keybindings
  // ─────────────────────────────────────────────────────────────────────────

  describe('keybindings/get', () => {
    test('returns keybindings array', async () => {
      const result = await adapter.handleRequest('keybindings/get', {});

      expect('result' in result).toBe(true);
      if ('result' in result) {
        const { bindings } = result.result as { bindings: unknown[] };
        expect(Array.isArray(bindings)).toBe(true);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Config
  // ─────────────────────────────────────────────────────────────────────────

  describe('config/getAll', () => {
    test('returns all settings', async () => {
      const result = await adapter.handleRequest('config/getAll', {});

      expect('result' in result).toBe(true);
      if ('result' in result) {
        const { settings } = result.result as { settings: Record<string, unknown> };
        expect(settings).toBeDefined();
        expect(settings['editor.fontSize']).toBeDefined();
      }
    });
  });

  describe('config/get', () => {
    test('returns specific setting', async () => {
      const result = await adapter.handleRequest('config/get', { key: 'editor.fontSize' });

      expect('result' in result).toBe(true);
      if ('result' in result) {
        const { value } = result.result as { value: number };
        expect(typeof value).toBe('number');
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Theme
  // ─────────────────────────────────────────────────────────────────────────

  describe('theme/list', () => {
    test('returns themes array', async () => {
      const result = await adapter.handleRequest('theme/list', {});

      expect('result' in result).toBe(true);
      if ('result' in result) {
        const { themes } = result.result as { themes: unknown[] };
        expect(Array.isArray(themes)).toBe(true);
        expect(themes.length).toBeGreaterThan(0);
      }
    });
  });

  describe('theme/current', () => {
    test('returns current theme', async () => {
      const result = await adapter.handleRequest('theme/current', {});

      expect('result' in result).toBe(true);
      if ('result' in result) {
        const { theme } = result.result as { theme: { name: string; type: string } };
        expect(theme).toBeDefined();
        expect(theme.name).toBeDefined();
        expect(theme.type).toBeDefined();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Workspace
  // ─────────────────────────────────────────────────────────────────────────

  describe('workspace/getRoot', () => {
    test('returns workspace root', async () => {
      const result = await adapter.handleRequest('workspace/getRoot', {});

      expect('result' in result).toBe(true);
      if ('result' in result) {
        const { path } = result.result as { path: string | null };
        expect(path).toBe('/test/workspace');
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Error Handling
  // ─────────────────────────────────────────────────────────────────────────

  describe('error handling', () => {
    test('returns method not found for unknown method', async () => {
      const result = await adapter.handleRequest('unknown/method', {});

      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error.code).toBe(-32601); // MethodNotFound
      }
    });
  });
});
