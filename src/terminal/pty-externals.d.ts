/**
 * Type declarations for optional PTY modules.
 * These are dynamically imported at runtime and may not be installed.
 */

declare module 'node-pty' {
  export interface IPty {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    onData: (callback: (data: string) => void) => { dispose(): void };
    onExit: (callback: (e: { exitCode: number; signal?: number }) => void) => { dispose(): void };
    pid: number;
    cols: number;
    rows: number;
    process: string;
  }

  export interface IPtyForkOptions {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
    encoding?: string | null;
  }

  export function spawn(
    file: string,
    args: string[] | string,
    options: IPtyForkOptions
  ): IPty;
}

declare module 'bun-pty' {
  export interface PTYOptions {
    name?: string;
    rows?: number;
    cols?: number;
    cwd?: string;
    env?: Record<string, string>;
  }

  export interface TerminalCell {
    char: string;
    fg: number;
    bg: number;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    strikethrough: boolean;
  }

  export interface PTYInstance {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
    read(): Uint8Array | null;
    fd: number;
    pid: number;
  }

  export function spawn(
    command: string,
    args: string[],
    options?: PTYOptions
  ): PTYInstance;
}
