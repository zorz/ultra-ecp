/**
 * Biome Adapter
 *
 * Linter adapter for Biome (fast JS/TS linter).
 */

import { debugLog } from '../../../debug.ts';
import type { LinterAdapter, LintResult, LintMessage } from './types.ts';

/**
 * Biome JSON output format.
 */
interface BiomeJsonOutput {
  diagnostics: Array<{
    category: string;
    severity: 'fatal' | 'error' | 'warning' | 'information' | 'hint';
    message: string;
    location: {
      path: {
        file: string;
      };
      span?: [number, number];
      sourceCode?: string;
    };
    advices?: {
      advices: Array<{
        log?: [string, string[]];
        diff?: {
          dictionary: string;
          ops: Array<unknown>;
        };
      }>;
    };
  }>;
}

/**
 * Biome linter adapter.
 */
export class BiomeAdapter implements LinterAdapter {
  name = 'biome';
  displayName = 'Biome';
  extensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.jsonc'];

  /**
   * Check if Biome config exists in the workspace.
   */
  async detect(workspaceRoot: string): Promise<boolean> {
    const configFiles = ['biome.json', 'biome.jsonc'];

    for (const configFile of configFiles) {
      const file = Bun.file(`${workspaceRoot}/${configFile}`);
      if (await file.exists()) {
        debugLog(`[BiomeAdapter] Found config: ${configFile}`);
        return true;
      }
    }

    return false;
  }

  /**
   * Check if Biome is available.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const proc = Bun.spawn(['npx', 'biome', '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch (error) {
      debugLog(`[BiomeAdapter] isAvailable check failed: ${error}`);
      return false;
    }
  }

  /**
   * Get Biome version.
   */
  async getVersion(): Promise<string | null> {
    try {
      const proc = Bun.spawn(['npx', 'biome', '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const output = await new Response(proc.stdout).text();
      await proc.exited;

      return output.trim();
    } catch (error) {
      debugLog(`[BiomeAdapter] getVersion failed: ${error}`);
      return null;
    }
  }

  /**
   * Run Biome on files.
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
      // Run Biome lint with JSON output
      const proc = Bun.spawn(
        ['npx', 'biome', 'lint', '--reporter=json', ...files],
        {
          cwd: workspaceRoot,
          stdout: 'pipe',
          stderr: 'pipe',
        }
      );

      const output = await new Response(proc.stdout).text();
      await proc.exited;

      const duration = Date.now() - startTime;

      // Parse JSON output
      let results: BiomeJsonOutput = { diagnostics: [] };
      if (output.trim()) {
        try {
          results = JSON.parse(output);
        } catch (parseError) {
          debugLog(`[BiomeAdapter] Failed to parse output: ${parseError}`);
          return {
            success: false,
            errors: [
              {
                file: workspaceRoot,
                line: 0,
                column: 0,
                message: `Biome output parse error: ${parseError}`,
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

      for (const diag of results.diagnostics) {
        // Extract line/column from span if available
        let line = 1;
        let column = 1;

        // Biome uses byte offsets, we'd need source to convert
        // For now, default to line 1 if we can't determine

        const lintMessage: LintMessage = {
          file: diag.location.path.file,
          line,
          column,
          message: diag.message,
          ruleId: diag.category || 'unknown',
          severity: diag.severity === 'error' || diag.severity === 'fatal' ? 'error' : 'warning',
        };

        if (diag.severity === 'error' || diag.severity === 'fatal') {
          errors.push(lintMessage);
        } else if (diag.severity === 'warning') {
          warnings.push(lintMessage);
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
      debugLog(`[BiomeAdapter] Lint error: ${error}`);

      return {
        success: false,
        errors: [
          {
            file: workspaceRoot,
            line: 0,
            column: 0,
            message: `Biome execution error: ${error instanceof Error ? error.message : String(error)}`,
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
