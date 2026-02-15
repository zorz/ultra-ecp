/**
 * Rule Loader
 *
 * Loads validation rules hierarchically based on file paths.
 */

import { debugLog } from '../../../debug.ts';
import { parseValidationContext } from './parser.ts';
import type {
  ValidationContext,
  RuleHierarchy,
  ParsedRule,
} from './types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cache for loaded context files.
 * Key is absolute path to context file.
 */
const contextCache = new Map<string, ValidationContext>();

/**
 * Cache for file modification times (for invalidation).
 */
const mtimeCache = new Map<string, number>();

/**
 * Clear the rule cache.
 */
export function clearRuleCache(): void {
  contextCache.clear();
  mtimeCache.clear();
  debugLog('[RuleLoader] Cache cleared');
}

// ─────────────────────────────────────────────────────────────────────────────
// Path Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the validation directory path.
 */
function getValidationDir(workspaceRoot: string): string {
  return `${workspaceRoot}/validation`;
}

/**
 * Get context file paths for a given source file.
 *
 * For a file at src/services/ai/provider.ts, returns:
 * - validation/context.md (root)
 * - validation/src/context.md
 * - validation/src/services/context.md
 * - validation/src/services/ai/context.md
 * - validation/src/services/ai/provider.md (file-specific, if exists)
 */
export function getContextPathsForFile(
  filePath: string,
  workspaceRoot: string
): string[] {
  const validationDir = getValidationDir(workspaceRoot);
  const paths: string[] = [];

  // Always include root context
  paths.push(`${validationDir}/context.md`);

  // Get relative path from workspace root
  let relativePath = filePath;
  if (filePath.startsWith(workspaceRoot)) {
    relativePath = filePath.slice(workspaceRoot.length);
    if (relativePath.startsWith('/')) {
      relativePath = relativePath.slice(1);
    }
  }

  // Build hierarchy paths
  const parts = relativePath.split('/');
  let currentPath = validationDir;

  for (let i = 0; i < parts.length - 1; i++) {
    currentPath += '/' + parts[i];
    paths.push(`${currentPath}/context.md`);
  }

  // Add file-specific context if it's not a context.md itself
  const fileName = parts[parts.length - 1];
  if (fileName && !fileName.endsWith('.md')) {
    const baseName = fileName.replace(/\.[^.]+$/, '');
    paths.push(`${currentPath}/${baseName}.md`);
  }

  return paths;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load a single context file.
 * Uses cache with mtime invalidation.
 */
async function loadContextFile(
  path: string
): Promise<ValidationContext | null> {
  try {
    const file = Bun.file(path);

    // Check if file exists
    if (!(await file.exists())) {
      return null;
    }

    // Check cache
    const stat = await file.stat();
    const mtime = stat?.mtime?.getTime() ?? 0;
    const cachedMtime = mtimeCache.get(path);

    if (cachedMtime === mtime && contextCache.has(path)) {
      return contextCache.get(path)!;
    }

    // Load and parse
    const content = await file.text();
    const context = parseValidationContext(path, content);

    // Update cache
    contextCache.set(path, context);
    mtimeCache.set(path, mtime);

    debugLog(`[RuleLoader] Loaded context: ${path} (${context.rules.length} rules)`);

    return context;
  } catch (error) {
    debugLog(`[RuleLoader] Error loading ${path}: ${error}`);
    return null;
  }
}

/**
 * Load rule hierarchy for a file.
 */
export async function loadRuleHierarchy(
  filePath: string,
  workspaceRoot: string
): Promise<RuleHierarchy> {
  const contextPaths = getContextPathsForFile(filePath, workspaceRoot);
  const contexts: ValidationContext[] = [];
  const allRules: ParsedRule[] = [];
  const contentParts: string[] = [];

  for (const contextPath of contextPaths) {
    const context = await loadContextFile(contextPath);
    if (context) {
      contexts.push(context);
      allRules.push(...context.rules);
      contentParts.push(`<!-- From: ${contextPath} -->\n${context.content}`);
    }
  }

  // Merge rules (later rules can override earlier by ID)
  const mergedRules = mergeRules(allRules);

  return {
    targetPath: filePath,
    contexts,
    rules: mergedRules,
    combinedContext: contentParts.join('\n\n---\n\n'),
  };
}

/**
 * Merge rules, with later rules overriding earlier ones by ID.
 */
function mergeRules(rules: ParsedRule[]): ParsedRule[] {
  const ruleMap = new Map<string, ParsedRule>();

  for (const rule of rules) {
    ruleMap.set(rule.id, rule);
  }

  return Array.from(ruleMap.values());
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule Matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get rules that apply to a specific file.
 */
export function getRulesForFile(
  filePath: string,
  rules: ParsedRule[]
): ParsedRule[] {
  return rules.filter((rule) => {
    // If no files pattern, rule applies to all files
    if (!rule.files || rule.files.length === 0) {
      return true;
    }

    // Check if file matches any pattern
    return rule.files.some((pattern) => matchesGlob(filePath, pattern));
  });
}

/**
 * Simple glob matching.
 */
function matchesGlob(filePath: string, pattern: string): boolean {
  // Normalize path separators
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');

  // Convert glob to regex
  const regexPattern = normalizedPattern
    .replace(/\*\*/g, '{{DOUBLE_STAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/{{DOUBLE_STAR}}/g, '.*')
    .replace(/\?/g, '.');

  const regex = new RegExp(`(^|/)${regexPattern}$`);
  return regex.test(normalizedPath);
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

export { parseValidationContext } from './parser.ts';
