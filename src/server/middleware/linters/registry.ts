/**
 * Linter Registry
 *
 * Manages linter adapters and handles auto-detection.
 */

import { debugLog } from '../../../debug.ts';
import type { LinterAdapter, ValidationConfig } from './types.ts';
import { DEFAULT_VALIDATION_CONFIG } from './types.ts';
import { ESLintAdapter } from './eslint-adapter.ts';
import { BiomeAdapter } from './biome-adapter.ts';
import { RuffAdapter } from './ruff-adapter.ts';
import { ClippyAdapter } from './clippy-adapter.ts';

/**
 * Linter registry.
 *
 * Manages available linter adapters and provides auto-detection.
 */
export class LinterRegistry {
  private adapters: Map<string, LinterAdapter> = new Map();

  constructor() {
    // Register built-in adapters
    // Order matters for auto-detection - more specific first
    this.register(new BiomeAdapter()); // Check Biome before ESLint
    this.register(new ESLintAdapter());
    this.register(new RuffAdapter());
    this.register(new ClippyAdapter());
  }

  /**
   * Register a linter adapter.
   */
  register(adapter: LinterAdapter): void {
    this.adapters.set(adapter.name, adapter);
    debugLog(`[LinterRegistry] Registered adapter: ${adapter.name}`);
  }

  /**
   * Get a linter adapter by name.
   */
  get(name: string): LinterAdapter | undefined {
    return this.adapters.get(name);
  }

  /**
   * Get all registered adapter names.
   */
  getNames(): string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Auto-detect the appropriate linter for a workspace.
   *
   * Checks each adapter's detect() method in order and returns
   * the first one that matches and is available.
   */
  async detectLinter(workspaceRoot: string): Promise<LinterAdapter | null> {
    for (const adapter of this.adapters.values()) {
      try {
        const detected = await adapter.detect(workspaceRoot);
        if (detected) {
          const available = await adapter.isAvailable();
          if (available) {
            debugLog(
              `[LinterRegistry] Auto-detected linter: ${adapter.name} for ${workspaceRoot}`
            );
            return adapter;
          } else {
            debugLog(
              `[LinterRegistry] Detected ${adapter.name} config but binary not available`
            );
          }
        }
      } catch (error) {
        debugLog(
          `[LinterRegistry] Error detecting ${adapter.name}: ${error}`
        );
      }
    }

    debugLog(`[LinterRegistry] No linter detected for ${workspaceRoot}`);
    return null;
  }

  /**
   * Get the appropriate linter based on config.
   */
  async getLinterForConfig(
    config: ValidationConfig,
    workspaceRoot: string
  ): Promise<LinterAdapter | null> {
    const linterConfig = config.linter;

    if (linterConfig.mode === 'disabled') {
      return null;
    }

    if (linterConfig.mode === 'explicit' && linterConfig.name) {
      const adapter = this.get(linterConfig.name);
      if (adapter) {
        const available = await adapter.isAvailable();
        if (available) {
          return adapter;
        }
        debugLog(
          `[LinterRegistry] Explicit linter ${linterConfig.name} not available`
        );
      }
      return null;
    }

    // Auto-detect
    return this.detectLinter(workspaceRoot);
  }

  /**
   * Find linters that handle a specific file extension.
   */
  getLintersByExtension(extension: string): LinterAdapter[] {
    const ext = extension.startsWith('.') ? extension : `.${extension}`;
    return Array.from(this.adapters.values()).filter((adapter) =>
      adapter.extensions.includes(ext)
    );
  }
}

/**
 * Load validation config from workspace or use defaults.
 *
 * Looks for .ultra/validation.json in workspace root.
 */
export async function loadValidationConfig(
  workspaceRoot: string
): Promise<ValidationConfig> {
  const configPath = `${workspaceRoot}/.ultra/validation.json`;

  try {
    const file = Bun.file(configPath);
    if (await file.exists()) {
      const content = await file.text();
      const parsed = JSON.parse(content) as Partial<ValidationConfig>;

      // Merge with defaults
      return {
        linter: {
          ...DEFAULT_VALIDATION_CONFIG.linter,
          ...parsed.linter,
        },
        semanticRules: {
          ...DEFAULT_VALIDATION_CONFIG.semanticRules,
          ...parsed.semanticRules,
        },
      };
    }
  } catch (error) {
    debugLog(`[LinterRegistry] Error loading validation config: ${error}`);
  }

  return DEFAULT_VALIDATION_CONFIG;
}

/**
 * Singleton registry instance.
 */
let registryInstance: LinterRegistry | null = null;

/**
 * Get the linter registry singleton.
 */
export function getLinterRegistry(): LinterRegistry {
  if (!registryInstance) {
    registryInstance = new LinterRegistry();
  }
  return registryInstance;
}
