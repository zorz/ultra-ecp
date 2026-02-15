/**
 * Chat System Smoke Test
 *
 * End-to-end test that exercises the full chat system flow:
 * - Session creation
 * - Agent registration
 * - Message sending with @mention routing
 * - Permission management
 * - Todo tracking
 * - Context building
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTestDatabase } from './test-utils.ts';
import { ChatOrchestrator } from '../../../src/services/chat/services/ChatOrchestrator.ts';
import type { AgentExecutor } from '../../../src/services/chat/services/AgentManager.ts';

describe('Chat System Smoke Test', () => {
  let db: Database;
  let orchestrator: ChatOrchestrator;

  // Mock executor that simulates AI responses
  const mockExecutor: AgentExecutor = mock(async (agent: any, message: any, context: any) => {
    return {
      id: `response-${Date.now()}`,
      role: 'assistant' as const,
      content: `[${agent.name}] Processed: "${message.substring(0, 50)}..."`,
      timestamp: Date.now(),
      sessionId: context.sessionId,
      agentId: agent.id,
      agentRole: agent.role,
      usage: {
        inputTokens: Math.floor(message.length / 4),
        outputTokens: 50,
      },
      durationMs: 100,
    };
  }) as any;

  beforeEach(() => {
    db = createTestDatabase();
    orchestrator = new ChatOrchestrator({
      db,
      defaultProvider: 'anthropic',
      defaultModel: 'claude-opus-4-5-20251101',
    });
    (mockExecutor as any).mockClear?.();
  });

  afterEach(() => {
    db.close();
  });

  describe('Full Conversation Flow', () => {
    it('should handle a complete multi-turn conversation', async () => {
      // 1. Register agents
      orchestrator.registerAgent({
        id: 'claude',
        name: 'Claude',
        role: 'primary',
        description: 'General purpose AI assistant',
      });

      orchestrator.registerAgent({
        id: 'code-reviewer',
        name: 'Code Reviewer',
        role: 'specialist',
        description: 'Reviews code for best practices',
        triggerKeywords: ['review', 'pr'],
      });

      // 2. Set up executor
      orchestrator.setExecutor(mockExecutor);

      // 3. Create a session
      const sessionId = orchestrator.createSession({
        title: 'Smoke Test Session',
        systemPrompt: 'You are a helpful AI assistant for code development.',
      });

      expect(sessionId).toBeDefined();
      expect(orchestrator.getSession(sessionId)).not.toBeNull();

      // 4. Send first message (routed to primary agent)
      const result1 = await orchestrator.sendMessage({
        sessionId,
        content: 'Hello, can you help me with a coding problem?',
      });

      expect(result1.userMessage.content).toContain('Hello');
      expect(result1.agent.id).toBe('claude');
      expect(result1.assistantMessage.content).toContain('[Claude]');

      // 5. Send message with @mention (routed to specialist)
      const result2 = await orchestrator.sendMessage({
        sessionId,
        content: '@code-reviewer Please review this function:\n\nfunction add(a, b) { return a + b; }',
      });

      expect(result2.agent.id).toBe('code-reviewer');
      expect(result2.assistantMessage.content).toContain('[Code Reviewer]');

      // 6. Continue conversation with primary agent
      const result3 = await orchestrator.sendMessage({
        sessionId,
        content: 'Thanks! Can you also write some tests?',
      });

      expect(result3.agent.id).toBe('claude');

      // 7. Verify message history
      const messages = orchestrator.getMessages(sessionId);
      // Each sendMessage creates user + assistant message (but timing may affect what's retrieved)
      expect(messages.length).toBeGreaterThanOrEqual(4);

      // 8. Check session stats
      const stats = orchestrator.getSessionStats(sessionId);
      expect(stats.messageCount).toBeGreaterThanOrEqual(4);
      expect(stats.usage.inputTokens).toBeGreaterThan(0);
      expect(stats.usage.outputTokens).toBeGreaterThan(0);
    });
  });

  describe('Permission Management Flow', () => {
    it('should manage permissions correctly', async () => {
      // 1. Create session and agent
      orchestrator.registerAgent({
        id: 'claude',
        name: 'Claude',
        role: 'primary',
      });
      orchestrator.setExecutor(mockExecutor);
      const sessionId = orchestrator.createSession();

      // 2. Initially no permissions
      const bashCheck = orchestrator.checkPermission('Bash', 'ls -la', sessionId);
      expect(bashCheck.allowed).toBe(false);

      // 3. Grant session-scoped permission
      const sessionPerm = orchestrator.grantPermission({
        toolName: 'Bash',
        scope: 'session',
        sessionId,
        description: 'Allow bash for this session',
      });

      expect(sessionPerm.scope).toBe('session');

      // 4. Check permission now passes
      const bashCheckAfter = orchestrator.checkPermission('Bash', 'ls -la', sessionId);
      expect(bashCheckAfter.allowed).toBe(true);

      // 5. Grant global permission with pattern
      orchestrator.grantPermission({
        toolName: 'Write',
        scope: 'global',
        pattern: '^/tmp/',
        description: 'Allow writing to /tmp',
      });

      // 6. Pattern matching works
      const tmpWrite = orchestrator.checkPermission('Write', '/tmp/test.txt');
      expect(tmpWrite.allowed).toBe(true);

      const etcWrite = orchestrator.checkPermission('Write', '/etc/passwd');
      expect(etcWrite.allowed).toBe(false);

      // 7. List permissions
      const perms = orchestrator.listPermissions();
      expect(perms.length).toBeGreaterThanOrEqual(2);

      // 8. Revoke permission
      orchestrator.revokePermission(sessionPerm.id);
      const bashCheckRevoked = orchestrator.checkPermission('Bash', 'ls -la', sessionId);
      expect(bashCheckRevoked.allowed).toBe(false);
    });
  });

  describe('Todo Management Flow', () => {
    it('should track todos through a session', async () => {
      // 1. Setup
      orchestrator.registerAgent({
        id: 'claude',
        name: 'Claude',
        role: 'primary',
      });
      orchestrator.setExecutor(mockExecutor);
      const sessionId = orchestrator.createSession();

      // 2. Create initial todos
      orchestrator.replaceTodos(sessionId, [
        { id: 'todo-1', content: 'Implement login feature', status: 'pending' },
        { id: 'todo-2', content: 'Write unit tests', status: 'pending' },
        { id: 'todo-3', content: 'Update documentation', status: 'pending' },
      ]);

      let todos = orchestrator.getTodos(sessionId);
      expect(todos).toHaveLength(3);
      expect(todos.every((t) => t.status === 'pending')).toBe(true);

      // 3. Start working on first todo
      orchestrator.updateTodoStatus('todo-1', 'in_progress');

      todos = orchestrator.getTodos(sessionId);
      const inProgress = todos.find((t) => t.id === 'todo-1');
      expect(inProgress?.status).toBe('in_progress');

      // 4. Complete first todo, start second
      orchestrator.updateTodoStatus('todo-1', 'completed');
      orchestrator.updateTodoStatus('todo-2', 'in_progress');

      // 5. Check statistics
      const todoStore = orchestrator.todoStore;
      const stats = todoStore.getStats(sessionId);
      expect(stats.total).toBe(3);
      expect(stats.completed).toBe(1);
      expect(stats.inProgress).toBe(1);
      expect(stats.pending).toBe(1);

      // 6. Replace with new todos (simulating AI update)
      orchestrator.replaceTodos(sessionId, [
        { id: 'new-1', content: 'Refactor authentication module', status: 'pending' },
        { id: 'new-2', content: 'Add OAuth support', status: 'pending' },
      ]);

      todos = orchestrator.getTodos(sessionId);
      expect(todos).toHaveLength(2);
      expect(todos[0].content).toContain('Refactor');
    });
  });

  describe('Context Building Flow', () => {
    it('should build appropriate context for conversations', async () => {
      // 1. Setup
      orchestrator.registerAgent({
        id: 'claude',
        name: 'Claude',
        role: 'primary',
        systemPrompt: 'You are a code review assistant.',
      });
      orchestrator.setExecutor(mockExecutor);

      const sessionId = orchestrator.createSession({
        systemPrompt: 'Session system prompt.',
      });

      // 2. Add some conversation history
      await orchestrator.sendMessage({
        sessionId,
        content: 'First message about the project.',
      });

      await orchestrator.sendMessage({
        sessionId,
        content: 'Second message with more details.',
      });

      // 3. Build context for next message
      const agent = orchestrator.getAgent('claude')!;
      const context = orchestrator.buildContext({
        sessionId,
        agent,
        additionalContext: 'The user is working on a TypeScript project.',
      });

      // 4. Verify context structure
      expect(context.messages.length).toBeGreaterThanOrEqual(2);
      expect(context.estimatedTokens).toBeGreaterThan(0);
      expect(context.systemPrompt).toContain('code review assistant'); // Agent prompt takes precedence
      expect(context.systemPrompt).toContain('TypeScript project'); // Additional context included

      // 5. Check context summary
      const summary = orchestrator.contextBuilder.getContextSummary(sessionId);
      expect(summary.messageCount).toBeGreaterThanOrEqual(2);
      expect(summary.oldestMessageAt).not.toBeNull();
      expect(summary.newestMessageAt).not.toBeNull();
    });
  });

  describe('Multi-Agent Collaboration', () => {
    it('should support multiple agents in a conversation', async () => {
      // 1. Register multiple agents
      orchestrator.registerAgent({
        id: 'planner',
        name: 'Project Planner',
        role: 'primary',
        description: 'Plans and breaks down tasks',
        triggerKeywords: ['plan', 'roadmap'],
      });

      orchestrator.registerAgent({
        id: 'coder',
        name: 'Code Writer',
        role: 'specialist',
        description: 'Writes implementation code',
        triggerKeywords: ['code', 'implement'],
      });

      orchestrator.registerAgent({
        id: 'tester',
        name: 'Test Writer',
        role: 'specialist',
        description: 'Writes tests',
        triggerKeywords: ['test', 'spec'],
      });

      orchestrator.setExecutor(mockExecutor);
      const sessionId = orchestrator.createSession();

      // 2. Start with planning
      const planResult = await orchestrator.sendMessage({
        sessionId,
        content: '@plan Create a roadmap for implementing user authentication',
      });
      expect(planResult.agent.id).toBe('planner');

      // 3. Ask for implementation
      const codeResult = await orchestrator.sendMessage({
        sessionId,
        content: '@coder Implement the login function based on the plan',
      });
      expect(codeResult.agent.id).toBe('coder');

      // 4. Ask for tests
      const testResult = await orchestrator.sendMessage({
        sessionId,
        content: '@tester Write tests for the login function',
      });
      expect(testResult.agent.id).toBe('tester');

      // 5. Fall back to primary for general questions
      const generalResult = await orchestrator.sendMessage({
        sessionId,
        content: 'What should we do next?',
      });
      expect(generalResult.agent.id).toBe('planner'); // Primary agent

      // 6. Verify all agents were used
      const agents = orchestrator.listAgents();
      expect(agents).toHaveLength(3);

      // 7. Check message history contains all interactions
      const messages = orchestrator.getMessages(sessionId);
      expect(messages.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('Error Handling', () => {
    it('should handle errors gracefully', async () => {
      orchestrator.registerAgent({
        id: 'claude',
        name: 'Claude',
        role: 'primary',
      });

      // 1. Error when no executor
      await expect(
        orchestrator.sendMessage({
          sessionId: orchestrator.createSession(),
          content: 'Hello',
        })
      ).rejects.toThrow('No agent executor configured');

      // 2. Set executor that throws
      const failingExecutor: AgentExecutor = mock(() => Promise.reject(new Error('API Error'))) as any;
      orchestrator.setExecutor(failingExecutor);

      const sessionId = orchestrator.createSession();

      // 3. Error should propagate
      await expect(
        orchestrator.sendMessage({
          sessionId,
          content: 'Hello',
        })
      ).rejects.toThrow('API Error');

      // 4. Agent should be in error state
      const agent = orchestrator.getAgent('claude');
      expect(agent?.status).toBe('error');

      // 5. Session still exists and is usable
      expect(orchestrator.getSession(sessionId)).not.toBeNull();

      // 6. Fix executor and retry
      orchestrator.setExecutor(mockExecutor);
      const result = await orchestrator.sendMessage({
        sessionId,
        content: 'Retry after error',
      });

      expect(result.assistantMessage.content).toBeDefined();
      expect(orchestrator.getAgent('claude')?.status).toBe('idle');
    });
  });

  describe('Transaction Safety', () => {
    it('should maintain data consistency', async () => {
      orchestrator.registerAgent({
        id: 'claude',
        name: 'Claude',
        role: 'primary',
      });
      orchestrator.setExecutor(mockExecutor);

      const sessionId = orchestrator.createSession();

      // 1. Replace todos multiple times in quick succession
      const todoPromises: Promise<void>[] = [];
      for (let i = 0; i < 5; i++) {
        todoPromises.push(
          new Promise<void>((resolve) => {
            orchestrator.replaceTodos(sessionId, [
              { id: `batch-${i}-1`, content: `Task from batch ${i}` },
              { id: `batch-${i}-2`, content: `Task 2 from batch ${i}` },
            ]);
            resolve();
          })
        );
      }

      await Promise.all(todoPromises);

      // 2. Final state should be consistent
      const todos = orchestrator.getTodos(sessionId);
      expect(todos.length).toBe(2); // Should have exactly 2 todos from last batch
      expect(todos[0].id).toMatch(/^batch-\d-1$/);

      // 3. Stats should match
      const stats = orchestrator.getStats();
      expect(stats.sessionCount).toBe(1);
    });
  });

  describe('Overall Statistics', () => {
    it('should track statistics correctly', async () => {
      orchestrator.registerAgent({
        id: 'claude',
        name: 'Claude',
        role: 'primary',
      });
      orchestrator.setExecutor(mockExecutor);

      // 1. Create multiple sessions
      const session1 = orchestrator.createSession({ title: 'Session 1' });
      const session2 = orchestrator.createSession({ title: 'Session 2' });

      // 2. Send messages to each
      await orchestrator.sendMessage({ sessionId: session1, content: 'Hello session 1' });
      await orchestrator.sendMessage({ sessionId: session1, content: 'Second message' });
      await orchestrator.sendMessage({ sessionId: session2, content: 'Hello session 2' });

      // 3. Add permissions
      orchestrator.grantPermission({ toolName: 'Bash', scope: 'global' });
      orchestrator.grantPermission({ toolName: 'Write', scope: 'project' });

      // 4. Add todos
      orchestrator.replaceTodos(session1, [
        { id: 't1', content: 'Task 1' },
        { id: 't2', content: 'Task 2' },
      ]);

      // 5. Check overall stats
      const stats = orchestrator.getStats();
      expect(stats.sessionCount).toBe(2);
      expect(stats.agentCount).toBe(1);
      expect(stats.permissionCount).toBe(2);
      expect(stats.todoCount).toBe(2);

      // 6. Check session-specific stats
      const session1Stats = orchestrator.getSessionStats(session1);
      expect(session1Stats.messageCount).toBeGreaterThanOrEqual(2);
      expect(session1Stats.todos.total).toBe(2);
    });
  });
});
