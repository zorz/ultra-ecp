/**
 * Semantic Rule Types
 *
 * Types for validation rules loaded from validation/*.md files.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Rule Definitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A parsed rule from a ```rule:name``` block.
 */
export interface ParsedRule {
  /** Rule identifier (from ```rule:name```) */
  id: string;

  /** File glob patterns this rule applies to */
  files?: string[];

  /** Import patterns to disallow */
  disallowImports?: string[];

  /** Import patterns to allow (overrides disallow) */
  allowImports?: string[];

  /** Whether to allow type-only imports from disallowed patterns */
  exceptTypes?: boolean;

  /** Patterns that must be present */
  require?: string[];

  /** Custom message when rule is violated */
  message?: string;

  /** Rule severity */
  severity?: 'error' | 'warning';

  /** Source file this rule came from */
  sourceFile: string;

  /** Line number in source file */
  sourceLine: number;
}

/**
 * A validation context file with its content and parsed rules.
 */
export interface ValidationContext {
  /** Path to the context file */
  path: string;

  /** Raw markdown content */
  content: string;

  /** Parsed rules from ```rule:``` blocks */
  rules: ParsedRule[];

  /** Section headings and their content (for AI context) */
  sections: ContextSection[];
}

/**
 * A section from a context file.
 */
export interface ContextSection {
  /** Section heading */
  heading: string;

  /** Heading level (1-6) */
  level: number;

  /** Section content (markdown) */
  content: string;

  /** Named items in this section (patterns, anti-patterns, conventions) */
  items: ContextItem[];
}

/**
 * A named item within a section (e.g., ### `result-type`).
 */
export interface ContextItem {
  /** Item name (from backticks in heading) */
  name: string;

  /** Item description */
  description: string;

  /** Code examples */
  codeExamples: CodeExample[];
}

/**
 * A code example from a context file.
 */
export interface CodeExample {
  /** Language identifier */
  language: string;

  /** Code content */
  code: string;

  /** Whether this is a "good" or "bad" example */
  type?: 'good' | 'bad' | 'neutral';
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule Hierarchy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hierarchical rules for a file path.
 *
 * Rules are loaded from most general to most specific:
 * validation/context.md → validation/src/context.md → validation/src/services/context.md
 */
export interface RuleHierarchy {
  /** The file path these rules apply to */
  targetPath: string;

  /** All applicable context files (most general first) */
  contexts: ValidationContext[];

  /** Merged rules (later rules override earlier) */
  rules: ParsedRule[];

  /** Combined markdown content for AI context injection */
  combinedContext: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule Violations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A rule violation found during validation.
 */
export interface RuleViolation {
  /** Rule that was violated */
  rule: ParsedRule;

  /** File where violation occurred */
  file: string;

  /** Line number (if applicable) */
  line?: number;

  /** Column number (if applicable) */
  column?: number;

  /** Description of the violation */
  message: string;

  /** The violating code/content (if applicable) */
  violatingContent?: string;
}

/**
 * Result from semantic rule validation.
 */
export interface SemanticValidationResult {
  /** Whether validation passed */
  success: boolean;

  /** Violations found */
  violations: RuleViolation[];

  /** Rules that were checked */
  rulesChecked: number;

  /** Time taken in milliseconds */
  duration: number;
}
