/**
 * Local Terminal Service Implementation
 *
 * Implements TerminalService using the PTY backend factory.
 * Uses IPC backend when running as bundled binary, bun-pty in development.
 */

import { debugLog as globalDebugLog } from '../../debug.ts';
import { createPtyBackend } from '../../terminal/pty-factory.ts';
import type { PTYBackend, TerminalCell as PTYBackendCell } from '../../terminal/pty-backend.ts';
import type { TerminalService } from './interface.ts';
import { TerminalError, TerminalErrorCode } from './errors.ts';
import type {
  TerminalOptions,
  TerminalInfo,
  TerminalBuffer,
  TerminalCell,
  TerminalOutputCallback,
  TerminalExitCallback,
  TerminalTitleCallback,
  Unsubscribe,
} from './types.ts';

/**
 * Internal terminal session state.
 */
interface TerminalSession {
  /** Terminal ID */
  terminalId: string;

  /** PTY backend instance */
  pty: PTYBackend;

  /** Shell path */
  shell: string;

  /** Working directory */
  cwd: string;

  /** Terminal dimensions */
  cols: number;
  rows: number;

  /** Current title */
  title: string;

  /** Tmux session name if attached */
  tmuxSession?: string;

  /** Tmux socket name if using custom socket */
  tmuxSocket?: string;

  /** Unsubscribe functions for PTY events */
  unsubscribes: Array<() => void>;
}

/**
 * Local Terminal Service.
 *
 * Manages embedded terminal sessions using PTY.
 */
export class LocalTerminalService implements TerminalService {
  private _debugName = 'LocalTerminalService';
  private sessions = new Map<string, TerminalSession>();
  private sessionCounter = 0;

  // Event callbacks
  private outputCallbacks: Set<TerminalOutputCallback> = new Set();
  private exitCallbacks: Set<TerminalExitCallback> = new Set();
  private titleCallbacks: Set<TerminalTitleCallback> = new Set();

  constructor() {
    this.debugLog('Initialized');
  }

