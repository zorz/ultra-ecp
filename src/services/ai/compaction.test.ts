import { describe, it, expect, beforeEach } from 'bun:test';
import { CompactionService } from './compaction.ts';
import type { StoredChatMessage } from '../chat/storage.ts';
import type { LocalAIService } from './local.ts';

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

function makeMessages(count: number, sessionId = 'sess-1'): StoredChatMessage[] {
  return Array.from({ length: count }, (_, i) =>
    makeMessage({
      id: `msg-${i}`,
      sessionId,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message number ${i}: ${'x'.repeat(100)}`,
      createdAt: 1000 + i * 100,
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock factories
// ─────────────────────────────────────────────────────────────────────────────

interface MockAIService {
  createSession: ReturnType<typeof import('bun:test').mock>;
  sendMessage: ReturnType<typeof import('bun:test').mock>;
  deleteSession: ReturnType<typeof import('bun:test').mock>;
}

function createMockAIService(summaryText = 'Summary of the conversation.'): MockAIService {
  const { mock } = require('bun:test');
  return {
    createSession: mock(() =>
      Promise.resolve({ id: 'temp-session-1' }),
    ),
    sendMessage: mock(() =>
      Promise.resolve({
        message: {
          content: [{ type: 'text', text: summaryText }],
        },
      }),
    ),
    deleteSession: mock(() => {}),
  };
}

function createMockECPRequest(): ReturnType<typeof import('bun:test').mock> {
  const { mock } = require('bun:test');
  return mock((method: string, _params?: unknown) => {
    if (method === 'chat/compaction/create') {
      return Promise.resolve({ compactionId: 'cmp-new-1' });
    }
    if (method === 'chat/compaction/apply') {
      return Promise.resolve({ success: true, messagesUpdated: 3 });
    }
    return Promise.resolve({});
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CompactionService
// ─────────────────────────────────────────────────────────────────────────────

describe('CompactionService', () => {
  let mockAI: MockAIService;
  let mockECP: ReturnType<typeof createMockECPRequest>;
  let service: CompactionService;

  beforeEach(() => {
    mockAI = createMockAIService();
    mockECP = createMockECPRequest();
    service = new CompactionService(
      mockAI as unknown as LocalAIService,
      mockECP,
    );
  });

  describe('compact()', () => {
    it('compacts messages and returns a result', async () => {
      const messages = makeMessages(15);

      const result = await service.compact({
        sessionId: 'sess-1',
        messages,
        keepRecentCount: 10,
      });

      expect(result.compactionId).toBe('cmp-new-1');
      expect(result.summary).toBe('Summary of the conversation.');
      expect(result.messagesCompacted).toBe(5); // 15 - 10 = 5
      expect(result.originalTokenCount).toBeGreaterThan(0);
      expect(result.compressedTokenCount).toBeGreaterThan(0);
    });

    it('uses default keepRecentCount of 10', async () => {
      const messages = makeMessages(15);

      const result = await service.compact({
        sessionId: 'sess-1',
        messages,
      });

      // Default keepRecentCount = 10, so 15 - 10 = 5 compacted
      expect(result.messagesCompacted).toBe(5);
    });

    it('throws when fewer than 3 messages to compact', async () => {
      const messages = makeMessages(12); // 12 - 10 = 2, less than 3

      await expect(
        service.compact({ sessionId: 'sess-1', messages, keepRecentCount: 10 }),
      ).rejects.toThrow('Not enough messages to compact');
    });

    it('throws when no messages to compact', async () => {
      const messages = makeMessages(5); // 5 - 10 = 0

      await expect(
        service.compact({ sessionId: 'sess-1', messages, keepRecentCount: 10 }),
      ).rejects.toThrow('Not enough messages to compact');
    });

    it('creates a temp AI session for summarization', async () => {
      const messages = makeMessages(15);
      await service.compact({ sessionId: 'sess-1', messages });

      expect(mockAI.createSession).toHaveBeenCalledTimes(1);
      const createArgs = mockAI.createSession.mock.calls[0]![0];
      expect(createArgs.provider.type).toBe('claude');
      expect(createArgs.systemPrompt).toContain('summarizer');
    });

    it('sends summarization prompt to the temp session', async () => {
      const messages = makeMessages(15);
      await service.compact({ sessionId: 'sess-1', messages });

      expect(mockAI.sendMessage).toHaveBeenCalledTimes(1);
      const sendArgs = mockAI.sendMessage.mock.calls[0]![0];
      expect(sendArgs.sessionId).toBe('temp-session-1');
      expect(sendArgs.content).toContain('Summarize this conversation');
      expect(sendArgs.content).toContain('5 messages'); // 15 - 10 = 5
    });

    it('cleans up temp session after compaction', async () => {
      const messages = makeMessages(15);
      await service.compact({ sessionId: 'sess-1', messages });

      expect(mockAI.deleteSession).toHaveBeenCalledTimes(1);
      expect(mockAI.deleteSession).toHaveBeenCalledWith('temp-session-1');
    });

    it('cleans up temp session even on error', async () => {
      const { mock } = require('bun:test');
      mockAI.sendMessage = mock(() => Promise.reject(new Error('AI error')));

      const messages = makeMessages(15);
      await expect(
        service.compact({ sessionId: 'sess-1', messages }),
      ).rejects.toThrow('AI error');

      expect(mockAI.deleteSession).toHaveBeenCalledTimes(1);
    });

    it('calls chat/compaction/create with correct params', async () => {
      const messages = makeMessages(15);
      await service.compact({ sessionId: 'sess-1', messages });

      const createCall = mockECP.mock.calls.find(
        (c: unknown[]) => c[0] === 'chat/compaction/create',
      );
      expect(createCall).toBeDefined();

      const params = createCall![1] as Record<string, unknown>;
      expect(params.sessionId).toBe('sess-1');
      expect(params.summary).toBe('Summary of the conversation.');
      expect(params.startMessageId).toBe('msg-0');
      expect(params.endMessageId).toBe('msg-4'); // 5 messages: 0..4
      expect(params.messagesCompacted).toBe(5);
      expect(params.originalTokenCount).toBeGreaterThan(0);
      expect(params.compressedTokenCount).toBeGreaterThan(0);
    });

    it('calls chat/compaction/apply with correct params', async () => {
      const messages = makeMessages(15);
      await service.compact({ sessionId: 'sess-1', messages });

      const applyCall = mockECP.mock.calls.find(
        (c: unknown[]) => c[0] === 'chat/compaction/apply',
      );
      expect(applyCall).toBeDefined();

      const params = applyCall![1] as Record<string, unknown>;
      expect(params.compactionId).toBe('cmp-new-1');
      expect(params.messageIds).toEqual(['msg-0', 'msg-1', 'msg-2', 'msg-3', 'msg-4']);
    });

    it('throws on empty AI response', async () => {
      const { mock } = require('bun:test');
      mockAI.sendMessage = mock(() =>
        Promise.resolve({
          message: { content: [{ type: 'text', text: '' }] },
        }),
      );

      const messages = makeMessages(15);
      await expect(
        service.compact({ sessionId: 'sess-1', messages }),
      ).rejects.toThrow('AI summarization returned empty response');
    });

    it('throws on whitespace-only AI response', async () => {
      const { mock } = require('bun:test');
      mockAI.sendMessage = mock(() =>
        Promise.resolve({
          message: { content: [{ type: 'text', text: '   \n  ' }] },
        }),
      );

      const messages = makeMessages(15);
      await expect(
        service.compact({ sessionId: 'sess-1', messages }),
      ).rejects.toThrow('AI summarization returned empty response');
    });
  });

  describe('conversation text building', () => {
    it('includes agent attribution when agentName is set', async () => {
      const messages = [
        ...makeMessages(3),
        ...Array.from({ length: 10 }, (_, i) =>
          makeMessage({
            id: `msg-${i + 3}`,
            role: 'assistant',
            content: `Response ${i}`,
            createdAt: 2000 + i * 100,
          }),
        ),
      ];
      // Set agentName on first message to be compacted
      messages[0]!.agentName = 'Atlas';

      await service.compact({ sessionId: 'sess-1', messages });

      const sendArgs = mockAI.sendMessage.mock.calls[0]![0];
      expect(sendArgs.content).toContain('Atlas (user)');
    });

    it('truncates long message content to 1000 chars', async () => {
      const longContent = 'x'.repeat(2000);
      const messages = [
        makeMessage({ id: 'msg-0', content: longContent, createdAt: 1000 }),
        makeMessage({ id: 'msg-1', role: 'assistant', content: 'Reply 1', createdAt: 1100 }),
        makeMessage({ id: 'msg-2', content: 'Question 2', createdAt: 1200 }),
        makeMessage({ id: 'msg-3', role: 'assistant', content: 'Reply 3', createdAt: 1300 }),
        // Keep these recent (not compacted)
        ...Array.from({ length: 10 }, (_, i) =>
          makeMessage({
            id: `msg-${i + 4}`,
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: `Recent ${i}`,
            createdAt: 2000 + i * 100,
          }),
        ),
      ];

      await service.compact({ sessionId: 'sess-1', messages });

      const sendArgs = mockAI.sendMessage.mock.calls[0]![0];
      // Should contain truncation indicator
      expect(sendArgs.content).toContain('...');
      // Should NOT contain the full 2000-char content
      expect(sendArgs.content.length).toBeLessThan(longContent.length);
    });
  });

  describe('keepRecentCount variations', () => {
    it('keeps only 5 recent messages when specified', async () => {
      const messages = makeMessages(20);

      const result = await service.compact({
        sessionId: 'sess-1',
        messages,
        keepRecentCount: 5,
      });

      expect(result.messagesCompacted).toBe(15); // 20 - 5 = 15
    });

    it('compacts all but 1 when keepRecentCount is 1', async () => {
      const messages = makeMessages(10);

      const result = await service.compact({
        sessionId: 'sess-1',
        messages,
        keepRecentCount: 1,
      });

      expect(result.messagesCompacted).toBe(9);
    });

    it('handles keepRecentCount larger than message count', async () => {
      const messages = makeMessages(5);

      await expect(
        service.compact({ sessionId: 'sess-1', messages, keepRecentCount: 20 }),
      ).rejects.toThrow('Not enough messages to compact');
    });
  });

  describe('token estimation', () => {
    it('calculates original token count from compacted messages', async () => {
      const messages = makeMessages(15);
      const result = await service.compact({ sessionId: 'sess-1', messages });

      // Each message is "Message number N: " + 100 'x' chars = ~130 chars
      // 5 messages * ~130 chars / 4 chars per token ≈ 163 tokens
      expect(result.originalTokenCount).toBeGreaterThan(100);
    });

    it('calculates compressed token count from summary', async () => {
      const messages = makeMessages(15);
      const result = await service.compact({ sessionId: 'sess-1', messages });

      // "Summary of the conversation." = 28 chars / 4 = 7 tokens
      expect(result.compressedTokenCount).toBe(Math.ceil(28 / 4));
    });

    it('compressed is smaller than original for typical compaction', async () => {
      const messages = makeMessages(15);
      const result = await service.compact({ sessionId: 'sess-1', messages });

      expect(result.compressedTokenCount).toBeLessThan(result.originalTokenCount);
    });
  });

  describe('error handling', () => {
    it('propagates AI session creation errors', async () => {
      const { mock } = require('bun:test');
      mockAI.createSession = mock(() =>
        Promise.reject(new Error('Rate limited')),
      );

      const messages = makeMessages(15);
      await expect(
        service.compact({ sessionId: 'sess-1', messages }),
      ).rejects.toThrow('Rate limited');
    });

    it('propagates ECP create errors', async () => {
      const { mock } = require('bun:test');
      mockECP = mock((method: string) => {
        if (method === 'chat/compaction/create') {
          return Promise.reject(new Error('DB write failed'));
        }
        return Promise.resolve({});
      });
      service = new CompactionService(
        mockAI as unknown as LocalAIService,
        mockECP,
      );

      const messages = makeMessages(15);
      await expect(
        service.compact({ sessionId: 'sess-1', messages }),
      ).rejects.toThrow('DB write failed');
    });

    it('propagates ECP apply errors', async () => {
      const { mock } = require('bun:test');
      mockECP = mock((method: string) => {
        if (method === 'chat/compaction/create') {
          return Promise.resolve({ compactionId: 'cmp-1' });
        }
        if (method === 'chat/compaction/apply') {
          return Promise.reject(new Error('Apply failed'));
        }
        return Promise.resolve({});
      });
      service = new CompactionService(
        mockAI as unknown as LocalAIService,
        mockECP,
      );

      const messages = makeMessages(15);
      await expect(
        service.compact({ sessionId: 'sess-1', messages }),
      ).rejects.toThrow('Apply failed');
    });

    it('ignores deleteSession errors during cleanup', async () => {
      const { mock } = require('bun:test');
      mockAI.deleteSession = mock(() => {
        throw new Error('Delete failed');
      });

      const messages = makeMessages(15);
      // Should NOT throw despite deleteSession error
      const result = await service.compact({ sessionId: 'sess-1', messages });
      expect(result.compactionId).toBe('cmp-new-1');
    });
  });

  describe('multi-content-block response', () => {
    it('joins multiple text blocks with newlines', async () => {
      const { mock } = require('bun:test');
      mockAI.sendMessage = mock(() =>
        Promise.resolve({
          message: {
            content: [
              { type: 'text', text: 'First part' },
              { type: 'text', text: 'Second part' },
            ],
          },
        }),
      );

      const messages = makeMessages(15);
      const result = await service.compact({ sessionId: 'sess-1', messages });

      expect(result.summary).toBe('First part\nSecond part');
    });

    it('filters out non-text content blocks', async () => {
      const { mock } = require('bun:test');
      mockAI.sendMessage = mock(() =>
        Promise.resolve({
          message: {
            content: [
              { type: 'tool_use', id: 'tu-1', name: 'foo', input: {} },
              { type: 'text', text: 'Summary text' },
            ],
          },
        }),
      );

      const messages = makeMessages(15);
      const result = await service.compact({ sessionId: 'sess-1', messages });

      expect(result.summary).toBe('Summary text');
    });
  });
});
