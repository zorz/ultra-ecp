/**
 * Shared Feed
 *
 * Central communication channel for ensemble sessions.
 * All agents, validators, and human interactions flow through this feed.
 */

import type {
  FeedEntry,
  FeedEntryType,
  FeedEntrySource,
  FeedFilter,
  FeedListener,
  Unsubscribe,
} from './types.ts';
import { generateFeedEntryId } from './types.ts';
import { debugLog, isDebugEnabled } from '../../debug.ts';

/**
 * Options for creating a shared feed.
 */
export interface SharedFeedOptions {
  /** Maximum entries to keep in memory */
  maxEntries: number;
  /** Whether to persist entries */
  persist: boolean;
  /** Persistence path (if persist is true) */
  persistPath?: string;
}

/**
 * Default feed options.
 */
const DEFAULT_OPTIONS: SharedFeedOptions = {
  maxEntries: 10000,
  persist: false,
};

/**
 * Shared feed for ensemble communication.
 */
export class SharedFeed {
  private options: SharedFeedOptions;
  private entries: FeedEntry[] = [];
  private listeners: Set<FeedListener> = new Set();
  private typeListeners: Map<FeedEntryType, Set<FeedListener>> = new Map();

  constructor(options: Partial<SharedFeedOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[SharedFeed] ${msg}`);
    }
  }

  /**
   * Post a new entry to the feed.
   */
  post(
    entry: Omit<FeedEntry, 'id' | 'timestamp'>
  ): FeedEntry {
    const fullEntry: FeedEntry = {
      ...entry,
      id: generateFeedEntryId(),
      timestamp: Date.now(),
    };

    this.entries.push(fullEntry);
    this.log(`Posted entry: ${fullEntry.type} from ${fullEntry.source}`);

    // Trim if over max
    if (this.entries.length > this.options.maxEntries) {
      const removed = this.entries.shift();
      this.log(`Trimmed oldest entry: ${removed?.id}`);
    }

    // Notify listeners
    this.notifyListeners(fullEntry);

    return fullEntry;
  }

  /**
   * Post a message entry.
   */
  postMessage(
    text: string,
    source: FeedEntrySource,
    options: {
      sourceId?: string;
      role?: 'user' | 'assistant';
      replyTo?: string;
      metadata?: Record<string, unknown>;
    } = {}
  ): FeedEntry {
    return this.post({
      type: 'message',
      source,
      sourceId: options.sourceId,
      content: {
        text,
        role: options.role ?? (source === 'human' ? 'user' : 'assistant'),
      },
      replyTo: options.replyTo,
      metadata: options.metadata,
    });
  }

  /**
   * Post a change entry.
   */
  postChange(
    changeType: 'file_edit' | 'file_create' | 'file_delete' | 'command',
    source: FeedEntrySource,
    options: {
      sourceId?: string;
      path?: string;
      command?: string;
      diff?: string;
      status?: 'proposed' | 'approved' | 'applied' | 'rejected';
      replyTo?: string;
      metadata?: Record<string, unknown>;
    } = {}
  ): FeedEntry {
    return this.post({
      type: 'change',
      source,
      sourceId: options.sourceId,
      content: {
        type: changeType,
        path: options.path,
        command: options.command,
        diff: options.diff,
        status: options.status ?? 'proposed',
      },
      replyTo: options.replyTo,
      metadata: options.metadata,
    });
  }

  /**
   * Post an action entry.
   */
  postAction(
    actionType: 'tool_use' | 'permission_request' | 'interrupt' | 'redirect',
    source: FeedEntrySource,
    options: {
      sourceId?: string;
      toolName?: string;
      toolInput?: Record<string, unknown>;
      toolResult?: unknown;
      description?: string;
      replyTo?: string;
      metadata?: Record<string, unknown>;
    } = {}
  ): FeedEntry {
    return this.post({
      type: 'action',
      source,
      sourceId: options.sourceId,
      content: {
        type: actionType,
        toolName: options.toolName,
        toolInput: options.toolInput,
        toolResult: options.toolResult,
        description: options.description,
      },
      replyTo: options.replyTo,
      metadata: options.metadata,
    });
  }

  /**
   * Post a system entry.
   */
  postSystem(
    event: 'session_start' | 'session_end' | 'agent_joined' | 'agent_left' | 'workflow_step',
    details?: Record<string, unknown>
  ): FeedEntry {
    return this.post({
      type: 'system',
      source: 'system',
      content: {
        event,
        details,
      },
    });
  }

  /**
   * Post an error entry.
   */
  postError(
    code: string,
    message: string,
    options: {
      source?: FeedEntrySource;
      sourceId?: string;
      details?: Record<string, unknown>;
      replyTo?: string;
    } = {}
  ): FeedEntry {
    return this.post({
      type: 'error',
      source: options.source ?? 'system',
      sourceId: options.sourceId,
      content: {
        code,
        message,
        details: options.details,
      },
      replyTo: options.replyTo,
    });
  }

  /**
   * Get entries with optional filtering.
   */
  getEntries(filter?: FeedFilter): FeedEntry[] {
    let result = [...this.entries];

    if (filter) {
      if (filter.types && filter.types.length > 0) {
        result = result.filter((e) => filter.types!.includes(e.type));
      }

      if (filter.sources && filter.sources.length > 0) {
        result = result.filter((e) => filter.sources!.includes(e.source));
      }

      if (filter.sourceId) {
        result = result.filter((e) => e.sourceId === filter.sourceId);
      }

      if (filter.after !== undefined) {
        result = result.filter((e) => e.timestamp > filter.after!);
      }

      if (filter.before !== undefined) {
        result = result.filter((e) => e.timestamp < filter.before!);
      }

      if (filter.limit !== undefined && filter.limit > 0) {
        result = result.slice(-filter.limit);
      }
    }

    return result;
  }

  /**
   * Get a single entry by ID.
   */
  getEntry(id: string): FeedEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /**
   * Get entries replying to a specific entry.
   */
  getReplies(entryId: string): FeedEntry[] {
    return this.entries.filter((e) => e.replyTo === entryId);
  }

  /**
   * Get the latest entry.
   */
  getLatest(): FeedEntry | undefined {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1] : undefined;
  }

  /**
   * Get entry count.
   */
  getCount(): number {
    return this.entries.length;
  }

  /**
   * Subscribe to all feed entries.
   */
  subscribe(listener: FeedListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Subscribe to specific entry types.
   */
  subscribeToType(type: FeedEntryType, listener: FeedListener): Unsubscribe {
    if (!this.typeListeners.has(type)) {
      this.typeListeners.set(type, new Set());
    }
    this.typeListeners.get(type)!.add(listener);

    return () => {
      this.typeListeners.get(type)?.delete(listener);
    };
  }

  /**
   * Notify all relevant listeners.
   */
  private notifyListeners(entry: FeedEntry): void {
    // Notify general listeners
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch (error) {
        this.log(`Listener error: ${error}`);
      }
    }

    // Notify type-specific listeners
    const typeListeners = this.typeListeners.get(entry.type);
    if (typeListeners) {
      for (const listener of typeListeners) {
        try {
          listener(entry);
        } catch (error) {
          this.log(`Type listener error: ${error}`);
        }
      }
    }
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.entries = [];
    this.log('Feed cleared');
  }

  /**
   * Export entries as JSON.
   */
  export(): string {
    return JSON.stringify(this.entries, null, 2);
  }

  /**
   * Import entries from JSON.
   */
  import(json: string): number {
    try {
      const imported = JSON.parse(json) as FeedEntry[];
      if (!Array.isArray(imported)) {
        throw new Error('Invalid import: expected array');
      }
      this.entries = imported;
      this.log(`Imported ${imported.length} entries`);
      return imported.length;
    } catch (error) {
      this.log(`Import error: ${error}`);
      throw error;
    }
  }
}

/**
 * Create a new shared feed instance.
 */
export function createSharedFeed(options?: Partial<SharedFeedOptions>): SharedFeed {
  return new SharedFeed(options);
}
