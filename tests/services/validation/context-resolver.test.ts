/**
 * Context Resolver Unit Tests
 *
 * Tests for hierarchical context resolution.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ContextResolver, createContextResolver } from '../../../src/services/validation/context-resolver.ts';
import { parseContextFile } from '../../../src/services/validation/context-parser.ts';
import { join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';

describe('ContextResolver', () => {
  const testDir = join(process.cwd(), '.test-validation');
  let resolver: ContextResolver;

  beforeEach(async () => {
    // Create test directory
    await mkdir(testDir, { recursive: true });
    resolver = createContextResolver({ contextDir: '.test-validation', cacheEnabled: false });
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore errors
    }
  });

  describe('getContextFilePaths', () => {
    it('should return correct paths for root file', () => {
      const paths = resolver.getContextFilePaths('index.ts');

      expect(paths).toContain('.test-validation/context.md');
      expect(paths).toContain('.test-validation/index.md');
    });

    it('should return correct paths for nested file', () => {
      const paths = resolver.getContextFilePaths('src/services/ai/provider.ts');

      expect(paths).toContain('.test-validation/context.md');
      expect(paths).toContain('.test-validation/src/context.md');
      expect(paths).toContain('.test-validation/src/services/context.md');
      expect(paths).toContain('.test-validation/src/services/ai/context.md');
      expect(paths).toContain('.test-validation/src/services/ai/provider.md');
    });

    it('should handle files without extension', () => {
      const paths = resolver.getContextFilePaths('Makefile');

      expect(paths).toContain('.test-validation/context.md');
      expect(paths).toContain('.test-validation/Makefile.md');
    });
  });

  describe('parseContextFile', () => {
    it('should parse patterns section', () => {
      const content = `# Patterns

## Required Patterns

- Use Result type for errors
- Always handle async errors
- Prefer const over let
`;

      const parsed = resolver.parseContextFile(content, 'test.md');

      expect(parsed.patterns.length).toBeGreaterThan(0);
      expect(parsed.patterns[0]?.description).toContain('Result type');
    });

    it('should parse anti-patterns section', () => {
      const content = `# Anti-Patterns

## Anti-Patterns (DO NOT USE)

- \`console.log\` → Use \`debugLog\` instead
- \`any\` type → Use unknown and narrow
`;

      const parsed = resolver.parseContextFile(content, 'test.md');

      expect(parsed.antiPatterns.length).toBeGreaterThan(0);
      expect(parsed.antiPatterns[0]?.pattern).toContain('console.log');
      expect(parsed.antiPatterns[0]?.alternative).toContain('debugLog');
    });

    it('should parse conventions section', () => {
      const content = `# Conventions

## Conventions

- File names: kebab-case
- Class names: PascalCase
- Use explicit exports
`;

      const parsed = resolver.parseContextFile(content, 'test.md');

      expect(parsed.conventions.length).toBeGreaterThan(0);
      expect(parsed.conventions[0]?.description).toContain('kebab-case');
    });

    it('should parse architecture notes', () => {
      const content = `# Architecture Notes

This module handles user authentication.
It uses JWT tokens for session management.
`;

      const parsed = resolver.parseContextFile(content, 'test.md');

      expect(parsed.architectureNotes).toContain('authentication');
      expect(parsed.architectureNotes).toContain('JWT');
    });

    it('should parse override directives', () => {
      const content = `# Overrides

@extend: "Error handling"
Additional context here.

@override: "Logging"
Use structured logging.

@disable: "No console.log"
`;

      const parsed = resolver.parseContextFile(content, 'test.md');

      expect(parsed.overrides.length).toBe(3);
      expect(parsed.overrides[0]?.type).toBe('extend');
      expect(parsed.overrides[0]?.targetId).toBe('Error handling');
      expect(parsed.overrides[1]?.type).toBe('override');
      expect(parsed.overrides[2]?.type).toBe('disable');
    });
  });

  describe('mergeContexts', () => {
    it('should merge patterns from multiple contexts', () => {
      const contexts = [
        {
          patterns: [{ id: 'p1', description: 'Pattern 1', source: 'global' }],
          antiPatterns: [],
          conventions: [],
          architectureNotes: '',
          overrides: [],
          source: 'global',
        },
        {
          patterns: [{ id: 'p2', description: 'Pattern 2', source: 'local' }],
          antiPatterns: [],
          conventions: [],
          architectureNotes: '',
          overrides: [],
          source: 'local',
        },
      ];

      const merged = resolver.mergeContexts(contexts);

      expect(merged.patterns.length).toBe(2);
    });

    it('should append architecture notes', () => {
      const contexts = [
        {
          patterns: [],
          antiPatterns: [],
          conventions: [],
          architectureNotes: 'Global notes.',
          overrides: [],
          source: 'global',
        },
        {
          patterns: [],
          antiPatterns: [],
          conventions: [],
          architectureNotes: 'Local notes.',
          overrides: [],
          source: 'local',
        },
      ];

      const merged = resolver.mergeContexts(contexts);

      expect(merged.architectureNotes).toContain('Global notes');
      expect(merged.architectureNotes).toContain('Local notes');
    });

    it('should apply disable override', () => {
      const contexts = [
        {
          patterns: [{ id: 'p1', description: 'No console.log', source: 'global' }],
          antiPatterns: [],
          conventions: [],
          architectureNotes: '',
          overrides: [],
          source: 'global',
        },
        {
          patterns: [],
          antiPatterns: [],
          conventions: [],
          architectureNotes: '',
          overrides: [{ type: 'disable' as const, targetId: 'console.log', source: 'local' }],
          source: 'local',
        },
      ];

      const merged = resolver.mergeContexts(contexts);

      // Pattern containing "console.log" should be disabled
      expect(merged.patterns.length).toBe(0);
    });
  });

  describe('resolveContext', () => {
    it('should resolve context with global file', async () => {
      // Create global context file
      await writeFile(
        join(testDir, 'context.md'),
        `# Global Patterns

## Required Patterns

- Use TypeScript strict mode
`
      );

      const context = await resolver.resolveContext('src/test.ts');

      expect(context.patterns.length).toBeGreaterThan(0);
    });

    it('should merge context from multiple levels', async () => {
      // Create global context
      await writeFile(
        join(testDir, 'context.md'),
        `# Global

## Required Patterns

- Global pattern
`
      );

      // Create src level context
      await mkdir(join(testDir, 'src'), { recursive: true });
      await writeFile(
        join(testDir, 'src', 'context.md'),
        `# Src Patterns

## Required Patterns

- Src pattern
`
      );

      const context = await resolver.resolveContext('src/test.ts');

      expect(context.patterns.length).toBe(2);
      expect(context.patterns.some((p) => p.description.includes('Global'))).toBe(true);
      expect(context.patterns.some((p) => p.description.includes('Src'))).toBe(true);
    });

    it('should return empty context when no files exist', async () => {
      const context = await resolver.resolveContext('nonexistent/path/file.ts');

      expect(context.patterns).toHaveLength(0);
      expect(context.antiPatterns).toHaveLength(0);
      expect(context.conventions).toHaveLength(0);
    });
  });

  describe('caching', () => {
    it('should cache resolved context', async () => {
      const cachedResolver = createContextResolver({ contextDir: '.test-validation', cacheEnabled: true });

      await writeFile(
        join(testDir, 'context.md'),
        `# Patterns

## Required Patterns

- Cached pattern
`
      );

      // First call
      const context1 = await cachedResolver.resolveContext('src/test.ts');
      expect(context1.patterns.length).toBe(1);

      // Second call should use cache
      const context2 = await cachedResolver.resolveContext('src/test.ts');
      expect(context2.patterns.length).toBe(1);
    });

    it('should clear cache', async () => {
      const cachedResolver = createContextResolver({ contextDir: '.test-validation', cacheEnabled: true });

      await writeFile(join(testDir, 'context.md'), '# Empty');

      await cachedResolver.resolveContext('test.ts');
      cachedResolver.clearCache();

      // Should work after clear
      const context = await cachedResolver.resolveContext('test.ts');
      expect(context).toBeDefined();
    });
  });

  describe('listContextFiles', () => {
    it('should list all context files', async () => {
      await writeFile(join(testDir, 'context.md'), '# Global');
      await mkdir(join(testDir, 'src'), { recursive: true });
      await writeFile(join(testDir, 'src', 'context.md'), '# Src');

      const files = await resolver.listContextFiles();

      expect(files.length).toBe(2);
      expect(files.some((f) => f.endsWith('context.md'))).toBe(true);
    });

    it('should return empty array when directory does not exist', async () => {
      const emptyResolver = createContextResolver({ contextDir: '.nonexistent' });
      const files = await emptyResolver.listContextFiles();

      expect(files).toHaveLength(0);
    });
  });
});
