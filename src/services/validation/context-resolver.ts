/**
 * Context Resolver
 *
 * Resolves hierarchical validation context from validation/ directory.
 * Merges context files from global to file-specific, applying overrides.
 */

import { join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import type {
  HierarchicalContext,
  ParsedContext,
  Override,
  Unsubscribe,
} from './types.ts';
import { parseContextFile } from './context-parser.ts';
import { ContextWatcher, type ContextChangeEvent } from './context-watcher.ts';
import { debugLog, isDebugEnabled } from '../../debug.ts';

/**
 * Cache entry for resolved context.
 */
interface ContextCacheEntry {
  /** Resolved context */
  context: HierarchicalContext;
  /** Modification times of all context files used */
  contextFileMtimes: Record<string, number>;
  /** When this entry was cached */
  cachedAt: number;
}

/**
 * Options for the context resolver.
 */
export interface ContextResolverOptions {
  /** Path to the validation context directory */
  contextDir: string;
  /** Whether to enable caching */
  cacheEnabled: boolean;
  /** Whether to watch for file changes */
  watchEnabled: boolean;
  /** Debounce delay for file watcher (ms) */
  watchDebounceMs: number;
}

/**
 * Default resolver options.
 */
const DEFAULT_RESOLVER_OPTIONS: ContextResolverOptions = {
  contextDir: 'validation',
  cacheEnabled: true,
  watchEnabled: false,
  watchDebounceMs: 100,
};

/**
 * Event emitted when context changes.
 */
export interface ContextInvalidationEvent {
  /** Path to the changed context file */
  contextFile: string;
  /** Source files affected by this change */
  affectedFiles: string[];
  /** Type of change */
  changeType: 'add' | 'change' | 'delete';
}

/**
 * Callback for context invalidation events.
 */
export type ContextInvalidationCallback = (event: ContextInvalidationEvent) => void;

/**
 * Resolves hierarchical validation context for source files.
 */
export class ContextResolver {
  private contextDir: string;
  private cacheEnabled: boolean;
  private cache: Map<string, ContextCacheEntry> = new Map();
  private watcher: ContextWatcher | null = null;
  private invalidationCallbacks: Set<ContextInvalidationCallback> = new Set();

  constructor(options: Partial<ContextResolverOptions> = {}) {
    const opts = { ...DEFAULT_RESOLVER_OPTIONS, ...options };
    this.contextDir = opts.contextDir;
    this.cacheEnabled = opts.cacheEnabled;

    // Set up file watcher if enabled
    if (opts.watchEnabled) {
      this.watcher = new ContextWatcher({
        contextDir: opts.contextDir,
        debounceMs: opts.watchDebounceMs,
        recursive: true,
      });

      this.watcher.onChange((event) => this.handleContextChange(event));
    }
  }

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[ContextResolver] ${msg}`);
    }
  }

  /**
   * Start watching for context file changes.
   */
  async startWatching(): Promise<void> {
    if (this.watcher) {
      await this.watcher.start();
    }
  }

  /**
   * Stop watching for context file changes.
   */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.stop();
    }
  }

  /**
   * Subscribe to context invalidation events.
   */
  onInvalidation(callback: ContextInvalidationCallback): Unsubscribe {
    this.invalidationCallbacks.add(callback);
    return () => {
      this.invalidationCallbacks.delete(callback);
    };
  }

  /**
   * Resolve all applicable context for a file path.
   */
  async resolveContext(filePath: string): Promise<HierarchicalContext> {
    this.log(`Resolving context for: ${filePath}`);

    // Check cache first
    if (this.cacheEnabled) {
      const cached = await this.getFromCache(filePath);
      if (cached) {
        this.log('Using cached context');
        return cached;
      }
    }

    // Get all context file paths for this source file
    const contextFiles = this.getContextFilePaths(filePath);
    this.log(`Context files to load: ${contextFiles.join(', ')}`);

    // Load and parse each context file that exists
    const contexts: ParsedContext[] = [];
    const mtimes: Record<string, number> = {};

    for (const contextFile of contextFiles) {
      try {
        const fullPath = join(process.cwd(), contextFile);
        const fileStat = await stat(fullPath);
        mtimes[contextFile] = fileStat.mtimeMs;

        const content = await Bun.file(fullPath).text();
        const parsed = parseContextFile(content, contextFile);
        contexts.push(parsed);
        this.log(`Loaded context file: ${contextFile}`);
      } catch {
        // File doesn't exist, skip it
        this.log(`Context file not found: ${contextFile}`);
      }
    }

    // Merge all contexts
    const merged = this.mergeContexts(contexts);

    // Cache the result
    if (this.cacheEnabled) {
      this.cache.set(filePath, {
        context: merged,
        contextFileMtimes: mtimes,
        cachedAt: Date.now(),
      });
    }

    return merged;
  }

  /**
   * Get all context file paths for a source file, in order.
   *
   * For src/clients/headless/server.ts, returns:
   * - validation/context.md (global)
   * - validation/src/context.md
   * - validation/src/clients/context.md
   * - validation/src/clients/headless/context.md
   * - validation/src/clients/headless/server.md (file-specific)
   */
  getContextFilePaths(filePath: string): string[] {
    const paths: string[] = [];
    const parts = filePath.split('/').filter(Boolean);

    // Global context
    paths.push(join(this.contextDir, 'context.md'));

    // Directory contexts
    let current = this.contextDir;
    for (let i = 0; i < parts.length - 1; i++) {
      current = join(current, parts[i]!);
      paths.push(join(current, 'context.md'));
    }

    // File-specific context
    const fileName = parts[parts.length - 1];
    if (fileName) {
      const baseName = fileName.replace(/\.[^.]+$/, '');
      paths.push(join(current, `${baseName}.md`));
    }

    return paths;
  }

  /**
   * Get source files that would be affected by a context file change.
   */
  getAffectedSourceFiles(contextFilePath: string): string[] {
    const affected: string[] = [];

    for (const [sourceFile, entry] of this.cache.entries()) {
      if (Object.keys(entry.contextFileMtimes).includes(contextFilePath)) {
        affected.push(sourceFile);
      }
    }

    return affected;
  }

  /**
   * Check if cache entry is still valid.
   */
  private async getFromCache(filePath: string): Promise<HierarchicalContext | null> {
    const entry = this.cache.get(filePath);
    if (!entry) {
      return null;
    }

    // Check if any context files have been modified
    for (const [contextFile, cachedMtime] of Object.entries(entry.contextFileMtimes)) {
      try {
        const fullPath = join(process.cwd(), contextFile);
        const fileStat = await stat(fullPath);
        if (fileStat.mtimeMs > cachedMtime) {
          this.log(`Context file modified: ${contextFile}`);
          this.cache.delete(filePath);
          return null;
        }
      } catch {
        // File was deleted
        this.log(`Context file deleted: ${contextFile}`);
        this.cache.delete(filePath);
        return null;
      }
    }

    return entry.context;
  }

  /**
   * Handle a context file change from the watcher.
   */
  private handleContextChange(event: ContextChangeEvent): void {
    const contextFile = join(this.contextDir, event.path);
    const affectedFiles = this.getAffectedSourceFiles(contextFile);

    this.log(`Context change: ${event.type} ${contextFile}, affects ${affectedFiles.length} files`);

    // Invalidate cache for affected files
    for (const sourceFile of affectedFiles) {
      this.cache.delete(sourceFile);
    }

    // Also invalidate any entries that might use the global context
    if (event.path === 'context.md') {
      this.clearCache();
    }

    // Notify listeners
    const invalidationEvent: ContextInvalidationEvent = {
      contextFile,
      affectedFiles,
      changeType: event.type,
    };

    for (const callback of this.invalidationCallbacks) {
      try {
        callback(invalidationEvent);
      } catch (error) {
        this.log(`Invalidation callback error: ${error}`);
      }
    }
  }

  /**
   * Parse a context.md file into structured data.
   * @deprecated Use parseContextFile from context-parser.ts instead.
   */
  parseContextFile(content: string, source: string): ParsedContext {
    return parseContextFile(content, source);
  }

  /**
   * Merge multiple contexts, applying overrides.
   */
  mergeContexts(contexts: ParsedContext[]): HierarchicalContext {
    const merged: HierarchicalContext = {
      patterns: [],
      antiPatterns: [],
      conventions: [],
      architectureNotes: '',
      overrides: [],
    };

    for (const ctx of contexts) {
      // Apply overrides first
      for (const override of ctx.overrides) {
        this.applyOverride(merged, override);
        merged.overrides.push(override);
      }

      // Merge patterns (by description to avoid duplicates)
      merged.patterns = this.mergeById(merged.patterns, ctx.patterns);
      merged.antiPatterns = this.mergeById(merged.antiPatterns, ctx.antiPatterns);
      merged.conventions = this.mergeById(merged.conventions, ctx.conventions);

      // Append architecture notes
      if (ctx.architectureNotes) {
        if (merged.architectureNotes) {
          merged.architectureNotes += '\n\n' + ctx.architectureNotes;
        } else {
          merged.architectureNotes = ctx.architectureNotes;
        }
      }
    }

    return merged;
  }

  /**
   * Apply an override to merged context.
   */
  private applyOverride(context: HierarchicalContext, override: Override): void {
    switch (override.type) {
      case 'disable': {
        // Remove matching items by ID or description containing the target
        context.patterns = context.patterns.filter(
          (p) => !p.id.includes(override.targetId) && !p.description.toLowerCase().includes(override.targetId.toLowerCase())
        );
        context.antiPatterns = context.antiPatterns.filter(
          (p) => !p.id.includes(override.targetId) && !p.pattern.toLowerCase().includes(override.targetId.toLowerCase())
        );
        context.conventions = context.conventions.filter(
          (c) => !c.id.includes(override.targetId) && !c.description.toLowerCase().includes(override.targetId.toLowerCase())
        );
        break;
      }

      case 'override': {
        // Find and replace matching items
        for (const pattern of context.patterns) {
          if (pattern.description.toLowerCase().includes(override.targetId.toLowerCase())) {
            pattern.description = override.newValue ?? pattern.description;
            pattern.source = override.source;
          }
        }
        for (const ap of context.antiPatterns) {
          if (ap.pattern.toLowerCase().includes(override.targetId.toLowerCase())) {
            ap.alternative = override.newValue ?? ap.alternative;
            ap.source = override.source;
          }
        }
        for (const conv of context.conventions) {
          if (conv.description.toLowerCase().includes(override.targetId.toLowerCase())) {
            conv.description = override.newValue ?? conv.description;
            conv.source = override.source;
          }
        }
        break;
      }

      case 'extend': {
        // Add to matching items (append to description/notes)
        if (override.newValue) {
          for (const pattern of context.patterns) {
            if (pattern.description.toLowerCase().includes(override.targetId.toLowerCase())) {
              pattern.description += ' ' + override.newValue;
            }
          }
        }
        break;
      }
    }
  }

  /**
   * Merge arrays by ID, later items override earlier ones with same ID.
   */
  private mergeById<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
    const byId = new Map<string, T>();

    for (const item of existing) {
      byId.set(item.id, item);
    }

    for (const item of incoming) {
      byId.set(item.id, item);
    }

    return Array.from(byId.values());
  }

  /**
   * Invalidate cache for all entries using a specific context file.
   */
  invalidateByContextFile(contextFilePath: string): void {
    for (const [filePath, entry] of this.cache.entries()) {
      if (Object.keys(entry.contextFileMtimes).includes(contextFilePath)) {
        this.cache.delete(filePath);
        this.log(`Invalidated cache for ${filePath} due to context file change`);
      }
    }
  }

  /**
   * Clear the entire cache.
   */
  clearCache(): void {
    this.cache.clear();
    this.log('Cache cleared');
  }

  /**
   * Get cache statistics.
   */
  getCacheStats(): { size: number; files: string[] } {
    return {
      size: this.cache.size,
      files: Array.from(this.cache.keys()),
    };
  }

  /**
   * List all context files in the validation directory.
   */
  async listContextFiles(): Promise<string[]> {
    const files: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      try {
        const entries = await readdir(join(process.cwd(), dir), { withFileTypes: true });
        for (const entry of entries) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(path);
          } else if (entry.name.endsWith('.md')) {
            files.push(path);
          }
        }
      } catch {
        // Directory doesn't exist
      }
    };

    await walk(this.contextDir);
    return files;
  }

  /**
   * Check if watching is enabled.
   */
  isWatching(): boolean {
    return this.watcher?.isActive() ?? false;
  }
}

/**
 * Create a new context resolver instance.
 */
export function createContextResolver(
  options?: Partial<ContextResolverOptions>
): ContextResolver {
  return new ContextResolver(options);
}
