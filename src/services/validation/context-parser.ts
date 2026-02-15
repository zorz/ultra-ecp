/**
 * Context Parser
 *
 * Parses markdown context files into structured validation rules.
 * Supports patterns, anti-patterns, conventions, and override directives.
 */

import type {
  ParsedContext,
  Pattern,
  AntiPattern,
  Convention,
  Override,
} from './types.ts';

/**
 * Section types in context files.
 */
type SectionType =
  | 'patterns'
  | 'antiPatterns'
  | 'conventions'
  | 'architecture'
  | 'overrides'
  | 'examples'
  | null;

/**
 * Parser state for tracking current section and item.
 */
interface ParserState {
  currentSection: SectionType;
  currentItem: string[];
  itemId: number;
  inCodeBlock: boolean;
  codeBlockContent: string[];
}

/**
 * Parse a markdown context file into structured data.
 */
export function parseContextFile(content: string, source: string): ParsedContext {
  const parsed: ParsedContext = {
    patterns: [],
    antiPatterns: [],
    conventions: [],
    architectureNotes: '',
    overrides: [],
    source,
  };

  const state: ParserState = {
    currentSection: null,
    currentItem: [],
    itemId: 0,
    inCodeBlock: false,
    codeBlockContent: [],
  };

  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Handle code blocks
    if (line.startsWith('```')) {
      if (state.inCodeBlock) {
        // End code block
        state.inCodeBlock = false;
        if (state.currentItem.length > 0) {
          state.currentItem.push('```' + state.codeBlockContent.join('\n') + '```');
        }
        state.codeBlockContent = [];
      } else {
        // Start code block
        state.inCodeBlock = true;
      }
      continue;
    }

    if (state.inCodeBlock) {
      state.codeBlockContent.push(line);
      continue;
    }

    // Check for section headers
    const headerMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headerMatch) {
      flushCurrentItem(state, parsed, source);
      state.currentSection = detectSectionType(headerMatch[2]!);
      continue;
    }

    // Check for override directives
    const overrideMatch = line.match(/@(extend|override|disable):\s*"([^"]+)"(?:\s+(.+))?/);
    if (overrideMatch) {
      flushCurrentItem(state, parsed, source);
      parsed.overrides.push({
        type: overrideMatch[1] as Override['type'],
        targetId: overrideMatch[2]!,
        newValue: overrideMatch[3]?.trim(),
        source,
      });
      continue;
    }

    // Check for new list item (starts with - or * or number.)
    if (line.match(/^[-*]\s+/) || line.match(/^\d+\.\s+/)) {
      flushCurrentItem(state, parsed, source);
      state.currentItem.push(line);
      continue;
    }

    // Continue current item or architecture section
    if (state.currentItem.length > 0) {
      // Multi-line item continuation (indented or empty line)
      if (line.trim() === '' || line.match(/^\s+/)) {
        state.currentItem.push(line);
      } else {
        // New paragraph in current section
        flushCurrentItem(state, parsed, source);
        if (state.currentSection === 'architecture') {
          state.currentItem.push(line);
        }
      }
    } else if (state.currentSection === 'architecture' && line.trim()) {
      state.currentItem.push(line);
    }
  }

  // Flush any remaining item
  flushCurrentItem(state, parsed, source);

  return parsed;
}

/**
 * Detect section type from header text.
 */
function detectSectionType(header: string): SectionType {
  const lower = header.toLowerCase();

  // Check anti-pattern first (before pattern)
  if (
    lower.includes('anti-pattern') ||
    lower.includes('antipattern') ||
    lower.includes('do not') ||
    lower.includes('don\'t') ||
    lower.includes('avoid')
  ) {
    return 'antiPatterns';
  }

  if (
    lower.includes('required pattern') ||
    lower.includes('pattern') ||
    lower.includes('best practice')
  ) {
    return 'patterns';
  }

  if (lower.includes('convention') || lower.includes('style')) {
    return 'conventions';
  }

  if (lower.includes('example')) {
    return 'examples';
  }

  if (lower.includes('override')) {
    return 'overrides';
  }

  if (
    lower.includes('architecture') ||
    lower.includes('overview') ||
    lower.includes('note') ||
    lower.includes('context') ||
    lower.includes('about')
  ) {
    return 'architecture';
  }

  // Default to architecture for unknown sections
  return 'architecture';
}

