/**
 * Validation Cache Unit Tests
 *
 * Tests for ValidationCache functionality.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { ValidationCache } from '../../../src/services/validation/cache.ts';
import type { ValidationContext, ValidationResult } from '../../../src/services/validation/types.ts';

describe('ValidationCache', () => {
  let cache: ValidationCache;

  beforeEach(() => {
    cache = new ValidationCache({ maxAge: 5000, maxEntries: 100 });
  });

  /**
   * Create a test validation context.
   */
  function createContext(files: Array<{ path: string; content: string }>): ValidationContext {
    return {
      trigger: 'pre-write',
      timestamp: Date.now(),
      files,
      sessionId: 'test-session',
    };
  }

  /**
   * Create a test validation result.
   */
  function createResult(validator: string, status: ValidationResult['status'] = 'approved'): ValidationResult {
    return {
      status,
      validator,
      severity: 'info',
      message: `${validator} passed`,
      durationMs: 100,
      cached: false,
    };
  }

  describe('get and set', () => {
    it('should cache and retrieve results', () => {
      const context = createContext([{ path: 'test.ts', content: 'const x = 1;' }]);
      const result = createResult('typescript');

      cache.set('typescript', context, result);
      const cached = cache.get('typescript', context);

      expect(cached).not.toBeNull();
      expect(cached?.validator).toBe('typescript');
      expect(cached?.status).toBe('approved');
    });

    it('should return null for non-existent entries', () => {
      const context = createContext([{ path: 'test.ts', content: 'const x = 1;' }]);

      const cached = cache.get('typescript', context);

      expect(cached).toBeNull();
    });

    it('should differentiate by validator ID', () => {
      const context = createContext([{ path: 'test.ts', content: 'const x = 1;' }]);
      const result1 = createResult('typescript');
      const result2 = createResult('eslint', 'rejected');

      cache.set('typescript', context, result1);
      cache.set('eslint', context, result2);

      const cached1 = cache.get('typescript', context);
      const cached2 = cache.get('eslint', context);

      expect(cached1?.status).toBe('approved');
      expect(cached2?.status).toBe('rejected');
    });

    it('should differentiate by file content', () => {
      const context1 = createContext([{ path: 'test.ts', content: 'const x = 1;' }]);
      const context2 = createContext([{ path: 'test.ts', content: 'const x = 2;' }]);
      const result = createResult('typescript');

      cache.set('typescript', context1, result);

      const cached1 = cache.get('typescript', context1);
      const cached2 = cache.get('typescript', context2);

      expect(cached1).not.toBeNull();
      expect(cached2).toBeNull();
    });

    it('should handle multiple files', () => {
      const context = createContext([
        { path: 'a.ts', content: 'const a = 1;' },
        { path: 'b.ts', content: 'const b = 2;' },
      ]);
      const result = createResult('typescript');

      cache.set('typescript', context, result);
      const cached = cache.get('typescript', context);

      expect(cached).not.toBeNull();
    });
  });

  describe('expiration', () => {
    it('should expire entries after maxAge', async () => {
      const shortCache = new ValidationCache({ maxAge: 100, maxEntries: 100 });
      const context = createContext([{ path: 'test.ts', content: 'const x = 1;' }]);
      const result = createResult('typescript');

      shortCache.set('typescript', context, result);

      // Should exist immediately
      expect(shortCache.get('typescript', context)).not.toBeNull();

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should be expired
      expect(shortCache.get('typescript', context)).toBeNull();
    });
  });

  describe('invalidation', () => {
    it('should invalidate all entries when no pattern given', () => {
      const context = createContext([{ path: 'test.ts', content: 'const x = 1;' }]);
      cache.set('typescript', context, createResult('typescript'));
      cache.set('eslint', context, createResult('eslint'));

      cache.invalidate();

      expect(cache.get('typescript', context)).toBeNull();
      expect(cache.get('eslint', context)).toBeNull();
    });

    it('should invalidate entries matching pattern', () => {
      const context = createContext([{ path: 'test.ts', content: 'const x = 1;' }]);
      cache.set('typescript', context, createResult('typescript'));
      cache.set('eslint', context, createResult('eslint'));

      cache.invalidate('typescript');

      expect(cache.get('typescript', context)).toBeNull();
      expect(cache.get('eslint', context)).not.toBeNull();
    });

    it('should invalidate by file path', () => {
      const context1 = createContext([{ path: 'src/a.ts', content: 'const a = 1;' }]);
      const context2 = createContext([{ path: 'src/b.ts', content: 'const b = 1;' }]);

      cache.set('typescript', context1, createResult('typescript'));
      cache.set('typescript', context2, createResult('typescript'));

      cache.invalidateByFile('src/a.ts');

      expect(cache.get('typescript', context1)).toBeNull();
      expect(cache.get('typescript', context2)).not.toBeNull();
    });
  });

  describe('clear', () => {
    it('should clear all entries', () => {
      const context = createContext([{ path: 'test.ts', content: 'const x = 1;' }]);
      cache.set('typescript', context, createResult('typescript'));
      cache.set('eslint', context, createResult('eslint'));

      cache.clear();

      expect(cache.getStats().size).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return cache statistics', () => {
      const context = createContext([{ path: 'test.ts', content: 'const x = 1;' }]);
      cache.set('typescript', context, createResult('typescript'));

      const stats = cache.getStats();

      expect(stats.size).toBe(1);
      expect(stats.maxEntries).toBe(100);
      expect(stats.maxAge).toBe(5000);
    });
  });

  describe('eviction', () => {
    it('should evict oldest entries when max is reached', () => {
      const smallCache = new ValidationCache({ maxAge: 60000, maxEntries: 5 });

      // Add 6 entries (one more than max)
      for (let i = 0; i < 6; i++) {
        const context = createContext([{ path: `test${i}.ts`, content: `const x = ${i};` }]);
        smallCache.set(`validator-${i}`, context, createResult(`validator-${i}`));
      }

      // Cache should have at most maxEntries
      expect(smallCache.getStats().size).toBeLessThanOrEqual(5);
    });
  });
});
