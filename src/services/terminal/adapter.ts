/**
 * Terminal Service ECP Adapter
 *
 * Maps ECP JSON-RPC calls to TerminalService methods.
 */

import { resolve, relative } from 'path';
import type { TerminalService } from './interface.ts';
import { TerminalError } from './errors.ts';
import type { TerminalInfo, TerminalBuffer, TerminalOptions } from './types.ts';
import {
  validateECPParams,
  TerminalCreateParamsSchema,
  TerminalWriteParamsSchema,
  TerminalResizeParamsSchema,
  TerminalCloseParamsSchema,
  TerminalExecuteParamsSchema,
  TerminalSpawnParamsSchema,
  TerminalIdParamsSchema,
  TerminalAttachTmuxParamsSchema,
  TerminalScrollParamsSchema,
} from '../../protocol/schemas.ts';

/**
 * ECP error codes (JSON-RPC 2.0 compatible).
 */
export const TerminalECPErrorCodes = {
  // Standard JSON-RPC errors
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,

  // Terminal service errors (-32700 to -32799)
  TerminalNotFound: -32700,
  TerminalExists: -32701,
  StartFailed: -32702,
  NotRunning: -32703,
  InvalidDimensions: -32704,
  ShellNotFound: -32705,
  WriteFailed: -32706,
  Timeout: -32707,
  ExecuteFailed: -32708,
  AccessDenied: -32709,
} as const;

/**
 * JSON-RPC error response.
 */
interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * Handler result type.
 */
type HandlerResult<T> = { result: T } | { error: JsonRpcError };

/**
 * Notification handler type.
 */
type NotificationHandler = (notification: {
  method: string;
  params: unknown;
}) => void;

/**
 * Terminal Service Adapter for ECP protocol.
 *
 * Handles JSON-RPC method routing and error conversion.
 */
export class TerminalServiceAdapter {
  private notificationHandler?: NotificationHandler;
  private workspaceRoot: string | undefined;

  constructor(private readonly service: TerminalService) {
    // Subscribe to events and forward as notifications
    this.service.onOutput((event) => {
      this.sendNotification('terminal/output', event);
    });

    this.service.onExit((event) => {
      this.sendNotification('terminal/exit', event);
    });

    this.service.onTitle((event) => {
      this.sendNotification('terminal/title', event);
    });
  }

