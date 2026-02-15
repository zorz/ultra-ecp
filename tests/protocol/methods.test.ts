import { describe, expect, test } from 'bun:test';
import { Methods } from '../../src/protocol/methods.ts';

describe('Methods', () => {
  test('has expected top-level namespaces', () => {
    const namespaces = Object.keys(Methods);
    expect(namespaces).toContain('Document');
    expect(namespaces).toContain('File');
    expect(namespaces).toContain('Git');
    expect(namespaces).toContain('Ai');
    expect(namespaces).toContain('Chat');
    expect(namespaces).toContain('Workflow');
    expect(namespaces).toContain('Agent');
    expect(namespaces).toContain('Terminal');
    expect(namespaces).toContain('Lsp');
    expect(namespaces).toContain('Config');
    expect(namespaces).toContain('Session');
    expect(namespaces).toContain('Theme');
    expect(namespaces).toContain('Layout');
    expect(namespaces).toContain('Shell');
    expect(namespaces).toContain('Models');
    expect(namespaces).toContain('Auth');
  });

  test('all leaf values are strings', () => {
    function checkLeaves(obj: Record<string, unknown>, path: string) {
      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'object' && value !== null) {
          checkLeaves(value as Record<string, unknown>, `${path}.${key}`);
        } else {
          expect(typeof value).toBe('string');
        }
      }
    }
    checkLeaves(Methods as unknown as Record<string, unknown>, 'Methods');
  });

  test('all method strings contain a slash', () => {
    function collectLeaves(obj: Record<string, unknown>): string[] {
      const leaves: string[] = [];
      for (const value of Object.values(obj)) {
        if (typeof value === 'string') {
          leaves.push(value);
        } else if (typeof value === 'object' && value !== null) {
          leaves.push(...collectLeaves(value as Record<string, unknown>));
        }
      }
      return leaves;
    }

    const all = collectLeaves(Methods as unknown as Record<string, unknown>);
    for (const method of all) {
      expect(method).toContain('/');
    }
  });

  test('no duplicate method strings', () => {
    function collectLeaves(obj: Record<string, unknown>): string[] {
      const leaves: string[] = [];
      for (const value of Object.values(obj)) {
        if (typeof value === 'string') {
          leaves.push(value);
        } else if (typeof value === 'object' && value !== null) {
          leaves.push(...collectLeaves(value as Record<string, unknown>));
        }
      }
      return leaves;
    }

    const all = collectLeaves(Methods as unknown as Record<string, unknown>);
    const unique = new Set(all);
    expect(unique.size).toBe(all.length);
  });

  test('namespace prefix matches method prefix', () => {
    const prefixMap: Record<string, string> = {
      Document: 'document/',
      File: 'file/',
      Git: 'git/',
      Config: 'config/',
      Session: 'session/',
      Keybindings: 'keybindings/',
      Commands: 'commands/',
      Theme: 'theme/',
      Workspace: 'workspace/',
      SystemPrompt: 'systemPrompt/',
      Terminal: 'terminal/',
      Lsp: 'lsp/',
      Syntax: 'syntax/',
      Secret: 'secret/',
      Database: 'database/',
      Ai: 'ai/',
      Chat: 'chat/',
      Workflow: 'workflow/',
      Agent: 'agent/',
      Auth: 'auth/',
      Models: 'models/',
      Shell: 'shell/',
      Layout: 'layout/',
    };

    for (const [namespace, prefix] of Object.entries(prefixMap)) {
      const ns = (Methods as Record<string, unknown>)[namespace];
      if (!ns || typeof ns !== 'object') continue;

      for (const [key, value] of Object.entries(ns as Record<string, unknown>)) {
        if (typeof value === 'string') {
          expect(value.startsWith(prefix)).toBe(true);
        }
      }
    }
  });

  test('has expected method counts (sanity check)', () => {
    // Just verify some key namespaces have reasonable method counts
    expect(Object.keys(Methods.File).length).toBeGreaterThan(10);
    expect(Object.keys(Methods.Ai).length).toBeGreaterThan(20);
    expect(Object.keys(Methods.Chat).length).toBeGreaterThan(20);
    expect(Object.keys(Methods.Workflow).length).toBeGreaterThan(20);
    expect(Object.keys(Methods.Git).length).toBeGreaterThan(15);
  });
});
