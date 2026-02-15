/**
 * Tool Result Processor
 *
 * Handles size limiting and summarization of tool results to keep
 * context within token limits. Full results are stored in a queryable
 * context store for later retrieval.
 */

import { debugLog, isDebugEnabled } from '../../../debug.ts';

// ============================================
// Configuration
// ============================================

/**
 * Size limits for different tool types.
 */
export interface ResultSizeLimits {
  /** Max characters for file content (Read) */
  maxFileContent: number;
  /** Max files to return from Glob */
  maxGlobFiles: number;
  /** Max matches to return from Grep */
  maxGrepMatches: number;
  /** Max characters for Bash output */
  maxBashOutput: number;
  /** Max characters for generic results */
  maxGenericResult: number;
}

/**
 * Default size limits.
 */
export const DEFAULT_LIMITS: ResultSizeLimits = {
  maxFileContent: 50000,    // ~12.5K tokens
  maxGlobFiles: 100,        // 100 files max
  maxGrepMatches: 50,       // 50 matches max
  maxBashOutput: 20000,     // ~5K tokens
  maxGenericResult: 30000,  // ~7.5K tokens
};

// ============================================
// Context Store
// ============================================

/**
 * A stored result that can be queried later.
 */
export interface StoredResult {
  /** Unique ID for this result */
  id: string;
  /** Tool that produced this result */
  tool: string;
  /** Original input that produced this result */
  input: Record<string, unknown>;
  /** Full result content */
  fullResult: string | Record<string, unknown>;
  /** Size of full result in characters */
  size: number;
  /** Whether result was truncated */
  truncated: boolean;
  /** Timestamp */
  timestamp: number;
}

/**
 * Context store for full tool results.
 */
export class ContextStore {
  private results: Map<string, StoredResult> = new Map();
  private maxResults: number;
  private idCounter = 0;

