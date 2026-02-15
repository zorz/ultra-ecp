/**
 * Search Service Types Unit Tests
 *
 * Tests for search type definitions and structures.
 */

import { describe, it, expect } from 'bun:test';
import type {
  SearchOptions,
  SearchMatchResult,
  SearchFileResult,
  SearchResult,
  ReplaceResult,
  SearchProgress,
} from '../../../src/services/search/types.ts';

describe('Search Types', () => {
  describe('SearchOptions', () => {
    it('should allow all optional fields', () => {
      const options: SearchOptions = {};

      // All fields are optional
      expect(options.caseSensitive).toBeUndefined();
      expect(options.regex).toBeUndefined();
      expect(options.wholeWord).toBeUndefined();
      expect(options.includeGlob).toBeUndefined();
      expect(options.excludeGlob).toBeUndefined();
      expect(options.maxResults).toBeUndefined();
      expect(options.contextLines).toBeUndefined();
    });

    it('should accept all fields', () => {
      const options: SearchOptions = {
        caseSensitive: true,
        regex: true,
        wholeWord: true,
        includeGlob: '*.ts',
        excludeGlob: 'node_modules/**',
        maxResults: 100,
        contextLines: 3,
      };

      expect(options.caseSensitive).toBe(true);
      expect(options.regex).toBe(true);
      expect(options.wholeWord).toBe(true);
      expect(options.includeGlob).toBe('*.ts');
      expect(options.excludeGlob).toBe('node_modules/**');
      expect(options.maxResults).toBe(100);
      expect(options.contextLines).toBe(3);
    });
  });

  describe('SearchMatchResult', () => {
    it('should have required fields', () => {
      const match: SearchMatchResult = {
        line: 42,
        column: 10,
        length: 5,
        lineText: 'const hello = "world";',
      };

      expect(match.line).toBe(42);
      expect(match.column).toBe(10);
      expect(match.length).toBe(5);
      expect(match.lineText).toBe('const hello = "world";');
    });

    it('should allow context lines', () => {
      const match: SearchMatchResult = {
        line: 10,
        column: 0,
        length: 3,
        lineText: 'foo',
        contextBefore: ['// comment', 'function bar() {'],
        contextAfter: ['  return x;', '}'],
      };

      expect(match.contextBefore).toEqual(['// comment', 'function bar() {']);
      expect(match.contextAfter).toEqual(['  return x;', '}']);
    });
  });

  describe('SearchFileResult', () => {
    it('should have path and matches', () => {
      const fileResult: SearchFileResult = {
        path: 'src/index.ts',
        matches: [
          { line: 1, column: 0, length: 6, lineText: 'import foo from "bar";' },
          { line: 5, column: 10, length: 6, lineText: 'const x = import("baz");' },
        ],
      };

      expect(fileResult.path).toBe('src/index.ts');
      expect(fileResult.matches.length).toBe(2);
    });

    it('should allow empty matches array', () => {
      const fileResult: SearchFileResult = {
        path: 'empty.ts',
        matches: [],
      };

      expect(fileResult.matches.length).toBe(0);
    });
  });

  describe('SearchResult', () => {
    it('should have all required fields', () => {
      const result: SearchResult = {
        query: 'import',
        files: [],
        totalMatches: 0,
        truncated: false,
      };

      expect(result.query).toBe('import');
      expect(result.files).toEqual([]);
      expect(result.totalMatches).toBe(0);
      expect(result.truncated).toBe(false);
    });

    it('should include duration when provided', () => {
      const result: SearchResult = {
        query: 'test',
        files: [
          {
            path: 'test.ts',
            matches: [{ line: 1, column: 0, length: 4, lineText: 'test string' }],
          },
        ],
        totalMatches: 1,
        truncated: false,
        durationMs: 42,
      };

      expect(result.durationMs).toBe(42);
    });

    it('should indicate truncation', () => {
      const result: SearchResult = {
        query: 'common',
        files: [],
        totalMatches: 1000,
        truncated: true,
      };

      expect(result.truncated).toBe(true);
    });
  });

  describe('ReplaceResult', () => {
    it('should have required fields', () => {
      const result: ReplaceResult = {
        filesModified: 5,
        matchesReplaced: 10,
        errors: [],
      };

      expect(result.filesModified).toBe(5);
      expect(result.matchesReplaced).toBe(10);
      expect(result.errors).toEqual([]);
    });

    it('should include errors', () => {
      const result: ReplaceResult = {
        filesModified: 2,
        matchesReplaced: 8,
        errors: [
          { path: 'readonly.ts', error: 'Permission denied' },
          { path: 'missing.ts', error: 'File not found' },
        ],
      };

      expect(result.errors.length).toBe(2);
      expect(result.errors[0]!.path).toBe('readonly.ts');
      expect(result.errors[0]!.error).toBe('Permission denied');
    });
  });

  describe('SearchProgress', () => {
    it('should have required fields', () => {
      const progress: SearchProgress = {
        filesSearched: 100,
        matchesFound: 25,
        complete: false,
      };

      expect(progress.filesSearched).toBe(100);
      expect(progress.matchesFound).toBe(25);
      expect(progress.complete).toBe(false);
    });

    it('should include current file when searching', () => {
      const progress: SearchProgress = {
        filesSearched: 50,
        matchesFound: 10,
        currentFile: 'src/services/search.ts',
        complete: false,
      };

      expect(progress.currentFile).toBe('src/services/search.ts');
    });

    it('should indicate completion', () => {
      const progress: SearchProgress = {
        filesSearched: 200,
        matchesFound: 50,
        complete: true,
      };

      expect(progress.complete).toBe(true);
    });
  });
});
