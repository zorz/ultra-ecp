/**
 * Agent Session Registry Unit Tests
 *
 * Tests for the AgentSessionRegistry which manages per-agent AI sessions.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { AgentSessionRegistry } from '../../../src/services/ai/agent-session-registry.ts';
import type { IAgentConfig } from '../../../src/services/chat/types/agents.ts';

// Mock LocalAIService
function createMockService() {
  let sessionCounter = 0;
  const sessions = new Map<string, { id: string; messages: any[] }>();

  return {
    createSession: mock(async (options: any) => {
      const id = `session-${++sessionCounter}`;
      sessions.set(id, { id, messages: [] });
      return { id, ...options };
    }),
    addMessage: mock((sessionId: string, message: any) => {
      const session = sessions.get(sessionId);
      if (session) session.messages.push(message);
    }),
    deleteSession: mock((sessionId: string) => {
      sessions.delete(sessionId);
    }),
    getToolsForProvider: mock((_providerType: string) => {
      return [
        { name: 'Read', description: 'Read files', ecpMethod: 'file/read', inputSchema: { type: 'object' as const, properties: {} } },
        { name: 'Write', description: 'Write files', ecpMethod: 'file/write', inputSchema: { type: 'object' as const, properties: {} } },
        { name: 'Bash', description: 'Run commands', ecpMethod: 'terminal/execute', inputSchema: { type: 'object' as const, properties: {} } },
        { name: 'Glob', description: 'Find files', ecpMethod: 'file/glob', inputSchema: { type: 'object' as const, properties: {} } },
      ];
    }),
    _sessions: sessions,
  };
}

// Mock agent configs
const agentConfigs: Record<string, IAgentConfig> = {
  coder: {
    id: 'coder',
    name: 'Coder',
    role: 'specialist',
    description: 'Writes code',
    systemPrompt: 'You are a coder.',
    model: 'claude-sonnet-4-20250514',
  },
  reviewer: {
    id: 'reviewer',
    name: 'Reviewer',
    role: 'reviewer',
    description: 'Reviews code',
    allowedTools: ['Read', 'Glob'],
  },
  'gpt-agent': {
    id: 'gpt-agent',
    name: 'GPT Agent',
    role: 'specialist',
    model: 'gpt-4o',
  },
  'gemini-agent': {
    id: 'gemini-agent',
    name: 'Gemini Agent',
    role: 'specialist',
    model: 'gemini-2.0-flash',
  },
  'llama-agent': {
    id: 'llama-agent',
    name: 'Llama Agent',
    role: 'specialist',
    model: 'llama-3.1-70b',
  },
};

describe('AgentSessionRegistry', () => {
  let service: ReturnType<typeof createMockService>;
  let registry: AgentSessionRegistry;

  beforeEach(() => {
    service = createMockService();
    registry = new AgentSessionRegistry(
      service as any,
      (agentId: string) => agentConfigs[agentId],
      '/workspace',
    );
  });

  describe('getOrCreateSession', () => {
    it('should create new session for unknown agent', async () => {
      const entry = await registry.getOrCreateSession(
        'chat-1', 'coder',
        { type: 'claude' },
      );

      expect(entry.aiSessionId).toBeDefined();
      expect(entry.agentId).toBe('coder');
      expect(entry.chatSessionId).toBe('chat-1');
      expect(entry.messageCount).toBe(0);
      expect(service.createSession).toHaveBeenCalledTimes(1);
    });

    it('should return existing session and update lastUsedAt', async () => {
      const first = await registry.getOrCreateSession(
        'chat-1', 'coder',
        { type: 'claude' },
      );

      // Wait a tick so lastUsedAt differs
      await new Promise(r => setTimeout(r, 5));

      const second = await registry.getOrCreateSession(
        'chat-1', 'coder',
        { type: 'claude' },
      );

      expect(second.aiSessionId).toBe(first.aiSessionId);
      expect(second.lastUsedAt).toBeGreaterThanOrEqual(first.lastUsedAt);
      // Should only create one session
      expect(service.createSession).toHaveBeenCalledTimes(1);
    });

    it('should inject transcript context into existing session', async () => {
      await registry.getOrCreateSession('chat-1', 'coder', { type: 'claude' });

      await registry.getOrCreateSession(
        'chat-1', 'coder',
        { type: 'claude' },
        'User asked about authentication.',
      );

      expect(service.addMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('setAvailableAgents', () => {
    it('should use buildWorkflowAgentSystemPrompt when >1 agent', async () => {
      registry.setAvailableAgents([
        { id: 'coder', name: 'Coder', role: 'specialist' },
        { id: 'reviewer', name: 'Reviewer', role: 'reviewer' },
      ]);

      await registry.getOrCreateSession('chat-1', 'coder', { type: 'claude' });

      // The system prompt should contain delegation info
      const createCall = (service.createSession as any).mock.calls[0];
      const options = createCall[0];
      expect(options.systemPrompt).toContain('Available Agents for Delegation');
    });

    it('should use buildAgentSystemPrompt when 0 or 1 agent', async () => {
      registry.setAvailableAgents([
        { id: 'coder', name: 'Coder', role: 'specialist' },
      ]);

      await registry.getOrCreateSession('chat-1', 'coder', { type: 'claude' });

      const createCall = (service.createSession as any).mock.calls[0];
      const options = createCall[0];
      expect(options.systemPrompt).not.toContain('Available Agents for Delegation');
    });
  });

  describe('resolveProviderAndModel', () => {
    it('should resolve claude model strings to claude provider', async () => {
      await registry.getOrCreateSession('chat-1', 'coder', { type: 'claude' });

      const createCall = (service.createSession as any).mock.calls[0];
      const options = createCall[0];
      expect(options.provider.type).toBe('claude');
      expect(options.provider.model).toBe('claude-sonnet-4-20250514');
    });

    it('should resolve gpt model strings to openai provider', async () => {
      await registry.getOrCreateSession('chat-1', 'gpt-agent', { type: 'claude' });

      const createCall = (service.createSession as any).mock.calls[0];
      const options = createCall[0];
      expect(options.provider.type).toBe('openai');
      expect(options.provider.model).toBe('gpt-4o');
    });

    it('should resolve gemini model strings to gemini provider', async () => {
      await registry.getOrCreateSession('chat-1', 'gemini-agent', { type: 'claude' });

      const createCall = (service.createSession as any).mock.calls[0];
      const options = createCall[0];
      expect(options.provider.type).toBe('gemini');
    });

    it('should resolve llama model strings to ollama provider', async () => {
      await registry.getOrCreateSession('chat-1', 'llama-agent', { type: 'claude' });

      const createCall = (service.createSession as any).mock.calls[0];
      const options = createCall[0];
      expect(options.provider.type).toBe('ollama');
    });

    it('should use fallback provider when no agent config model', async () => {
      await registry.getOrCreateSession('chat-1', 'unknown-agent', { type: 'openai', model: 'gpt-4' });

      const createCall = (service.createSession as any).mock.calls[0];
      const options = createCall[0];
      expect(options.provider.type).toBe('openai');
      expect(options.provider.model).toBe('gpt-4');
    });
  });

  describe('filterToolsForAgent', () => {
    it('should respect allowedTools list', async () => {
      await registry.getOrCreateSession('chat-1', 'reviewer', { type: 'claude' });

      const createCall = (service.createSession as any).mock.calls[0];
      const options = createCall[0];
      const toolNames = options.tools.map((t: any) => t.name);

      expect(toolNames).toContain('Read');
      expect(toolNames).toContain('Glob');
      expect(toolNames).not.toContain('Write');
      expect(toolNames).not.toContain('Bash');
    });

    it('should return all tools when no filter specified', async () => {
      await registry.getOrCreateSession('chat-1', 'coder', { type: 'claude' });

      const createCall = (service.createSession as any).mock.calls[0];
      const options = createCall[0];

      expect(options.tools.length).toBe(4); // All 4 mock tools
    });
  });

  describe('deleteChatSessions', () => {
    it('should clean up all sessions for a chat', async () => {
      await registry.getOrCreateSession('chat-1', 'coder', { type: 'claude' });
      await registry.getOrCreateSession('chat-1', 'reviewer', { type: 'claude' });

      registry.deleteChatSessions('chat-1');

      expect(service.deleteSession).toHaveBeenCalledTimes(2);
      expect(registry.listSessions('chat-1')).toHaveLength(0);
    });

    it('should not affect other chats', async () => {
      await registry.getOrCreateSession('chat-1', 'coder', { type: 'claude' });
      await registry.getOrCreateSession('chat-2', 'coder', { type: 'claude' });

      registry.deleteChatSessions('chat-1');

      expect(registry.listSessions('chat-2')).toHaveLength(1);
    });
  });

  describe('deleteAllSessionsForAgent', () => {
    it('should clean up across all chats', async () => {
      await registry.getOrCreateSession('chat-1', 'coder', { type: 'claude' });
      await registry.getOrCreateSession('chat-2', 'coder', { type: 'claude' });
      await registry.getOrCreateSession('chat-1', 'reviewer', { type: 'claude' });

      registry.deleteAllSessionsForAgent('coder');

      expect(service.deleteSession).toHaveBeenCalledTimes(2);
      // Reviewer should still exist
      expect(registry.listSessions('chat-1')).toHaveLength(1);
      expect(registry.listSessions('chat-1')[0].agentId).toBe('reviewer');
    });
  });

  describe('getSession and listSessions', () => {
    it('should return undefined for non-existent session', () => {
      expect(registry.getSession('chat-1', 'unknown')).toBeUndefined();
    });

    it('should list all sessions for a chat', async () => {
      await registry.getOrCreateSession('chat-1', 'coder', { type: 'claude' });
      await registry.getOrCreateSession('chat-1', 'reviewer', { type: 'claude' });

      const sessions = registry.listSessions('chat-1');

      expect(sessions).toHaveLength(2);
      const agentIds = sessions.map(s => s.agentId);
      expect(agentIds).toContain('coder');
      expect(agentIds).toContain('reviewer');
    });

    it('should return empty array for unknown chat', () => {
      expect(registry.listSessions('unknown-chat')).toHaveLength(0);
    });
  });
});
