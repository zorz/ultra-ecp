/**
 * Chat Service Tests
 *
 * Tests for AgentManager, ContextBuilder, and ChatOrchestrator.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTestDatabase, sleep } from './test-utils.ts';
import { SessionStore } from '../../../src/services/chat/stores/SessionStore.ts';
import { MessageStore } from '../../../src/services/chat/stores/MessageStore.ts';
import {
  AgentManager,
  type AgentExecutor,
  type AgentManagerEvent,
} from '../../../src/services/chat/services/AgentManager.ts';
import { ContextBuilder } from '../../../src/services/chat/services/ContextBuilder.ts';
import { ChatOrchestrator } from '../../../src/services/chat/services/ChatOrchestrator.ts';

// ─────────────────────────────────────────────────────────────────────────────
// AgentManager Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('AgentManager', () => {
  let manager: AgentManager;

  beforeEach(() => {
    manager = new AgentManager();
  });

  describe('registerAgent', () => {
    it('should register an agent', () => {
      const agent = manager.registerAgent({
        id: 'claude',
        name: 'Claude',
        role: 'primary',
      });

      expect(agent.id).toBe('claude');
      expect(agent.name).toBe('Claude');
      expect(agent.role).toBe('primary');
      expect(agent.status).toBe('idle');
    });

    it('should set first registered agent as primary', () => {
      manager.registerAgent({
        id: 'agent-1',
        name: 'First Agent',
        role: 'specialist',
      });

      expect(manager.getPrimaryAgent().id).toBe('agent-1');
    });

    it('should override primary when explicitly set', () => {
      manager.registerAgent({
        id: 'agent-1',
        name: 'First',
        role: 'specialist',
      });
      manager.registerAgent({
        id: 'agent-2',
        name: 'Primary',
        role: 'primary',
      });

      expect(manager.getPrimaryAgent().id).toBe('agent-2');
    });

    it('should emit registered event', () => {
      const events: AgentManagerEvent[] = [];
      manager.addEventListener((e) => events.push(e));

      manager.registerAgent({
        id: 'test',
        name: 'Test',
        role: 'primary',
      });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('agent:registered');
    });
  });

  describe('unregisterAgent', () => {
    it('should remove agent', () => {
      manager.registerAgent({ id: 'test', name: 'Test', role: 'primary' });
      manager.unregisterAgent('test');

      expect(manager.getAgent('test')).toBeUndefined();
    });

    it('should reassign primary when primary is removed', () => {
      manager.registerAgent({ id: 'primary', name: 'Primary', role: 'primary' });
      manager.registerAgent({ id: 'backup', name: 'Backup', role: 'specialist' });
      manager.unregisterAgent('primary');

      expect(manager.hasPrimaryAgent()).toBe(true);
      expect(manager.getPrimaryAgent().id).toBe('backup');
    });

    it('should emit unregistered event', () => {
      manager.registerAgent({ id: 'test', name: 'Test', role: 'primary' });

      const events: AgentManagerEvent[] = [];
      manager.addEventListener((e) => events.push(e));
      manager.unregisterAgent('test');

      expect(events.some((e) => e.type === 'agent:unregistered')).toBe(true);
    });
  });

  describe('getAgent', () => {
    it('should return agent by ID', () => {
      manager.registerAgent({ id: 'test', name: 'Test', role: 'primary' });
      const agent = manager.getAgent('test');

      expect(agent).toBeDefined();
      expect(agent?.id).toBe('test');
    });

    it('should return undefined for non-existent agent', () => {
      expect(manager.getAgent('non-existent')).toBeUndefined();
    });
  });

  describe('getPrimaryAgent', () => {
    it('should throw when no agents registered', () => {
      expect(() => manager.getPrimaryAgent()).toThrow('No primary agent registered');
    });

    it('should return primary agent', () => {
      manager.registerAgent({ id: 'primary', name: 'Primary', role: 'primary' });
      expect(manager.getPrimaryAgent().id).toBe('primary');
    });
  });

  describe('listAgents', () => {
    it('should return all registered agents', () => {
      manager.registerAgent({ id: 'a1', name: 'Agent 1', role: 'primary' });
      manager.registerAgent({ id: 'a2', name: 'Agent 2', role: 'specialist' });

      const agents = manager.listAgents();
      expect(agents).toHaveLength(2);
    });
  });

  describe('findAgents', () => {
    beforeEach(() => {
      manager.registerAgent({
        id: 'code-reviewer',
        name: 'Code Reviewer',
        role: 'specialist',
        description: 'Reviews code for quality',
        triggerKeywords: ['review', 'pr'],
      });
      manager.registerAgent({
        id: 'writer',
        name: 'Technical Writer',
        role: 'specialist',
        description: 'Writes documentation',
        triggerKeywords: ['docs', 'readme'],
      });
    });

    it('should find by ID', () => {
      const found = manager.findAgents('code-reviewer');
      expect(found).toHaveLength(1);
      expect(found[0].id).toBe('code-reviewer');
    });

    it('should find by name', () => {
      const found = manager.findAgents('writer');
      expect(found).toHaveLength(1);
      expect(found[0].id).toBe('writer');
    });

    it('should find by description', () => {
      const found = manager.findAgents('documentation');
      expect(found).toHaveLength(1);
      expect(found[0].id).toBe('writer');
    });

    it('should find by trigger keyword', () => {
      const found = manager.findAgents('pr');
      expect(found).toHaveLength(1);
      expect(found[0].id).toBe('code-reviewer');
    });
  });

  describe('parseMentions', () => {
    beforeEach(() => {
      manager.registerAgent({
        id: 'claude',
        name: 'Claude',
        role: 'primary',
        triggerKeywords: ['ai', 'assistant'],
      });
      manager.registerAgent({
        id: 'reviewer',
        name: 'Code Reviewer',
        role: 'specialist',
      });
    });

    it('should parse single mention by ID', () => {
      const result = manager.parseMentions('@claude help me');

      expect(result.mentions).toHaveLength(1);
      expect(result.mentions[0].agentId).toBe('claude');
      expect(result.cleanText).toBe('help me');
    });

    it('should parse mention by trigger keyword', () => {
      const result = manager.parseMentions('@ai what is this?');

      expect(result.mentions).toHaveLength(1);
      expect(result.mentions[0].agentId).toBe('claude');
    });

    it('should parse multiple mentions', () => {
      const result = manager.parseMentions('@claude and @reviewer please look at this');

      expect(result.mentions).toHaveLength(2);
      expect(result.mentions[0].agentId).toBe('claude');
      expect(result.mentions[1].agentId).toBe('reviewer');
      expect(result.cleanText).toBe('and please look at this');
    });

    it('should ignore unknown mentions', () => {
      const result = manager.parseMentions('@unknown help me');

      expect(result.mentions).toHaveLength(0);
      expect(result.cleanText).toBe('@unknown help me');
    });

    it('should handle text without mentions', () => {
      const result = manager.parseMentions('just regular text');

      expect(result.mentions).toHaveLength(0);
      expect(result.cleanText).toBe('just regular text');
    });
  });

  describe('delegate', () => {
    it('should fail when agent not found', async () => {
      const result = await manager.delegate({
        fromAgentId: 'primary',
        toAgentId: 'non-existent',
        task: 'Do something',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should fail when no executor configured', async () => {
      manager.registerAgent({ id: 'target', name: 'Target', role: 'specialist' });

      const result = await manager.delegate({
        fromAgentId: 'primary',
        toAgentId: 'target',
        task: 'Do something',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No agent executor');
    });

    it('should execute delegation successfully', async () => {
      manager.registerAgent({ id: 'target', name: 'Target', role: 'specialist' });

      const mockExecutor: AgentExecutor = mock(() => Promise.resolve({
        id: 'response-1',
        role: 'assistant',
        content: 'Done!',
        timestamp: Date.now(),
      })) as any;
      manager.setExecutor(mockExecutor);

      const result = await manager.delegate({
        fromAgentId: 'primary',
        toAgentId: 'target',
        task: 'Do the thing',
      });

      expect(result.success).toBe(true);
      expect(result.response?.content).toBe('Done!');
      expect(mockExecutor).toHaveBeenCalled();
    });
  });

  describe('updateStatus', () => {
    it('should update agent status and emit event', () => {
      manager.registerAgent({ id: 'test', name: 'Test', role: 'primary' });

      const events: AgentManagerEvent[] = [];
      manager.addEventListener((e) => events.push(e));

      manager.updateStatus('test', 'thinking');

      const agent = manager.getAgent('test');
      expect(agent?.status).toBe('thinking');

      const statusEvent = events.find((e) => e.type === 'agent:status_changed');
      expect(statusEvent).toBeDefined();
    });
  });

  describe('getAgentsByRole', () => {
    it('should return agents with matching role', () => {
      manager.registerAgent({ id: 'p1', name: 'Primary', role: 'primary' });
      manager.registerAgent({ id: 's1', name: 'Specialist 1', role: 'specialist' });
      manager.registerAgent({ id: 's2', name: 'Specialist 2', role: 'specialist' });

      const specialists = manager.getAgentsByRole('specialist');
      expect(specialists).toHaveLength(2);
    });
  });

  describe('setPrimaryAgent', () => {
    it('should set primary agent', () => {
      manager.registerAgent({ id: 'a1', name: 'Agent 1', role: 'specialist' });
      manager.registerAgent({ id: 'a2', name: 'Agent 2', role: 'specialist' });

      manager.setPrimaryAgent('a2');
      expect(manager.getPrimaryAgent().id).toBe('a2');
    });

    it('should throw for non-existent agent', () => {
      expect(() => manager.setPrimaryAgent('non-existent')).toThrow();
    });
  });

  describe('clear', () => {
    it('should remove all agents', () => {
      manager.registerAgent({ id: 'a1', name: 'Agent 1', role: 'primary' });
      manager.registerAgent({ id: 'a2', name: 'Agent 2', role: 'specialist' });

      manager.clear();

      expect(manager.size).toBe(0);
      expect(manager.hasPrimaryAgent()).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ContextBuilder Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ContextBuilder', () => {
  let db: Database;
  let messageStore: MessageStore;
  let sessionStore: SessionStore;
  let builder: ContextBuilder;
  let sessionId: string;

  beforeEach(() => {
    db = createTestDatabase();
    messageStore = new MessageStore(db);
    sessionStore = new SessionStore(db);
    builder = new ContextBuilder(messageStore, sessionStore);

    // Create a session with system prompt
    sessionId = crypto.randomUUID();
    sessionStore.create({
      id: sessionId,
      provider: 'anthropic',
      model: 'claude-opus',
      systemPrompt: 'You are a helpful assistant.',
    });
  });

  afterEach(() => {
    db.close();
  });

  describe('build', () => {
    it('should build empty context for empty session', () => {
      const context = builder.build({ sessionId });

      expect(context.messages).toHaveLength(0);
      expect(context.messageCount).toBe(0);
      expect(context.wasTruncated).toBe(false);
    });

    it('should include session system prompt', () => {
      const context = builder.build({ sessionId });

      expect(context.systemPrompt).toBe('You are a helpful assistant.');
    });

    it('should override system prompt with custom', () => {
      const context = builder.build({
        sessionId,
        systemPrompt: 'Custom prompt',
      });

      expect(context.systemPrompt).toBe('Custom prompt');
    });

    it('should include messages in chronological order', async () => {
      messageStore.create({ id: 'm1', sessionId, role: 'user', content: 'First' });
      await sleep(10);
      messageStore.create({ id: 'm2', sessionId, role: 'assistant', content: 'Second' });
      await sleep(10);
      messageStore.create({ id: 'm3', sessionId, role: 'user', content: 'Third' });

      const context = builder.build({ sessionId });

      expect(context.messages).toHaveLength(3);
      expect(context.messages[0].content).toBe('First');
      expect(context.messages[1].content).toBe('Second');
      expect(context.messages[2].content).toBe('Third');
    });

    it('should append additional messages', () => {
      messageStore.create({ id: 'm1', sessionId, role: 'user', content: 'History' });

      const context = builder.build({
        sessionId,
        appendMessages: [{ role: 'user', content: 'New message' }],
      });

      expect(context.messages).toHaveLength(2);
      expect(context.messages[1].content).toBe('New message');
    });

    it('should add additional context to system prompt', () => {
      const context = builder.build({
        sessionId,
        additionalContext: 'Extra context here.',
      });

      expect(context.systemPrompt).toContain('You are a helpful assistant.');
      expect(context.systemPrompt).toContain('Extra context here.');
    });

    it('should truncate old messages when token budget exceeded', () => {
      // Create many messages
      for (let i = 0; i < 100; i++) {
        messageStore.create({
          id: `m${i}`,
          sessionId,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: 'A'.repeat(500), // ~125 tokens each
        });
      }

      const context = builder.build({
        sessionId,
        maxTokens: 1000, // Very small budget
      });

      expect(context.wasTruncated).toBe(true);
      expect(context.messageCount).toBeLessThan(100);
    });

    it('should ensure conversation starts with user message', () => {
      // Create starting with assistant (shouldn't normally happen, but edge case)
      messageStore.create({ id: 'm1', sessionId, role: 'assistant', content: 'Hello' });
      messageStore.create({ id: 'm2', sessionId, role: 'user', content: 'Hi there' });

      const context = builder.build({ sessionId });

      // First message should be user
      expect(context.messages[0].role).toBe('user');
    });

    it('should estimate tokens correctly', () => {
      messageStore.create({ id: 'm1', sessionId, role: 'user', content: 'Hello' }); // ~2 tokens

      const context = builder.build({ sessionId });

      expect(context.estimatedTokens).toBeGreaterThan(0);
    });

    it('should include agent system prompt', () => {
      const context = builder.build({
        sessionId,
        agent: {
          id: 'custom',
          name: 'Custom',
          role: 'primary',
          status: 'idle',
          systemPrompt: 'Agent-specific prompt',
        },
      });

      expect(context.systemPrompt).toBe('Agent-specific prompt');
    });
  });

  describe('buildWithUserMessage', () => {
    it('should append user message', () => {
      messageStore.create({ id: 'm1', sessionId, role: 'user', content: 'Previous' });

      const context = builder.buildWithUserMessage(sessionId, 'New question');

      expect(context.messages).toHaveLength(2);
      expect(context.messages[1].role).toBe('user');
      expect(context.messages[1].content).toBe('New question');
    });
  });

  describe('estimateMessageTokens', () => {
    it('should estimate string content', () => {
      const tokens = builder.estimateMessageTokens('Hello world!');
      expect(tokens).toBe(3); // 12 chars / 4 = 3
    });

    it('should estimate content blocks', () => {
      const tokens = builder.estimateMessageTokens([
        { type: 'text', text: 'Hello' },
        { type: 'text', text: 'World' },
      ]);
      expect(tokens).toBeGreaterThan(0);
    });
  });

  describe('hasMinimalContext', () => {
    it('should return false for empty session', () => {
      expect(builder.hasMinimalContext(sessionId)).toBe(false);
    });

    it('should return true when messages exist', () => {
      messageStore.create({ id: 'm1', sessionId, role: 'user', content: 'Hello' });
      expect(builder.hasMinimalContext(sessionId)).toBe(true);
    });

    it('should check minimum message count', () => {
      messageStore.create({ id: 'm1', sessionId, role: 'user', content: 'Hello' });
      expect(builder.hasMinimalContext(sessionId, 2)).toBe(false);
    });
  });

  describe('getContextSummary', () => {
    it('should return summary for empty session', () => {
      const summary = builder.getContextSummary(sessionId);

      expect(summary.messageCount).toBe(0);
      expect(summary.estimatedTokens).toBe(0);
      expect(summary.oldestMessageAt).toBeNull();
      expect(summary.newestMessageAt).toBeNull();
    });

    it('should return correct summary', async () => {
      messageStore.create({ id: 'm1', sessionId, role: 'user', content: 'Hello' });
      await sleep(10);
      messageStore.create({ id: 'm2', sessionId, role: 'assistant', content: 'Hi there!' });

      const summary = builder.getContextSummary(sessionId);

      expect(summary.messageCount).toBe(2);
      expect(summary.estimatedTokens).toBeGreaterThan(0);
      expect(summary.oldestMessageAt).not.toBeNull();
      expect(summary.newestMessageAt).not.toBeNull();
      expect(summary.newestMessageAt!).toBeGreaterThan(summary.oldestMessageAt!);
    });
  });

  describe('buildMinimal', () => {
    it('should build minimal context with limited messages', () => {
      for (let i = 0; i < 10; i++) {
        messageStore.create({
          id: `m${i}`,
          sessionId,
          role: 'user',
          content: `Message ${i}`,
        });
      }

      const context = builder.buildMinimal(sessionId, { maxMessages: 3 });

      expect(context.messageCount).toBe(3);
      expect(context.wasTruncated).toBe(false);
    });

    it('should include custom system prompt', () => {
      const context = builder.buildMinimal(sessionId, {
        systemPrompt: 'Minimal prompt',
      });

      expect(context.systemPrompt).toBe('Minimal prompt');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ChatOrchestrator Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('ChatOrchestrator', () => {
  let db: Database;
  let orchestrator: ChatOrchestrator;

  beforeEach(() => {
    db = createTestDatabase();
    orchestrator = new ChatOrchestrator({ db });
  });

  afterEach(() => {
    db.close();
  });

  describe('constructor', () => {
    it('should initialize with default values', () => {
      expect(orchestrator.getDefaultProvider()).toBe('anthropic');
      expect(orchestrator.getDefaultModel()).toBe('claude-opus-4-5-20251101');
    });

    it('should accept custom defaults', () => {
      const custom = new ChatOrchestrator({
        db,
        defaultProvider: 'openai',
        defaultModel: 'gpt-4',
      });

      expect(custom.getDefaultProvider()).toBe('openai');
      expect(custom.getDefaultModel()).toBe('gpt-4');
    });
  });

  describe('createSession', () => {
    it('should create a session with defaults', () => {
      const sessionId = orchestrator.createSession();

      expect(sessionId).toBeDefined();
      const session = orchestrator.getSession(sessionId);
      expect(session?.provider).toBe('anthropic');
      expect(session?.model).toBe('claude-opus-4-5-20251101');
    });

    it('should create session with custom options', () => {
      const sessionId = orchestrator.createSession({
        title: 'My Session',
        provider: 'openai',
        model: 'gpt-4',
      });

      const session = orchestrator.getSession(sessionId);
      expect(session?.title).toBe('My Session');
      expect(session?.provider).toBe('openai');
    });
  });

  describe('getSession / listSessions', () => {
    it('should get session by ID', () => {
      const id = orchestrator.createSession({ title: 'Test' });
      const session = orchestrator.getSession(id);

      expect(session?.id).toBe(id);
      expect(session?.title).toBe('Test');
    });

    it('should list sessions', () => {
      orchestrator.createSession();
      orchestrator.createSession();
      orchestrator.createSession();

      const sessions = orchestrator.listSessions();
      expect(sessions).toHaveLength(3);
    });
  });

  describe('deleteSession', () => {
    it('should delete a session', () => {
      const id = orchestrator.createSession();
      const deleted = orchestrator.deleteSession(id);

      expect(deleted).toBe(true);
      expect(orchestrator.getSession(id)).toBeNull();
    });
  });

  describe('registerAgent', () => {
    it('should register an agent', () => {
      const agent = orchestrator.registerAgent({
        id: 'claude',
        name: 'Claude',
        role: 'primary',
      });

      expect(agent.id).toBe('claude');
      expect(orchestrator.getAgent('claude')).toBeDefined();
    });
  });

  describe('sendMessage', () => {
    let sessionId: string;

    beforeEach(() => {
      sessionId = orchestrator.createSession();
      orchestrator.registerAgent({
        id: 'claude',
        name: 'Claude',
        role: 'primary',
      });
    });

    it('should fail without executor', async () => {
      await expect(
        orchestrator.sendMessage({
          sessionId,
          content: 'Hello',
        })
      ).rejects.toThrow('No agent executor configured');
    });

    it('should send message and get response', async () => {
      orchestrator.setExecutor(async (agent, _message, context) => ({
        id: 'response-1',
        role: 'assistant',
        content: 'Hello back!',
        timestamp: Date.now(),
        sessionId: context.sessionId,
        agentId: agent.id,
        agentRole: agent.role,
      }));

      const result = await orchestrator.sendMessage({
        sessionId,
        content: 'Hello AI',
      });

      expect(result.userMessage.content).toBe('Hello AI');
      expect(result.assistantMessage.content).toBe('Hello back!');
      expect(result.agent.id).toBe('claude');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should route to mentioned agent', async () => {
      orchestrator.registerAgent({
        id: 'reviewer',
        name: 'Code Reviewer',
        role: 'specialist',
      });

      let calledAgent: string | undefined;
      orchestrator.setExecutor(async (agent) => {
        calledAgent = agent.id;
        return {
          id: 'r1',
          role: 'assistant',
          content: 'Done',
          timestamp: Date.now(),
          sessionId: '',
          agentId: agent.id,
          agentRole: agent.role,
        };
      });

      await orchestrator.sendMessage({
        sessionId,
        content: '@reviewer check this code',
      });

      expect(calledAgent).toBe('reviewer');
    });

    it('should fail for non-existent session', async () => {
      orchestrator.setExecutor(async () => ({
        id: 'r1',
        role: 'assistant',
        content: 'Done',
        timestamp: Date.now(),
        sessionId: '',
        agentId: 'claude',
        agentRole: 'primary',
      }));

      await expect(
        orchestrator.sendMessage({
          sessionId: 'non-existent',
          content: 'Hello',
        })
      ).rejects.toThrow('not found');
    });
  });

  describe('getMessages', () => {
    it('should get messages for a session', async () => {
      const sessionId = orchestrator.createSession();
      orchestrator.registerAgent({ id: 'claude', name: 'Claude', role: 'primary' });

      orchestrator.setExecutor(async () => ({
        id: 'r1',
        role: 'assistant',
        content: 'Response',
        timestamp: Date.now(),
        sessionId: '',
        agentId: 'claude',
        agentRole: 'primary',
      }));

      await orchestrator.sendMessage({ sessionId, content: 'Hello' });

      const messages = orchestrator.getMessages(sessionId);
      expect(messages.length).toBeGreaterThanOrEqual(2); // user + assistant
    });
  });

  describe('permission methods', () => {
    it('should grant and check permissions', () => {
      const perm = orchestrator.grantPermission({
        toolName: 'Bash',
        scope: 'global',
      });

      expect(perm.id).toBeDefined();

      const result = orchestrator.checkPermission('Bash', 'ls');
      expect(result.allowed).toBe(true);
    });

    it('should revoke permissions', () => {
      const perm = orchestrator.grantPermission({
        toolName: 'Write',
        scope: 'global',
      });

      orchestrator.revokePermission(perm.id);

      const result = orchestrator.checkPermission('Write', '/test.txt');
      expect(result.allowed).toBe(false);
    });

    it('should list permissions', () => {
      orchestrator.grantPermission({ toolName: 'Bash', scope: 'global' });
      orchestrator.grantPermission({ toolName: 'Write', scope: 'global' });

      const perms = orchestrator.listPermissions();
      expect(perms).toHaveLength(2);
    });
  });

  describe('todo methods', () => {
    it('should manage todos', () => {
      const sessionId = orchestrator.createSession();

      orchestrator.replaceTodos(sessionId, [
        { id: 't1', content: 'Task 1' },
        { id: 't2', content: 'Task 2' },
      ]);

      const todos = orchestrator.getTodos(sessionId);
      expect(todos).toHaveLength(2);
    });

    it('should update todo status', () => {
      const sessionId = orchestrator.createSession();

      orchestrator.replaceTodos(sessionId, [{ id: 't1', content: 'Task 1' }]);

      const updated = orchestrator.updateTodoStatus('t1', 'completed');
      expect(updated?.status).toBe('completed');
    });
  });

  describe('agent methods', () => {
    it('should list agents', () => {
      orchestrator.registerAgent({ id: 'a1', name: 'Agent 1', role: 'primary' });
      orchestrator.registerAgent({ id: 'a2', name: 'Agent 2', role: 'specialist' });

      expect(orchestrator.listAgents()).toHaveLength(2);
    });

    it('should parse mentions', () => {
      orchestrator.registerAgent({ id: 'claude', name: 'Claude', role: 'primary' });

      const result = orchestrator.parseMentions('@claude help');
      expect(result.mentions).toHaveLength(1);
    });
  });

  describe('buildContext', () => {
    it('should build context for preview', () => {
      const sessionId = orchestrator.createSession({
        systemPrompt: 'Test prompt',
      });

      orchestrator.registerAgent({ id: 'claude', name: 'Claude', role: 'primary' });

      const context = orchestrator.buildContext({
        sessionId,
        agent: orchestrator.getAgent('claude')!,
      });

      expect(context.systemPrompt).toBe('Test prompt');
    });
  });

  describe('getSessionStats', () => {
    it('should return session statistics', async () => {
      const sessionId = orchestrator.createSession();
      orchestrator.registerAgent({ id: 'claude', name: 'Claude', role: 'primary' });

      orchestrator.setExecutor(async () => ({
        id: 'r1',
        role: 'assistant',
        content: 'Response',
        timestamp: Date.now(),
        sessionId: '',
        agentId: 'claude',
        agentRole: 'primary',
        usage: { inputTokens: 10, outputTokens: 20 },
      }));

      await orchestrator.sendMessage({ sessionId, content: 'Hello' });

      const stats = orchestrator.getSessionStats(sessionId);
      expect(stats.messageCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe('getStats', () => {
    it('should return overall statistics', () => {
      orchestrator.createSession();
      orchestrator.createSession();
      orchestrator.registerAgent({ id: 'claude', name: 'Claude', role: 'primary' });

      const stats = orchestrator.getStats();
      expect(stats.sessionCount).toBe(2);
      expect(stats.agentCount).toBe(1);
    });
  });

  describe('model configuration', () => {
    it('should set default model', () => {
      orchestrator.setDefaultModel('gpt-4');
      expect(orchestrator.getDefaultModel()).toBe('gpt-4');
    });

    it('should set default provider', () => {
      orchestrator.setDefaultProvider('openai', false);
      expect(orchestrator.getDefaultProvider()).toBe('openai');
    });

    it('should report initialization state', () => {
      expect(orchestrator.isInitialized()).toBe(false);
    });
  });
});
