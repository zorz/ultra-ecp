/**
 * ESLint Adapter
 *
 * Linter adapter for ESLint.
 */

import { debugLog } from '../../../debug.ts';
import type { LinterAdapter, LintResult, LintMessage } from './types.ts';

/**
 * ESLint output format (when using --format json).
 */
interface ESLintJsonOutput {
  filePath: string;
  messages: Array<{
    ruleId: string | null;
    severity: 1 | 2; // 1 = warning, 2 = error
    message: string;
    line: number;
    column: number;
    endLine?: number;
    endColumn?: number;
    fix?: {
      range: [number, number];
      text: string;
    };
  }>;
  errorCount: number;
  warningCount: number;
}

/**
 * ESLint linter adapter.
 */
export class ESLintAdapter implements LinterAdapter {
  name = 'eslint';
  displayName = 'ESLint';
  extensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];

  /**
   * Check if ESLint config exists in the workspace.
   */
  async detect(workspaceRoot: string): Promise<boolean> {
    const configFiles = [
      'eslint.config.js',
      'eslint.config.mjs',
      'eslint.config.cjs',
      '.eslintrc',
      '.eslintrc.js',
      '.eslintrc.cjs',
      '.eslintrc.json',
      '.eslintrc.yml',
      '.eslintrc.yaml',
    ];

    for (const configFile of configFiles) {
      const file = Bun.file(`${workspaceRoot}/${configFile}`);
      if (await file.exists()) {
        debugLog(`[ESLintAdapter] Found config: ${configFile}`);
        return true;
      }
    }

    // Also check package.json for eslintConfig
    try {
      const pkgFile = Bun.file(`${workspaceRoot}/package.json`);
      if (await pkgFile.exists()) {
        const pkg = await pkgFile.json();
        if (pkg.eslintConfig) {
          debugLog('[ESLintAdapter] Found eslintConfig in package.json');
          return true;
        }
      }
    } catch (error) {
      debugLog(`[ESLintAdapter] Failed to parse package.json: ${error}`);
    }

    return false;
  }

  /**
   * Check if ESLint is available.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const proc = Bun.spawn(['npx', 'eslint', '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch (error) {
      debugLog(`[ESLintAdapter] isAvailable check failed: ${error}`);
      return false;
    }
  }

  /**
   * Get ESLint version.
   */
  async getVersion(): Promise<string | null> {
    try {
      const proc = Bun.spawn(['npx', 'eslint', '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const output = await new Response(proc.stdout).text();
      await proc.exited;

      return output.trim();
    } catch (error) {
      debugLog(`[ESLintAdapter] getVersion failed: ${error}`);
      return null;
    }
  }

  /**
   * Run ESLint on files.
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
      // Run ESLint with JSON output
      const proc = Bun.spawn(
        ['npx', 'eslint', '--format', 'json', '--no-error-on-unmatched-pattern', ...files],
        {
          cwd: workspaceRoot,
          stdout: 'pipe',
          stderr: 'pipe',
        }
      );

      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      const duration = Date.now() - startTime;

      // Parse JSON output
      let results: ESLintJsonOutput[] = [];
      if (output.trim()) {
        try {
          results = JSON.parse(output);
        } catch (parseError) {
          debugLog(`[ESLintAdapter] Failed to parse output: ${parseError}`);
          // Return as internal error
          return {
            success: false,
            errors: [
              {
                file: workspaceRoot,
                line: 0,
                column: 0,
                message: `ESLint output parse error: ${parseError}`,
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
      const errors: LintMessage[] = [];
      const warnings: LintMessage[] = [];

      for (const fileResult of results) {
        for (const msg of fileResult.messages) {
          const lintMessage: LintMessage = {
            file: fileResult.filePath,
            line: msg.line,
            column: msg.column,
            endLine: msg.endLine,
            endColumn: msg.endColumn,
            message: msg.message,
            ruleId: msg.ruleId || 'unknown',
            severity: msg.severity === 2 ? 'error' : 'warning',
            fix: msg.fix
              ? { description: 'Auto-fix available', replacement: msg.fix.text }
              : undefined,
          };

          if (msg.severity === 2) {
            errors.push(lintMessage);
          } else {
            warnings.push(lintMessage);
          }
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
      debugLog(`[ESLintAdapter] Lint error: ${error}`);

      return {
        success: false,
        errors: [
          {
            file: workspaceRoot,
            line: 0,
            column: 0,
            message: `ESLint execution error: ${error instanceof Error ? error.message : String(error)}`,
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
