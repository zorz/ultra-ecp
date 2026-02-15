/**
 * Rule Validator
 *
 * Validates file content against semantic rules.
 */

import { debugLog } from '../../../debug.ts';
import type {
  ParsedRule,
  RuleViolation,
  SemanticValidationResult,
} from './types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Import Pattern Matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Regex to match import statements.
 * Captures: 1) import specifiers, 2) module path
 */
const IMPORT_REGEX = /import\s+(?:type\s+)?(?:{[^}]*}|[^'"]+)\s+from\s+['"]([^'"]+)['"]/g;

/**
 * Regex to match type-only imports.
 */
const TYPE_IMPORT_REGEX = /import\s+type\s+/;

/**
 * Extract imports from TypeScript/JavaScript content.
 */
interface ImportInfo {
  /** The import path */
  path: string;
  /** Whether this is a type-only import */
  isTypeOnly: boolean;
  /** Line number (1-indexed) */
  line: number;
  /** The full import statement */
  statement: string;
}

function extractImports(content: string): ImportInfo[] {
  const imports: ImportInfo[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    IMPORT_REGEX.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = IMPORT_REGEX.exec(line)) !== null) {
      imports.push({
        path: match[1] ?? '',
        isTypeOnly: TYPE_IMPORT_REGEX.test(line),
        line: i + 1,
        statement: line.trim(),
      });
    }
  }

  return imports;
}

/**
 * Check if an import path matches a pattern.
 */
function importMatchesPattern(importPath: string, pattern: string): boolean {
  // Handle glob patterns
  const regexPattern = pattern
    .replace(/\*\*/g, '{{DOUBLE_STAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/{{DOUBLE_STAR}}/g, '.*');

  const regex = new RegExp(`^${regexPattern}$|/${regexPattern}$`);
  return regex.test(importPath);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule Checking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check a file against import disallow rules.
 */
function checkImportRules(
  filePath: string,
  content: string,
  rule: ParsedRule
): RuleViolation[] {
  const violations: RuleViolation[] = [];

  if (!rule.disallowImports || rule.disallowImports.length === 0) {
    return violations;
  }

  const imports = extractImports(content);

  for (const imp of imports) {
    // Skip type-only imports if exceptTypes is true
    if (rule.exceptTypes && imp.isTypeOnly) {
      continue;
    }

    // Check if import matches any disallowed pattern
    for (const disallowedPattern of rule.disallowImports) {
      if (importMatchesPattern(imp.path, disallowedPattern)) {
        // Check if it's allowed by an allow pattern
        const isAllowed = rule.allowImports?.some((allowPattern) =>
          importMatchesPattern(imp.path, allowPattern)
        );

        if (!isAllowed) {
          violations.push({
            rule,
            file: filePath,
            line: imp.line,
            message:
              rule.message ||
              `Import from '${imp.path}' is not allowed (rule: ${rule.id})`,
            violatingContent: imp.statement,
          });
        }
      }
    }
  }

  return violations;
}

/**
 * Check a file against require rules (patterns that must be present).
 */
function checkRequireRules(
  filePath: string,
  content: string,
  rule: ParsedRule
): RuleViolation[] {
  const violations: RuleViolation[] = [];

  if (!rule.require || rule.require.length === 0) {
    return violations;
  }

  for (const requiredPattern of rule.require) {
    const regex = new RegExp(requiredPattern);
    if (!regex.test(content)) {
      violations.push({
        rule,
        file: filePath,
        message:
          rule.message ||
          `Required pattern '${requiredPattern}' not found (rule: ${rule.id})`,
      });
    }
  }

  return violations;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Validator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate file content against a set of rules.
 */
export function validateContent(
  filePath: string,
  content: string,
  rules: ParsedRule[]
): SemanticValidationResult {
  const startTime = Date.now();
  const violations: RuleViolation[] = [];

  for (const rule of rules) {
    // Check import rules
    violations.push(...checkImportRules(filePath, content, rule));

    // Check require rules
    violations.push(...checkRequireRules(filePath, content, rule));
  }

  const duration = Date.now() - startTime;

  if (violations.length > 0) {
    debugLog(
      `[RuleValidator] Found ${violations.length} violation(s) in ${filePath}`
    );
  }

  return {
    success: violations.length === 0,
    violations,
    rulesChecked: rules.length,
    duration,
  };
}

/**
 * Format violations into readable feedback.
 */
export function formatViolationFeedback(
  result: SemanticValidationResult
): string {
  const lines: string[] = [];

  lines.push(`Semantic validation failed with ${result.violations.length} violation(s):\n`);

  for (const violation of result.violations.slice(0, 10)) {
    const location = violation.line
      ? `${violation.file}:${violation.line}`
      : violation.file;

    lines.push(`  ${location}`);
    lines.push(`    [${violation.rule.id}] ${violation.message}`);

    if (violation.violatingContent) {
      lines.push(`    > ${violation.violatingContent}`);
    }

    lines.push('');
  }

  if (result.violations.length > 10) {
    lines.push(`  ... and ${result.violations.length - 10} more violations`);
  }

  return lines.join('\n');
}
