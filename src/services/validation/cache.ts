/**
 * Validation Cache
 *
 * Caches validation results based on content hashes to avoid
 * redundant validation of unchanged files.
 */

import type { ValidationContext, ValidationResult } from './types.ts';
import { debugLog, isDebugEnabled } from '../../debug.ts';

/**
 * Cache entry with result and metadata.
 */
interface CacheEntry {
  /** Cached validation result */
  result: ValidationResult;
  /** When this entry was created */
  timestamp: number;
  /** Content hashes used to generate this result */
  fileHashes: Record<string, string>;
}

/**
 * Options for the validation cache.
 */
export interface ValidationCacheOptions {
  /** Maximum age for cache entries in milliseconds */
  maxAge: number;
  /** Maximum number of entries to keep */
  maxEntries: number;
}

/**
 * Default cache options.
 */
const DEFAULT_CACHE_OPTIONS: ValidationCacheOptions = {
  maxAge: 5 * 60 * 1000, // 5 minutes
  maxEntries: 1000,
};

/**
 * Validation result cache.
 */
export class ValidationCache {
  private cache: Map<string, CacheEntry> = new Map();
  private options: ValidationCacheOptions;

  constructor(options: Partial<ValidationCacheOptions> = {}) {
    this.options = { ...DEFAULT_CACHE_OPTIONS, ...options };
  }

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[ValidationCache] ${msg}`);
    }
  }

  /**
   * Get a cached result for a validator and context.
   */
  get(validatorId: string, context: ValidationContext): ValidationResult | null {
    const key = this.computeKey(validatorId, context);
    const entry = this.cache.get(key);

    if (!entry) {
      this.log(`Cache miss for ${validatorId}`);
      return null;
    }

    // Check if entry has expired
    if (Date.now() - entry.timestamp > this.options.maxAge) {
      this.log(`Cache entry expired for ${validatorId}`);
      this.cache.delete(key);
      return null;
    }

    // Verify file hashes still match
    const currentHashes = this.computeFileHashes(context);
    for (const [path, hash] of Object.entries(entry.fileHashes)) {
      if (currentHashes[path] !== hash) {
        this.log(`Cache invalidated for ${validatorId} due to file change: ${path}`);
        this.cache.delete(key);
        return null;
      }
    }

    this.log(`Cache hit for ${validatorId}`);
    return entry.result;
  }

  /**
   * Store a validation result in the cache.
   */
  set(validatorId: string, context: ValidationContext, result: ValidationResult): void {
    // Enforce max entries limit
    if (this.cache.size >= this.options.maxEntries) {
      this.evictOldest();
    }

    const key = this.computeKey(validatorId, context);
    const fileHashes = this.computeFileHashes(context);

    this.cache.set(key, {
      result,
      timestamp: Date.now(),
      fileHashes,
    });

    this.log(`Cached result for ${validatorId}`);
  }

  /**
   * Invalidate cache entries matching a pattern.
   */
  invalidate(pattern?: string): void {
    if (!pattern) {
      this.log('Clearing entire cache');
      this.cache.clear();
      return;
    }

    let invalidated = 0;
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
        invalidated++;
      }
    }

    this.log(`Invalidated ${invalidated} entries matching pattern: ${pattern}`);
  }

  /**
   * Invalidate all entries for a specific file path.
   */
  invalidateByFile(filePath: string): void {
    let invalidated = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (Object.keys(entry.fileHashes).includes(filePath)) {
        this.cache.delete(key);
        invalidated++;
      }
    }

    this.log(`Invalidated ${invalidated} entries for file: ${filePath}`);
  }

  /**
   * Get cache statistics.
   */
  getStats(): { size: number; maxEntries: number; maxAge: number } {
    return {
      size: this.cache.size,
      maxEntries: this.options.maxEntries,
      maxAge: this.options.maxAge,
    };
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.cache.clear();
    this.log('Cache cleared');
  }

  /**
   * Compute a cache key for a validator and context.
   */
  private computeKey(validatorId: string, context: ValidationContext): string {
    const fileHashes = this.computeFileHashes(context);
    const hashString = Object.entries(fileHashes)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, hash]) => `${path}:${hash}`)
      .join('|');

    return `${validatorId}:${this.hash(hashString)}`;
  }

  /**
   * Compute content hashes for all files in context.
   */
  private computeFileHashes(context: ValidationContext): Record<string, string> {
    const hashes: Record<string, string> = {};

    for (const file of context.files) {
      hashes[file.path] = this.hash(file.content);
    }

    return hashes;
  }

  /**
   * Compute a fast hash of content.
   */
  private hash(content: string): string {
    // Use Bun's built-in hash function
    return Bun.hash(content).toString(16);
  }

  /**
   * Evict the oldest cache entries.
   */
  private evictOldest(): void {
    // Find entries to evict (oldest 10%)
    const entries = Array.from(this.cache.entries())
      .sort(([, a], [, b]) => a.timestamp - b.timestamp);

    const toEvict = Math.ceil(entries.length * 0.1);
    for (let i = 0; i < toEvict; i++) {
      const entry = entries[i];
      if (entry) {
        this.cache.delete(entry[0]);
      }
    }

    this.log(`Evicted ${toEvict} oldest entries`);
  }
}
