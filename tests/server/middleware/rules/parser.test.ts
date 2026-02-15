/**
 * Rule Parser Unit Tests
 */

import { describe, test, expect } from 'bun:test';
import {
  extractRules,
  extractSections,
  parseValidationContext,
} from '../../../../src/server/middleware/rules/parser.ts';

// ─────────────────────────────────────────────────────────────────────────────
// extractRules
// ─────────────────────────────────────────────────────────────────────────────

describe('extractRules', () => {
  describe('basic parsing', () => {
    test('extracts single rule from markdown', () => {
      const content = `
# Test Rules

\`\`\`rule:no-console
files: src/**/*.ts
disallow-imports: console
message: "Don't use console in production code"
severity: error
\`\`\`
`;

      const rules = extractRules(content, 'test.md');

      expect(rules).toHaveLength(1);
      expect(rules[0]!.id).toBe('no-console');
      expect(rules[0]!.files).toEqual(['src/**/*.ts']);
      expect(rules[0]!.message).toBe("Don't use console in production code");
      expect(rules[0]!.severity).toBe('error');
    });

    test('extracts multiple rules', () => {
      const content = `
\`\`\`rule:rule-one
files: src/*.ts
message: "Rule one"
\`\`\`

Some text between rules.

\`\`\`rule:rule-two
files: lib/*.ts
message: "Rule two"
\`\`\`
`;

      const rules = extractRules(content, 'test.md');

      expect(rules).toHaveLength(2);
      expect(rules[0]!.id).toBe('rule-one');
      expect(rules[1]!.id).toBe('rule-two');
    });

    test('handles empty content', () => {
      const rules = extractRules('', 'test.md');
      expect(rules).toEqual([]);
    });

    test('handles content with no rules', () => {
      const content = `
# Some Document

This has no rule blocks.

\`\`\`javascript
const x = 1;
\`\`\`
`;

      const rules = extractRules(content, 'test.md');
      expect(rules).toEqual([]);
    });
  });

  describe('rule properties', () => {
    test('parses files array', () => {
      const content = `
\`\`\`rule:test
files: src/**/*.ts, lib/**/*.ts
\`\`\`
`;

      const rules = extractRules(content, 'test.md');
      expect(rules[0]!.files).toEqual(['src/**/*.ts', 'lib/**/*.ts']);
    });

    test('parses disallow-imports', () => {
      const content = `
\`\`\`rule:no-store
files: components/**/*.tsx
disallow-imports: **/stores/*, **/state/*
message: "Components cannot import stores directly"
\`\`\`
`;

      const rules = extractRules(content, 'test.md');
      expect(rules[0]!.disallowImports).toEqual(['**/stores/*', '**/state/*']);
    });

    test('parses allow-imports', () => {
      const content = `
\`\`\`rule:limited-store
files: containers/**/*.tsx
disallow-imports: **/stores/*
allow-imports: **/stores/uiStore
message: "Only uiStore is allowed"
\`\`\`
`;

      const rules = extractRules(content, 'test.md');
      expect(rules[0]!.allowImports).toEqual(['**/stores/uiStore']);
    });

    test('parses except-types: true', () => {
      const content = `
\`\`\`rule:no-store-values
files: types/**/*.ts
disallow-imports: **/stores/*
except-types: true
message: "Type imports are allowed"
\`\`\`
`;

      const rules = extractRules(content, 'test.md');
      expect(rules[0]!.exceptTypes).toBe(true);
    });

    test('parses except-types: false', () => {
      const content = `
\`\`\`rule:strict
disallow-imports: **/stores/*
except-types: false
\`\`\`
`;

      const rules = extractRules(content, 'test.md');
      expect(rules[0]!.exceptTypes).toBe(false);
    });

    test('parses require pattern', () => {
      const content = `
\`\`\`rule:require-props
files: **/*.tsx
require: interface.*Props
message: "Components must have Props interface"
\`\`\`
`;

      const rules = extractRules(content, 'test.md');
      expect(rules[0]!.require).toEqual(['interface.*Props']);
    });

    test('parses severity: error', () => {
      const content = `
\`\`\`rule:test
severity: error
\`\`\`
`;

      const rules = extractRules(content, 'test.md');
      expect(rules[0]!.severity).toBe('error');
    });

    test('parses severity: warning', () => {
      const content = `
\`\`\`rule:test
severity: warning
\`\`\`
`;

      const rules = extractRules(content, 'test.md');
      expect(rules[0]!.severity).toBe('warning');
    });

    test('ignores invalid severity', () => {
      const content = `
\`\`\`rule:test
severity: invalid
\`\`\`
`;

      const rules = extractRules(content, 'test.md');
      expect(rules[0]!.severity).toBeUndefined();
    });
  });

  describe('source tracking', () => {
    test('tracks source file', () => {
      const content = `
\`\`\`rule:test
files: *.ts
\`\`\`
`;

      const rules = extractRules(content, '/path/to/rules.md');
      expect(rules[0]!.sourceFile).toBe('/path/to/rules.md');
    });

    test('tracks source line', () => {
      const content = `Line 1
Line 2
\`\`\`rule:test-rule
files: *.ts
\`\`\`
`;

      const rules = extractRules(content, 'test.md');
      expect(rules[0]!.sourceLine).toBe(3);
    });

    test('tracks source line for multiple rules', () => {
      const content = `
\`\`\`rule:first
\`\`\`

More content here
And more

\`\`\`rule:second
\`\`\`
`;

      const rules = extractRules(content, 'test.md');
      expect(rules[0]!.sourceLine).toBe(2);
      expect(rules[1]!.sourceLine).toBe(8);
    });
  });

  describe('edge cases', () => {
    test('handles rule with no properties', () => {
      const content = `
\`\`\`rule:empty
\`\`\`
`;

      const rules = extractRules(content, 'test.md');
      expect(rules).toHaveLength(1);
      expect(rules[0]!.id).toBe('empty');
    });

    test('handles comments in rule block', () => {
      const content = `
\`\`\`rule:with-comments
# This is a comment
files: src/*.ts
# Another comment
message: "Test"
\`\`\`
`;

      const rules = extractRules(content, 'test.md');
      expect(rules[0]!.files).toEqual(['src/*.ts']);
      expect(rules[0]!.message).toBe('Test');
    });

    test('handles quoted message values', () => {
      const content = `
\`\`\`rule:quoted
message: "Message with: colons"
\`\`\`
`;

      const rules = extractRules(content, 'test.md');
      expect(rules[0]!.message).toBe('Message with: colons');
    });

    test('handles array values in brackets', () => {
      const content = `
\`\`\`rule:bracketed
files: [src/*.ts, lib/*.ts]
\`\`\`
`;

      const rules = extractRules(content, 'test.md');
      expect(rules[0]!.files).toEqual(['src/*.ts', 'lib/*.ts']);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractSections
// ─────────────────────────────────────────────────────────────────────────────

describe('extractSections', () => {
  test('extracts sections with headings', () => {
    const content = `
# Main Title

Some intro text.

## Section One

Content for section one.

## Section Two

Content for section two.
`;

    const sections = extractSections(content);

    expect(sections.length).toBeGreaterThanOrEqual(2);
    expect(sections.some((s) => s.heading === 'Section One')).toBe(true);
    expect(sections.some((s) => s.heading === 'Section Two')).toBe(true);
  });

  test('tracks heading levels', () => {
    const content = `
# Level 1

## Level 2

### Level 3
`;

    const sections = extractSections(content);
    const level1 = sections.find((s) => s.heading === 'Level 1');
    const level2 = sections.find((s) => s.heading === 'Level 2');
    const level3 = sections.find((s) => s.heading === 'Level 3');

    expect(level1?.level).toBe(1);
    expect(level2?.level).toBe(2);
    expect(level3?.level).toBe(3);
  });

  test('extracts named items', () => {
    const content = `
## Patterns

### \`pattern-one\`
Description of pattern one.

### \`pattern-two\`
Description of pattern two.
`;

    const sections = extractSections(content);
    const patternsSection = sections.find((s) => s.heading === 'Patterns');

    expect(patternsSection).toBeDefined();
    expect(patternsSection!.items).toHaveLength(2);
    expect(patternsSection!.items[0]!.name).toBe('pattern-one');
    expect(patternsSection!.items[1]!.name).toBe('pattern-two');
  });

  test('extracts item descriptions', () => {
    const content = `
## Items

### \`my-item\`
This is the description.
It can span multiple lines.
`;

    const sections = extractSections(content);
    const section = sections.find((s) => s.heading === 'Items');
    const item = section?.items[0];

    expect(item?.description).toContain('This is the description');
  });

  test('handles empty sections', () => {
    const content = `
## Empty Section

## Next Section

Content here.
`;

    const sections = extractSections(content);
    expect(sections.some((s) => s.heading === 'Empty Section')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseValidationContext
// ─────────────────────────────────────────────────────────────────────────────

describe('parseValidationContext', () => {
  test('parses complete context file', () => {
    const content = `
# Test Context

## Rules

\`\`\`rule:test-rule
files: *.ts
message: "Test message"
\`\`\`

## Patterns

### \`my-pattern\`
This is a pattern description.
`;

    const ctx = parseValidationContext('/test/context.md', content);

    expect(ctx.path).toBe('/test/context.md');
    expect(ctx.content).toBe(content);
    expect(ctx.rules).toHaveLength(1);
    expect(ctx.sections.length).toBeGreaterThan(0);
  });

  test('includes raw content', () => {
    const content = '# Test\n\nSome content.';
    const ctx = parseValidationContext('/test.md', content);

    expect(ctx.content).toBe(content);
  });

  test('handles file with only rules', () => {
    const content = `
\`\`\`rule:only-rule
files: *.ts
\`\`\`
`;

    const ctx = parseValidationContext('/rules.md', content);
    expect(ctx.rules).toHaveLength(1);
  });

  test('handles file with no rules', () => {
    const content = `
# Documentation

Just regular markdown.
`;

    const ctx = parseValidationContext('/docs.md', content);
    expect(ctx.rules).toEqual([]);
  });
});
