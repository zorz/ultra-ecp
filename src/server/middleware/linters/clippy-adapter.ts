/**
 * Clippy Adapter
 *
 * Linter adapter for Clippy (Rust linter).
 */

import { debugLog } from '../../../debug.ts';
import type { LinterAdapter, LintResult, LintMessage } from './types.ts';

/**
 * Cargo/Clippy JSON message format.
 */
interface CargoJsonMessage {
  reason: 'compiler-message' | 'compiler-artifact' | 'build-script-executed' | 'build-finished';
  message?: {
    code?: {
      code: string;
      explanation?: string;
    };
    level: 'error' | 'warning' | 'note' | 'help' | 'failure-note';
    message: string;
    spans: Array<{
      byte_end: number;
      byte_start: number;
      column_end: number;
      column_start: number;
      file_name: string;
      is_primary: boolean;
      label?: string;
      line_end: number;
      line_start: number;
      suggested_replacement?: string;
      suggestion_applicability?: string;
      text: Array<{
        highlight_end: number;
        highlight_start: number;
        text: string;
      }>;
    }>;
    children: Array<{
      code?: { code: string };
      level: string;
      message: string;
      spans: Array<{
        column_end: number;
        column_start: number;
        file_name: string;
        line_end: number;
        line_start: number;
        suggested_replacement?: string;
      }>;
    }>;
    rendered?: string;
  };
}

/**
 * Clippy linter adapter.
 */
export class ClippyAdapter implements LinterAdapter {
  name = 'clippy';
  displayName = 'Clippy';
  extensions = ['.rs'];

  /**
   * Check if this is a Rust project.
   */
  async detect(workspaceRoot: string): Promise<boolean> {
    const cargoFile = Bun.file(`${workspaceRoot}/Cargo.toml`);
    if (await cargoFile.exists()) {
      debugLog('[ClippyAdapter] Found Cargo.toml');
      return true;
    }
    return false;
  }

  /**
   * Check if Clippy is available.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const proc = Bun.spawn(['cargo', 'clippy', '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch (error) {
      debugLog(`[ClippyAdapter] isAvailable check failed: ${error}`);
      return false;
    }
  }

  /**
   * Get Clippy version.
   */
  async getVersion(): Promise<string | null> {
    try {
      const proc = Bun.spawn(['cargo', 'clippy', '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const output = await new Response(proc.stdout).text();
      await proc.exited;

      return output.trim();
    } catch (error) {
      debugLog(`[ClippyAdapter] getVersion failed: ${error}`);
      return null;
    }
  }

  /**
   * Run Clippy on files.
   *
   * Note: Clippy runs on the entire crate, not individual files.
   * We check if the specified files are within the workspace.
   */
  async lint(files: string[], workspaceRoot: string): Promise<LintResult> {
    if (files.length === 0) {
      return {
        success: true,
        errors: [],
        warnings: [],
        filesChecked: 0,
        duration: 0,
      };
    }

    const startTime = Date.now();

    try {
      // Run Clippy with JSON output
      // --message-format=json outputs one JSON object per line
      const proc = Bun.spawn(
        [
          'cargo',
          'clippy',
          '--message-format=json',
          '--',
          '-D',
          'warnings', // Deny warnings (treat as errors)
        ],
        {
          cwd: workspaceRoot,
          stdout: 'pipe',
          stderr: 'pipe',
        }
      );

      const output = await new Response(proc.stdout).text();
      await proc.exited;

      const duration = Date.now() - startTime;

      // Parse line-delimited JSON
      const errors: LintMessage[] = [];
      const warnings: LintMessage[] = [];

      // Track files we care about
      const targetFiles = new Set(files.map((f) => f.replace(workspaceRoot + '/', '')));

      for (const line of output.split('\n')) {
        if (!line.trim()) continue;

        try {
          const msg: CargoJsonMessage = JSON.parse(line);

          if (msg.reason !== 'compiler-message' || !msg.message) {
            continue;
          }

          const diagnostic = msg.message;

          // Find primary span
          const primarySpan = diagnostic.spans.find((s) => s.is_primary);
          if (!primarySpan) continue;

          // Filter to only files we're checking
          const relativeFile = primarySpan.file_name;
          const shouldInclude =
            targetFiles.size === 0 ||
            targetFiles.has(relativeFile) ||
            Array.from(targetFiles).some((f) => f.endsWith(relativeFile));

          if (!shouldInclude) continue;

          // Extract fix suggestion if available
          let fix: { description: string; replacement?: string } | undefined;
          for (const child of diagnostic.children) {
            if (child.level === 'help' && child.spans.length > 0) {
              const suggestion = child.spans[0]?.suggested_replacement;
              if (suggestion) {
                fix = { description: child.message, replacement: suggestion };
                break;
              }
            }
          }

          const lintMessage: LintMessage = {
            file: `${workspaceRoot}/${primarySpan.file_name}`,
            line: primarySpan.line_start,
            column: primarySpan.column_start,
            endLine: primarySpan.line_end,
            endColumn: primarySpan.column_end,
            message: diagnostic.message,
            ruleId: diagnostic.code?.code || 'clippy',
            severity: diagnostic.level === 'error' ? 'error' : 'warning',
            fix,
          };

          if (diagnostic.level === 'error') {
            errors.push(lintMessage);
          } else if (diagnostic.level === 'warning') {
            warnings.push(lintMessage);
          }
        } catch (parseError) {
          debugLog(`[ClippyAdapter] Skipping malformed JSON line: ${parseError}`);
        }
      }

      return {
        success: errors.length === 0,
        errors,
        warnings,
        filesChecked: files.length,
        duration,
      };
    } catch (error) {
      debugLog(`[ClippyAdapter] Lint error: ${error}`);

      return {
        success: false,
        errors: [
          {
            file: workspaceRoot,
            line: 0,
            column: 0,
            message: `Clippy execution error: ${error instanceof Error ? error.message : String(error)}`,
            ruleId: 'execution-error',
            severity: 'error',
          },
        ],
        warnings: [],
        filesChecked: files.length,
        duration: Date.now() - startTime,
      };
    }
  }
}
