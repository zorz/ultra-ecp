/**
 * Rule Parser
 *
 * Parses validation context files and extracts rules.
 */

import { debugLog } from '../../../debug.ts';
import type {
  ParsedRule,
  ValidationContext,
  ContextSection,
  ContextItem,
  CodeExample,
} from './types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Rule Block Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Regex to match ```rule:name blocks.
 * Captures: 1) rule name, 2) block content
 */
const RULE_BLOCK_REGEX = /```rule:([a-z0-9_-]+)\n([\s\S]*?)```/gi;

/**
 * Parse a rule block's YAML-like content.
 */
function parseRuleContent(
  ruleId: string,
  content: string,
  sourceFile: string,
  sourceLine: number
): ParsedRule {
  const rule: ParsedRule = {
    id: ruleId,
    sourceFile,
    sourceLine,
  };

  const lines = content.trim().split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Parse key: value or key:
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;

    const key = trimmed.slice(0, colonIndex).trim();
    let value = trimmed.slice(colonIndex + 1).trim();

    // Handle array values on same line: key: [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1);
    }

    switch (key) {
      case 'files':
        rule.files = parseArrayValue(value);
        break;
      case 'disallow-imports':
        rule.disallowImports = parseArrayValue(value);
        break;
      case 'allow-imports':
        rule.allowImports = parseArrayValue(value);
        break;
      case 'except-types':
        rule.exceptTypes = value.toLowerCase() === 'true';
        break;
      case 'require':
        rule.require = parseArrayValue(value);
        break;
      case 'message':
        rule.message = value.replace(/^["']|["']$/g, '');
        break;
      case 'severity':
        if (value === 'error' || value === 'warning') {
          rule.severity = value;
        }
        break;
    }
  }

  return rule;
}

/**
 * Parse a comma-separated or multi-line array value.
 */
function parseArrayValue(value: string): string[] {
  if (!value) return [];

  return value
    .split(/[,\n]/)
    .map((v) => v.trim().replace(/^["']|["']$/g, ''))
    .filter((v) => v.length > 0);
}

/**
 * Extract all rule blocks from markdown content.
 */
export function extractRules(
  content: string,
  sourceFile: string
): ParsedRule[] {
  const rules: ParsedRule[] = [];
  let match: RegExpExecArray | null;

  // Reset regex state
  RULE_BLOCK_REGEX.lastIndex = 0;

  while ((match = RULE_BLOCK_REGEX.exec(content)) !== null) {
    const ruleId = match[1] ?? 'unknown';
    const ruleContent = match[2] ?? '';

    // Calculate line number
    const beforeMatch = content.slice(0, match.index);
    const sourceLine = beforeMatch.split('\n').length;

    try {
      const rule = parseRuleContent(ruleId, ruleContent, sourceFile, sourceLine);
      rules.push(rule);
      debugLog(`[RuleParser] Parsed rule: ${ruleId} from ${sourceFile}:${sourceLine}`);
    } catch (error) {
      debugLog(`[RuleParser] Failed to parse rule ${ruleId}: ${error}`);
    }
  }

  return rules;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Regex to match headings.
 */
const HEADING_REGEX = /^(#{1,6})\s+(.+)$/;

/**
 * Regex to match named items (### `name`).
 */
const NAMED_ITEM_REGEX = /^(#{1,6})\s+`([a-z0-9_-]+)`$/i;

/**
 * Regex to match code blocks.
 */
const CODE_BLOCK_REGEX = /```(\w*)\n([\s\S]*?)```/g;

/**
 * Parse sections from markdown content.
 */
export function extractSections(content: string): ContextSection[] {
  const sections: ContextSection[] = [];
  const lines = content.split('\n');

  let currentSection: ContextSection | null = null;
  let currentItem: ContextItem | null = null;
  let contentBuffer: string[] = [];

  const flushContent = () => {
    if (currentItem && contentBuffer.length > 0) {
      const itemContent = contentBuffer.join('\n');
      currentItem.description = extractDescription(itemContent);
      currentItem.codeExamples = extractCodeExamples(itemContent);
    } else if (currentSection && contentBuffer.length > 0) {
      currentSection.content += contentBuffer.join('\n') + '\n';
    }
    contentBuffer = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(HEADING_REGEX);

    if (headingMatch) {
      flushContent();

      const level = (headingMatch[1] ?? '#').length;
      const headingText = headingMatch[2] ?? '';

      // Check if this is a named item
      const namedMatch = line.match(NAMED_ITEM_REGEX);

      if (namedMatch && currentSection) {
        // This is a named item within a section
        currentItem = {
          name: namedMatch[2] ?? '',
          description: '',
          codeExamples: [],
        };
        currentSection.items.push(currentItem);
      } else {
        // This is a new section
        if (currentSection) {
          sections.push(currentSection);
        }
        currentSection = {
          heading: headingText,
          level,
          content: '',
          items: [],
        };
        currentItem = null;
      }
    } else {
      contentBuffer.push(line);
    }
  }

  // Flush remaining content
  flushContent();
  if (currentSection) {
    sections.push(currentSection);
  }

  return sections;
}

/**
 * Extract plain text description from markdown (before first code block).
 */
function extractDescription(content: string): string {
  const codeBlockStart = content.indexOf('```');
  const text = codeBlockStart >= 0 ? content.slice(0, codeBlockStart) : content;
  return text.trim();
}

/**
 * Extract code examples from markdown.
 */
function extractCodeExamples(content: string): CodeExample[] {
  const examples: CodeExample[] = [];
  let match: RegExpExecArray | null;

  CODE_BLOCK_REGEX.lastIndex = 0;

  while ((match = CODE_BLOCK_REGEX.exec(content)) !== null) {
    const lang = match[1] ?? '';
    const code = match[2] ?? '';

    // Skip rule blocks
    if (lang.startsWith('rule:')) continue;

    const example: CodeExample = {
      language: lang || 'text',
      code: code.trim(),
    };

    // Check for good/bad markers in surrounding text
    const before = content.slice(Math.max(0, match.index - 50), match.index);
    if (/good|correct|do this/i.test(before)) {
      example.type = 'good';
    } else if (/bad|avoid|don't|wrong/i.test(before)) {
      example.type = 'bad';
    }

    examples.push(example);
  }

  return examples;
}

// ─────────────────────────────────────────────────────────────────────────────
// Full Context Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a complete validation context file.
 */
export function parseValidationContext(
  path: string,
  content: string
): ValidationContext {
  return {
    path,
    content,
    rules: extractRules(content, path),
    sections: extractSections(content),
  };
}
