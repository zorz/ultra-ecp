/**
 * Context Watcher
 *
 * Watches the validation/ directory for changes and triggers
 * cache invalidation when context files are modified.
 */

import { watch } from 'node:fs';
import { join, relative } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import type { Unsubscribe } from './types.ts';
import { debugLog, isDebugEnabled } from '../../debug.ts';

/**
 * Change event for context files.
 */
export interface ContextChangeEvent {
  /** Type of change */
  type: 'add' | 'change' | 'delete';
  /** Path to the changed context file (relative to contextDir) */
  path: string;
  /** Absolute path to the file */
  absolutePath: string;
  /** Timestamp of the change */
  timestamp: number;
}

/**
 * Callback for context changes.
 */
export type ContextChangeCallback = (event: ContextChangeEvent) => void;

/**
 * Options for the context watcher.
 */
export interface ContextWatcherOptions {
  /** Path to the validation context directory */
  contextDir: string;
  /** Debounce delay in milliseconds */
  debounceMs: number;
  /** Whether to watch recursively */
  recursive: boolean;
}

/**
 * Default watcher options.
 */
const DEFAULT_WATCHER_OPTIONS: ContextWatcherOptions = {
  contextDir: 'validation',
  debounceMs: 100,
  recursive: true,
};

/**
 * Watches context files for changes.
 */
export class ContextWatcher {
  private options: ContextWatcherOptions;
  private callbacks: Set<ContextChangeCallback> = new Set();
  private watcher: ReturnType<typeof watch> | null = null;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private knownFiles: Set<string> = new Set();
  private isWatching: boolean = false;

  constructor(options: Partial<ContextWatcherOptions> = {}) {
    this.options = { ...DEFAULT_WATCHER_OPTIONS, ...options };
  }

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[ContextWatcher] ${msg}`);
    }
  }

  /**
   * Start watching for context file changes.
   */
  async start(): Promise<void> {
    if (this.isWatching) {
      this.log('Already watching');
      return;
    }

    const contextDir = join(process.cwd(), this.options.contextDir);

    // Build initial set of known files
    await this.buildKnownFiles(contextDir);

    try {
      this.watcher = watch(
        contextDir,
        { recursive: this.options.recursive },
        (eventType, filename) => {
          if (filename && filename.endsWith('.md')) {
            this.handleFileEvent(eventType, filename);
          }
        }
      );

      this.watcher.on('error', (error) => {
        this.log(`Watcher error: ${error.message}`);
      });

      this.isWatching = true;
      this.log(`Started watching ${contextDir}`);
    } catch (error) {
      // Directory might not exist yet
      this.log(`Could not start watching: ${error}`);
    }
  }

  /**
   * Stop watching for changes.
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    this.isWatching = false;
    this.log('Stopped watching');
  }

  /**
   * Subscribe to context change events.
   */
  onChange(callback: ContextChangeCallback): Unsubscribe {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  /**
   * Check if the watcher is active.
   */
  isActive(): boolean {
    return this.isWatching;
  }

  /**
   * Handle a file system event.
   */
  private handleFileEvent(eventType: string, filename: string): void {
    // Debounce rapid changes to the same file
    const existingTimer = this.debounceTimers.get(filename);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filename);
      this.processFileEvent(eventType, filename);
    }, this.options.debounceMs);

    this.debounceTimers.set(filename, timer);
  }

  /**
   * Process a debounced file event.
   */
  private async processFileEvent(_eventType: string, filename: string): Promise<void> {
    const absolutePath = join(process.cwd(), this.options.contextDir, filename);
    const relativePath = filename;

    // Determine the actual event type
    let type: ContextChangeEvent['type'];

    try {
      await stat(absolutePath);

      // File exists
      if (this.knownFiles.has(relativePath)) {
        type = 'change';
      } else {
        type = 'add';
        this.knownFiles.add(relativePath);
      }
    } catch {
      // File doesn't exist (deleted)
      if (this.knownFiles.has(relativePath)) {
        type = 'delete';
        this.knownFiles.delete(relativePath);
      } else {
        // Unknown file, ignore
        return;
      }
    }

    const event: ContextChangeEvent = {
      type,
      path: relativePath,
      absolutePath,
      timestamp: Date.now(),
    };

    this.log(`Context ${type}: ${relativePath}`);

    // Notify all callbacks
    for (const callback of this.callbacks) {
      try {
        callback(event);
      } catch (error) {
        this.log(`Callback error: ${error}`);
      }
    }
  }

  /**
   * Build the initial set of known files.
   */
  private async buildKnownFiles(dir: string): Promise<void> {
    this.knownFiles.clear();

    const walk = async (currentDir: string): Promise<void> => {
      try {
        const entries = await readdir(currentDir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = join(currentDir, entry.name);

          if (entry.isDirectory()) {
            await walk(fullPath);
          } else if (entry.name.endsWith('.md')) {
            const relativePath = relative(
              join(process.cwd(), this.options.contextDir),
              fullPath
            );
            this.knownFiles.add(relativePath);
          }
        }
      } catch {
        // Directory doesn't exist
      }
    };

    await walk(dir);
    this.log(`Found ${this.knownFiles.size} existing context files`);
  }

  /**
   * Get all known context files.
   */
  getKnownFiles(): string[] {
    return Array.from(this.knownFiles);
  }
}

/**
 * Create a new context watcher instance.
 */
export function createContextWatcher(
  options?: Partial<ContextWatcherOptions>
): ContextWatcher {
  return new ContextWatcher(options);
}