/**
 * Flush the current item to the appropriate collection.
 */
function flushCurrentItem(
  state: ParserState,
  parsed: ParsedContext,
  source: string
): void {
  if (state.currentItem.length === 0) return;

  const text = state.currentItem.join('\n').trim();
  if (!text) {
    state.currentItem = [];
    return;
  }

  state.itemId++;
  const id = generateItemId(source, state.itemId);

  switch (state.currentSection) {
    case 'patterns':
      parsed.patterns.push(parsePattern(id, text, source));
      break;

    case 'antiPatterns':
      parsed.antiPatterns.push(parseAntiPattern(id, text, source));
      break;

    case 'conventions':
      parsed.conventions.push(parseConvention(id, text, source));
      break;

    case 'architecture':
      if (parsed.architectureNotes) {
        parsed.architectureNotes += '\n\n' + text;
      } else {
        parsed.architectureNotes = text;
      }
      break;

    case 'examples':
      // Examples are attached to the previous pattern/anti-pattern
      attachExample(parsed, text);
      break;

    default:
      // Unknown section, treat as architecture notes
      if (parsed.architectureNotes) {
        parsed.architectureNotes += '\n\n' + text;
      } else {
        parsed.architectureNotes = text;
      }
  }

  state.currentItem = [];
}

/**
 * Parse a pattern from text.
 */
function parsePattern(id: string, text: string, source: string): Pattern {
  // Remove list marker
  let description = text.replace(/^[-*]\s*/, '').replace(/^\d+\.\s*/, '');

  // Extract code examples
  const examples: string[] = [];
  const codeBlockMatch = description.match(/```[\s\S]*?```/g);
  if (codeBlockMatch) {
    for (const block of codeBlockMatch) {
      examples.push(block.replace(/^```\w*\n?/, '').replace(/\n?```$/, ''));
      description = description.replace(block, '').trim();
    }
  }

  return {
    id,
    description: description.trim(),
    source,
    examples: examples.length > 0 ? examples : undefined,
  };
}

/**
 * Parse an anti-pattern from text.
 */
