/**
 * Ruff Adapter
 *
 * Linter adapter for Ruff (fast Python linter).
 */

import { debugLog } from '../../../debug.ts';
import type { LinterAdapter, LintResult, LintMessage } from './types.ts';

/**
 * Ruff JSON output format.
 */
interface RuffJsonOutput {
  cell?: number;
  code: string;
  end_location: {
    column: number;
    row: number;
  };
  filename: string;
  fix?: {
    applicability: string;
    edits: Array<{
      content: string;
      end_location: { column: number; row: number };
      location: { column: number; row: number };
    }>;
    message: string;
  };
  location: {
    column: number;
    row: number;
  };
  message: string;
  noqa_row?: number;
  url: string;
}

/**
 * Ruff linter adapter.
 */
export class RuffAdapter implements LinterAdapter {
  name = 'ruff';
  displayName = 'Ruff';
  extensions = ['.py', '.pyi'];

  /**
   * Check if Ruff config exists in the workspace.
   */
  async detect(workspaceRoot: string): Promise<boolean> {
    const configFiles = ['ruff.toml', '.ruff.toml'];

    for (const configFile of configFiles) {
      const file = Bun.file(`${workspaceRoot}/${configFile}`);
      if (await file.exists()) {
        debugLog(`[RuffAdapter] Found config: ${configFile}`);
        return true;
      }
    }

    // Check pyproject.toml for [tool.ruff] section
    try {
      const pyprojectFile = Bun.file(`${workspaceRoot}/pyproject.toml`);
      if (await pyprojectFile.exists()) {
        const content = await pyprojectFile.text();
        if (content.includes('[tool.ruff]')) {
          debugLog('[RuffAdapter] Found ruff config in pyproject.toml');
          return true;
        }
      }
    } catch (error) {
      debugLog(`[RuffAdapter] Failed to read pyproject.toml: ${error}`);
    }

    // Check for any .py files (ruff works without config)
    try {
      const proc = Bun.spawn(['find', workspaceRoot, '-name', '*.py', '-type', 'f', '-maxdepth', '3'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const output = await new Response(proc.stdout).text();
      await proc.exited;
      if (output.trim().length > 0) {
        debugLog('[RuffAdapter] Found Python files, ruff can lint without config');
        return true;
      }
    } catch (error) {
      debugLog(`[RuffAdapter] Failed to search for Python files: ${error}`);
    }

    return false;
  }

  /**
   * Check if Ruff is available.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const proc = Bun.spawn(['ruff', '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch (error) {
      debugLog(`[RuffAdapter] isAvailable check failed: ${error}`);
      return false;
    }
  }

  /**
   * Get Ruff version.
   */
  async getVersion(): Promise<string | null> {
    try {
      const proc = Bun.spawn(['ruff', '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const output = await new Response(proc.stdout).text();
      await proc.exited;

      return output.trim();
    } catch (error) {
      debugLog(`[RuffAdapter] getVersion failed: ${error}`);
      return null;
    }
  }

  /**
   * Run Ruff on files.
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
      // Run Ruff check with JSON output
      const proc = Bun.spawn(
        ['ruff', 'check', '--output-format=json', ...files],
        {
          cwd: workspaceRoot,
          stdout: 'pipe',
          stderr: 'pipe',
        }
      );

      const output = await new Response(proc.stdout).text();
      await proc.exited;

      const duration = Date.now() - startTime;

      // Parse JSON output (array of diagnostics)
      let results: RuffJsonOutput[] = [];
      if (output.trim()) {
        try {
          results = JSON.parse(output);
        } catch (parseError) {
          debugLog(`[RuffAdapter] Failed to parse output: ${parseError}`);
          return {
            success: false,
            errors: [
              {
                file: workspaceRoot,
                line: 0,
                column: 0,
                message: `Ruff output parse error: ${parseError}`,
                ruleId: 'internal-error',
                severity: 'error',
              },
            ],
            warnings: [],
            filesChecked: files.length,
            duration,
          };
        }
      }

      // Convert to our format
      // Ruff treats everything as errors by default
      const errors: LintMessage[] = [];
      const warnings: LintMessage[] = [];

      for (const diag of results) {
        const lintMessage: LintMessage = {
          file: diag.filename,
          line: diag.location.row,
          column: diag.location.column,
          endLine: diag.end_location.row,
          endColumn: diag.end_location.column,
          message: diag.message,
          ruleId: diag.code,
          severity: 'error', // Ruff doesn't distinguish warning/error
          fix: diag.fix
            ? { description: diag.fix.message, replacement: diag.fix.edits[0]?.content }
            : undefined,
        };

        errors.push(lintMessage);
      }

      return {
        success: errors.length === 0,
        errors,
        warnings,
        filesChecked: files.length,
        duration,
      };
    } catch (error) {
      debugLog(`[RuffAdapter] Lint error: ${error}`);

      return {
        success: false,
        errors: [
          {
            file: workspaceRoot,
            line: 0,
            column: 0,
            message: `Ruff execution error: ${error instanceof Error ? error.message : String(error)}`,
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
