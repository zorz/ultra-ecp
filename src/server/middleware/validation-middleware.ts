/**
 * Validation Middleware
 *
 * Middleware that validates file edits using linters and semantic rules.
 * Blocks edits that fail validation and returns actionable feedback.
 */

import { debugLog } from '../../debug.ts';
import type { ECPMiddleware, MiddlewareContext, MiddlewareResult } from './types.ts';
import { MiddlewareErrorCodes } from './types.ts';
import {
  getLinterRegistry,
  loadValidationConfig,
  type LintResult,
  type ValidationConfig,
} from './linters/index.ts';
import {
  loadRuleHierarchy,
  getRulesForFile,
  validateContent,
  formatViolationFeedback,
  clearRuleCache,
} from './rules/index.ts';

/**
 * Methods that the validation middleware applies to.
 */
const VALIDATION_METHODS = [
  'file/write',
  'file/edit',
  'document/save',
];

/**
 * Extract file paths from request params.
 */
function extractFilePaths(method: string, params: unknown): string[] {
  const p = params as Record<string, unknown>;

  // Helper to convert URI to path
  const uriToPath = (uri: string): string => {
    if (uri.startsWith('file://')) {
      return uri.slice(7);
    }
    return uri;
  };

  switch (method) {
    case 'file/write':
    case 'file/edit':
      // Handle both uri and path params
      if (typeof p?.uri === 'string') {
        return [uriToPath(p.uri)];
      }
      if (typeof p?.path === 'string') {
        return [p.path];
      }
      break;

    case 'document/save':
      if (typeof p?.uri === 'string') {
        return [uriToPath(p.uri)];
      }
      break;
  }

  return [];
}

/**
 * Format lint errors into readable feedback.
 */
function formatLintFeedback(result: LintResult): string {
  const lines: string[] = [];

  lines.push(`Linting failed with ${result.errors.length} error(s):\n`);

  for (const error of result.errors.slice(0, 10)) {
    const location = `${error.file}:${error.line}:${error.column}`;
    lines.push(`  ${location}`);
    lines.push(`    ${error.ruleId}: ${error.message}`);
    if (error.fix) {
      lines.push(`    Fix: ${error.fix.description}`);
    }
    lines.push('');
  }

  if (result.errors.length > 10) {
    lines.push(`  ... and ${result.errors.length - 10} more errors`);
  }

  if (result.warnings.length > 0) {
    lines.push(`\nAlso ${result.warnings.length} warning(s).`);
  }

  return lines.join('\n');
}

/**
 * Validation middleware.
 *
 * Intercepts file write/edit operations and validates them using
 * the configured linter and semantic rules.
 */
export class ValidationMiddleware implements ECPMiddleware {
  name = 'validation';
  priority = 50; // Run early in the chain

  private config: ValidationConfig | null = null;
  private workspaceRoot: string = '';

  /**
   * Initialize the middleware.
   */
  async init(workspaceRoot: string): Promise<void> {
    this.workspaceRoot = workspaceRoot;
    this.config = await loadValidationConfig(workspaceRoot);
    debugLog(`[ValidationMiddleware] Initialized with config: ${JSON.stringify(this.config.linter)}`);
  }

  /**
   * Check if this middleware applies to the method.
   */
  appliesTo(method: string): boolean {
    return VALIDATION_METHODS.includes(method);
  }

  /**
   * Validate the request.
   */
  async validate(ctx: MiddlewareContext): Promise<MiddlewareResult> {
    // Reload config if needed (allows hot-reload of validation config)
    if (!this.config) {
      this.config = await loadValidationConfig(ctx.workspaceRoot);
    }

    const files = extractFilePaths(ctx.method, ctx.params);
    if (files.length === 0) {
      return { allowed: true };
    }

    // Run linter validation
    const lintResult = await this.runLintValidation(files, ctx);
    if (!lintResult.allowed) {
      return lintResult;
    }

    // Run semantic validation
    if (this.config?.semanticRules.enabled) {
      const semanticResult = await this.runSemanticValidation(files, ctx);
      if (!semanticResult.allowed) {
        return semanticResult;
      }
    }

    return { allowed: true };
  }

