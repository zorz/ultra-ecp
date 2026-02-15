import { describe, expect, test } from 'bun:test';
import { Notifications } from '../../src/protocol/notifications.ts';

describe('Notifications', () => {
  test('has expected top-level namespaces', () => {
    const namespaces = Object.keys(Notifications);
    expect(namespaces).toContain('Auth');
    expect(namespaces).toContain('Server');
    expect(namespaces).toContain('File');
    expect(namespaces).toContain('Terminal');
    expect(namespaces).toContain('Ai');
    expect(namespaces).toContain('Chat');
    expect(namespaces).toContain('Workflow');
    expect(namespaces).toContain('Layout');
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
    checkLeaves(Notifications as unknown as Record<string, unknown>, 'Notifications');
  });

  test('all notification strings contain a slash', () => {
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

    const all = collectLeaves(Notifications as unknown as Record<string, unknown>);
    for (const name of all) {
      expect(name).toContain('/');
    }
  });

  test('no duplicate notification strings', () => {
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

    const all = collectLeaves(Notifications as unknown as Record<string, unknown>);
    const unique = new Set(all);
    expect(unique.size).toBe(all.length);
  });

  test('core notification values match expected strings', () => {
    expect(Notifications.Auth.Required).toBe('auth/required');
    expect(Notifications.Server.Connected).toBe('server/connected');
    expect(Notifications.File.DidChange).toBe('file/didChange');
    expect(Notifications.File.DidCreate).toBe('file/didCreate');
    expect(Notifications.File.DidDelete).toBe('file/didDelete');
    expect(Notifications.Terminal.Output).toBe('terminal/output');
    expect(Notifications.Ai.StreamEvent).toBe('ai/stream/event');
    expect(Notifications.Chat.Activity).toBe('chat/activity');
  });

  test('workflow has execution lifecycle events', () => {
    expect(Notifications.Workflow.Execution.Started).toBe('workflow/execution/started');
    expect(Notifications.Workflow.Execution.Completed).toBe('workflow/execution/completed');
    expect(Notifications.Workflow.Execution.Failed).toBe('workflow/execution/failed');
    expect(Notifications.Workflow.Execution.Cancelled).toBe('workflow/execution/cancelled');
  });
});
