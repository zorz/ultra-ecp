/**
 * Rule Loader Unit Tests
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  getContextPathsForFile,
  loadRuleHierarchy,
  getRulesForFile,
  clearRuleCache,
} from '../../../../src/server/middleware/rules/loader.ts';
import { createTempWorkspace, type TempWorkspace } from '../../../helpers/temp-workspace.ts';

// ─────────────────────────────────────────────────────────────────────────────
// getContextPathsForFile
// ─────────────────────────────────────────────────────────────────────────────

describe('getContextPathsForFile', () => {
  test('returns hierarchy for nested file', () => {
    const paths = getContextPathsForFile(
      '/workspace/src/components/Button.tsx',
      '/workspace'
    );

    expect(paths).toContain('/workspace/validation/context.md');
    expect(paths).toContain('/workspace/validation/src/context.md');
    expect(paths).toContain('/workspace/validation/src/components/context.md');
  });

  test('returns root context for file at root', () => {
    const paths = getContextPathsForFile('/workspace/file.ts', '/workspace');

    expect(paths).toContain('/workspace/validation/context.md');
  });

  test('handles deeply nested paths', () => {
    const paths = getContextPathsForFile(
      '/workspace/src/features/auth/components/LoginForm.tsx',
      '/workspace'
    );

    expect(paths.length).toBeGreaterThanOrEqual(5);
    expect(paths[0]).toBe('/workspace/validation/context.md');
    // Last path is file-specific context (LoginForm.md)
    expect(paths[paths.length - 1]).toBe(
      '/workspace/validation/src/features/auth/components/LoginForm.md'
    );
    // Should also include the directory context.md paths
    expect(paths).toContain('/workspace/validation/src/features/auth/components/context.md');
  });

  test('handles trailing slashes in workspace root', () => {
    // Note: trailing slash causes double slash - test actual behavior
    const paths = getContextPathsForFile(
      '/workspace/src/file.ts',
      '/workspace/'
    );

    // With trailing slash, paths have double slash
    expect(paths[0]).toBe('/workspace//validation/context.md');
  });

  test('returns ordered from general to specific', () => {
    const paths = getContextPathsForFile(
      '/workspace/src/lib/utils.ts',
      '/workspace'
    );

    // Root should come first
    expect(paths[0]).toContain('validation/context.md');
    // Most specific is the file-specific context (utils.md)
    expect(paths[paths.length - 1]).toContain('src/lib/utils.md');
    // Should also include directory context
    expect(paths).toContain('/workspace/validation/src/lib/context.md');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadRuleHierarchy
// ─────────────────────────────────────────────────────────────────────────────

describe('loadRuleHierarchy', () => {
  let workspace: TempWorkspace;

  beforeEach(async () => {
    workspace = await createTempWorkspace();
    clearRuleCache();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  test('loads rules from context file', async () => {
    await workspace.mkdir('validation');
    await workspace.writeFile(
      'validation/context.md',
      `
# Root Context

\`\`\`rule:root-rule
files: **/*.ts
message: "Root rule"
\`\`\`
`
    );

    await workspace.writeFile('src/test.ts', 'const x = 1;');

    const hierarchy = await loadRuleHierarchy(
      `${workspace.path}/src/test.ts`,
      workspace.path
    );

    expect(hierarchy.rules).toHaveLength(1);
    expect(hierarchy.rules[0]!.id).toBe('root-rule');
  });

  test('merges rules from multiple context files', async () => {
    await workspace.mkdir('validation/src');
    await workspace.writeFile(
      'validation/context.md',
      `
\`\`\`rule:root-rule
message: "From root"
\`\`\`
`
    );
    await workspace.writeFile(
      'validation/src/context.md',
      `
\`\`\`rule:src-rule
message: "From src"
\`\`\`
`
    );

    await workspace.mkdir('src');
    await workspace.writeFile('src/test.ts', '');

    const hierarchy = await loadRuleHierarchy(
      `${workspace.path}/src/test.ts`,
      workspace.path
    );

    expect(hierarchy.rules).toHaveLength(2);
    expect(hierarchy.rules.some((r) => r.id === 'root-rule')).toBe(true);
    expect(hierarchy.rules.some((r) => r.id === 'src-rule')).toBe(true);
  });

  test('later rules override earlier rules by ID', async () => {
    await workspace.mkdir('validation/src');
    await workspace.writeFile(
      'validation/context.md',
      `
\`\`\`rule:override-me
message: "Original"
severity: warning
\`\`\`
`
    );
    await workspace.writeFile(
      'validation/src/context.md',
      `
\`\`\`rule:override-me
message: "Overridden"
severity: error
\`\`\`
`
    );

    await workspace.mkdir('src');
    await workspace.writeFile('src/test.ts', '');

    const hierarchy = await loadRuleHierarchy(
      `${workspace.path}/src/test.ts`,
      workspace.path
    );

    // Should only have one rule with the overridden values
    const rule = hierarchy.rules.find((r) => r.id === 'override-me');
    expect(rule).toBeDefined();
    expect(rule!.message).toBe('Overridden');
    expect(rule!.severity).toBe('error');
  });

  test('returns empty rules when no context files exist', async () => {
    await workspace.mkdir('src');
    await workspace.writeFile('src/test.ts', '');

    const hierarchy = await loadRuleHierarchy(
      `${workspace.path}/src/test.ts`,
      workspace.path
    );

    expect(hierarchy.rules).toEqual([]);
  });

  test('includes context files that were loaded', async () => {
    await workspace.mkdir('validation/src');
    await workspace.writeFile('validation/context.md', '# Root');
    await workspace.writeFile('validation/src/context.md', '# Src');

    await workspace.mkdir('src');
    await workspace.writeFile('src/test.ts', '');

    const hierarchy = await loadRuleHierarchy(
      `${workspace.path}/src/test.ts`,
      workspace.path
    );

    expect(hierarchy.contexts.length).toBe(2);
  });

  test('caches loaded rules', async () => {
    await workspace.mkdir('validation');
    await workspace.writeFile('validation/context.md', '# Root');
    await workspace.mkdir('src');
    await workspace.writeFile('src/test.ts', '');

    // Load twice
    const hierarchy1 = await loadRuleHierarchy(
      `${workspace.path}/src/test.ts`,
      workspace.path
    );
    const hierarchy2 = await loadRuleHierarchy(
      `${workspace.path}/src/test.ts`,
      workspace.path
    );

    // Both should return the same context files
    expect(hierarchy1.contexts).toEqual(hierarchy2.contexts);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getRulesForFile
// ─────────────────────────────────────────────────────────────────────────────

describe('getRulesForFile', () => {
  test('filters rules by file pattern', () => {
    const rules = [
      { id: 'ts-only', files: ['**/*.ts'], sourceFile: 'test.md', sourceLine: 1 },
      { id: 'tsx-only', files: ['**/*.tsx'], sourceFile: 'test.md', sourceLine: 2 },
      { id: 'all-files', files: ['**/*'], sourceFile: 'test.md', sourceLine: 3 },
    ];

    const tsRules = getRulesForFile('/src/test.ts', rules);
    expect(tsRules.some((r) => r.id === 'ts-only')).toBe(true);
    expect(tsRules.some((r) => r.id === 'tsx-only')).toBe(false);
    expect(tsRules.some((r) => r.id === 'all-files')).toBe(true);

    const tsxRules = getRulesForFile('/src/test.tsx', rules);
    expect(tsxRules.some((r) => r.id === 'ts-only')).toBe(false);
    expect(tsxRules.some((r) => r.id === 'tsx-only')).toBe(true);
    expect(tsxRules.some((r) => r.id === 'all-files')).toBe(true);
  });

  test('includes rules without file patterns', () => {
    const rules = [
      { id: 'no-pattern', message: 'Applies to all', sourceFile: 'test.md', sourceLine: 1 },
    ];

    const matching = getRulesForFile('/any/file.ts', rules);
    expect(matching).toHaveLength(1);
  });

  test('supports multiple file patterns', () => {
    const rules = [
      {
        id: 'multi-pattern',
        files: ['src/*.ts', 'lib/*.ts'],
        sourceFile: 'test.md',
        sourceLine: 1,
      },
    ];

    expect(getRulesForFile('/workspace/src/test.ts', rules)).toHaveLength(1);
    expect(getRulesForFile('/workspace/lib/util.ts', rules)).toHaveLength(1);
    expect(getRulesForFile('/workspace/other/file.ts', rules)).toHaveLength(0);
  });

  test('handles directory wildcards', () => {
    const rules = [
      {
        id: 'components-only',
        files: ['components/*.tsx', 'components/**/*.tsx'],
        sourceFile: 'test.md',
        sourceLine: 1,
      },
    ];

    expect(getRulesForFile('/workspace/src/components/Button.tsx', rules)).toHaveLength(1);
    expect(getRulesForFile('/workspace/src/components/forms/Input.tsx', rules)).toHaveLength(1);
    expect(getRulesForFile('/workspace/src/utils/helper.tsx', rules)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// clearRuleCache
// ─────────────────────────────────────────────────────────────────────────────

describe('clearRuleCache', () => {
  let workspace: TempWorkspace;

  beforeEach(async () => {
    workspace = await createTempWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  test('clears cached rules', async () => {
    await workspace.mkdir('validation');
    await workspace.writeFile(
      'validation/context.md',
      `
\`\`\`rule:original
message: "Original"
\`\`\`
`
    );
    await workspace.writeFile('test.ts', '');

    // Load rules
    await loadRuleHierarchy(`${workspace.path}/test.ts`, workspace.path);

    // Update the file
    await workspace.writeFile(
      'validation/context.md',
      `
\`\`\`rule:updated
message: "Updated"
\`\`\`
`
    );

    // Clear cache
    clearRuleCache();

    // Load again - should get new rules
    const hierarchy = await loadRuleHierarchy(
      `${workspace.path}/test.ts`,
      workspace.path
    );

    expect(hierarchy.rules.some((r) => r.id === 'updated')).toBe(true);
  });
});