  /**
   * Run linter validation on files.
   */
  private async runLintValidation(
    files: string[],
    ctx: MiddlewareContext
  ): Promise<MiddlewareResult> {
    if (!this.config || this.config.linter.mode === 'disabled') {
      return { allowed: true };
    }

    const registry = getLinterRegistry();
    const linter = await registry.getLinterForConfig(this.config, ctx.workspaceRoot);

    if (!linter) {
      // No linter configured/detected - allow the request
      debugLog('[ValidationMiddleware] No linter available, skipping lint validation');
      return { allowed: true };
    }

    // Filter files to only those the linter handles
    const lintableFiles = files.filter((file) => {
      const ext = '.' + file.split('.').pop();
      return linter.extensions.includes(ext);
    });

    if (lintableFiles.length === 0) {
      return { allowed: true };
    }

    // Apply include/exclude filters
    const filteredFiles = this.applyFilters(lintableFiles);
    if (filteredFiles.length === 0) {
      return { allowed: true };
    }

    debugLog(`[ValidationMiddleware] Running ${linter.name} on ${filteredFiles.length} file(s)`);

    try {
      const result = await linter.lint(filteredFiles, ctx.workspaceRoot);

      if (!result.success) {
        return {
          allowed: false,
          feedback: formatLintFeedback(result),
          errorData: {
            code: MiddlewareErrorCodes.LintFailed,
            linter: linter.name,
            errors: result.errors,
            warnings: result.warnings,
          },
        };
      }

      return { allowed: true };
    } catch (error) {
      debugLog(`[ValidationMiddleware] Lint error: ${error}`);

      // Don't block on linter errors - just log and continue
      return { allowed: true };
    }
  }

  /**
   * Run semantic validation on files.
   */
  private async runSemanticValidation(
    files: string[],
    ctx: MiddlewareContext
  ): Promise<MiddlewareResult> {
    // Extract content from params for write operations
    const p = ctx.params as Record<string, unknown>;
    const newContent = typeof p?.content === 'string' ? p.content : null;

    for (const filePath of files) {
      try {
        // Load rule hierarchy for this file
        const hierarchy = await loadRuleHierarchy(filePath, ctx.workspaceRoot);

        if (hierarchy.rules.length === 0) {
          continue;
        }

        // Get rules that apply to this specific file
        const applicableRules = getRulesForFile(filePath, hierarchy.rules);

        if (applicableRules.length === 0) {
          continue;
        }

        // For write operations, validate the new content being written
        // For other operations, read existing file content
        let content: string;
        if (newContent !== null && (ctx.method === 'file/write' || ctx.method === 'file/edit')) {
          content = newContent;
        } else {
          const file = Bun.file(filePath);
          if (!(await file.exists())) {
            continue;
          }
          content = await file.text();
        }

        // Validate content against rules
        const result = validateContent(filePath, content, applicableRules);

        if (!result.success) {
          return {
            allowed: false,
            feedback: formatViolationFeedback(result),
            errorData: {
              code: MiddlewareErrorCodes.RuleViolation,
              violations: result.violations,
            },
          };
        }

        debugLog(
          `[ValidationMiddleware] Semantic validation passed for ${filePath} (${applicableRules.length} rules)`
        );
      } catch (error) {
        debugLog(`[ValidationMiddleware] Semantic validation error for ${filePath}: ${error}`);
        // Don't block on validation errors - just log and continue
      }
    }

    return { allowed: true };
  }

  /**
   * Apply include/exclude filters to file list.
   */
  private applyFilters(files: string[]): string[] {
    if (!this.config) return files;

    const { include, exclude } = this.config.linter;

    return files.filter((file) => {
      // Check exclude patterns
      if (exclude) {
        for (const pattern of exclude) {
          if (this.matchesPattern(file, pattern)) {
            return false;
          }
        }
      }

      // Check include patterns (if specified, file must match at least one)
      if (include && include.length > 0) {
        return include.some((pattern) => this.matchesPattern(file, pattern));
      }

      return true;
    });
  }

  /**
   * Simple glob pattern matching.
   */
  private matchesPattern(file: string, pattern: string): boolean {
    // Convert glob pattern to regex
    const regexPattern = pattern
      .replace(/\*\*/g, '{{DOUBLE_STAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/{{DOUBLE_STAR}}/g, '.*')
      .replace(/\?/g, '.');

    const regex = new RegExp(`^${regexPattern}$|/${regexPattern}$`);
    return regex.test(file);
  }
}

/**
 * Create a validation middleware instance.
 */
export function createValidationMiddleware(): ValidationMiddleware {
  return new ValidationMiddleware();
}
