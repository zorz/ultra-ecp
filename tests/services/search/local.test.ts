/**
 * Local Search Service Unit Tests
 *
 * Tests for the LocalSearchService implementation.
 * Note: Some tests require ripgrep to be installed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { LocalSearchService } from '../../../src/services/search/local.ts';
import type { SearchProgress } from '../../../src/services/search/types.ts';

// Check if ripgrep is available
let ripgrepAvailable: boolean | null = null;
async function checkRipgrepAvailable(): Promise<boolean> {
  if (ripgrepAvailable !== null) return ripgrepAvailable;
  try {
    const proc = Bun.spawn(['rg', '--version'], { stdout: 'pipe', stderr: 'pipe' });
    await proc.exited;
    ripgrepAvailable = true;
    return true;
  } catch {
    ripgrepAvailable = false;
    return false;
  }
}

describe('LocalSearchService', () => {
  let service: LocalSearchService;
  let testDir: string;

  // Create a temporary test directory with test files
  async function setupTestDirectory(): Promise<string> {
    const dir = path.join(os.tmpdir(), `ultra-search-test-${Date.now()}`);
    await fs.promises.mkdir(dir, { recursive: true });

    // Create test files
    await fs.promises.writeFile(
      path.join(dir, 'file1.ts'),
      `import { foo } from 'bar';
const hello = 'world';
function test() {
  return hello;
}
`
    );

    await fs.promises.writeFile(
      path.join(dir, 'file2.ts'),
      `// Another file
const hello = 'everyone';
export { hello };
`
    );

    await fs.promises.writeFile(
      path.join(dir, 'readme.md'),
      `# Test Project
This is a test project.
Hello world!
`
    );

    // Create a subdirectory with a file
    await fs.promises.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, 'src', 'index.ts'),
      `import { hello } from '../file2';
console.log(hello);
`
    );

    return dir;
  }

  async function cleanupTestDirectory(dir: string): Promise<void> {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }

  beforeEach(async () => {
    service = new LocalSearchService();
    testDir = await setupTestDirectory();
    service.setWorkspaceRoot(testDir);
  });

  afterEach(async () => {
    service.cancel();
    await cleanupTestDirectory(testDir);
  });

  describe('workspace configuration', () => {
    it('should set and get workspace root', () => {
      service.setWorkspaceRoot('/test/path');

      expect(service.getWorkspaceRoot()).toBe('/test/path');
    });

    it('should start with empty workspace root', () => {
      const newService = new LocalSearchService();

      expect(newService.getWorkspaceRoot()).toBe('');
    });
  });

  describe('search', () => {
    it('should return empty result for empty query', async () => {
      const result = await service.search('');

      expect(result.query).toBe('');
      expect(result.files).toEqual([]);
      expect(result.totalMatches).toBe(0);
      expect(result.truncated).toBe(false);
    });

    it('should find matches in files (requires ripgrep)', async () => {
      if (!await checkRipgrepAvailable()) {
        console.log('Skipping: ripgrep not installed');
        return;
      }

      const result = await service.search('hello');

      expect(result.query).toBe('hello');
      expect(result.totalMatches).toBeGreaterThan(0);
      expect(result.files.length).toBeGreaterThan(0);
    });

    it('should include file paths in results (requires ripgrep)', async () => {
      if (!await checkRipgrepAvailable()) {
        console.log('Skipping: ripgrep not installed');
        return;
      }

      const result = await service.search('hello');

      const paths = result.files.map((f) => f.path);
      expect(paths.some((p) => p.includes('file1.ts'))).toBe(true);
      expect(paths.some((p) => p.includes('file2.ts'))).toBe(true);
    });

    it('should include match details (requires ripgrep)', async () => {
      if (!await checkRipgrepAvailable()) {
        console.log('Skipping: ripgrep not installed');
        return;
      }

      const result = await service.search('hello');

      expect(result.files.length).toBeGreaterThan(0);
      const firstFile = result.files[0]!;
      expect(firstFile.matches.length).toBeGreaterThan(0);

      const firstMatch = firstFile.matches[0]!;
      expect(firstMatch.line).toBeGreaterThan(0);
      expect(firstMatch.column).toBeGreaterThanOrEqual(0);
      expect(firstMatch.length).toBe(5); // 'hello' is 5 chars
      expect(firstMatch.lineText).toBeDefined();
    });

    it('should search case-insensitively by default (requires ripgrep)', async () => {
      if (!await checkRipgrepAvailable()) {
        console.log('Skipping: ripgrep not installed');
        return;
      }

      const result = await service.search('HELLO');

      expect(result.totalMatches).toBeGreaterThan(0);
    });

    it('should support case-sensitive search (requires ripgrep)', async () => {
      if (!await checkRipgrepAvailable()) {
        console.log('Skipping: ripgrep not installed');
        return;
      }

      // 'Hello' with capital H only appears in readme.md
      const result = await service.search('Hello', { caseSensitive: true });

      // Should find 'Hello' in readme.md
      const readmeResult = result.files.find((f) => f.path.includes('readme.md'));
      expect(readmeResult).toBeDefined();
    });

    it('should support include glob filter (requires ripgrep)', async () => {
      if (!await checkRipgrepAvailable()) {
        console.log('Skipping: ripgrep not installed');
        return;
      }

      const result = await service.search('hello', { includeGlob: '*.ts' });

      // Should not include readme.md
      const hasMarkdown = result.files.some((f) => f.path.endsWith('.md'));
      expect(hasMarkdown).toBe(false);
    });

    it('should support exclude glob filter (requires ripgrep)', async () => {
      if (!await checkRipgrepAvailable()) {
        console.log('Skipping: ripgrep not installed');
        return;
      }

      const result = await service.search('hello', { excludeGlob: '*.md' });

      const hasMarkdown = result.files.some((f) => f.path.endsWith('.md'));
      expect(hasMarkdown).toBe(false);
    });

    it('should support max results limit (requires ripgrep)', async () => {
      if (!await checkRipgrepAvailable()) {
        console.log('Skipping: ripgrep not installed');
        return;
      }

      const result = await service.search('hello', { maxResults: 1 });

      // May be truncated depending on matches
      expect(result.totalMatches).toBeLessThanOrEqual(1);
    });

    it('should support regex search (requires ripgrep)', async () => {
      if (!await checkRipgrepAvailable()) {
        console.log('Skipping: ripgrep not installed');
        return;
      }

      const result = await service.search('hello.*world', { regex: true });

      // Should match "const hello = 'world'" line
      expect(result.totalMatches).toBeGreaterThanOrEqual(1);
    });

    it('should support whole word matching (requires ripgrep)', async () => {
      if (!await checkRipgrepAvailable()) {
        console.log('Skipping: ripgrep not installed');
        return;
      }

      const result = await service.search('test', { wholeWord: true });

      // Should match 'test' but not if it's part of a larger word
      expect(result.totalMatches).toBeGreaterThan(0);
    });

    it('should include duration in results (requires ripgrep)', async () => {
      if (!await checkRipgrepAvailable()) {
        console.log('Skipping: ripgrep not installed');
        return;
      }

      const result = await service.search('hello');

      expect(result.durationMs).toBeDefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('replace (requires ripgrep)', () => {
    it('should replace matches in files', async () => {
      if (!await checkRipgrepAvailable()) {
        console.log('Skipping: ripgrep not installed');
        return;
      }

      // Create a dedicated file for replacement
      await fs.promises.writeFile(
        path.join(testDir, 'replace-test.txt'),
        'old old old'
      );

      const result = await service.replace('old', 'new');

      expect(result.matchesReplaced).toBeGreaterThan(0);
      expect(result.filesModified).toBeGreaterThan(0);

      // Verify replacement
      const content = await fs.promises.readFile(
        path.join(testDir, 'replace-test.txt'),
        'utf-8'
      );
      expect(content).toBe('new new new');
    });

    it('should return zero counts for no matches', async () => {
      if (!await checkRipgrepAvailable()) {
        console.log('Skipping: ripgrep not installed');
        return;
      }

      const result = await service.replace('nonexistent12345', 'replacement');

      expect(result.filesModified).toBe(0);
      expect(result.matchesReplaced).toBe(0);
      expect(result.errors).toEqual([]);
    });
  });

  describe('replaceInFiles', () => {
    it('should replace specific matches', async () => {
      await fs.promises.writeFile(
        path.join(testDir, 'specific.txt'),
        'line one\nline two\nline three'
      );

      const result = await service.replaceInFiles(
        [
          {
            path: 'specific.txt',
            matches: [
              { line: 2, column: 5, length: 3 }, // 'two'
            ],
          },
        ],
        'two',
        'TWO'
      );

      expect(result.matchesReplaced).toBe(1);
      expect(result.filesModified).toBe(1);

      const content = await fs.promises.readFile(
        path.join(testDir, 'specific.txt'),
        'utf-8'
      );
      expect(content).toBe('line one\nline TWO\nline three');
    });

    it('should handle multiple matches in same file', async () => {
      await fs.promises.writeFile(
        path.join(testDir, 'multi.txt'),
        'foo bar foo'
      );

      const result = await service.replaceInFiles(
        [
          {
            path: 'multi.txt',
            matches: [
              { line: 1, column: 0, length: 3 },
              { line: 1, column: 8, length: 3 },
            ],
          },
        ],
        'foo',
        'baz'
      );

      expect(result.matchesReplaced).toBe(2);

      const content = await fs.promises.readFile(
        path.join(testDir, 'multi.txt'),
        'utf-8'
      );
      expect(content).toBe('baz bar baz');
    });

    it('should handle regex group replacements', async () => {
      await fs.promises.writeFile(
        path.join(testDir, 'regex.txt'),
        'hello world'
      );

      const result = await service.replaceInFiles(
        [
          {
            path: 'regex.txt',
            matches: [{ line: 1, column: 0, length: 11 }],
          },
        ],
        '(hello) (world)',
        '$2 $1',
        { regex: true }
      );

      expect(result.matchesReplaced).toBe(1);

      const content = await fs.promises.readFile(
        path.join(testDir, 'regex.txt'),
        'utf-8'
      );
      expect(content).toBe('world hello');
    });

    it('should report errors for non-existent files', async () => {
      const result = await service.replaceInFiles(
        [
          {
            path: 'nonexistent-file.txt',
            matches: [{ line: 1, column: 0, length: 4 }],
          },
        ],
        'test',
        'new'
      );

      // Should have error for the missing file
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]!.path).toBe('nonexistent-file.txt');
    });
  });

  describe('cancel', () => {
    it('should cancel without error when no search is running', () => {
      expect(() => service.cancel()).not.toThrow();
    });

    it('should cancel running search (requires ripgrep)', async () => {
      if (!await checkRipgrepAvailable()) {
        console.log('Skipping: ripgrep not installed');
        return;
      }

      // This is hard to test reliably, but we can at least verify
      // that cancel doesn't cause errors
      const searchPromise = service.search('hello');
      service.cancel();

      const result = await searchPromise;
      // Result may be empty due to cancellation
      expect(result).toBeDefined();
    });
  });

  describe('progress events', () => {
    it('should subscribe to progress updates', () => {
      const unsubscribe = service.onProgress(() => {});

      expect(typeof unsubscribe).toBe('function');
    });

    it('should unsubscribe from progress updates', () => {
      const callback = () => {};
      const unsubscribe = service.onProgress(callback);

      unsubscribe();
      // No direct way to verify, but should not throw
    });

    it('should receive progress updates during search (requires ripgrep)', async () => {
      if (!await checkRipgrepAvailable()) {
        console.log('Skipping: ripgrep not installed');
        return;
      }

      const progressUpdates: SearchProgress[] = [];
      service.onProgress((progress) => progressUpdates.push(progress));

      await service.search('hello');

      expect(progressUpdates.length).toBeGreaterThan(0);
      // Should have at least start and complete
      const hasStart = progressUpdates.some((p) => !p.complete);
      const hasComplete = progressUpdates.some((p) => p.complete);
      expect(hasStart).toBe(true);
      expect(hasComplete).toBe(true);
    });
  });
});
