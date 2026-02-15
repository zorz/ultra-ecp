/**
 * Shared Feed Unit Tests
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { SharedFeed, createSharedFeed } from '../../../src/services/ensemble/shared-feed.ts';
import type { FeedEntry } from '../../../src/services/ensemble/types.ts';

describe('SharedFeed', () => {
  let feed: SharedFeed;

  beforeEach(() => {
    feed = createSharedFeed();
  });

  describe('post', () => {
    it('should create entry with id and timestamp', () => {
      const entry = feed.post({
        type: 'message',
        source: 'agent',
        sourceId: 'coder',
        content: { text: 'Hello', role: 'assistant' },
      });

      expect(entry.id).toMatch(/^feed-/);
      expect(entry.timestamp).toBeGreaterThan(0);
      expect(entry.type).toBe('message');
      expect(entry.source).toBe('agent');
    });

    it('should add entry to feed', () => {
      feed.post({
        type: 'message',
        source: 'human',
        content: { text: 'Hi', role: 'user' },
      });

      expect(feed.getCount()).toBe(1);
    });

    it('should respect max entries limit', () => {
      const smallFeed = createSharedFeed({ maxEntries: 3 });

      for (let i = 0; i < 5; i++) {
        smallFeed.post({
          type: 'message',
          source: 'agent',
          content: { text: `Message ${i}`, role: 'assistant' },
        });
      }

      expect(smallFeed.getCount()).toBe(3);

      // Should have the last 3 messages
      const entries = smallFeed.getEntries();
      expect((entries[0]!.content as { text: string }).text).toBe('Message 2');
      expect((entries[2]!.content as { text: string }).text).toBe('Message 4');
    });
  });

  describe('postMessage', () => {
    it('should create message entry', () => {
      const entry = feed.postMessage('Hello world', 'agent', { sourceId: 'coder' });

      expect(entry.type).toBe('message');
      expect(entry.source).toBe('agent');
      expect(entry.sourceId).toBe('coder');
      expect((entry.content as { text: string }).text).toBe('Hello world');
      expect((entry.content as { role: string }).role).toBe('assistant');
    });

    it('should default to user role for human source', () => {
      const entry = feed.postMessage('Question', 'human');

      expect((entry.content as { role: string }).role).toBe('user');
    });
  });

  describe('postChange', () => {
    it('should create change entry', () => {
      const entry = feed.postChange('file_edit', 'agent', {
        sourceId: 'coder',
        path: '/src/index.ts',
        diff: '+line',
        status: 'proposed',
      });

      expect(entry.type).toBe('change');
      const content = entry.content as { type: string; path: string; status: string };
      expect(content.type).toBe('file_edit');
      expect(content.path).toBe('/src/index.ts');
      expect(content.status).toBe('proposed');
    });
  });

  describe('postAction', () => {
    it('should create action entry', () => {
      const entry = feed.postAction('tool_use', 'agent', {
        sourceId: 'coder',
        toolName: 'Edit',
        toolInput: { file: 'test.ts' },
      });

      expect(entry.type).toBe('action');
      const content = entry.content as { type: string; toolName: string };
      expect(content.type).toBe('tool_use');
      expect(content.toolName).toBe('Edit');
    });
  });

  describe('postSystem', () => {
    it('should create system entry', () => {
      const entry = feed.postSystem('session_start', { task: 'Build API' });

      expect(entry.type).toBe('system');
      expect(entry.source).toBe('system');
      const content = entry.content as { event: string; details: { task: string } };
      expect(content.event).toBe('session_start');
      expect(content.details.task).toBe('Build API');
    });
  });

  describe('postError', () => {
    it('should create error entry', () => {
      const entry = feed.postError('TIMEOUT', 'Request timed out', {
        source: 'agent',
        sourceId: 'coder',
      });

      expect(entry.type).toBe('error');
      const content = entry.content as { code: string; message: string };
      expect(content.code).toBe('TIMEOUT');
      expect(content.message).toBe('Request timed out');
    });
  });

  describe('getEntries', () => {
    beforeEach(() => {
      feed.postMessage('Message 1', 'agent', { sourceId: 'coder' });
      feed.postMessage('Message 2', 'human');
      feed.postChange('file_edit', 'agent', { sourceId: 'coder' });
      feed.postSystem('workflow_step');
    });

    it('should return all entries without filter', () => {
      expect(feed.getEntries()).toHaveLength(4);
    });

    it('should filter by type', () => {
      const messages = feed.getEntries({ types: ['message'] });
      expect(messages).toHaveLength(2);
    });

    it('should filter by source', () => {
      const agentEntries = feed.getEntries({ sources: ['agent'] });
      expect(agentEntries).toHaveLength(2);
    });

    it('should filter by sourceId', () => {
      const coderEntries = feed.getEntries({ sourceId: 'coder' });
      expect(coderEntries).toHaveLength(2);
    });

    it('should filter by timestamp', () => {
      const before = Date.now() + 1000;
      const entries = feed.getEntries({ before });
      expect(entries).toHaveLength(4);

      const after = Date.now() + 1000;
      const futureEntries = feed.getEntries({ after });
      expect(futureEntries).toHaveLength(0);
    });

    it('should limit results', () => {
      const entries = feed.getEntries({ limit: 2 });
      expect(entries).toHaveLength(2);
    });
  });

  describe('getEntry', () => {
    it('should find entry by id', () => {
      const posted = feed.postMessage('Test', 'agent');
      const found = feed.getEntry(posted.id);

      expect(found).toBeDefined();
      expect(found!.id).toBe(posted.id);
    });

    it('should return undefined for non-existent id', () => {
      expect(feed.getEntry('non-existent')).toBeUndefined();
    });
  });

  describe('getReplies', () => {
    it('should find replies to an entry', () => {
      const original = feed.postMessage('Original', 'human');
      feed.postMessage('Reply 1', 'agent', { replyTo: original.id });
      feed.postMessage('Reply 2', 'agent', { replyTo: original.id });
      feed.postMessage('Unrelated', 'agent');

      const replies = feed.getReplies(original.id);
      expect(replies).toHaveLength(2);
    });
  });

  describe('getLatest', () => {
    it('should return the most recent entry', () => {
      feed.postMessage('First', 'agent');
      feed.postMessage('Second', 'agent');
      feed.postMessage('Third', 'agent');

      const latest = feed.getLatest();
      expect((latest!.content as { text: string }).text).toBe('Third');
    });

    it('should return undefined for empty feed', () => {
      expect(feed.getLatest()).toBeUndefined();
    });
  });

  describe('subscribe', () => {
    it('should notify listeners on new entries', () => {
      const received: FeedEntry[] = [];
      feed.subscribe((entry) => received.push(entry));

      feed.postMessage('Test 1', 'agent');
      feed.postMessage('Test 2', 'agent');

      expect(received).toHaveLength(2);
    });

    it('should unsubscribe correctly', () => {
      const received: FeedEntry[] = [];
      const unsubscribe = feed.subscribe((entry) => received.push(entry));

      feed.postMessage('Test 1', 'agent');
      unsubscribe();
      feed.postMessage('Test 2', 'agent');

      expect(received).toHaveLength(1);
    });
  });

  describe('subscribeToType', () => {
    it('should only notify for specific type', () => {
      const received: FeedEntry[] = [];
      feed.subscribeToType('change', (entry) => received.push(entry));

      feed.postMessage('Test', 'agent');
      feed.postChange('file_edit', 'agent');
      feed.postSystem('workflow_step');
      feed.postChange('file_create', 'agent');

      expect(received).toHaveLength(2);
      expect(received.every((e) => e.type === 'change')).toBe(true);
    });
  });

  describe('clear', () => {
    it('should remove all entries', () => {
      feed.postMessage('Test 1', 'agent');
      feed.postMessage('Test 2', 'agent');

      feed.clear();

      expect(feed.getCount()).toBe(0);
    });
  });

  describe('export/import', () => {
    it('should export entries as JSON', () => {
      feed.postMessage('Test', 'agent');

      const json = feed.export();
      const parsed = JSON.parse(json);

      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
    });

    it('should import entries from JSON', () => {
      const entries = [
        {
          id: 'feed-1',
          type: 'message',
          source: 'agent',
          content: { text: 'Imported', role: 'assistant' },
          timestamp: Date.now(),
        },
      ];

      const count = feed.import(JSON.stringify(entries));

      expect(count).toBe(1);
      expect(feed.getCount()).toBe(1);
    });

    it('should throw on invalid import', () => {
      expect(() => feed.import('invalid json')).toThrow();
      expect(() => feed.import('{}')).toThrow();
    });
  });
});
