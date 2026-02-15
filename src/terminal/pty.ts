/**
 * PTY (Pseudo-Terminal) Support
 *
 * Uses bun-pty for real PTY support with a simple built-in ANSI parser.
 * Note: bun-pty is loaded lazily to avoid native library issues when
 * running as a bundled binary (which uses node-pty via IPC instead).
 */

import { debugLog } from '../debug.ts';

// Lazy-loaded bun-pty spawn function
let bunPtySpawn: typeof import('bun-pty').spawn | null = null;

async function getBunPtySpawn(): Promise<typeof import('bun-pty').spawn> {
  if (!bunPtySpawn) {
    const bunPty = await import('bun-pty');
    bunPtySpawn = bunPty.spawn;
  }
  return bunPtySpawn;
}

/**
 * Validate tmux session/socket names to prevent command injection.
 * Allows alphanumeric characters, dashes, underscores, and dots.
 */
const SAFE_TMUX_NAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;

function validateTmuxName(name: string, type: 'session' | 'socket'): void {
  if (!SAFE_TMUX_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid tmux ${type} name: "${name}". ` +
      `Only alphanumeric characters, dashes, underscores, and dots are allowed.`
    );
  }
  // Also check length to prevent buffer issues
  if (name.length > 256) {
    throw new Error(`Tmux ${type} name too long (max 256 characters)`);
  }
}

// Re-export screen buffer types and classes from screen-buffer.ts
// These are separated to allow imports without loading bun-pty
export type { TerminalCell } from './screen-buffer.ts';
export {
  createEmptyCell,
  ansiToHex,
  ScreenBuffer,
  AnsiParser,
} from './screen-buffer.ts';

import { ScreenBuffer, AnsiParser, type TerminalCell } from './screen-buffer.ts';

export interface PTYSize {
  cols: number;
  rows: number;
}

export interface PTYOptions {
  shell?: string;
  /** Arguments to pass to the shell (defaults to ['-il'] for bash/zsh/sh) */
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  scrollback?: number;
  /**
   * Attach to an existing tmux session instead of spawning a shell.
   * When set, spawns `tmux attach-session -t <tmuxSession>`.
   */
  tmuxSession?: string;
  /**
   * Custom tmux socket name (for `tmux -L <socket>`).
   * Only used when tmuxSession is set.
   */
  tmuxSocket?: string;
}

/**
 * PTY Terminal Emulator
 * 
 * Manages a pseudo-terminal session using bun-pty.
 */
export class PTY {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ptyProcess: any = null;
  private screen: ScreenBuffer;
  private parser: AnsiParser;
  private _cols: number;
  private _rows: number;
  private shell: string;
  private args: string[] | undefined;
  private cwd: string;
  private env: Record<string, string>;
  private _tmuxSession?: string;
  private _tmuxSocket?: string;

  // Callbacks
  private onDataCallback?: (data: string) => void;
  private onExitCallback?: (code: number) => void;
  private onTitleCallback?: (title: string) => void;
  private onUpdateCallback?: () => void;
  private onErrorCallback?: (error: Error) => void;

  constructor(options: PTYOptions = {}) {
    this._cols = options.cols || 80;
    this._rows = options.rows || 24;
    this.shell = options.shell || process.env.SHELL || '/bin/zsh';
    this.args = options.args;
    this.cwd = options.cwd || process.cwd();
    this._tmuxSession = options.tmuxSession;
    this._tmuxSocket = options.tmuxSocket;
    this.env = {
      ...process.env as Record<string, string>,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      // Set TERM_PROGRAM so shell prompts know they're in a terminal emulator
      TERM_PROGRAM: 'ultra',
      TERM_PROGRAM_VERSION: '0.5.0',
      ...options.env
    };

    // Create screen buffer and ANSI parser
    const scrollbackLimit = options.scrollback || 1000;
    this.screen = new ScreenBuffer(this._cols, this._rows, scrollbackLimit);
    this.parser = new AnsiParser(this.screen);

    // Set up parser output callback for DSR responses
    this.parser.onOutput((data: string) => {
      if (this.ptyProcess) {
        this.ptyProcess.write(data);
      }
    });
  }

  /**
   * Start the PTY process
   */
  async start(): Promise<void> {
    if (this.ptyProcess) {
      return;
    }

    try {
      let command: string;
      let commandArgs: string[];

      if (this._tmuxSession) {
        // Validate tmux names to prevent command injection
        validateTmuxName(this._tmuxSession, 'session');
        if (this._tmuxSocket) {
          validateTmuxName(this._tmuxSocket, 'socket');
        }

        // Attach to existing tmux session
        command = 'tmux';
        commandArgs = [];

        // Add socket option if specified
        if (this._tmuxSocket) {
          commandArgs.push('-L', this._tmuxSocket);
        }

        // Attach to the session
        commandArgs.push('attach-session', '-t', this._tmuxSession);

        debugLog(`[PTY] Attaching to tmux session: ${this._tmuxSession}${this._tmuxSocket ? ` (socket: ${this._tmuxSocket})` : ''}`);
      } else {
        // Spawn PTY process using bun-pty
        // Only use -il for POSIX shells (bash, zsh, sh) that support it
        // Other shells (fish, nu, etc.) get no args by default
        command = this.shell;
        const shellName = this.shell.split('/').pop() || '';
        const defaultArgs = ['bash', 'zsh', 'sh'].includes(shellName) ? ['-il'] : [];
        commandArgs = this.args ?? defaultArgs;
      }

      const spawn = await getBunPtySpawn();
      this.ptyProcess = spawn(command, commandArgs, {
        name: 'xterm-256color',
        cols: this._cols,
        rows: this._rows,
        cwd: this.cwd,
        env: this.env,
      });

      // Handle data from PTY
      this.ptyProcess.onData((data: string) => {
        // Parse ANSI sequences and update screen buffer
        this.parser.process(data);

        if (this.onDataCallback) {
          this.onDataCallback(data);
        }

        if (this.onUpdateCallback) {
          this.onUpdateCallback();
        }
      });

      // Handle exit
      this.ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
        this.ptyProcess = null;
        if (this.onExitCallback) {
          this.onExitCallback(exitCode);
        }
      });

    } catch (error) {
      debugLog(`[PTY] Failed to start PTY: ${error}`);
      throw error;
    }
  }

  /**
   * Write data to the PTY.
   * Returns false if the PTY is not running or write fails.
   */
  write(data: string): boolean {
    if (!this.ptyProcess) {
      return false;
    }

    try {
      this.ptyProcess.write(data);
      return true;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      debugLog(`[PTY] Write failed: ${err.message}`);
      this.onErrorCallback?.(err);
      return false;
    }
  }

  /**
   * Resize the terminal.
   * Returns false if resize fails on the PTY process.
   */
  resize(cols: number, rows: number): boolean {
    this._cols = cols;
    this._rows = rows;

    // Always resize the screen buffer
    this.screen.resize(cols, rows);

    // Resize the PTY process if running
    if (this.ptyProcess) {
      try {
        this.ptyProcess.resize(cols, rows);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        debugLog(`[PTY] Resize failed: ${err.message}`);
        this.onErrorCallback?.(err);
        return false;
      }
    }
    return true;
  }

  /**
   * Kill the PTY process.
   * Returns true if successfully killed, false if not running or kill failed.
   */
  kill(): boolean {
    if (!this.ptyProcess) {
      return false;
    }

    try {
      this.ptyProcess.kill();
      this.ptyProcess = null;
      return true;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      debugLog(`[PTY] Kill failed: ${err.message}`);
      this.onErrorCallback?.(err);
      // Still null out the process reference since we can't use it anymore
      this.ptyProcess = null;
      return false;
    }
  }

  /**
   * Check if running
   */
  isRunning(): boolean {
    return this.ptyProcess !== null;
  }

  /**
   * Get terminal dimensions
   */
  get cols(): number {
    return this._cols;
  }

  get rows(): number {
    return this._rows;
  }

  /**
   * Get the tmux session name (if attached to tmux)
   */
  get tmuxSession(): string | undefined {
    return this._tmuxSession;
  }

  /**
   * Get the tmux socket name (if using custom socket)
   */
  get tmuxSocket(): string | undefined {
    return this._tmuxSocket;
  }

  /**
   * Get the terminal buffer for rendering
   */
  getBuffer(): TerminalCell[][] {
    return this.screen.getBuffer();
  }

  /**
   * Get cursor position
   */
  getCursor(): { x: number; y: number } {
    return this.screen.getCursor();
  }

  /**
   * Check if cursor is visible (DECTCEM state)
   */
  isCursorVisible(): boolean {
    return this.screen.isCursorVisible();
  }

  /**
   * Scroll view up (into scrollback history)
   * @returns true if scroll position changed
   */
  scrollViewUp(lines: number): boolean {
    return this.screen.scrollViewUp(lines);
  }

  /**
   * Scroll view down (towards current)
   * @returns true if scroll position changed
   */
  scrollViewDown(lines: number): boolean {
    return this.screen.scrollViewDown(lines);
  }

  /**
   * Reset view to bottom (current output)
   */
  resetViewOffset(): void {
    this.screen.resetViewOffset();
  }

  /**
   * Get current view offset
   */
  getViewOffset(): number {
    return this.screen.getViewOffset();
  }

  /**
   * Get total number of lines (scrollback + visible)
   */
  getTotalLines(): number {
    return this.screen.getTotalLines();
  }

  /**
   * Set callback for data events
   */
  onData(callback: (data: string) => void): void {
    this.onDataCallback = callback;
  }

  /**
   * Set callback for exit events
   */
  onExit(callback: (code: number) => void): void {
    this.onExitCallback = callback;
  }

  /**
   * Set callback for title changes
   */
  onTitle(callback: (title: string) => void): void {
    this.onTitleCallback = callback;
  }

  /**
   * Set callback for update events
   */
  onUpdate(callback: () => void): void {
    this.onUpdateCallback = callback;
  }

  /**
   * Set callback for error events.
   * Called when write() or resize() fails on a running PTY.
   */
  onError(callback: (error: Error) => void): void {
    this.onErrorCallback = callback;
  }

  /**
   * Set callback for OSC 99 notifications (used by Claude Code, etc.)
   */
  onNotification(callback: (message: string) => void): void {
    this.parser.onNotification(callback);
  }
}
