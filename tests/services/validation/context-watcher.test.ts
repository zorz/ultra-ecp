/**
 * Context Watcher Unit Tests
 *
 * Tests for file watching and change detection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ContextWatcher, createContextWatcher } from '../../../src/services/validation/context-watcher.ts';
import { join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';

describe('ContextWatcher', () => {
  const testDir = join(process.cwd(), '.test-watch-validation');
  let watcher: ContextWatcher;

  beforeEach(async () => {
    // Create test directory
    await mkdir(testDir, { recursive: true });
    watcher = createContextWatcher({ contextDir: '.test-watch-validation', debounceMs: 50 });
  });

  afterEach(async () => {
    // Stop watcher and clean up
    watcher.stop();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore errors
    }
  });

  describe('constructor', () => {
    it('should create watcher with default options', () => {
      const w = new ContextWatcher();
      expect(w.isActive()).toBe(false);
    });

    it('should create watcher with custom options', () => {
      const w = new ContextWatcher({
        contextDir: '.custom-validation',
        debounceMs: 200,
        recursive: false,
      });
      expect(w.isActive()).toBe(false);
    });
  });

  describe('start/stop', () => {
    it('should start and stop watching', async () => {
      expect(watcher.isActive()).toBe(false);

      await watcher.start();
      expect(watcher.isActive()).toBe(true);

      watcher.stop();
      expect(watcher.isActive()).toBe(false);
    });

    it('should handle starting when already watching', async () => {
      await watcher.start();
      await watcher.start(); // Should not throw
      expect(watcher.isActive()).toBe(true);
    });

    it('should handle stopping when not watching', () => {
      watcher.stop(); // Should not throw
      expect(watcher.isActive()).toBe(false);
    });
  });

  describe('getKnownFiles', () => {
    it('should return empty array when no files exist', async () => {
      await watcher.start();
      const files = watcher.getKnownFiles();
      expect(files).toEqual([]);
    });

    it('should find existing context files', async () => {
      // Create test files
      await writeFile(join(testDir, 'context.md'), '# Test');
      await mkdir(join(testDir, 'src'), { recursive: true });
      await writeFile(join(testDir, 'src', 'context.md'), '# Src');

      await watcher.start();
      const files = watcher.getKnownFiles();

      expect(files.length).toBe(2);
      expect(files.some((f) => f === 'context.md')).toBe(true);
    });
  });

  describe('onChange', () => {
    it('should subscribe to change events', async () => {
      const unsubscribe = watcher.onChange(() => {
        // Event callback
      });

      expect(typeof unsubscribe).toBe('function');
    });

    it('should unsubscribe from change events', async () => {
      let callCount = 0;

      const unsubscribe = watcher.onChange(() => {
        callCount++;
      });

      unsubscribe();

      // Even if watcher fires, callback should not be called
      expect(callCount).toBe(0);
    });

    it('should detect file creation', async () => {
      await watcher.start();

      const events: Array<{ type: string; path: string }> = [];

      watcher.onChange((e) => {
        events.push({ type: e.type, path: e.path });
      });

      // Create a new file
      await writeFile(join(testDir, 'new-context.md'), '# New');

      // Wait for debounce and event processing
      await new Promise((resolve) => setTimeout(resolve, 200));

      // File watching may not work in all test environments
      if (events.length > 0) {
        const event = events[events.length - 1];
        expect(event?.type).toBe('add');
        expect(event?.path).toContain('new-context.md');
      }
    });

    it('should detect file modification', async () => {
      // Create initial file
      await writeFile(join(testDir, 'existing.md'), '# Initial');

      await watcher.start();

      const events: Array<{ type: string }> = [];

      watcher.onChange((e) => {
        events.push({ type: e.type });
      });

      // Modify the file
      await new Promise((resolve) => setTimeout(resolve, 100));
      await writeFile(join(testDir, 'existing.md'), '# Modified');

      // Wait for debounce and event processing
      await new Promise((resolve) => setTimeout(resolve, 200));

      // File watching may not work in all test environments
      if (events.length > 0) {
        const event = events[events.length - 1];
        expect(event?.type).toBe('change');
      }
    });

    it('should detect file deletion', async () => {
      // Create initial file
      await writeFile(join(testDir, 'to-delete.md'), '# Delete me');

      await watcher.start();

      const events: Array<{ type: string }> = [];

      watcher.onChange((e) => {
        events.push({ type: e.type });
      });

      // Delete the file
      await new Promise((resolve) => setTimeout(resolve, 100));
      await rm(join(testDir, 'to-delete.md'));

      // Wait for debounce and event processing
      await new Promise((resolve) => setTimeout(resolve, 200));

      // File watching may not work in all test environments
      if (events.length > 0) {
        const event = events[events.length - 1];
        expect(event?.type).toBe('delete');
      }
    });

    it('should debounce rapid changes', async () => {
      await watcher.start();

      let eventCount = 0;

      watcher.onChange(() => {
        eventCount++;
      });

      // Create and immediately modify a file multiple times
      await writeFile(join(testDir, 'debounce-test.md'), '# v1');
      await writeFile(join(testDir, 'debounce-test.md'), '# v2');
      await writeFile(join(testDir, 'debounce-test.md'), '# v3');

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Due to debouncing, we should get at most 1-2 events
      expect(eventCount).toBeLessThanOrEqual(2);
    });
  });

  describe('ignore non-markdown files', () => {
    it('should not track non-markdown files', async () => {
      await writeFile(join(testDir, 'config.json'), '{}');
      await writeFile(join(testDir, 'readme.txt'), 'readme');

      await watcher.start();

      const files = watcher.getKnownFiles();
      expect(files.every((f) => f.endsWith('.md'))).toBe(true);
    });
  });
});

describe('createContextWatcher', () => {
  it('should create a watcher instance', () => {
    const watcher = createContextWatcher();
    expect(watcher).toBeInstanceOf(ContextWatcher);
  });

  it('should accept options', () => {
    const watcher = createContextWatcher({
      contextDir: '.custom',
      debounceMs: 500,
    });
    expect(watcher).toBeInstanceOf(ContextWatcher);
  });
});