  /**
   * Set notification handler.
   */
  setNotificationHandler(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  /**
   * Set the workspace root for path validation.
   * All terminal operations will be restricted to this directory.
   */
  setWorkspaceRoot(workspaceRoot: string): void {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Validate that a cwd is within the workspace root.
   * Prevents path traversal attacks and unauthorized access.
   * @returns Error object if invalid, undefined if valid
   */
  private validateCwd(cwd: string | undefined): JsonRpcError | undefined {
    if (!cwd) {
      // No cwd specified - will use workspace root or process.cwd()
      return undefined;
    }

    if (!this.workspaceRoot) {
      // No workspace root set - deny all explicit cwd values for security
      return {
        code: TerminalECPErrorCodes.AccessDenied,
        message: 'Cannot specify cwd: no workspace root configured',
      };
    }

    // Resolve to absolute paths
    const resolvedWorkspace = resolve(this.workspaceRoot);
    const resolvedCwd = resolve(resolvedWorkspace, cwd);
    const relativePath = relative(resolvedWorkspace, resolvedCwd);

    // Check if path escapes workspace root
    if (relativePath.startsWith('..') || relativePath.startsWith('/')) {
      return {
        code: TerminalECPErrorCodes.AccessDenied,
        message: `Access denied: cwd is outside workspace root`,
      };
    }

    return undefined;
  }

  /**
   * Send a notification.
   */
  private sendNotification(method: string, params: unknown): void {
    if (this.notificationHandler) {
      this.notificationHandler({ method, params });
    }
  }

  /**
   * Handle an ECP request.
   *
   * @param method The method name (e.g., "terminal/create")
   * @param params The request parameters
   * @returns The method result
   */
  async handleRequest(method: string, params: unknown): Promise<HandlerResult<unknown>> {
    try {
      switch (method) {
        // Lifecycle
        case 'terminal/create':
          return await this.create(params);
        case 'terminal/attachTmux':
          return await this.attachTmux(params);
        case 'terminal/close':
          return this.close(params);
        case 'terminal/closeAll':
          return this.closeAll();

        // Operations
        case 'terminal/write':
          return this.write(params);
        case 'terminal/resize':
          return this.resize(params);

        // Buffer
        case 'terminal/getBuffer':
          return this.getBuffer(params);
        case 'terminal/scroll':
          return this.scroll(params);
        case 'terminal/scrollToBottom':
          return this.scrollToBottom(params);

        // Info
        case 'terminal/getInfo':
          return this.getInfo(params);
        case 'terminal/list':
          return this.list();
        case 'terminal/exists':
          return this.exists(params);
        case 'terminal/isRunning':
          return this.isRunning(params);

        // Command execution
        case 'terminal/execute':
          return await this.execute(params);
        case 'terminal/spawn':
          return await this.spawn(params);

        default:
          return {
            error: {
              code: TerminalECPErrorCodes.MethodNotFound,
              message: `Method not found: ${method}`,
            },
          };
      }
    } catch (error) {
      return { error: this.toJsonRpcError(error) };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle handlers
  // ─────────────────────────────────────────────────────────────────────────

  private async create(params: unknown): Promise<HandlerResult<{ terminalId: string }>> {
    // TerminalCreateParamsSchema allows all fields to be optional
    const validation = validateECPParams(TerminalCreateParamsSchema.optional(), params, TerminalECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data as TerminalOptions | undefined;

    const terminalId = await this.service.create(p);
    return { result: { terminalId } };
  }

  private async attachTmux(params: unknown): Promise<HandlerResult<{ terminalId: string }>> {
    const validation = validateECPParams(TerminalAttachTmuxParamsSchema, params, TerminalECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const terminalId = await this.service.create({
      tmuxSession: p.session,
      tmuxSocket: p.socket,
      cols: p.cols,
      rows: p.rows,
    });
    return { result: { terminalId } };
  }

  private close(params: unknown): HandlerResult<{ success: boolean }> {
    const validation = validateECPParams(TerminalCloseParamsSchema, params, TerminalECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    this.service.close(p.terminalId);
    return { result: { success: true } };
  }

  private closeAll(): HandlerResult<{ success: boolean }> {
    this.service.closeAll();
    return { result: { success: true } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Operation handlers
  // ─────────────────────────────────────────────────────────────────────────

  private write(params: unknown): HandlerResult<{ success: boolean }> {
    const validation = validateECPParams(TerminalWriteParamsSchema, params, TerminalECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    this.service.write(p.terminalId, p.data);
    return { result: { success: true } };
  }

  private resize(params: unknown): HandlerResult<{ success: boolean }> {
    const validation = validateECPParams(TerminalResizeParamsSchema, params, TerminalECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    this.service.resize(p.terminalId, p.cols, p.rows);
    return { result: { success: true } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Buffer handlers
  // ─────────────────────────────────────────────────────────────────────────

  private getBuffer(params: unknown): HandlerResult<{ buffer: TerminalBuffer | null }> {
    const validation = validateECPParams(TerminalIdParamsSchema, params, TerminalECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const buffer = this.service.getBuffer(p.terminalId);
    return { result: { buffer } };
  }

  private scroll(params: unknown): HandlerResult<{ success: boolean }> {
    const validation = validateECPParams(TerminalScrollParamsSchema, params, TerminalECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    this.service.scroll(p.terminalId, p.lines);
    return { result: { success: true } };
  }

  private scrollToBottom(params: unknown): HandlerResult<{ success: boolean }> {
    const validation = validateECPParams(TerminalIdParamsSchema, params, TerminalECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    this.service.scrollToBottom(p.terminalId);
    return { result: { success: true } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Info handlers
  // ─────────────────────────────────────────────────────────────────────────

  private getInfo(params: unknown): HandlerResult<{ info: TerminalInfo | null }> {
    const validation = validateECPParams(TerminalIdParamsSchema, params, TerminalECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const info = this.service.getInfo(p.terminalId);
    return { result: { info } };
  }

  private list(): HandlerResult<{ terminals: TerminalInfo[] }> {
    const terminals = this.service.list();
    return { result: { terminals } };
  }

  private exists(params: unknown): HandlerResult<{ exists: boolean }> {
    const validation = validateECPParams(TerminalIdParamsSchema, params, TerminalECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const exists = this.service.exists(p.terminalId);
    return { result: { exists } };
  }

  private isRunning(params: unknown): HandlerResult<{ running: boolean }> {
    const validation = validateECPParams(TerminalIdParamsSchema, params, TerminalECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const running = this.service.isRunning(p.terminalId);
    return { result: { running } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Command execution handlers
  // ─────────────────────────────────────────────────────────────────────────

  private async execute(
    params: unknown
  ): Promise<HandlerResult<{ stdout: string; stderr: string; exitCode: number }>> {
    const validation = validateECPParams(TerminalExecuteParamsSchema, params, TerminalECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    // Validate cwd is within workspace
    const cwdError = this.validateCwd(p.cwd);
    if (cwdError) return { error: cwdError };

    // Use workspace root as default cwd if not specified
    const effectiveCwd = p.cwd || this.workspaceRoot;

    const result = await this.service.execute(p.command, {
      cwd: effectiveCwd,
      timeout: p.timeout,
    });
    return { result };
  }

  /**
   * Spawn a long-running command in a new terminal.
   * Unlike execute(), this doesn't wait for completion - ideal for dev servers, watchers, etc.
   */
  private async spawn(
    params: unknown
  ): Promise<HandlerResult<{ terminalId: string; title?: string }>> {
    const validation = validateECPParams(TerminalSpawnParamsSchema, params, TerminalECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    // Validate cwd is within workspace
    const cwdError = this.validateCwd(p.cwd);
    if (cwdError) return { error: cwdError };

    // Use workspace root as default cwd if not specified
    const effectiveCwd = p.cwd || this.workspaceRoot;

    // Create a new terminal
    const terminalId = await this.service.create({
      cwd: effectiveCwd,
    });

    // Write the command to the terminal (with newline to execute)
    this.service.write(terminalId, p.command + '\n');

    // Return terminalId and title (title can be used by GUI for tab display)
    return { result: { terminalId, title: p.title } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private toJsonRpcError(error: unknown): JsonRpcError {
    if (error instanceof TerminalError) {
      // Map TerminalError codes to ECP error codes
      let code: number = TerminalECPErrorCodes.InternalError;
      switch (error.code) {
        case 'TERMINAL_NOT_FOUND':
          code = TerminalECPErrorCodes.TerminalNotFound;
          break;
        case 'TERMINAL_EXISTS':
          code = TerminalECPErrorCodes.TerminalExists;
          break;
        case 'START_FAILED':
          code = TerminalECPErrorCodes.StartFailed;
          break;
        case 'NOT_RUNNING':
          code = TerminalECPErrorCodes.NotRunning;
          break;
        case 'INVALID_DIMENSIONS':
          code = TerminalECPErrorCodes.InvalidDimensions;
          break;
        case 'SHELL_NOT_FOUND':
          code = TerminalECPErrorCodes.ShellNotFound;
          break;
        case 'WRITE_FAILED':
          code = TerminalECPErrorCodes.WriteFailed;
          break;
        case 'TIMEOUT':
          code = TerminalECPErrorCodes.Timeout;
          break;
        case 'EXECUTE_FAILED':
          code = TerminalECPErrorCodes.ExecuteFailed;
          break;
      }

      return {
        code,
        message: error.message,
        data: error.data,
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
      code: TerminalECPErrorCodes.InternalError,
      message,
    };
  }
}
