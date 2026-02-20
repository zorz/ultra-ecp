import { describe, it, expect } from 'bun:test';
import {
  estimateTokens,
  RollingContextWindow,
  ContextWindowService,
  type ContextBuildParams,
  type ContextWindowStrategy,
  type CuratedContext,
} from './context-window.ts';
import type { StoredChatMessage, StoredCompaction } from '../chat/storage.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<StoredChatMessage> & { id: string }): StoredChatMessage {
  return {
    sessionId: 'sess-1',
    role: 'user',
    content: 'Hello world',
    model: null,
    inputTokens: null,
    outputTokens: null,
    durationMs: null,
    agentId: null,
    agentName: null,
    agentRole: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeCompaction(overrides: Partial<StoredCompaction> & { id: string }): StoredCompaction {
  return {
    sessionId: 'sess-1',
    summary: 'Summary of earlier messages',
    startMessageId: 'msg-1',
    endMessageId: 'msg-3',
    messageCount: 3,
    tokensBefore: 500,
    tokensAfter: 100,
    createdAt: Date.now(),
    isActive: true,
    expandedAt: null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// estimateTokens
// ─────────────────────────────────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('estimates ~4 chars per token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('a')).toBe(1); // ceil(0.25) = 1
  });

  it('handles empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('rounds up', () => {
    expect(estimateTokens('abcde')).toBe(2); // ceil(5/4) = 2
    expect(estimateTokens('abcdefg')).toBe(2); // ceil(7/4) = 2
  });

  it('handles long strings', () => {
    const text = 'a'.repeat(1000);
    expect(estimateTokens(text)).toBe(250);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RollingContextWindow
// ─────────────────────────────────────────────────────────────────────────────

describe('RollingContextWindow', () => {
  const strategy = new RollingContextWindow();

  it('has name "rolling"', () => {
    expect(strategy.name).toBe('rolling');
  });

  describe('basic context building', () => {
    it('includes all messages when under budget', () => {
      const messages = [
        makeMessage({ id: 'msg-1', role: 'user', content: 'Hello', createdAt: 1000 }),
        makeMessage({ id: 'msg-2', role: 'assistant', content: 'Hi there, how can I help?', createdAt: 2000 }),
        makeMessage({ id: 'msg-3', role: 'user', content: 'Can you help me code?', createdAt: 3000 }),
      ];

      const result = strategy.buildContext({
        systemPrompt: 'You are helpful.',
        activeMessages: messages,
        compactions: [],
        contextWindow: 200000,
      });

      expect(result.messagesLoaded).toBe(3);
      expect(result.messages.length).toBe(3);
      expect(result.compactionsApplied).toBe(0);
      expect(result.exceedsWindow).toBe(false);
      expect(result.contextWindow).toBe(200000);
      expect(result.totalTokens).toBeGreaterThan(0);
    });

    it('preserves chronological order', () => {
      const messages = [
        makeMessage({ id: 'msg-1', role: 'user', content: 'First message', createdAt: 1000 }),
        makeMessage({ id: 'msg-2', role: 'assistant', content: 'Second message', createdAt: 2000 }),
        makeMessage({ id: 'msg-3', role: 'user', content: 'Third message', createdAt: 3000 }),
      ];

      const result = strategy.buildContext({
        systemPrompt: 'System',
        activeMessages: messages,
        compactions: [],
        contextWindow: 200000,
      });

      expect(result.messages[0]!.id).toBe('msg-1');
      expect(result.messages[1]!.id).toBe('msg-2');
      expect(result.messages[2]!.id).toBe('msg-3');
    });

    it('returns empty messages when no active messages', () => {
      const result = strategy.buildContext({
        systemPrompt: 'System prompt',
        activeMessages: [],
        compactions: [],
        contextWindow: 200000,
      });

      expect(result.messages.length).toBe(0);
      expect(result.messagesLoaded).toBe(0);
    });
  });

  describe('message filtering', () => {
    it('filters out empty content messages', () => {
      const messages = [
        makeMessage({ id: 'msg-1', role: 'user', content: 'Valid', createdAt: 1000 }),
        makeMessage({ id: 'msg-2', role: 'assistant', content: '', createdAt: 2000 }),
        makeMessage({ id: 'msg-3', role: 'user', content: '   ', createdAt: 3000 }),
      ];

      const result = strategy.buildContext({
        systemPrompt: 'System',
        activeMessages: messages,
        compactions: [],
        contextWindow: 200000,
      });

      expect(result.messagesLoaded).toBe(1);
      expect(result.messages[0]!.id).toBe('msg-1');
    });

    it('filters out "(No response)" placeholder', () => {
      const messages = [
        makeMessage({ id: 'msg-1', role: 'user', content: 'Hello', createdAt: 1000 }),
        makeMessage({ id: 'msg-2', role: 'assistant', content: '(No response)', createdAt: 2000 }),
      ];

      const result = strategy.buildContext({
        systemPrompt: 'System',
        activeMessages: messages,
        compactions: [],
        contextWindow: 200000,
      });

      expect(result.messagesLoaded).toBe(1);
    });

    it('filters out very short assistant messages', () => {
      const messages = [
        makeMessage({ id: 'msg-1', role: 'user', content: 'Hello', createdAt: 1000 }),
        makeMessage({ id: 'msg-2', role: 'assistant', content: 'OK', createdAt: 2000 }), // < 5 chars
        makeMessage({ id: 'msg-3', role: 'assistant', content: 'Sure, I can help you with that!', createdAt: 3000 }),
      ];

      const result = strategy.buildContext({
        systemPrompt: 'System',
        activeMessages: messages,
        compactions: [],
        contextWindow: 200000,
      });

      expect(result.messagesLoaded).toBe(2);
      expect(result.messages.map(m => m.id)).toEqual(['msg-1', 'msg-3']);
    });

    it('keeps short user messages (only filters short assistant)', () => {
      const messages = [
        makeMessage({ id: 'msg-1', role: 'user', content: 'Hi', createdAt: 1000 }),
        makeMessage({ id: 'msg-2', role: 'assistant', content: 'Hello! How can I help?', createdAt: 2000 }),
      ];

      const result = strategy.buildContext({
        systemPrompt: 'System',
        activeMessages: messages,
        compactions: [],
        contextWindow: 200000,
      });

      expect(result.messagesLoaded).toBe(2);
    });

    it('includes agent metadata when agentName is set', () => {
      const messages = [
        makeMessage({
          id: 'msg-1',
          role: 'assistant',
          content: 'I am Atlas, your coding assistant.',
          agentName: 'Atlas',
          agentId: 'agent-1',
          createdAt: 1000,
        }),
      ];

      const result = strategy.buildContext({
        systemPrompt: 'System',
        activeMessages: messages,
        compactions: [],
        contextWindow: 200000,
      });

      expect(result.messages[0]!.metadata).toEqual({ agentName: 'Atlas', agentId: 'agent-1' });
    });
  });

  describe('compaction interleaving', () => {
    it('includes applied compaction summaries as system messages', () => {
      // Compaction covers msg-1 through msg-3 (not in active list)
      const compaction = makeCompaction({
        id: 'cmp-1',
        startMessageId: 'msg-1',
        endMessageId: 'msg-3',
        summary: 'User discussed file refactoring with assistant.',
        createdAt: 1000,
      });

      // Active messages are only msg-4 and msg-5 (after compaction)
      const messages = [
        makeMessage({ id: 'msg-4', role: 'user', content: 'Now lets work on tests', createdAt: 4000 }),
        makeMessage({ id: 'msg-5', role: 'assistant', content: 'Sure, I will write tests.', createdAt: 5000 }),
      ];

      const result = strategy.buildContext({
        systemPrompt: 'System',
        activeMessages: messages,
        compactions: [compaction],
        contextWindow: 200000,
      });

      expect(result.compactionsApplied).toBe(1);
      expect(result.messagesLoaded).toBe(2);
      expect(result.messages.length).toBe(3); // 1 compaction summary + 2 messages

      // Compaction summary should come first (oldest timestamp)
      const first = result.messages[0]!;
      expect(first.id).toBe('compaction-cmp-1');
      expect(first.role).toBe('system');
      const textContent = first.content[0]!;
      expect(textContent.type).toBe('text');
      expect((textContent as { type: 'text'; text: string }).text).toContain('[Summary of earlier conversation]');
      expect((textContent as { type: 'text'; text: string }).text).toContain('file refactoring');
    });

    it('skips compactions whose start message is still in active list (not applied)', () => {
      const compaction = makeCompaction({
        id: 'cmp-1',
        startMessageId: 'msg-1', // msg-1 IS in active list → compaction not applied
        endMessageId: 'msg-3',
        createdAt: 500,
      });

      const messages = [
        makeMessage({ id: 'msg-1', role: 'user', content: 'Hello', createdAt: 1000 }),
        makeMessage({ id: 'msg-2', role: 'assistant', content: 'Hi there friend!', createdAt: 2000 }),
        makeMessage({ id: 'msg-3', role: 'user', content: 'Help me', createdAt: 3000 }),
      ];

      const result = strategy.buildContext({
        systemPrompt: 'System',
        activeMessages: messages,
        compactions: [compaction],
        contextWindow: 200000,
      });

      expect(result.compactionsApplied).toBe(0);
      expect(result.messagesLoaded).toBe(3);
      expect(result.messages.length).toBe(3); // No compaction summary
    });

    it('skips inactive compactions', () => {
      const compaction = makeCompaction({
        id: 'cmp-1',
        startMessageId: 'msg-old',
        isActive: false, // Expanded / not active
        createdAt: 500,
      });

      const messages = [
        makeMessage({ id: 'msg-4', role: 'user', content: 'Hello', createdAt: 4000 }),
      ];

      const result = strategy.buildContext({
        systemPrompt: 'System',
        activeMessages: messages,
        compactions: [compaction],
        contextWindow: 200000,
      });

      expect(result.compactionsApplied).toBe(0);
    });

    it('interleaves multiple compactions chronologically with messages', () => {
      const compactions = [
        makeCompaction({
          id: 'cmp-1',
          startMessageId: 'old-1',
          endMessageId: 'old-3',
          summary: 'First batch summary',
          createdAt: 1000,
        }),
        makeCompaction({
          id: 'cmp-2',
          startMessageId: 'old-4',
          endMessageId: 'old-6',
          summary: 'Second batch summary',
          createdAt: 3000,
        }),
      ];

      const messages = [
        makeMessage({ id: 'msg-7', role: 'user', content: 'Latest message here', createdAt: 5000 }),
      ];

      const result = strategy.buildContext({
        systemPrompt: 'System',
        activeMessages: messages,
        compactions,
        contextWindow: 200000,
      });

      expect(result.compactionsApplied).toBe(2);
      expect(result.messages.length).toBe(3);
      expect(result.messages[0]!.id).toBe('compaction-cmp-1');
      expect(result.messages[1]!.id).toBe('compaction-cmp-2');
      expect(result.messages[2]!.id).toBe('msg-7');
    });
  });

  describe('budget management', () => {
    it('trims oldest messages when over budget', () => {
      // Create messages that exceed a small context window
      const longContent = 'x'.repeat(400); // 100 tokens each
      const messages = Array.from({ length: 10 }, (_, i) =>
        makeMessage({
          id: `msg-${i}`,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Message ${i}: ${longContent}`,
          createdAt: i * 1000,
        }),
      );

      // Very small window: 500 tokens total
      // Head (system prompt) ~4 tokens, response reserve ~125 tokens (25%)
      // Budget = 500 - 4 - 125 = 371 tokens → fits ~3.5 messages of ~105 tokens each
      const result = strategy.buildContext({
        systemPrompt: 'Test',
        activeMessages: messages,
        compactions: [],
        contextWindow: 500,
      });

      expect(result.messagesLoaded).toBeLessThan(10);
      expect(result.messagesLoaded).toBeGreaterThan(0);
      // Should keep the most recent messages (trimmed from front)
      const lastMsg = result.messages[result.messages.length - 1]!;
      expect(lastMsg.id).toBe('msg-9');
    });

    it('response reserve caps at 8000 tokens', () => {
      const messages = [
        makeMessage({ id: 'msg-1', role: 'user', content: 'Hello', createdAt: 1000 }),
      ];

      // Very large window: 200k tokens → 25% = 50000, but capped at 8000
      const result = strategy.buildContext({
        systemPrompt: 'System',
        activeMessages: messages,
        compactions: [],
        contextWindow: 200000,
      });

      // With 200k window, head ~2 tokens, reserve = 8000, budget = 200000 - 2 - 8000 = 191998
      // Should not exceed window
      expect(result.exceedsWindow).toBe(false);
    });

    it('sets exceedsWindow=true when content exceeds budget', () => {
      const hugeContent = 'x'.repeat(4000); // 1000 tokens
      const messages = [
        makeMessage({ id: 'msg-1', role: 'user', content: hugeContent, createdAt: 1000 }),
      ];

      // Tiny window that can't fit even one message
      // contextWindow=100, head~2, reserve=25, budget=73
      // But there's only 1 message so the loop doesn't trim it (length > 1 guard)
      // totalTokens = head(2) + torso(1000) = 1002
      // 1002 + 25 > 100 → exceedsWindow = true
      const result = strategy.buildContext({
        systemPrompt: 'Hi',
        activeMessages: messages,
        compactions: [],
        contextWindow: 100,
      });

      expect(result.exceedsWindow).toBe(true);
    });
  });

  describe('tail instructions', () => {
    it('appends tail instructions as system message', () => {
      const messages = [
        makeMessage({ id: 'msg-1', role: 'user', content: 'Hello', createdAt: 1000 }),
      ];

      const result = strategy.buildContext({
        systemPrompt: 'System',
        activeMessages: messages,
        compactions: [],
        contextWindow: 200000,
        tailInstructions: 'Always respond in JSON format.',
      });

      const lastMsg = result.messages[result.messages.length - 1]!;
      expect(lastMsg.id).toBe('context-tail');
      expect(lastMsg.role).toBe('system');
      const textContent = lastMsg.content[0] as { type: 'text'; text: string };
      expect(textContent.text).toBe('Always respond in JSON format.');
    });

    it('reserves budget for tail instructions', () => {
      const longTail = 'x'.repeat(200); // 50 tokens
      const longContent = 'y'.repeat(400); // 100 tokens each
      const messages = Array.from({ length: 5 }, (_, i) =>
        makeMessage({
          id: `msg-${i}`,
          role: 'user',
          content: longContent,
          createdAt: i * 1000,
        }),
      );

      const resultWithTail = strategy.buildContext({
        systemPrompt: 'S',
        activeMessages: messages,
        compactions: [],
        contextWindow: 500,
        tailInstructions: longTail,
      });

      const resultWithoutTail = strategy.buildContext({
        systemPrompt: 'S',
        activeMessages: messages,
        compactions: [],
        contextWindow: 500,
      });

      // With tail, fewer messages should fit
      expect(resultWithTail.messagesLoaded).toBeLessThanOrEqual(resultWithoutTail.messagesLoaded);
    });
  });

  describe('message conversion', () => {
    it('converts StoredChatMessage to ChatMessage with text content block', () => {
      const messages = [
        makeMessage({ id: 'msg-1', role: 'user', content: 'Test message', createdAt: 1000 }),
      ];

      const result = strategy.buildContext({
        systemPrompt: 'System',
        activeMessages: messages,
        compactions: [],
        contextWindow: 200000,
      });

      const msg = result.messages[0]!;
      expect(msg.id).toBe('msg-1');
      expect(msg.role).toBe('user');
      expect(msg.content).toEqual([{ type: 'text', text: 'Test message' }]);
      expect(msg.timestamp).toBe(1000);
    });

    it('includes system role messages', () => {
      const messages = [
        makeMessage({ id: 'msg-1', role: 'system', content: 'You are a helpful assistant.', createdAt: 1000 }),
        makeMessage({ id: 'msg-2', role: 'user', content: 'Hello', createdAt: 2000 }),
      ];

      const result = strategy.buildContext({
        systemPrompt: 'System',
        activeMessages: messages,
        compactions: [],
        contextWindow: 200000,
      });

      expect(result.messagesLoaded).toBe(2);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ContextWindowService
// ─────────────────────────────────────────────────────────────────────────────

describe('ContextWindowService', () => {
  it('defaults to RollingContextWindow strategy', () => {
    const service = new ContextWindowService();
    expect(service.getStrategyName()).toBe('rolling');
  });

  it('delegates to strategy', () => {
    const service = new ContextWindowService();
    const result = service.buildContext({
      systemPrompt: 'Test',
      activeMessages: [
        makeMessage({ id: 'msg-1', role: 'user', content: 'Hello', createdAt: 1000 }),
      ],
      compactions: [],
      contextWindow: 200000,
    });

    expect(result.messagesLoaded).toBe(1);
  });

  it('allows swapping strategy', () => {
    const service = new ContextWindowService();
    expect(service.getStrategyName()).toBe('rolling');

    const customStrategy: ContextWindowStrategy = {
      name: 'custom',
      buildContext(params: ContextBuildParams): CuratedContext {
        return {
          messages: [],
          totalTokens: 0,
          contextWindow: params.contextWindow,
          messagesLoaded: 0,
          compactionsApplied: 0,
          exceedsWindow: false,
        };
      },
    };

    service.setStrategy(customStrategy);
    expect(service.getStrategyName()).toBe('custom');

    const result = service.buildContext({
      systemPrompt: 'Test',
      activeMessages: [makeMessage({ id: 'msg-1', content: 'Hello', createdAt: 1000 })],
      compactions: [],
      contextWindow: 200000,
    });

    expect(result.messagesLoaded).toBe(0); // Custom strategy returns 0
  });

  it('accepts custom strategy in constructor', () => {
    const custom: ContextWindowStrategy = {
      name: 'test-strategy',
      buildContext(): CuratedContext {
        return {
          messages: [],
          totalTokens: 42,
          contextWindow: 100,
          messagesLoaded: 0,
          compactionsApplied: 0,
          exceedsWindow: false,
        };
      },
    };

    const service = new ContextWindowService(custom);
    expect(service.getStrategyName()).toBe('test-strategy');
    expect(service.buildContext({
      systemPrompt: '',
      activeMessages: [],
      compactions: [],
      contextWindow: 100,
    }).totalTokens).toBe(42);
  });
});
