/**
 * Chat Store Tests
 *
 * Tests for SessionStore, MessageStore, PermissionStore, and TodoStore.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTestDatabase, createTestSession, createTestMessage, sleep } from './test-utils.ts';
import { SessionStore } from '../../../src/services/chat/stores/SessionStore.ts';
import { MessageStore } from '../../../src/services/chat/stores/MessageStore.ts';
import { PermissionStore } from '../../../src/services/chat/stores/PermissionStore.ts';
import { TodoStore } from '../../../src/services/chat/stores/TodoStore.ts';

// ─────────────────────────────────────────────────────────────────────────────
// SessionStore Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('SessionStore', () => {
  let db: Database;
  let store: SessionStore;

  beforeEach(() => {
    db = createTestDatabase();
    store = new SessionStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('create', () => {
    it('should create a session with required fields', () => {
      const session = store.create({
        id: 'test-1',
        provider: 'anthropic',
        model: 'claude-opus-4-5',
      });

      expect(session.id).toBe('test-1');
      expect(session.provider).toBe('anthropic');
      expect(session.model).toBe('claude-opus-4-5');
      expect(session.title).toBeNull();
      expect(session.systemPrompt).toBeNull();
      expect(session.createdAt).toBeGreaterThan(0);
      expect(session.updatedAt).toBe(session.createdAt);
    });

    it('should create a session with optional fields', () => {
      const session = store.create({
        id: 'test-2',
        provider: 'openai',
        model: 'gpt-4',
        title: 'My Chat',
        systemPrompt: 'You are helpful.',
      });

      expect(session.title).toBe('My Chat');
      expect(session.systemPrompt).toBe('You are helpful.');
    });
  });

  describe('get', () => {
    it('should return session by ID', () => {
      store.create({ id: 'session-1', provider: 'test', model: 'test' });
      const session = store.get('session-1');

      expect(session).not.toBeNull();
      expect(session?.id).toBe('session-1');
    });

    it('should return null for non-existent session', () => {
      const session = store.get('non-existent');
      expect(session).toBeNull();
    });
  });

  describe('update', () => {
    it('should update session fields', () => {
      store.create({ id: 'session-1', provider: 'test', model: 'test' });
      const updated = store.update('session-1', { title: 'Updated Title' });

      expect(updated?.title).toBe('Updated Title');
      // updatedAt should be >= createdAt (may be same if update happens instantly)
      expect(updated?.updatedAt).toBeGreaterThanOrEqual(updated?.createdAt ?? 0);
    });

    it('should return null for non-existent session', () => {
      const updated = store.update('non-existent', { title: 'Test' });
      expect(updated).toBeNull();
    });

    it('should update model', () => {
      store.create({ id: 'session-1', provider: 'test', model: 'old-model' });
      const updated = store.update('session-1', { model: 'new-model' });
      expect(updated?.model).toBe('new-model');
    });
  });

  describe('delete', () => {
    it('should delete a session and return true', () => {
      store.create({ id: 'session-1', provider: 'test', model: 'test' });
      const deleted = store.delete('session-1');

      expect(deleted).toBe(true);
      expect(store.get('session-1')).toBeNull();
    });

    it('should return false for non-existent session', () => {
      const deleted = store.delete('non-existent');
      expect(deleted).toBe(false);
    });
  });

  describe('list', () => {
    it('should list sessions with message counts', () => {
      const sessionId = createTestSession(db);
      createTestMessage(db, sessionId, { content: 'Hello' });
      createTestMessage(db, sessionId, { content: 'World' });

      const sessions = store.list();

      expect(sessions).toHaveLength(1);
      expect(sessions[0].messageCount).toBe(2);
    });

    it('should filter by provider', () => {
      store.create({ id: 's1', provider: 'anthropic', model: 'claude' });
      store.create({ id: 's2', provider: 'openai', model: 'gpt-4' });

      const sessions = store.list({ provider: 'anthropic' });

      expect(sessions).toHaveLength(1);
      expect(sessions[0].provider).toBe('anthropic');
    });

    it('should paginate results', () => {
      for (let i = 0; i < 10; i++) {
        store.create({ id: `s${i}`, provider: 'test', model: 'test' });
      }

      const page1 = store.list({ limit: 3, offset: 0 });
      const page2 = store.list({ limit: 3, offset: 3 });

      expect(page1).toHaveLength(3);
      expect(page2).toHaveLength(3);
      expect(page1[0].id).not.toBe(page2[0].id);
    });
  });

  describe('exists', () => {
    it('should return true for existing session', () => {
      store.create({ id: 'session-1', provider: 'test', model: 'test' });
      expect(store.exists('session-1')).toBe(true);
    });

    it('should return false for non-existent session', () => {
      expect(store.exists('non-existent')).toBe(false);
    });
  });

  describe('count', () => {
    it('should count all sessions', () => {
      store.create({ id: 's1', provider: 'test', model: 'test' });
      store.create({ id: 's2', provider: 'test', model: 'test' });

      expect(store.count()).toBe(2);
    });

    it('should count sessions by provider', () => {
      store.create({ id: 's1', provider: 'anthropic', model: 'claude' });
      store.create({ id: 's2', provider: 'openai', model: 'gpt-4' });
      store.create({ id: 's3', provider: 'anthropic', model: 'claude' });

      expect(store.count('anthropic')).toBe(2);
      expect(store.count('openai')).toBe(1);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MessageStore Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('MessageStore', () => {
  let db: Database;
  let store: MessageStore;
  let sessionId: string;

  beforeEach(() => {
    db = createTestDatabase();
    store = new MessageStore(db);
    sessionId = createTestSession(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('create', () => {
    it('should create a user message', () => {
      const msg = store.create({
        id: 'msg-1',
        sessionId,
        role: 'user',
        content: 'Hello AI',
      });

      expect(msg.id).toBe('msg-1');
      expect(msg.sessionId).toBe(sessionId);
      expect(msg.role).toBe('user');
      expect(msg.content).toBe('Hello AI');
      expect(msg.createdAt).toBeGreaterThan(0);
    });

    it('should create an assistant message with usage stats', () => {
      const msg = store.create({
        id: 'msg-2',
        sessionId,
        role: 'assistant',
        content: 'Hello human!',
        model: 'claude-opus',
        inputTokens: 10,
        outputTokens: 20,
        durationMs: 500,
      });

      expect(msg.model).toBe('claude-opus');
      expect(msg.inputTokens).toBe(10);
      expect(msg.outputTokens).toBe(20);
      expect(msg.durationMs).toBe(500);
    });
  });

  describe('get', () => {
    it('should return message by ID', () => {
      store.create({ id: 'msg-1', sessionId, role: 'user', content: 'test' });
      const msg = store.get('msg-1');

      expect(msg).not.toBeNull();
      expect(msg?.id).toBe('msg-1');
    });

    it('should return null for non-existent message', () => {
      const msg = store.get('non-existent');
      expect(msg).toBeNull();
    });
  });

  describe('listBySession', () => {
    it('should return messages in chronological order', async () => {
      store.create({ id: 'msg-1', sessionId, role: 'user', content: 'First' });
      await sleep(10);
      store.create({ id: 'msg-2', sessionId, role: 'assistant', content: 'Second' });
      await sleep(10);
      store.create({ id: 'msg-3', sessionId, role: 'user', content: 'Third' });

      const messages = store.listBySession(sessionId);

      expect(messages).toHaveLength(3);
      expect(messages[0].content).toBe('First');
      expect(messages[1].content).toBe('Second');
      expect(messages[2].content).toBe('Third');
    });

    it('should respect limit option', () => {
      for (let i = 0; i < 10; i++) {
        store.create({ id: `msg-${i}`, sessionId, role: 'user', content: `Message ${i}` });
      }

      const messages = store.listBySession(sessionId, { limit: 5 });
      expect(messages).toHaveLength(5);
    });
  });

  describe('delete', () => {
    it('should delete a message', () => {
      const uniqueId = `msg-del-${Date.now()}`;
      const msg = store.create({ id: uniqueId, sessionId, role: 'user', content: 'test to delete' });
      expect(store.get(msg.id)).not.toBeNull();

      store.delete(msg.id);
      expect(store.get(msg.id)).toBeNull();
    });
  });

  describe('deleteBySession', () => {
    it('should delete all messages for a session', () => {
      // Use a fresh session to avoid interference from other tests
      const freshSessionId = createTestSession(db);

      store.create({ id: `del-msg-1-${Date.now()}`, sessionId: freshSessionId, role: 'user', content: 'test1' });
      store.create({ id: `del-msg-2-${Date.now()}`, sessionId: freshSessionId, role: 'user', content: 'test2' });

      // Count before delete
      const countBefore = store.countBySession(freshSessionId);
      expect(countBefore).toBe(2);

      store.deleteBySession(freshSessionId);

      // Verify deletion
      expect(store.listBySession(freshSessionId)).toHaveLength(0);
      expect(store.countBySession(freshSessionId)).toBe(0);
    });
  });

  describe('countBySession', () => {
    it('should count messages for a session', () => {
      store.create({ id: 'msg-1', sessionId, role: 'user', content: 'test1' });
      store.create({ id: 'msg-2', sessionId, role: 'user', content: 'test2' });
      store.create({ id: 'msg-3', sessionId, role: 'assistant', content: 'test3' });

      expect(store.countBySession(sessionId)).toBe(3);
    });
  });

  describe('createBatch', () => {
    it('should create multiple messages atomically', () => {
      const messages = store.createBatch([
        { id: 'msg-1', sessionId, role: 'user', content: 'First' },
        { id: 'msg-2', sessionId, role: 'assistant', content: 'Second' },
      ]);

      expect(messages).toHaveLength(2);
      expect(store.countBySession(sessionId)).toBe(2);
    });

    it('should return empty array for empty input', () => {
      const messages = store.createBatch([]);
      expect(messages).toHaveLength(0);
    });
  });

  describe('getUsageStats', () => {
    it('should sum token usage', () => {
      store.create({
        id: 'msg-1',
        sessionId,
        role: 'assistant',
        content: 'test',
        inputTokens: 100,
        outputTokens: 50,
      });
      store.create({
        id: 'msg-2',
        sessionId,
        role: 'assistant',
        content: 'test',
        inputTokens: 200,
        outputTokens: 100,
      });

      const stats = store.getUsageStats(sessionId);

      expect(stats.inputTokens).toBe(300);
      expect(stats.outputTokens).toBe(150);
    });
  });

  describe('search', () => {
    it('should find messages by content', () => {
      store.create({ id: 'msg-1', sessionId, role: 'user', content: 'Hello world' });
      store.create({ id: 'msg-2', sessionId, role: 'user', content: 'Goodbye world' });
      store.create({ id: 'msg-3', sessionId, role: 'user', content: 'Different text' });

      const results = store.search('world');

      expect(results).toHaveLength(2);
    });
  });

  describe('toSessionMessage', () => {
    it('should convert stored message to session message', () => {
      const stored = store.create({
        id: 'msg-1',
        sessionId,
        role: 'assistant',
        content: 'test',
        model: 'claude',
        inputTokens: 10,
        outputTokens: 20,
        durationMs: 500,
      });

      const session = store.toSessionMessage(stored);

      expect(session.id).toBe('msg-1');
      expect(session.role).toBe('assistant');
      expect((session as any).model).toBe('claude');
      expect((session as any).usage?.inputTokens).toBe(10);
      expect((session as any).usage?.outputTokens).toBe(20);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PermissionStore Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('PermissionStore', () => {
  let db: Database;
  let store: PermissionStore;
  let sessionId: string;

  beforeEach(() => {
    db = createTestDatabase();
    store = new PermissionStore(db);
    sessionId = createTestSession(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('grantPermission', () => {
    it('should create a global permission', () => {
      const perm = store.grantPermission({
        toolName: 'Bash',
        scope: 'global',
      });

      expect(perm.id).toBeDefined();
      expect(perm.toolName).toBe('Bash');
      expect(perm.scope).toBe('global');
      expect(perm.sessionId).toBeNull();
    });

    it('should create a session-scoped permission', () => {
      const perm = store.grantPermission({
        toolName: 'Write',
        scope: 'session',
        sessionId,
      });

      expect(perm.sessionId).toBe(sessionId);
      expect(perm.scope).toBe('session');
    });

    it('should use UPSERT to update existing permission', () => {
      store.grantPermission({
        toolName: 'Bash',
        scope: 'global',
      });

      store.grantPermission({
        toolName: 'Bash',
        scope: 'global',
      });

      const perms = store.listPermissions({ toolName: 'Bash' });
      expect(perms).toHaveLength(1);
    });
  });

  describe('checkPermission', () => {
    it('should return allowed for matching permission', () => {
      store.grantPermission({ toolName: 'Bash', scope: 'global' });

      const result = store.checkPermission('Bash', 'ls -la');

      expect(result.allowed).toBe(true);
      expect(result.permission).toBeDefined();
    });

    it('should return not allowed when no permission exists', () => {
      const result = store.checkPermission('Write', '/etc/passwd');

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('No matching permission');
    });

    it('should prefer more specific scope', () => {
      store.grantPermission({ toolName: 'Bash', scope: 'global' });
      store.grantPermission({ toolName: 'Bash', scope: 'session', sessionId });

      const result = store.checkPermission('Bash', 'test', sessionId);

      expect(result.allowed).toBe(true);
      // Session scope (2) should be preferred over global (4)
      expect(result.permission?.scope).toBe('session');
    });

    it('should check pattern match', () => {
      store.grantPermission({
        toolName: 'Bash',
        scope: 'global',
        pattern: '^ls ',
      });

      const lsResult = store.checkPermission('Bash', 'ls -la');
      expect(lsResult.allowed).toBe(true);

      const rmResult = store.checkPermission('Bash', 'rm -rf /');
      expect(rmResult.allowed).toBe(false);
    });

    it('should delete once-scoped permission after use', () => {
      store.grantPermission({
        toolName: 'Bash',
        scope: 'once',
        sessionId,
      });

      // First check should pass and delete the permission
      const first = store.checkPermission('Bash', 'test', sessionId);
      expect(first.allowed).toBe(true);

      // Second check should fail
      const second = store.checkPermission('Bash', 'test', sessionId);
      expect(second.allowed).toBe(false);
    });

    it('should not allow expired permissions', () => {
      const pastTime = Date.now() - 10000;
      db.run(
        `INSERT INTO permissions (id, tool_name, scope, decision, granted_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['perm-1', 'Bash', 'global', 'approved', pastTime - 20000, pastTime]
      );

      const result = store.checkPermission('Bash', 'test');
      expect(result.allowed).toBe(false);
    });
  });

  describe('revokePermission', () => {
    it('should delete permission by ID', () => {
      const perm = store.grantPermission({ toolName: 'Bash', scope: 'global' });
      store.revokePermission(perm.id);

      expect(store.get(perm.id)).toBeNull();
    });
  });

  describe('revokeByTool', () => {
    it('should delete all permissions for a tool', () => {
      store.grantPermission({ toolName: 'Bash', scope: 'global' });
      store.grantPermission({ toolName: 'Bash', scope: 'project' });
      store.grantPermission({ toolName: 'Write', scope: 'global' });

      const deleted = store.revokeByTool('Bash');

      expect(deleted).toBe(2);
      expect(store.listPermissions({ toolName: 'Bash' })).toHaveLength(0);
      expect(store.listPermissions({ toolName: 'Write' })).toHaveLength(1);
    });
  });

  describe('listPermissions', () => {
    it('should list all permissions', () => {
      store.grantPermission({ toolName: 'Bash', scope: 'global' });
      store.grantPermission({ toolName: 'Write', scope: 'project' });

      const perms = store.listPermissions();
      expect(perms).toHaveLength(2);
    });

    it('should filter by tool name', () => {
      store.grantPermission({ toolName: 'Bash', scope: 'global' });
      store.grantPermission({ toolName: 'Write', scope: 'project' });

      const perms = store.listPermissions({ toolName: 'Bash' });
      expect(perms).toHaveLength(1);
      expect(perms[0].toolName).toBe('Bash');
    });

    it('should filter by scope', () => {
      store.grantPermission({ toolName: 'Bash', scope: 'global' });
      store.grantPermission({ toolName: 'Bash', scope: 'project' });

      const perms = store.listPermissions({ scope: 'global' });
      expect(perms).toHaveLength(1);
      expect(perms[0].scope).toBe('global');
    });
  });

  describe('hasPermission', () => {
    it('should return true when permission exists', () => {
      store.grantPermission({ toolName: 'Bash', scope: 'global' });
      expect(store.hasPermission('Bash')).toBe(true);
    });

    it('should return false when no permission exists', () => {
      expect(store.hasPermission('Bash')).toBe(false);
    });
  });

  describe('count', () => {
    it('should count all permissions', () => {
      store.grantPermission({ toolName: 'Bash', scope: 'global' });
      store.grantPermission({ toolName: 'Write', scope: 'project' });

      expect(store.count()).toBe(2);
    });

    it('should count by tool', () => {
      store.grantPermission({ toolName: 'Bash', scope: 'global' });
      store.grantPermission({ toolName: 'Bash', scope: 'project' });
      store.grantPermission({ toolName: 'Write', scope: 'global' });

      expect(store.count({ toolName: 'Bash' })).toBe(2);
    });
  });

  describe('clearExpired', () => {
    it('should delete expired permissions', () => {
      const pastTime = Date.now() - 10000;
      db.run(
        `INSERT INTO permissions (id, tool_name, scope, decision, granted_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['perm-1', 'Bash', 'global', 'approved', pastTime - 20000, pastTime]
      );
      store.grantPermission({ toolName: 'Write', scope: 'global' });

      const deleted = store.clearExpired();

      expect(deleted).toBe(1);
      expect(store.count()).toBe(1);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TodoStore Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('TodoStore', () => {
  let db: Database;
  let store: TodoStore;
  let sessionId: string;

  beforeEach(() => {
    db = createTestDatabase();
    store = new TodoStore(db);
    sessionId = createTestSession(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('create', () => {
    it('should create a todo with required fields', () => {
      const todo = store.create({
        id: 'todo-1',
        content: 'Implement feature',
      });

      expect(todo.id).toBe('todo-1');
      expect(todo.content).toBe('Implement feature');
      expect(todo.status).toBe('pending');
      expect(todo.orderIndex).toBe(0);
      expect(todo.sessionId).toBeNull();
    });

    it('should create a todo with session (planId skipped due to FK)', () => {
      // Note: documentId has a foreign key to documents which requires a valid document
      const todo = store.create({
        id: 'todo-2',
        content: 'Test task',
        sessionId,
        status: 'in_progress',
        activeForm: 'Testing task',
        orderIndex: 5,
      });

      expect(todo.sessionId).toBe(sessionId);
      expect(todo.status).toBe('in_progress');
      expect(todo.activeForm).toBe('Testing task');
      expect(todo.orderIndex).toBe(5);
    });
  });

  describe('get', () => {
    it('should return todo by ID', () => {
      store.create({ id: 'todo-1', content: 'Test' });
      const todo = store.get('todo-1');

      expect(todo).not.toBeNull();
      expect(todo?.id).toBe('todo-1');
    });

    it('should return null for non-existent todo', () => {
      const todo = store.get('non-existent');
      expect(todo).toBeNull();
    });
  });

  describe('update', () => {
    it('should update todo content', () => {
      store.create({ id: 'todo-1', content: 'Original' });
      const updated = store.update('todo-1', { content: 'Updated' });

      expect(updated?.content).toBe('Updated');
      // updatedAt should be >= createdAt (may be same if update happens instantly)
      expect(updated?.updatedAt).toBeGreaterThanOrEqual(updated?.createdAt ?? 0);
    });

    it('should set completedAt when status becomes completed', () => {
      store.create({ id: 'todo-1', content: 'Test' });
      const updated = store.update('todo-1', { status: 'completed' });

      expect(updated?.status).toBe('completed');
      expect(updated?.completedAt).not.toBeNull();
    });

    it('should clear completedAt when moving away from completed', () => {
      store.create({ id: 'todo-1', content: 'Test', status: 'completed' });
      // Manually set completedAt since create doesn't do it
      db.run('UPDATE todos SET completed_at = ? WHERE id = ?', [Date.now(), 'todo-1']);

      const updated = store.update('todo-1', { status: 'in_progress' });

      expect(updated?.status).toBe('in_progress');
      expect(updated?.completedAt).toBeNull();
    });
  });

  describe('updateStatus', () => {
    it('should update only the status', () => {
      store.create({ id: 'todo-1', content: 'Test' });
      const updated = store.updateStatus('todo-1', 'in_progress');

      expect(updated?.status).toBe('in_progress');
    });
  });

  describe('delete', () => {
    it('should delete a todo', () => {
      store.create({ id: 'todo-1', content: 'Test' });
      const deleted = store.delete('todo-1');

      expect(deleted).toBe(true);
      expect(store.get('todo-1')).toBeNull();
    });
  });

  describe('list', () => {
    it('should list todos ordered by orderIndex', () => {
      store.create({ id: 'todo-3', content: 'Third', orderIndex: 3 });
      store.create({ id: 'todo-1', content: 'First', orderIndex: 1 });
      store.create({ id: 'todo-2', content: 'Second', orderIndex: 2 });

      const todos = store.list();

      expect(todos).toHaveLength(3);
      expect(todos[0].content).toBe('First');
      expect(todos[1].content).toBe('Second');
      expect(todos[2].content).toBe('Third');
    });

    it('should filter by session', () => {
      store.create({ id: 'todo-1', content: 'With session', sessionId });
      store.create({ id: 'todo-2', content: 'No session' });

      const withSession = store.list({ sessionId });
      const noSession = store.list({ sessionId: null });

      expect(withSession).toHaveLength(1);
      expect(withSession[0].content).toBe('With session');
      expect(noSession).toHaveLength(1);
      expect(noSession[0].content).toBe('No session');
    });

    it('should filter by status', () => {
      store.create({ id: 'todo-1', content: 'Pending', status: 'pending' });
      store.create({ id: 'todo-2', content: 'Done', status: 'completed' });

      const pending = store.list({ status: 'pending' });
      expect(pending).toHaveLength(1);
      expect(pending[0].content).toBe('Pending');
    });
  });

  describe('replaceForSession', () => {
    it('should atomically replace all todos for a session', () => {
      // Create initial todos
      store.create({ id: 'old-1', content: 'Old 1', sessionId });
      store.create({ id: 'old-2', content: 'Old 2', sessionId });

      // Replace with new todos
      const newTodos = store.replaceForSession(sessionId, [
        { id: 'new-1', content: 'New 1' },
        { id: 'new-2', content: 'New 2' },
        { id: 'new-3', content: 'New 3' },
      ]);

      expect(newTodos).toHaveLength(3);
      expect(store.list({ sessionId })).toHaveLength(3);
      expect(store.get('old-1')).toBeNull();
      expect(store.get('new-1')).not.toBeNull();
    });

    it('should auto-assign orderIndex', () => {
      const todos = store.replaceForSession(sessionId, [
        { id: 'a', content: 'A' },
        { id: 'b', content: 'B' },
        { id: 'c', content: 'C' },
      ]);

      expect(todos[0].orderIndex).toBe(0);
      expect(todos[1].orderIndex).toBe(1);
      expect(todos[2].orderIndex).toBe(2);
    });

    it('should handle null sessionId', () => {
      store.create({ id: 'old', content: 'Old', sessionId: null });

      const todos = store.replaceForSession(null, [
        { id: 'new', content: 'New' },
      ]);

      expect(todos).toHaveLength(1);
      expect(store.get('old')).toBeNull();
    });
  });

  describe('upsert', () => {
    it('should create if not exists', () => {
      const todo = store.upsert({ id: 'todo-1', content: 'New' });
      expect(todo.content).toBe('New');
    });

    it('should update if exists', () => {
      store.create({ id: 'todo-1', content: 'Old' });
      const todo = store.upsert({ id: 'todo-1', content: 'Updated' });
      expect(todo.content).toBe('Updated');
    });
  });

  describe('createBatch', () => {
    it('should create multiple todos atomically', () => {
      const todos = store.createBatch([
        { id: 'todo-1', content: 'First' },
        { id: 'todo-2', content: 'Second' },
      ]);

      expect(todos).toHaveLength(2);
      expect(store.count()).toBe(2);
    });
  });

  describe('deleteBySession', () => {
    it('should delete all todos for a session', () => {
      store.create({ id: 'todo-1', content: 'Test 1', sessionId });
      store.create({ id: 'todo-2', content: 'Test 2', sessionId });

      const deleted = store.deleteBySession(sessionId);

      expect(deleted).toBe(2);
      expect(store.list({ sessionId })).toHaveLength(0);
    });
  });

  describe('count', () => {
    it('should count all todos', () => {
      store.create({ id: 'todo-1', content: 'Test 1' });
      store.create({ id: 'todo-2', content: 'Test 2' });

      expect(store.count()).toBe(2);
    });

    it('should count by status', () => {
      store.create({ id: 'todo-1', content: 'Pending', status: 'pending' });
      store.create({ id: 'todo-2', content: 'Done', status: 'completed' });

      expect(store.count({ status: 'pending' })).toBe(1);
      expect(store.count({ status: 'completed' })).toBe(1);
    });
  });

  describe('getStats', () => {
    it('should return completion statistics', () => {
      store.create({ id: 'todo-1', content: 'Pending', status: 'pending' });
      store.create({ id: 'todo-2', content: 'In Progress', status: 'in_progress' });
      store.create({ id: 'todo-3', content: 'Done 1', status: 'completed' });
      store.create({ id: 'todo-4', content: 'Done 2', status: 'completed' });

      const stats = store.getStats();

      expect(stats.total).toBe(4);
      expect(stats.pending).toBe(1);
      expect(stats.inProgress).toBe(1);
      expect(stats.completed).toBe(2);
    });

    it('should filter stats by session', () => {
      store.create({ id: 'todo-1', content: 'Session todo', sessionId, status: 'completed' });
      store.create({ id: 'todo-2', content: 'Global todo', status: 'pending' });

      const sessionStats = store.getStats(sessionId);
      const globalStats = store.getStats(null);

      expect(sessionStats.total).toBe(1);
      expect(sessionStats.completed).toBe(1);
      expect(globalStats.total).toBe(1);
      expect(globalStats.pending).toBe(1);
    });
  });
});
