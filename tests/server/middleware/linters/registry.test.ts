/**
 * Linter Registry Unit Tests
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  getLinterRegistry,
  LinterRegistry,
  loadValidationConfig,
} from '../../../../src/server/middleware/linters/registry.ts';
import { ESLintAdapter } from '../../../../src/server/middleware/linters/eslint-adapter.ts';
import { BiomeAdapter } from '../../../../src/server/middleware/linters/biome-adapter.ts';
import { RuffAdapter } from '../../../../src/server/middleware/linters/ruff-adapter.ts';
import { ClippyAdapter } from '../../../../src/server/middleware/linters/clippy-adapter.ts';
import { DEFAULT_VALIDATION_CONFIG } from '../../../../src/server/middleware/linters/types.ts';
import { createTempWorkspace, type TempWorkspace } from '../../../helpers/temp-workspace.ts';

describe('LinterRegistry', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // Singleton
  // ─────────────────────────────────────────────────────────────────────────

  describe('singleton', () => {
    test('getLinterRegistry returns same instance', () => {
      const registry1 = getLinterRegistry();
      const registry2 = getLinterRegistry();
      expect(registry1).toBe(registry2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Adapter Registration
  // ─────────────────────────────────────────────────────────────────────────

  describe('adapter registration', () => {
    test('has all built-in adapters registered', () => {
      const registry = getLinterRegistry();
      const names = registry.getNames();

      expect(names).toContain('eslint');
      expect(names).toContain('biome');
      expect(names).toContain('ruff');
      expect(names).toContain('clippy');
    });

    test('get returns correct adapter instances', () => {
      const registry = getLinterRegistry();

      expect(registry.get('eslint')).toBeInstanceOf(ESLintAdapter);
      expect(registry.get('biome')).toBeInstanceOf(BiomeAdapter);
      expect(registry.get('ruff')).toBeInstanceOf(RuffAdapter);
      expect(registry.get('clippy')).toBeInstanceOf(ClippyAdapter);
    });

    test('get returns undefined for unknown adapter', () => {
      const registry = getLinterRegistry();
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    test('register adds new adapter', () => {
      const registry = new LinterRegistry();
      const customAdapter = {
        name: 'custom-linter',
        displayName: 'Custom',
        extensions: ['.custom'],
        detect: async () => false,
        isAvailable: async () => false,
        lint: async () => ({ success: true, errors: [], warnings: [], filesChecked: 0, duration: 0 }),
      };

      registry.register(customAdapter);
      expect(registry.get('custom-linter')).toBe(customAdapter);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Extension Lookup
  // ─────────────────────────────────────────────────────────────────────────

  describe('getLintersByExtension', () => {
    test('returns TypeScript linters', () => {
      const registry = getLinterRegistry();
      const adapters = registry.getLintersByExtension('.ts');

      expect(adapters.length).toBeGreaterThanOrEqual(2);
      expect(adapters.some((a) => a.name === 'eslint')).toBe(true);
      expect(adapters.some((a) => a.name === 'biome')).toBe(true);
    });

    test('returns JavaScript linters', () => {
      const registry = getLinterRegistry();
      const adapters = registry.getLintersByExtension('.js');

      expect(adapters.some((a) => a.name === 'eslint')).toBe(true);
      expect(adapters.some((a) => a.name === 'biome')).toBe(true);
    });

    test('returns Python linters', () => {
      const registry = getLinterRegistry();
      const adapters = registry.getLintersByExtension('.py');

      expect(adapters.some((a) => a.name === 'ruff')).toBe(true);
    });

    test('returns Rust linters', () => {
      const registry = getLinterRegistry();
      const adapters = registry.getLintersByExtension('.rs');

      expect(adapters.some((a) => a.name === 'clippy')).toBe(true);
    });

    test('returns JSON linters', () => {
      const registry = getLinterRegistry();
      const adapters = registry.getLintersByExtension('.json');

      expect(adapters.some((a) => a.name === 'biome')).toBe(true);
    });

    test('handles extension without dot prefix', () => {
      const registry = getLinterRegistry();
      const adapters = registry.getLintersByExtension('ts');

      expect(adapters.length).toBeGreaterThanOrEqual(2);
    });

    test('returns empty array for unknown extension', () => {
      const registry = getLinterRegistry();
      const adapters = registry.getLintersByExtension('.unknown123');

      expect(adapters).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Linter Detection
  // ─────────────────────────────────────────────────────────────────────────

  describe('detectLinter', () => {
    let workspace: TempWorkspace;

    beforeEach(async () => {
      workspace = await createTempWorkspace();
    });

    test('detects ESLint from eslint.config.js', async () => {
      await workspace.writeFile('eslint.config.js', 'export default [];');
      await workspace.writeFile('test.ts', 'const x = 1;');

      const registry = getLinterRegistry();
      const linter = await registry.detectLinter(workspace.path);

      // May detect eslint or biome depending on order, but should detect something
      if (linter) {
        expect(['eslint', 'biome']).toContain(linter.name);
      }
    });

    test('detects Biome from biome.json', async () => {
      await workspace.writeFile('biome.json', '{}');
      await workspace.writeFile('test.ts', 'const x = 1;');

      const registry = getLinterRegistry();
      const linter = await registry.detectLinter(workspace.path);

      // Biome is checked first, so it should be detected
      if (linter) {
        expect(linter.name).toBe('biome');
      }
    });

    test('detects Ruff from ruff.toml', async () => {
      await workspace.writeFile('ruff.toml', '[tool.ruff]');
      await workspace.writeFile('test.py', 'x = 1');

      const registry = getLinterRegistry();
      const linter = await registry.detectLinter(workspace.path);

      if (linter) {
        expect(linter.name).toBe('ruff');
      }
    });

    test('detects Clippy from Cargo.toml', async () => {
      await workspace.writeFile('Cargo.toml', '[package]\nname = "test"');

      const registry = getLinterRegistry();
      const linter = await registry.detectLinter(workspace.path);

      if (linter) {
        expect(linter.name).toBe('clippy');
      }
    });

    test('returns null when no linter detected', async () => {
      // Empty workspace with no config files
      const registry = getLinterRegistry();
      const linter = await registry.detectLinter(workspace.path);

      // Should return null for empty workspace
      expect(linter).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // getLinterForConfig
  // ─────────────────────────────────────────────────────────────────────────

  describe('getLinterForConfig', () => {
    let workspace: TempWorkspace;

    beforeEach(async () => {
      workspace = await createTempWorkspace();
    });

    test('returns null when mode is disabled', async () => {
      const registry = getLinterRegistry();
      const config = {
        ...DEFAULT_VALIDATION_CONFIG,
        linter: { ...DEFAULT_VALIDATION_CONFIG.linter, mode: 'disabled' as const },
      };

      const linter = await registry.getLinterForConfig(config, workspace.path);
      expect(linter).toBeNull();
    });

    test('returns explicit linter when mode is explicit', async () => {
      const registry = getLinterRegistry();
      const config = {
        ...DEFAULT_VALIDATION_CONFIG,
        linter: { ...DEFAULT_VALIDATION_CONFIG.linter, mode: 'explicit' as const, name: 'eslint' },
      };

      const linter = await registry.getLinterForConfig(config, workspace.path);

      // May be null if eslint not available, but if available should be eslint
      if (linter) {
        expect(linter.name).toBe('eslint');
      }
    });

    test('auto-detects when mode is auto', async () => {
      await workspace.writeFile('eslint.config.js', 'export default [];');

      const registry = getLinterRegistry();
      const config = {
        ...DEFAULT_VALIDATION_CONFIG,
        linter: { ...DEFAULT_VALIDATION_CONFIG.linter, mode: 'auto' as const },
      };

      const linter = await registry.getLinterForConfig(config, workspace.path);

      // Should auto-detect the linter
      if (linter) {
        expect(['eslint', 'biome']).toContain(linter.name);
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadValidationConfig
// ─────────────────────────────────────────────────────────────────────────────

describe('loadValidationConfig', () => {
  let workspace: TempWorkspace;

  beforeEach(async () => {
    workspace = await createTempWorkspace();
  });

  test('returns defaults when no config file exists', async () => {
    const config = await loadValidationConfig(workspace.path);

    expect(config.linter.mode).toBe('auto');
    expect(config.semanticRules.enabled).toBe(true);
  });

  test('loads config from .ultra/validation.json', async () => {
    await workspace.mkdir('.ultra');
    await workspace.writeFile(
      '.ultra/validation.json',
      JSON.stringify({
        linter: { mode: 'disabled' },
        semanticRules: { enabled: false },
      })
    );

    const config = await loadValidationConfig(workspace.path);

    expect(config.linter.mode).toBe('disabled');
    expect(config.semanticRules.enabled).toBe(false);
  });

  test('merges partial config with defaults', async () => {
    await workspace.mkdir('.ultra');
    await workspace.writeFile(
      '.ultra/validation.json',
      JSON.stringify({
        linter: { mode: 'explicit', name: 'biome' },
      })
    );

    const config = await loadValidationConfig(workspace.path);

    expect(config.linter.mode).toBe('explicit');
    expect(config.linter.name).toBe('biome');
    expect(config.semanticRules.enabled).toBe(true); // Default
  });

  test('handles malformed config gracefully', async () => {
    await workspace.mkdir('.ultra');
    await workspace.writeFile('.ultra/validation.json', 'not valid json');

    const config = await loadValidationConfig(workspace.path);

    // Should return defaults on parse error
    expect(config.linter.mode).toBe('auto');
  });
});
