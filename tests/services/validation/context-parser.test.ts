/**
 * Context Parser Unit Tests
 *
 * Tests for markdown context file parsing.
 */

import { describe, it, expect } from 'bun:test';
import {
  parseContextFile,
  extractIds,
  validateOverrides,
} from '../../../src/services/validation/context-parser.ts';

describe('parseContextFile', () => {
  describe('patterns section', () => {
    it('should parse simple patterns', () => {
      const content = `# Patterns

## Required Patterns

- Use Result type for errors
- Always handle async errors
- Prefer const over let
`;

      const parsed = parseContextFile(content, 'test.md');

      expect(parsed.patterns.length).toBe(3);
      expect(parsed.patterns[0]?.description).toBe('Use Result type for errors');
      expect(parsed.patterns[1]?.description).toBe('Always handle async errors');
      expect(parsed.patterns[2]?.description).toBe('Prefer const over let');
    });

    it('should parse patterns with best practices header', () => {
      const content = `# Best Practices

- Use meaningful variable names
- Write unit tests
`;

      const parsed = parseContextFile(content, 'test.md');

      expect(parsed.patterns.length).toBe(2);
    });

    it('should parse patterns with code examples', () => {
      const content = `# Patterns

- Use Result type for errors
\`\`\`typescript
const result: Result<T, Error> = await operation();
\`\`\`
`;

      const parsed = parseContextFile(content, 'test.md');

      expect(parsed.patterns.length).toBe(1);
      expect(parsed.patterns[0]?.examples).toBeDefined();
      expect(parsed.patterns[0]?.examples?.[0]).toContain('Result<T, Error>');
    });
  });

  describe('anti-patterns section', () => {
    it('should parse anti-patterns with arrow format', () => {
      const content = `# Anti-Patterns

- \`console.log\` → Use \`debugLog\` instead
- \`any\` type → Use \`unknown\` and narrow
`;

      const parsed = parseContextFile(content, 'test.md');

      expect(parsed.antiPatterns.length).toBe(2);
      expect(parsed.antiPatterns[0]?.pattern).toBe('console.log');
      expect(parsed.antiPatterns[0]?.alternative).toBe('Use `debugLog` instead');
      expect(parsed.antiPatterns[1]?.pattern).toBe('any');
    });

    it('should parse anti-patterns with dash separator', () => {
      const content = `# Avoid

- var -- use const or let
- eval() -- security risk
`;

      const parsed = parseContextFile(content, 'test.md');

      expect(parsed.antiPatterns.length).toBe(2);
      expect(parsed.antiPatterns[0]?.pattern).toBe('var');
      expect(parsed.antiPatterns[0]?.alternative).toBe('use const or let');
    });

    it('should parse anti-patterns with reason', () => {
      const content = `# Do Not Use

- console.log → debugLog (maintains consistency)
`;

      const parsed = parseContextFile(content, 'test.md');

      expect(parsed.antiPatterns.length).toBe(1);
      expect(parsed.antiPatterns[0]?.pattern).toBe('console.log');
      expect(parsed.antiPatterns[0]?.alternative).toBe('debugLog');
      expect(parsed.antiPatterns[0]?.reason).toBe('maintains consistency');
    });

    it('should parse simple anti-patterns without alternative', () => {
      const content = `# Avoid

- Using magic numbers
- Global mutable state
`;

      const parsed = parseContextFile(content, 'test.md');

      expect(parsed.antiPatterns.length).toBe(2);
      expect(parsed.antiPatterns[0]?.pattern).toBe('Using magic numbers');
      expect(parsed.antiPatterns[0]?.alternative).toContain('see context');
    });
  });

  describe('conventions section', () => {
    it('should parse conventions', () => {
      const content = `# Conventions

- File names: kebab-case
- Class names: PascalCase
- Use explicit exports
`;

      const parsed = parseContextFile(content, 'test.md');

      expect(parsed.conventions.length).toBe(3);
      expect(parsed.conventions[0]?.description).toBe('File names: kebab-case');
    });

    it('should parse style section as conventions', () => {
      const content = `# Style Guide

- Use 2-space indentation
- No trailing whitespace
`;

      const parsed = parseContextFile(content, 'test.md');

      expect(parsed.conventions.length).toBe(2);
    });
  });

  describe('architecture notes', () => {
    it('should parse architecture section', () => {
      const content = `# Architecture Notes

This module handles user authentication.
It uses JWT tokens for session management.

The auth flow is:
1. User submits credentials
2. Server validates and returns token
3. Client stores token for future requests
`;

      const parsed = parseContextFile(content, 'test.md');

      expect(parsed.architectureNotes).toContain('authentication');
      expect(parsed.architectureNotes).toContain('JWT');
      expect(parsed.architectureNotes).toContain('auth flow');
    });

    it('should parse overview section as architecture', () => {
      const content = `# Overview

This is the main entry point for the application.
`;

      const parsed = parseContextFile(content, 'test.md');

      expect(parsed.architectureNotes).toContain('main entry point');
    });

    it('should parse context section as architecture', () => {
      const content = `# Context

This file was refactored from legacy code.
`;

      const parsed = parseContextFile(content, 'test.md');

      expect(parsed.architectureNotes).toContain('refactored');
    });
  });

  describe('override directives', () => {
    it('should parse @extend directive', () => {
      const content = `# Overrides

@extend: "Error handling"
Additionally, all errors must include correlation IDs.
`;

      const parsed = parseContextFile(content, 'test.md');

      expect(parsed.overrides.length).toBe(1);
      expect(parsed.overrides[0]?.type).toBe('extend');
      expect(parsed.overrides[0]?.targetId).toBe('Error handling');
    });

    it('should parse @override directive', () => {
      const content = `# Overrides

@override: "Logging" Use structured logging via logger.ts
`;

      const parsed = parseContextFile(content, 'test.md');

      expect(parsed.overrides.length).toBe(1);
      expect(parsed.overrides[0]?.type).toBe('override');
      expect(parsed.overrides[0]?.targetId).toBe('Logging');
      expect(parsed.overrides[0]?.newValue).toBe('Use structured logging via logger.ts');
    });

    it('should parse @disable directive', () => {
      const content = `@disable: "No console.log"
`;

      const parsed = parseContextFile(content, 'test.md');

      expect(parsed.overrides.length).toBe(1);
      expect(parsed.overrides[0]?.type).toBe('disable');
      expect(parsed.overrides[0]?.targetId).toBe('No console.log');
    });

    it('should parse multiple override directives', () => {
      const content = `# Overrides

@extend: "Error handling"
@override: "Logging"
@disable: "No console.log"
`;

      const parsed = parseContextFile(content, 'test.md');

      expect(parsed.overrides.length).toBe(3);
    });
  });

  describe('numbered lists', () => {
    it('should parse numbered lists', () => {
      const content = `# Patterns

1. First pattern
2. Second pattern
3. Third pattern
`;

      const parsed = parseContextFile(content, 'test.md');

      expect(parsed.patterns.length).toBe(3);
      expect(parsed.patterns[0]?.description).toBe('First pattern');
    });
  });

  describe('mixed content', () => {
    it('should parse a complete context file', () => {
      const content = `# Ultra IDE Patterns

## Overview

This module handles the main editor functionality.

## Required Patterns

- Use Result type for errors
- Always handle async errors

## Anti-Patterns (DO NOT USE)

- \`console.log()\` → Use \`debugLog()\`
- \`any\` type → Use \`unknown\`

## Conventions

- File names: kebab-case
- Class names: PascalCase

## Overrides

@extend: "Error handling"
Add correlation IDs to all errors.
`;

      const parsed = parseContextFile(content, 'test.md');

      expect(parsed.patterns.length).toBe(2);
      expect(parsed.antiPatterns.length).toBe(2);
      expect(parsed.conventions.length).toBe(2);
      expect(parsed.architectureNotes).toContain('editor functionality');
      expect(parsed.overrides.length).toBe(1);
    });
  });

  describe('source tracking', () => {
    it('should track source file in patterns', () => {
      const content = `# Patterns

- Test pattern
`;

      const parsed = parseContextFile(content, 'src/context.md');

      expect(parsed.source).toBe('src/context.md');
      expect(parsed.patterns[0]?.source).toBe('src/context.md');
    });

    it('should generate unique IDs', () => {
      const content = `# Patterns

- Pattern one
- Pattern two
`;

      const parsed = parseContextFile(content, 'test.md');

      expect(parsed.patterns[0]?.id).not.toBe(parsed.patterns[1]?.id);
    });
  });
});

describe('extractIds', () => {
  it('should extract all IDs from a parsed context', () => {
    const content = `# Patterns

- Pattern one
- Pattern two

## Anti-Patterns

- Bad thing → Good thing

## Conventions

- Convention one
`;

    const parsed = parseContextFile(content, 'test.md');
    const ids = extractIds(parsed);

    expect(ids.length).toBe(4);
  });
});

describe('validateOverrides', () => {
  it('should return empty array when overrides are valid', () => {
    const context = parseContextFile(`
# Patterns

- Use Result type

@disable: "Result type"
`, 'test.md');

    const errors = validateOverrides(context, ['test-md-1']);

    expect(errors.length).toBe(0);
  });

  it('should return errors for invalid override targets', () => {
    const context = parseContextFile(`
@disable: "NonexistentPattern"
`, 'test.md');

    const errors = validateOverrides(context, []);

    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('NonexistentPattern');
  });
});
