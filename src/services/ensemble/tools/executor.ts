/**
 * Tool Executor
 *
 * Executes tools with permission checking for ensemble agents.
 * Provides built-in handlers for common file and bash operations.
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { debugLog, isDebugEnabled } from '../../../debug.ts';
import {
  PermissionEvaluator,
  createPermissionEvaluator,
} from '../permissions/evaluator.ts';
import type { PermissionRequest, PermissionResponse } from '../permissions/types.ts';
import type {
  ToolExecutionRequest,
  ToolExecutionResult,
  ExecutorToolDefinition,
  ToolHandler,
  PermissionPromptHandler,
  ToolExecutorConfig,
} from './types.ts';
import {
  ResultProcessor,
  ContextStore,
  createResultProcessor,
  createContextStore,
} from './result-processor.ts';

// ============================================
// Tool Executor
// ============================================

/**
 * Tool executor events.
 */
export interface ToolExecutorEvents {
  'execution:start': [ToolExecutionRequest];
  'execution:complete': [ToolExecutionResult];
  'execution:error': [ToolExecutionRequest, Error];
  'permission:request': [PermissionRequest];
  'permission:response': [PermissionResponse];
}

/**
 * Executor for ensemble agent tools.
 */
export class ToolExecutor extends EventEmitter {
  private config: {
    sessionId: string;
    onPermissionPrompt: PermissionPromptHandler;
    executionTimeout: number;
    logExecutions: boolean;
  };
  private evaluator: PermissionEvaluator;
  private tools: Map<string, ExecutorToolDefinition> = new Map();
  private pendingExecutions: Map<string, AbortController> = new Map();
  private resultProcessor: ResultProcessor;
  private contextStore: ContextStore;

  constructor(config: ToolExecutorConfig) {
    super();
    this.config = {
      sessionId: config.sessionId,
      onPermissionPrompt: config.onPermissionPrompt ?? (() => Promise.resolve(null)),
      executionTimeout: config.executionTimeout ?? 120000,
      logExecutions: config.logExecutions ?? false,
    };

    this.evaluator = createPermissionEvaluator(config.sessionId);

    // Create context store and result processor
    this.contextStore = createContextStore(config.maxStoredResults ?? 1000);
    this.resultProcessor = createResultProcessor(config.resultSizeLimits, this.contextStore);

    // Register built-in tools
    this.registerBuiltinTools();
  }