function parseAntiPattern(id: string, text: string, source: string): AntiPattern {
  // Remove list marker
  let cleanText = text.replace(/^[-*]\s*/, '').replace(/^\d+\.\s*/, '');

  // Try to parse pattern → alternative format
  // Patterns: `code` → `alternative`, code → alternative, code -- alternative

  // First try backtick-wrapped pattern (may have extra text before arrow)
  // e.g., `any` type → Use `unknown` and narrow
  const backtickMatch = cleanText.match(
    /^`([^`]+)`[^→\->—–]*(?:→|->|—|–|-{2,})\s*(.+)/s
  );

  if (backtickMatch) {
    const pattern = backtickMatch[1]!.trim();
    let rest = backtickMatch[2]!.trim();

    return parseAntiPatternRest(id, pattern, rest, source);
  }

  // Try non-backtick pattern → alternative format
  const arrowMatch = cleanText.match(
    /^([^→\->—–\n]+?)(?:\s*(?:→|->|—|–|-{2,})\s*)(.+)/s
  );

  if (arrowMatch) {
    const pattern = arrowMatch[1]!.trim();
    let rest = arrowMatch[2]!.trim();

    return parseAntiPatternRest(id, pattern, rest, source);
  }

  // Simple format without arrow - just a pattern to avoid
  return {
    id,
    pattern: cleanText.split('\n')[0]!.trim(),
    alternative: '(see context for alternatives)',
    reason: cleanText.split('\n').slice(1).join('\n').trim() || undefined,
    source,
  };
}

/**
 * Parse the rest of an anti-pattern (alternative and reason).
 */
function parseAntiPatternRest(
  id: string,
  pattern: string,
  rest: string,
  source: string
): AntiPattern {
  // Check for reason in parentheses or after a period
  let alternative = rest;
  let reason: string | undefined;

  // Pattern: alternative (reason)
  const parenMatch = rest.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (parenMatch) {
    alternative = parenMatch[1]!.trim();
    reason = parenMatch[2]!.trim();
  } else {
    // Pattern: alternative. Reason sentence.
    const periodMatch = rest.match(/^([^.]+)\.\s+(.+)$/);
    if (periodMatch) {
      alternative = periodMatch[1]!.trim();
      reason = periodMatch[2]!.trim();
    }
  }

  return {
    id,
    pattern,
    alternative: alternative.replace(/^`|`$/g, ''),
    reason,
    source,
  };
}

/**
 * Parse a convention from text.
 */
function parseConvention(id: string, text: string, source: string): Convention {
  // Remove list marker
  const description = text
    .replace(/^[-*]\s*/, '')
    .replace(/^\d+\.\s*/, '')
    .trim();

  return {
    id,
    description,
    source,
  };
}

/**
 * Attach an example to the most recent pattern or anti-pattern.
 */
function attachExample(parsed: ParsedContext, exampleText: string): void {
  // Try to attach to most recent pattern
  if (parsed.patterns.length > 0) {
    const pattern = parsed.patterns[parsed.patterns.length - 1]!;
    if (!pattern.examples) {
      pattern.examples = [];
    }
    pattern.examples.push(exampleText);
    return;
  }

  // Or attach to most recent anti-pattern as reason/context
  if (parsed.antiPatterns.length > 0) {
    const ap = parsed.antiPatterns[parsed.antiPatterns.length - 1]!;
    if (ap.reason) {
      ap.reason += '\n\n' + exampleText;
    } else {
      ap.reason = exampleText;
    }
  }
}

/**
 * Generate a unique item ID.
 */
function generateItemId(source: string, index: number): string {
  // Create a stable ID from source path and index
  const cleanSource = source.replace(/[/\\]/g, '-').replace(/\.md$/, '');
  return `${cleanSource}-${index}`;
}

/**
 * Extract all IDs from a parsed context (for override targeting).
 */
export function extractIds(context: ParsedContext): string[] {
  const ids: string[] = [];

  for (const p of context.patterns) {
    ids.push(p.id);
  }
  for (const ap of context.antiPatterns) {
    ids.push(ap.id);
  }
  for (const c of context.conventions) {
    ids.push(c.id);
  }

  return ids;
}

/**
 * Validate that override targets exist.
 * Checks both IDs and pattern descriptions.
 */
export function validateOverrides(
  context: ParsedContext,
  availableIds: string[]
): string[] {
  const errors: string[] = [];

  for (const override of context.overrides) {
    const targetLower = override.targetId.toLowerCase();

    // Check if target matches by ID
    const idMatch = availableIds.some(
      (id) =>
        id.includes(override.targetId) ||
        targetLower.includes(id.toLowerCase())
    );

    // Check if target matches by pattern description
    const descriptionMatch =
      context.patterns.some((p) =>
        p.description.toLowerCase().includes(targetLower)
      ) ||
      context.antiPatterns.some((ap) =>
        ap.pattern.toLowerCase().includes(targetLower)
      ) ||
      context.conventions.some((c) =>
        c.description.toLowerCase().includes(targetLower)
      );

    if (!idMatch && !descriptionMatch) {
      errors.push(
        `Override target "${override.targetId}" in ${context.source} does not match any known pattern`
      );
    }
  }

  return errors;
}
