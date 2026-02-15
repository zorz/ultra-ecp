/**
 * AI Types Unit Tests
 *
 * Tests for AI type helper functions.
 */

import { describe, it, expect } from 'bun:test';
import {
  createTextMessage,
  getMessageText,
  getToolUses,
  generateMessageId,
  generateSessionId,
  generateToolUseId,
  type ChatMessage,
} from '../../../src/services/ai/types.ts';

describe('AI Types', () => {
  describe('createTextMessage', () => {
    it('should create a text message with required fields', () => {
      const message = createTextMessage('user', 'Hello, world!');

      expect(message.role).toBe('user');
      expect(message.content.length).toBe(1);
      expect(message.content[0]!.type).toBe('text');
      expect((message.content[0] as { type: 'text'; text: string }).text).toBe('Hello, world!');
      expect(message.id).toBeDefined();
      expect(message.timestamp).toBeDefined();
    });

    it('should create message with custom ID', () => {
      const message = createTextMessage('assistant', 'Response', 'custom-id-123');

      expect(message.id).toBe('custom-id-123');
    });

    it('should handle different roles', () => {
      const userMsg = createTextMessage('user', 'User message');
      const assistantMsg = createTextMessage('assistant', 'Assistant message');
      const systemMsg = createTextMessage('system', 'System message');

      expect(userMsg.role).toBe('user');
      expect(assistantMsg.role).toBe('assistant');
      expect(systemMsg.role).toBe('system');
    });

    it('should set timestamp to current time', () => {
      const before = Date.now();
      const message = createTextMessage('user', 'Test');
      const after = Date.now();

      expect(message.timestamp).toBeGreaterThanOrEqual(before);
      expect(message.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('getMessageText', () => {
    it('should extract text from single text content', () => {
      const message: ChatMessage = {
        id: 'msg-1',
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
        timestamp: Date.now(),
      };

      expect(getMessageText(message)).toBe('Hello');
    });

    it('should concatenate multiple text blocks', () => {
      const message: ChatMessage = {
        id: 'msg-1',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Line 1' },
          { type: 'text', text: 'Line 2' },
        ],
        timestamp: Date.now(),
      };

      expect(getMessageText(message)).toBe('Line 1\nLine 2');
    });

    it('should ignore non-text content', () => {
      const message: ChatMessage = {
        id: 'msg-1',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Before' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/test' } },
          { type: 'text', text: 'After' },
        ],
        timestamp: Date.now(),
      };

      expect(getMessageText(message)).toBe('Before\nAfter');
    });

    it('should return empty string for no text content', () => {
      const message: ChatMessage = {
        id: 'msg-1',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
        ],
        timestamp: Date.now(),
      };

      expect(getMessageText(message)).toBe('');
    });
  });

  describe('getToolUses', () => {
    it('should extract tool uses from message', () => {
      const message: ChatMessage = {
        id: 'msg-1',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me read that file' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/test.txt' } },
        ],
        timestamp: Date.now(),
      };

      const toolUses = getToolUses(message);

      expect(toolUses.length).toBe(1);
      expect(toolUses[0]!.name).toBe('Read');
      expect(toolUses[0]!.id).toBe('tool-1');
    });

    it('should extract multiple tool uses', () => {
      const message: ChatMessage = {
        id: 'msg-1',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/a.txt' } },
          { type: 'tool_use', id: 'tool-2', name: 'Write', input: { file_path: '/b.txt', content: 'data' } },
        ],
        timestamp: Date.now(),
      };

      const toolUses = getToolUses(message);

      expect(toolUses.length).toBe(2);
      expect(toolUses[0]!.name).toBe('Read');
      expect(toolUses[1]!.name).toBe('Write');
    });

    it('should return empty array for no tool uses', () => {
      const message: ChatMessage = {
        id: 'msg-1',
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
        timestamp: Date.now(),
      };

      expect(getToolUses(message)).toEqual([]);
    });
  });

  describe('generateMessageId', () => {
    it('should generate unique IDs', () => {
      const id1 = generateMessageId();
      const id2 = generateMessageId();

      expect(id1).not.toBe(id2);
    });

    it('should start with msg- prefix', () => {
      const id = generateMessageId();

      expect(id.startsWith('msg-')).toBe(true);
    });

    it('should include timestamp', () => {
      const before = Date.now();
      const id = generateMessageId();
      const after = Date.now();

      // Extract timestamp from ID
      const parts = id.split('-');
      const timestamp = parseInt(parts[1]!, 10);

      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('generateSessionId', () => {
    it('should generate unique IDs', () => {
      const id1 = generateSessionId();
      const id2 = generateSessionId();

      expect(id1).not.toBe(id2);
    });

    it('should start with session- prefix', () => {
      const id = generateSessionId();

      expect(id.startsWith('session-')).toBe(true);
    });
  });

  describe('generateToolUseId', () => {
    it('should generate unique IDs', () => {
      const id1 = generateToolUseId();
      const id2 = generateToolUseId();

      expect(id1).not.toBe(id2);
    });

    it('should start with toolu- prefix', () => {
      const id = generateToolUseId();

      expect(id.startsWith('toolu-')).toBe(true);
    });
  });
});