  constructor(maxResults = 1000) {
    this.maxResults = maxResults;
  }

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[ContextStore] ${msg}`);
    }
  }

  /**
   * Store a result and return its ID.
   */
  store(
    tool: string,
    input: Record<string, unknown>,
    fullResult: string | Record<string, unknown>
  ): string {
    const id = `ctx-${Date.now()}-${++this.idCounter}`;
    const size = typeof fullResult === 'string'
      ? fullResult.length
      : JSON.stringify(fullResult).length;

    const stored: StoredResult = {
      id,
      tool,
      input,
      fullResult,
      size,
      truncated: false,
      timestamp: Date.now(),
    };

    this.results.set(id, stored);
    this.log(`Stored result ${id} (${size} chars) for ${tool}`);

    // Evict old results if over limit
    if (this.results.size > this.maxResults) {
      const oldest = Array.from(this.results.keys())[0];
      if (oldest) {
        this.results.delete(oldest);
        this.log(`Evicted old result ${oldest}`);
      }
    }

    return id;
  }

  /**
   * Retrieve a stored result by ID.
   */
  get(id: string): StoredResult | undefined {
    return this.results.get(id);
  }

  /**
   * Query stored results by tool type.
   */
  queryByTool(tool: string, limit = 10): StoredResult[] {
    const results: StoredResult[] = [];
    for (const stored of this.results.values()) {
      if (stored.tool === tool) {
        results.push(stored);
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  /**
   * Get recent results.
   */
  getRecent(limit = 10): StoredResult[] {
    const all = Array.from(this.results.values());
    return all.slice(-limit);
  }

  /**
   * Clear all stored results.
   */
  clear(): void {
    this.results.clear();
    this.log('Cleared all stored results');
  }

  /**
   * Get store statistics.
   */
  getStats(): { count: number; totalSize: number } {
    let totalSize = 0;
    for (const stored of this.results.values()) {
      totalSize += stored.size;
    }
    return { count: this.results.size, totalSize };
  }
}

// ============================================
// Result Processor
// ============================================

/**
 * Processed result with summary and reference.
 */
export interface ProcessedResult {
  /** Summarized/truncated result for context */
  summary: string | Record<string, unknown>;
  /** Whether the result was truncated */
  truncated: boolean;
  /** ID to retrieve full result (if stored) */
  storeId?: string;
  /** Original size in characters */
  originalSize: number;
  /** Summary size in characters */
  summarySize: number;
}

/**
 * Process tool results to fit within size limits.
 */
export class ResultProcessor {
  private limits: ResultSizeLimits;
  private store: ContextStore;

  constructor(limits: Partial<ResultSizeLimits> = {}, store?: ContextStore) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.store = store ?? new ContextStore();
  }

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[ResultProcessor] ${msg}`);
    }
  }

  /**
   * Get the context store.
   */
  getStore(): ContextStore {
    return this.store;
  }

  /**
   * Process a tool result.
   */
  process(
    tool: string,
    input: Record<string, unknown>,
    result: string | Record<string, unknown>
  ): ProcessedResult {
    const originalSize = typeof result === 'string'
      ? result.length
      : JSON.stringify(result).length;

    // Route to specific processor based on tool
    switch (tool) {
      case 'Read':
        return this.processReadResult(input, result, originalSize);
      case 'Glob':
        return this.processGlobResult(input, result, originalSize);
      case 'Grep':
        return this.processGrepResult(input, result, originalSize);
      case 'Bash':
        return this.processBashResult(input, result, originalSize);
      default:
        return this.processGenericResult(tool, input, result, originalSize);
    }
  }

  /**
   * Process Read tool result (file content).
   */
  private processReadResult(
    input: Record<string, unknown>,
    result: string | Record<string, unknown>,
    originalSize: number
  ): ProcessedResult {
    const content = typeof result === 'string' ? result : JSON.stringify(result);
    const limit = this.limits.maxFileContent;

    if (content.length <= limit) {
      return {
        summary: result,
        truncated: false,
        originalSize,
        summarySize: originalSize,
      };
    }

    // Store full result
    const storeId = this.store.store('Read', input, result);

    // Truncate with context - show beginning and end
    const headSize = Math.floor(limit * 0.7);
    const tailSize = Math.floor(limit * 0.25);
    const lines = content.split('\n');
    const totalLines = lines.length;

    let headLines: string[] = [];
    let headChars = 0;
    for (const line of lines) {
      if (headChars + line.length > headSize) break;
      headLines.push(line);
      headChars += line.length + 1;
    }

    let tailLines: string[] = [];
    let tailChars = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (tailChars + line.length > tailSize) break;
      tailLines.unshift(line);
      tailChars += line.length + 1;
    }

    const omittedLines = totalLines - headLines.length - tailLines.length;
    const summary = [
      ...headLines,
      '',
      `... [${omittedLines} lines omitted - full content stored as ${storeId}] ...`,
      '',
      ...tailLines,
    ].join('\n');

    this.log(`Read result truncated: ${originalSize} -> ${summary.length} chars`);

    return {
      summary,
      truncated: true,
      storeId,
      originalSize,
      summarySize: summary.length,
    };
  }

  /**
   * Process Glob tool result (file list).
   */
  private processGlobResult(
    input: Record<string, unknown>,
    result: string | Record<string, unknown>,
    originalSize: number
  ): ProcessedResult {
    const limit = this.limits.maxGlobFiles;

    // Handle different result formats
    let files: string[] = [];
    if (typeof result === 'string') {
      files = result.split('\n').filter(Boolean);
    } else if (result && typeof result === 'object' && 'files' in result) {
      files = (result as { files: string[] }).files;
    }

    if (files.length <= limit) {
      return {
        summary: result,
        truncated: false,
        originalSize,
        summarySize: originalSize,
      };
    }

    // Store full result
    const storeId = this.store.store('Glob', input, result);

    // Return truncated list with summary
    const truncatedFiles = files.slice(0, limit);
    const omitted = files.length - limit;

    const summary = {
      files: truncatedFiles,
      totalCount: files.length,
      omittedCount: omitted,
      truncated: true,
      fullResultId: storeId,
      note: `Showing ${limit} of ${files.length} files. Use context ID ${storeId} to retrieve full list.`,
    };

    const summarySize = JSON.stringify(summary).length;
    this.log(`Glob result truncated: ${files.length} -> ${limit} files`);

    return {
      summary,
      truncated: true,
      storeId,
      originalSize,
      summarySize,
    };
  }

  /**
   * Process Grep tool result (search matches).
   */
  private processGrepResult(
    input: Record<string, unknown>,
    result: string | Record<string, unknown>,
    originalSize: number
  ): ProcessedResult {
    const limit = this.limits.maxGrepMatches;

    // Handle different result formats
    let matches: Array<{ path: string; line: number; text: string }> = [];
    if (result && typeof result === 'object' && 'matches' in result) {
      matches = (result as { matches: typeof matches }).matches;
    }

    if (matches.length <= limit) {
      return {
        summary: result,
        truncated: false,
        originalSize,
        summarySize: originalSize,
      };
    }

    // Store full result
    const storeId = this.store.store('Grep', input, result);

    // Return truncated matches with summary
    const truncatedMatches = matches.slice(0, limit);
    const omitted = matches.length - limit;

    // Group omitted matches by file for context
    const omittedByFile: Record<string, number> = {};
    for (let i = limit; i < matches.length; i++) {
      const match = matches[i]!;
      omittedByFile[match.path] = (omittedByFile[match.path] || 0) + 1;
    }

    const summary = {
      matches: truncatedMatches,
      totalCount: matches.length,
      omittedCount: omitted,
      omittedByFile,
      truncated: true,
      fullResultId: storeId,
      note: `Showing ${limit} of ${matches.length} matches. Use context ID ${storeId} to retrieve all matches.`,
    };

    const summarySize = JSON.stringify(summary).length;
    this.log(`Grep result truncated: ${matches.length} -> ${limit} matches`);

    return {
      summary,
      truncated: true,
      storeId,
      originalSize,
      summarySize,
    };
  }

  /**
   * Process Bash tool result (command output).
   */
  private processBashResult(
    input: Record<string, unknown>,
    result: string | Record<string, unknown>,
    originalSize: number
  ): ProcessedResult {
    const limit = this.limits.maxBashOutput;

    // Extract stdout from result object
    let stdout = '';
    let stderr = '';
    let exitCode: number | undefined;

    if (typeof result === 'string') {
      stdout = result;
    } else if (result && typeof result === 'object') {
      const r = result as { stdout?: string; stderr?: string; exitCode?: number };
      stdout = r.stdout || '';
      stderr = r.stderr || '';
      exitCode = r.exitCode;
    }

    const totalOutput = stdout + stderr;
    if (totalOutput.length <= limit) {
      return {
        summary: result,
        truncated: false,
        originalSize,
        summarySize: originalSize,
      };
    }

    // Store full result
    const storeId = this.store.store('Bash', input, result);

    // Truncate output - prioritize end (most recent output)
    const truncateOutput = (output: string, maxLen: number): string => {
      if (output.length <= maxLen) return output;

      const headSize = Math.floor(maxLen * 0.3);
      const tailSize = Math.floor(maxLen * 0.6);

      const head = output.slice(0, headSize);
      const tail = output.slice(-tailSize);
      const omitted = output.length - headSize - tailSize;

      return `${head}\n\n... [${omitted} characters omitted] ...\n\n${tail}`;
    };

    const stdoutLimit = Math.floor(limit * 0.8);
    const stderrLimit = Math.floor(limit * 0.2);

    const summary = {
      stdout: truncateOutput(stdout, stdoutLimit),
      stderr: truncateOutput(stderr, stderrLimit),
      exitCode,
      truncated: true,
      originalStdoutLength: stdout.length,
      originalStderrLength: stderr.length,
      fullResultId: storeId,
      note: `Output truncated. Use context ID ${storeId} to retrieve full output.`,
    };

    const summarySize = JSON.stringify(summary).length;
    this.log(`Bash result truncated: ${totalOutput.length} -> ${summarySize} chars`);

    return {
      summary,
      truncated: true,
      storeId,
      originalSize,
      summarySize,
    };
  }

  /**
   * Process generic tool result.
   */
  private processGenericResult(
    tool: string,
    input: Record<string, unknown>,
    result: string | Record<string, unknown>,
    originalSize: number
  ): ProcessedResult {
    const limit = this.limits.maxGenericResult;
    const content = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

    if (content.length <= limit) {
      return {
        summary: result,
        truncated: false,
        originalSize,
        summarySize: originalSize,
      };
    }

    // Store full result
    const storeId = this.store.store(tool, input, result);

    // Simple truncation for unknown formats
    const truncated = content.slice(0, limit);
    const summary = `${truncated}\n\n... [${content.length - limit} characters omitted - full content stored as ${storeId}] ...`;

    this.log(`Generic result truncated: ${originalSize} -> ${summary.length} chars`);

    return {
      summary,
      truncated: true,
      storeId,
      originalSize,
      summarySize: summary.length,
    };
  }
}

/**
 * Create a result processor with default settings.
 */
export function createResultProcessor(
  limits?: Partial<ResultSizeLimits>,
  store?: ContextStore
): ResultProcessor {
  return new ResultProcessor(limits, store);
}

/**
 * Create a context store.
 */
export function createContextStore(maxResults?: number): ContextStore {
  return new ContextStore(maxResults);
}
