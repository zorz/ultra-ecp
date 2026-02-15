/**
 * Linter Adapter Unit Tests
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { ESLintAdapter } from '../../../../src/server/middleware/linters/eslint-adapter.ts';
import { BiomeAdapter } from '../../../../src/server/middleware/linters/biome-adapter.ts';
import { RuffAdapter } from '../../../../src/server/middleware/linters/ruff-adapter.ts';
import { ClippyAdapter } from '../../../../src/server/middleware/linters/clippy-adapter.ts';
import { createTempWorkspace, type TempWorkspace } from '../../../helpers/temp-workspace.ts';

// ─────────────────────────────────────────────────────────────────────────────
// ESLint Adapter
// ─────────────────────────────────────────────────────────────────────────────

describe('ESLintAdapter', () => {
  const adapter = new ESLintAdapter();
  let workspace: TempWorkspace;

  beforeEach(async () => {
    workspace = await createTempWorkspace();
  });

  describe('properties', () => {
    test('has correct name', () => {
      expect(adapter.name).toBe('eslint');
    });

    test('has correct displayName', () => {
      expect(adapter.displayName).toBe('ESLint');
    });

    test('supports JavaScript extensions', () => {
      expect(adapter.extensions).toContain('.js');
      expect(adapter.extensions).toContain('.jsx');
      expect(adapter.extensions).toContain('.mjs');
      expect(adapter.extensions).toContain('.cjs');
    });

    test('supports TypeScript extensions', () => {
      expect(adapter.extensions).toContain('.ts');
      expect(adapter.extensions).toContain('.tsx');
    });
  });

  describe('detect', () => {
    test('detects eslint.config.js', async () => {
      await workspace.writeFile('eslint.config.js', 'export default [];');
      expect(await adapter.detect(workspace.path)).toBe(true);
    });

    test('detects eslint.config.mjs', async () => {
      await workspace.writeFile('eslint.config.mjs', 'export default [];');
      expect(await adapter.detect(workspace.path)).toBe(true);
    });

    test('detects .eslintrc.json', async () => {
      await workspace.writeFile('.eslintrc.json', '{}');
      expect(await adapter.detect(workspace.path)).toBe(true);
    });

    test('detects .eslintrc.js', async () => {
      await workspace.writeFile('.eslintrc.js', 'module.exports = {};');
      expect(await adapter.detect(workspace.path)).toBe(true);
    });

    test('detects .eslintrc.yml', async () => {
      await workspace.writeFile('.eslintrc.yml', 'root: true');
      expect(await adapter.detect(workspace.path)).toBe(true);
    });

    test('detects eslintConfig in package.json', async () => {
      await workspace.writeFile(
        'package.json',
        JSON.stringify({ eslintConfig: { root: true } })
      );
      expect(await adapter.detect(workspace.path)).toBe(true);
    });

    test('returns false when no config exists', async () => {
      expect(await adapter.detect(workspace.path)).toBe(false);
    });
  });

  describe('lint', () => {
    test('returns success for empty file list', async () => {
      const result = await adapter.lint([], workspace.path);

      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(result.filesChecked).toBe(0);
    });

    test('lint returns result with expected shape', async () => {
      await workspace.writeFile('eslint.config.js', 'export default [];');
      await workspace.writeFile('test.ts', 'const x = 1;');

      const result = await adapter.lint([`${workspace.path}/test.ts`], workspace.path);

      expect(typeof result.success).toBe('boolean');
      expect(Array.isArray(result.errors)).toBe(true);
      expect(Array.isArray(result.warnings)).toBe(true);
      expect(typeof result.filesChecked).toBe('number');
      expect(typeof result.duration).toBe('number');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Biome Adapter
// ─────────────────────────────────────────────────────────────────────────────

describe('BiomeAdapter', () => {
  const adapter = new BiomeAdapter();
  let workspace: TempWorkspace;

  beforeEach(async () => {
    workspace = await createTempWorkspace();
  });

  describe('properties', () => {
    test('has correct name', () => {
      expect(adapter.name).toBe('biome');
    });

    test('has correct displayName', () => {
      expect(adapter.displayName).toBe('Biome');
    });

    test('supports JavaScript/TypeScript extensions', () => {
      expect(adapter.extensions).toContain('.js');
      expect(adapter.extensions).toContain('.jsx');
      expect(adapter.extensions).toContain('.ts');
      expect(adapter.extensions).toContain('.tsx');
    });

    test('supports JSON extensions', () => {
      expect(adapter.extensions).toContain('.json');
      expect(adapter.extensions).toContain('.jsonc');
    });
  });

  describe('detect', () => {
    test('detects biome.json', async () => {
      await workspace.writeFile('biome.json', '{}');
      expect(await adapter.detect(workspace.path)).toBe(true);
    });

    test('detects biome.jsonc', async () => {
      await workspace.writeFile('biome.jsonc', '{}');
      expect(await adapter.detect(workspace.path)).toBe(true);
    });

    test('returns false when no config exists', async () => {
      expect(await adapter.detect(workspace.path)).toBe(false);
    });
  });

  describe('lint', () => {
    test('returns success for empty file list', async () => {
      const result = await adapter.lint([], workspace.path);

      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.filesChecked).toBe(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ruff Adapter
// ─────────────────────────────────────────────────────────────────────────────

describe('RuffAdapter', () => {
  const adapter = new RuffAdapter();
  let workspace: TempWorkspace;

  beforeEach(async () => {
    workspace = await createTempWorkspace();
  });

  describe('properties', () => {
    test('has correct name', () => {
      expect(adapter.name).toBe('ruff');
    });

    test('has correct displayName', () => {
      expect(adapter.displayName).toBe('Ruff');
    });

    test('supports Python extensions', () => {
      expect(adapter.extensions).toContain('.py');
      expect(adapter.extensions).toContain('.pyi');
    });
  });

  describe('detect', () => {
    test('detects ruff.toml', async () => {
      await workspace.writeFile('ruff.toml', '[tool.ruff]');
      expect(await adapter.detect(workspace.path)).toBe(true);
    });

    test('detects .ruff.toml', async () => {
      await workspace.writeFile('.ruff.toml', '[tool.ruff]');
      expect(await adapter.detect(workspace.path)).toBe(true);
    });

    test('detects [tool.ruff] in pyproject.toml', async () => {
      await workspace.writeFile('pyproject.toml', '[tool.ruff]\nselect = ["E"]');
      expect(await adapter.detect(workspace.path)).toBe(true);
    });

    test('returns false when no config and no Python files', async () => {
      expect(await adapter.detect(workspace.path)).toBe(false);
    });
  });

  describe('lint', () => {
    test('returns success for empty file list', async () => {
      const result = await adapter.lint([], workspace.path);

      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.filesChecked).toBe(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Clippy Adapter
// ─────────────────────────────────────────────────────────────────────────────

describe('ClippyAdapter', () => {
  const adapter = new ClippyAdapter();
  let workspace: TempWorkspace;

  beforeEach(async () => {
    workspace = await createTempWorkspace();
  });

  describe('properties', () => {
    test('has correct name', () => {
      expect(adapter.name).toBe('clippy');
    });

    test('has correct displayName', () => {
      expect(adapter.displayName).toBe('Clippy');
    });

    test('supports Rust extensions', () => {
      expect(adapter.extensions).toContain('.rs');
    });
  });

  describe('detect', () => {
    test('detects Cargo.toml', async () => {
      await workspace.writeFile('Cargo.toml', '[package]\nname = "test"');
      expect(await adapter.detect(workspace.path)).toBe(true);
    });

    test('returns false when no Cargo.toml', async () => {
      expect(await adapter.detect(workspace.path)).toBe(false);
    });
  });

  describe('lint', () => {
    test('returns success for empty file list', async () => {
      const result = await adapter.lint([], workspace.path);

      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.filesChecked).toBe(0);
    });
  });
});