  private log(msg: string): void {
    if (isDebugEnabled() || this.config.logExecutions) {
      debugLog(`[ToolExecutor] ${msg}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tool Registration
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Register a tool.
   */
  registerTool(tool: ExecutorToolDefinition): void {
    this.tools.set(tool.name, tool);
    this.log(`Registered tool: ${tool.name}`);
  }

  /**
   * Unregister a tool.
   */
  unregisterTool(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Get a tool definition.
   */
  getTool(name: string): ExecutorToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tools.
   */
  getTools(): ExecutorToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Register built-in file and bash tools.
   */
  private registerBuiltinTools(): void {
    // Read tool - safe, no permission needed
    this.registerTool({
      name: 'Read',
      description: 'Read file contents',
      handler: this.createReadHandler(),
      requiresPermission: false,
    });

    // Glob tool - safe, no permission needed
    this.registerTool({
      name: 'Glob',
      description: 'Find files matching a pattern',
      handler: this.createGlobHandler(),
      requiresPermission: false,
    });

    // Grep tool - safe, no permission needed
    this.registerTool({
      name: 'Grep',
      description: 'Search file contents',
      handler: this.createGrepHandler(),
      requiresPermission: false,
    });

    // Write tool - requires permission
    this.registerTool({
      name: 'Write',
      description: 'Write file contents',
      handler: this.createWriteHandler(),
      requiresPermission: true,
      permissionDescription: 'Write to file',
    });

    // Edit tool - requires permission
    this.registerTool({
      name: 'Edit',
      description: 'Edit file contents',
      handler: this.createEditHandler(),
      requiresPermission: true,
      permissionDescription: 'Edit file',
    });

    // Bash tool - requires permission
    this.registerTool({
      name: 'Bash',
      description: 'Execute bash command',
      handler: this.createBashHandler(),
      requiresPermission: true,
      permissionDescription: 'Execute command',
    });

    // GetStoredResult tool - retrieve full results from context store
    this.registerTool({
      name: 'GetStoredResult',
      description: 'Retrieve full result from context store when a previous result was truncated',
      handler: this.createGetStoredResultHandler(),
      requiresPermission: false,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tool Execution
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Execute a tool with permission checking.
   */
  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    this.log(`Executing tool: ${request.tool}`);

    const tool = this.tools.get(request.tool);
    if (!tool) {
      return {
        requestId: request.id,
        success: false,
        result: '',
        error: `Unknown tool: ${request.tool}`,
        duration: Date.now() - startTime,
      };
    }

    try {
      // Check permission if required
      if (tool.requiresPermission) {
        const permissionResult = await this.checkPermission(request, tool);
        if (!permissionResult.granted) {
          // Include feedback in the error message so the coder can address it
          const errorMsg = permissionResult.feedback
            ? `Permission denied. User feedback:\n${permissionResult.feedback}`
            : 'Permission denied';
          return {
            requestId: request.id,
            success: false,
            result: '',
            error: errorMsg,
            permissionDenied: true,
            duration: Date.now() - startTime,
          };
        }
      }

      // Create abort controller for timeout
      const controller = new AbortController();
      this.pendingExecutions.set(request.id, controller);

      // Execute with timeout
      const rawResult = await this.executeWithTimeout(
        tool.handler,
        request.input,
        controller.signal
      );

      this.pendingExecutions.delete(request.id);

      // Process result to limit size and store full result if needed
      const processed = this.resultProcessor.process(request.tool, request.input, rawResult);

      if (processed.truncated) {
        this.log(`Result truncated: ${processed.originalSize} -> ${processed.summarySize} chars (stored as ${processed.storeId})`);
      }

      const executionResult: ToolExecutionResult = {
        requestId: request.id,
        success: true,
        result: processed.summary,
        duration: Date.now() - startTime,
        truncated: processed.truncated,
        fullResultId: processed.storeId,
      };

      this.emit('execution:complete', executionResult);
      return executionResult;
    } catch (error) {
      this.pendingExecutions.delete(request.id);
      const err = error instanceof Error ? error : new Error(String(error));
      this.log(`Tool execution error (${request.tool}): ${err.message}\n${err.stack || ''}`);

      const errorResult: ToolExecutionResult = {
        requestId: request.id,
        success: false,
        result: '',
        error: err.message,
        duration: Date.now() - startTime,
      };

      this.emit('execution:error', request, err);
      return errorResult;
    }
  }

  /**
   * Check permission for a tool execution.
   */
  private async checkPermission(
    request: ToolExecutionRequest,
    tool: ExecutorToolDefinition
  ): Promise<{ granted: boolean; feedback?: string }> {
    const inputStr = this.formatInputForPermission(request.tool, request.input);
    const evaluation = this.evaluator.evaluate(
      request.tool,
      inputStr,
      request.targetPath
    );

    // Already allowed
    if (evaluation.allowed) {
      this.log(`Permission already granted: ${evaluation.reason}`);
      return { granted: true };
    }

    // Requires user confirmation
    if (evaluation.requiresConfirmation) {
      const permRequest = this.evaluator.createRequest(
        request.tool,
        tool.permissionDescription || `Execute ${request.tool}`,
        inputStr,
        request.targetPath
      );

      this.emit('permission:request', permRequest);

      // Prompt user - include critic reviews if available
      const response = await this.config.onPermissionPrompt(
        permRequest.tool,
        permRequest.description,
        permRequest.input,
        permRequest.riskLevel,
        permRequest.scopeOptions,
        permRequest.doubleConfirm,
        request.input, // Pass raw input for diff display
        request.criticReviews // Pass critic reviews for display
      );

      if (response) {
        this.emit('permission:response', response);
        this.evaluator.applyResponse(permRequest, response);
        return { granted: response.granted, feedback: response.feedback };
      }

      return { granted: false };
    }

    // Denied by rule
    this.log(`Permission denied: ${evaluation.reason}`);
    return { granted: false };
  }

  /**
   * Format input for permission display.
   */
  private formatInputForPermission(tool: string, input: Record<string, unknown>): string {
    switch (tool) {
      case 'Read':
      case 'Write':
      case 'Edit':
        return (input.file_path as string) || (input.path as string) || '';
      case 'Bash':
        return (input.command as string) || '';
      case 'Glob':
        return (input.pattern as string) || '';
      case 'Grep':
        return (input.pattern as string) || '';
      default:
        return JSON.stringify(input);
    }
  }

  /**
   * Execute a handler with timeout.
   */
  private async executeWithTimeout(
    handler: ToolHandler,
    input: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<string | Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Execution timeout'));
      }, this.config.executionTimeout);

      signal.addEventListener('abort', () => {
        clearTimeout(timeoutId);
        reject(new Error('Execution aborted'));
      });

      handler(input)
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  /**
   * Abort a pending execution.
   */
  abort(requestId: string): boolean {
    const controller = this.pendingExecutions.get(requestId);
    if (controller) {
      controller.abort();
      this.pendingExecutions.delete(requestId);
      return true;
    }
    return false;
  }

  /**
   * Abort all pending executions.
   */
  abortAll(): void {
    for (const controller of this.pendingExecutions.values()) {
      controller.abort();
    }
    this.pendingExecutions.clear();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Built-in Tool Handlers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create Read tool handler.
   */
  private createReadHandler(): ToolHandler {
    return async (input) => {
      const filePath = (input.file_path as string) || (input.path as string);
      if (!filePath) {
        throw new Error('file_path is required');
      }

      const content = await fs.readFile(filePath, 'utf-8');
      return content;
    };
  }

  /**
   * Create Glob tool handler.
   */
  private createGlobHandler(): ToolHandler {
    return async (input) => {
      const pattern = input.pattern as string;
      const basePath = (input.path as string) || process.cwd();

      if (!pattern) {
        throw new Error('pattern is required');
      }

      // Use Bun's built-in glob
      const globby = new Bun.Glob(pattern);
      const matches: string[] = [];

      for await (const file of globby.scan({ cwd: basePath, absolute: true })) {
        matches.push(file);
      }

      return { files: matches };
    };
  }

  /**
   * Create Grep tool handler.
   */
  private createGrepHandler(): ToolHandler {
    return async (input) => {
      const pattern = input.pattern as string;
      const searchPath = (input.path as string) || process.cwd();

      if (!pattern) {
        throw new Error('pattern is required');
      }

      // Use ripgrep if available, otherwise fallback to simple search
      return new Promise((resolve, reject) => {
        const rg = spawn('rg', [
          '--json',
          '--max-count', '100',
          pattern,
          searchPath,
        ]);

        let output = '';
        let errorOutput = '';

        rg.stdout.on('data', (data) => {
          output += data.toString();
        });

        rg.stderr.on('data', (data) => {
          errorOutput += data.toString();
        });

        rg.on('close', (code) => {
          if (code === 0 || code === 1) {
            // Parse ripgrep JSON output
            const lines = output.trim().split('\n').filter(Boolean);
            const matches: Array<{ path: string; line: number; text: string }> = [];

            for (const line of lines) {
              try {
                const entry = JSON.parse(line);
                if (entry.type === 'match') {
                  matches.push({
                    path: entry.data.path.text,
                    line: entry.data.line_number,
                    text: entry.data.lines.text.trim(),
                  });
                }
              } catch {
                // Skip invalid JSON lines
              }
            }

            resolve({ matches });
          } else {
            reject(new Error(`grep failed: ${errorOutput}`));
          }
        });

        rg.on('error', (error) => {
          reject(error);
        });
      });
    };
  }

  /**
   * Create Write tool handler.
   */
  private createWriteHandler(): ToolHandler {
    return async (input) => {
      const filePath = (input.file_path as string) || (input.path as string);
      const content = input.content as string;

      if (!filePath) {
        throw new Error('file_path is required');
      }
      if (content === undefined) {
        throw new Error('content is required');
      }

      // Ensure directory exists
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });

      // Write file
      await fs.writeFile(filePath, content, 'utf-8');

      return { success: true, path: filePath };
    };
  }

  /**
   * Create Edit tool handler.
   */
  private createEditHandler(): ToolHandler {
    return async (input) => {
      const filePath = (input.file_path as string) || (input.path as string);
      const oldString = input.old_string as string;
      const newString = input.new_string as string;
      const replaceAll = (input.replace_all as boolean) ?? false;

      if (!filePath) {
        throw new Error('file_path is required');
      }
      if (oldString === undefined) {
        throw new Error('old_string is required');
      }
      if (newString === undefined) {
        throw new Error('new_string is required');
      }

      // Read current content
      const content = await fs.readFile(filePath, 'utf-8');

      // Check if old_string exists
      if (!content.includes(oldString)) {
        throw new Error(`old_string not found in file: ${oldString.substring(0, 50)}...`);
      }

      // Replace
      let newContent: string;
      if (replaceAll) {
        newContent = content.split(oldString).join(newString);
      } else {
        newContent = content.replace(oldString, newString);
      }

      // Write back
      await fs.writeFile(filePath, newContent, 'utf-8');

      return { success: true, path: filePath };
    };
  }

  /**
   * Create Bash tool handler.
   */
  private createBashHandler(): ToolHandler {
    return async (input) => {
      const command = input.command as string;
      const timeout = (input.timeout as number) || 120000;

      if (!command) {
        throw new Error('command is required');
      }

      return new Promise((resolve, reject) => {
        const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
        const args = process.platform === 'win32' ? ['/c', command] : ['-c', command];

        const proc = spawn(shell, args, {
          cwd: process.cwd(),
          env: process.env,
          timeout,
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        proc.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        proc.on('close', (code) => {
          if (code === 0) {
            resolve({
              exitCode: code,
              stdout,
              stderr,
            });
          } else {
            resolve({
              exitCode: code,
              stdout,
              stderr,
              error: `Command exited with code ${code}`,
            });
          }
        });

        proc.on('error', (error) => {
          reject(error);
        });
      });
    };
  }

  /**
   * Create GetStoredResult tool handler.
   */
  private createGetStoredResultHandler(): ToolHandler {
    return async (input) => {
      const id = input.id as string;
      const offset = (input.offset as number) || 0;
      const limit = (input.limit as number) || 50000; // Default 50K chars

      if (!id) {
        throw new Error('id is required');
      }

      const stored = this.contextStore.get(id);
      if (!stored) {
        return {
          error: `No stored result found with ID: ${id}`,
          availableIds: this.contextStore.getRecent(10).map(r => ({
            id: r.id,
            tool: r.tool,
            size: r.size,
            timestamp: r.timestamp,
          })),
        };
      }

      // Get the full content
      const fullContent = typeof stored.fullResult === 'string'
        ? stored.fullResult
        : JSON.stringify(stored.fullResult, null, 2);

      // Apply offset and limit for pagination
      const slice = fullContent.slice(offset, offset + limit);
      const hasMore = offset + limit < fullContent.length;

      return {
        id: stored.id,
        tool: stored.tool,
        content: slice,
        offset,
        limit,
        totalSize: fullContent.length,
        hasMore,
        nextOffset: hasMore ? offset + limit : null,
      };
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Permission Evaluator Access
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get the permission evaluator.
   */
  getEvaluator(): PermissionEvaluator {
    return this.evaluator;
  }

  /**
   * Set the permission prompt handler.
   */
  setPermissionPromptHandler(handler: PermissionPromptHandler): void {
    this.config.onPermissionPrompt = handler;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Context Store Access
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get the context store for accessing full results.
   */
  getContextStore(): ContextStore {
    return this.contextStore;
  }

  /**
   * Get the result processor.
   */
  getResultProcessor(): ResultProcessor {
    return this.resultProcessor;
  }

  /**
   * Retrieve a stored result by ID.
   */
  getStoredResult(id: string): ReturnType<ContextStore['get']> {
    return this.contextStore.get(id);
  }

  /**
   * Get context store statistics.
   */
  getContextStats(): ReturnType<ContextStore['getStats']> {
    return this.contextStore.getStats();
  }
}

/**
 * Create a tool executor.
 */
export function createToolExecutor(config: ToolExecutorConfig): ToolExecutor {
  return new ToolExecutor(config);
}