  protected debugLog(msg: string): void {
    globalDebugLog(`[${this._debugName}] ${msg}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  async create(options: TerminalOptions = {}): Promise<string> {
    const terminalId = `terminal-${++this.sessionCounter}-${Date.now()}`;

    // Determine shell with fallbacks
    const shell = options.shell || process.env.SHELL || '/bin/sh';
    const cwd = options.cwd || process.cwd();
    const cols = options.cols || 80;
    const rows = options.rows || 24;

    // Create PTY backend using factory (handles bundled binary vs dev mode)
    let pty: PTYBackend;
    try {
      pty = await createPtyBackend({
        shell,
        cwd,
        cols,
        rows,
        env: options.env,
        scrollback: options.scrollback || 1000,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw TerminalError.startFailed(`Failed to create PTY backend: ${message}`, error instanceof Error ? error : undefined);
    }

    // Determine title based on whether this is a tmux session
    const title = options.tmuxSession
      ? `tmux: ${options.tmuxSession}`
      : shell;

    // Track unsubscribe functions
    const unsubscribes: Array<() => void> = [];

    // Create session
    const session: TerminalSession = {
      terminalId,
      pty,
      shell,
      cwd,
      cols,
      rows,
      title,
      tmuxSession: options.tmuxSession,
      tmuxSocket: options.tmuxSocket,
      unsubscribes,
    };

    // Set up callbacks
    unsubscribes.push(pty.onData((data: string) => {
      this.emitOutput(terminalId, data);
    }));

    unsubscribes.push(pty.onExit((exitCode: number) => {
      this.emitExit(terminalId, exitCode);
    }));

    // Start the PTY
    try {
      await pty.start();
    } catch (error) {
      // Clean up on failure
      for (const unsub of unsubscribes) unsub();
      const message = error instanceof Error ? error.message : String(error);
      throw TerminalError.startFailed(message, error instanceof Error ? error : undefined);
    }

    this.sessions.set(terminalId, session);
    this.debugLog(`Created terminal ${terminalId}`);

    return terminalId;
  }

  close(terminalId: string): void {
    const session = this.sessions.get(terminalId);
    if (!session) {
      return;
    }

    // Unsubscribe from events
    for (const unsub of session.unsubscribes) {
      unsub();
    }
    session.pty.kill();
    this.sessions.delete(terminalId);
    this.debugLog(`Closed terminal ${terminalId}`);
  }

  closeAll(): void {
    for (const [terminalId] of this.sessions) {
      this.close(terminalId);
    }
    this.debugLog('Closed all terminals');
  }

  /**
   * Shutdown the service, closing all terminals and clearing callbacks.
   */
  shutdown(): void {
    this.closeAll();
    this.outputCallbacks.clear();
    this.exitCallbacks.clear();
    this.titleCallbacks.clear();
    this.debugLog('Shutdown complete');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Terminal Operations
  // ─────────────────────────────────────────────────────────────────────────

  write(terminalId: string, data: string): void {
    const session = this.sessions.get(terminalId);
    if (!session) {
      throw TerminalError.terminalNotFound(terminalId);
    }

    if (!session.pty.isRunning()) {
      throw TerminalError.notRunning(terminalId);
    }

    session.pty.write(data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const session = this.sessions.get(terminalId);
    if (!session) {
      throw TerminalError.terminalNotFound(terminalId);
    }

    if (cols < 1 || rows < 1) {
      throw TerminalError.invalidDimensions(cols, rows);
    }

    session.pty.resize(cols, rows);
    this.debugLog(`Resized terminal ${terminalId} to ${cols}x${rows}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Buffer Access
  // ─────────────────────────────────────────────────────────────────────────

  getBuffer(terminalId: string): TerminalBuffer | null {
    const session = this.sessions.get(terminalId);
    if (!session) {
      return null;
    }

    const buffer = session.pty.getBuffer();
    const cursor = session.pty.getCursor();
    const scrollOffset = session.pty.getViewOffset();

    // Convert PTY cells to service cells
    const cells: TerminalCell[][] = buffer.map((row: PTYBackendCell[]) =>
      row.map((cell: PTYBackendCell) => ({
        char: cell.char,
        fg: cell.fg,
        bg: cell.bg,
        bold: cell.bold,
        italic: cell.italic,
        underline: cell.underline,
        dim: cell.dim,
        inverse: cell.inverse,
      }))
    );

    return {
      cells,
      cursor: { x: cursor.x, y: cursor.y },
      scrollOffset,
      scrollbackSize: 0, // PTY doesn't expose scrollback size directly
    };
  }

  scroll(terminalId: string, lines: number): void {
    const session = this.sessions.get(terminalId);
    if (!session) {
      throw TerminalError.terminalNotFound(terminalId);
    }

    if (lines > 0) {
      session.pty.scrollViewUp(lines);
    } else if (lines < 0) {
      session.pty.scrollViewDown(-lines);
    }
  }

  scrollToBottom(terminalId: string): void {
    const session = this.sessions.get(terminalId);
    if (!session) {
      throw TerminalError.terminalNotFound(terminalId);
    }

    session.pty.resetViewOffset();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Terminal Info
  // ─────────────────────────────────────────────────────────────────────────

  getInfo(terminalId: string): TerminalInfo | null {
    const session = this.sessions.get(terminalId);
    if (!session) {
      return null;
    }

    return {
      terminalId: session.terminalId,
      shell: session.shell,
      cwd: session.cwd,
      cols: session.pty.getSize().cols,
      rows: session.pty.getSize().rows,
      running: session.pty.isRunning(),
      title: session.title,
      tmuxSession: session.tmuxSession,
      tmuxSocket: session.tmuxSocket,
    };
  }

  list(): TerminalInfo[] {
    const result: TerminalInfo[] = [];
    for (const session of this.sessions.values()) {
      const info = this.getInfo(session.terminalId);
      if (info) {
        result.push(info);
      }
    }
    return result;
  }

  exists(terminalId: string): boolean {
    return this.sessions.has(terminalId);
  }

  isRunning(terminalId: string): boolean {
    const session = this.sessions.get(terminalId);
    if (!session) {
      return false;
    }
    return session.pty.isRunning();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Command Execution
  // ─────────────────────────────────────────────────────────────────────────

  async execute(
    command: string,
    options?: { cwd?: string; timeout?: number }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const cwd = options?.cwd || process.cwd();
    const timeout = options?.timeout ?? 30000; // Default 30s timeout

    this.debugLog(`Executing command: ${command} in ${cwd}`);

    return new Promise((resolve, reject) => {
      const shell = process.env.SHELL || '/bin/sh';
      const proc = Bun.spawn([shell, '-c', command], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      // Set up timeout
      const timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill();
        reject(new TerminalError(`Command timed out after ${timeout}ms`, TerminalErrorCode.TIMEOUT));
      }, timeout);

      // Read stdout
      const readStdout = async () => {
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            stdout += decoder.decode(value, { stream: true });
          }
        } catch {
          // Ignore read errors on killed process
        }
      };

      // Read stderr
      const readStderr = async () => {
        const reader = proc.stderr.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            stderr += decoder.decode(value, { stream: true });
          }
        } catch {
          // Ignore read errors on killed process
        }
      };

      // Wait for process and streams
      Promise.all([readStdout(), readStderr(), proc.exited])
        .then(([, , exitCode]) => {
          clearTimeout(timeoutId);
          if (!timedOut) {
            this.debugLog(`Command exited with code ${exitCode}`);
            resolve({ stdout, stderr, exitCode });
          }
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          if (!timedOut) {
            reject(new TerminalError(`Command failed: ${error.message}`, TerminalErrorCode.EXECUTE_FAILED));
          }
        });
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Events
  // ─────────────────────────────────────────────────────────────────────────

  onOutput(callback: TerminalOutputCallback): Unsubscribe {
    this.outputCallbacks.add(callback);
    return () => {
      this.outputCallbacks.delete(callback);
    };
  }

  onExit(callback: TerminalExitCallback): Unsubscribe {
    this.exitCallbacks.add(callback);
    return () => {
      this.exitCallbacks.delete(callback);
    };
  }

  onTitle(callback: TerminalTitleCallback): Unsubscribe {
    this.titleCallbacks.add(callback);
    return () => {
      this.titleCallbacks.delete(callback);
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Event Emission
  // ─────────────────────────────────────────────────────────────────────────

  private emitOutput(terminalId: string, data: string): void {
    for (const callback of this.outputCallbacks) {
      try {
        callback({ terminalId, data });
      } catch (error) {
        this.debugLog(`Output callback error: ${error}`);
      }
    }
  }

  private emitExit(terminalId: string, exitCode: number): void {
    for (const callback of this.exitCallbacks) {
      try {
        callback({ terminalId, exitCode });
      } catch (error) {
        this.debugLog(`Exit callback error: ${error}`);
      }
    }
  }

  private emitTitle(terminalId: string, title: string): void {
    for (const callback of this.titleCallbacks) {
      try {
        callback({ terminalId, title });
      } catch (error) {
        this.debugLog(`Title callback error: ${error}`);
      }
    }
  }
}

export const localTerminalService = new LocalTerminalService();
export default localTerminalService;
