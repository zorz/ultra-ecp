/**
 * Validation Middleware Unit Tests
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  ValidationMiddleware,
  createValidationMiddleware,
} from '../../../src/server/middleware/validation-middleware.ts';
import { MiddlewareErrorCodes } from '../../../src/server/middleware/types.ts';
import { createTempWorkspace, type TempWorkspace } from '../../helpers/temp-workspace.ts';

// ─────────────────────────────────────────────────────────────────────────────
// ValidationMiddleware
// ─────────────────────────────────────────────────────────────────────────────

describe('ValidationMiddleware', () => {
  let middleware: ValidationMiddleware;

  beforeEach(() => {
    middleware = createValidationMiddleware();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Properties
  // ─────────────────────────────────────────────────────────────────────────

  describe('properties', () => {
    test('has correct name', () => {
      expect(middleware.name).toBe('validation');
    });

    test('has priority set', () => {
      expect(middleware.priority).toBe(50);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // appliesTo
  // ─────────────────────────────────────────────────────────────────────────

  describe('appliesTo', () => {
    test('returns true for file/write', () => {
      expect(middleware.appliesTo('file/write')).toBe(true);
    });

    test('returns true for file/edit', () => {
      expect(middleware.appliesTo('file/edit')).toBe(true);
    });

    test('returns true for document/save', () => {
      expect(middleware.appliesTo('document/save')).toBe(true);
    });

    test('returns false for file/read', () => {
      expect(middleware.appliesTo('file/read')).toBe(false);
    });

    test('returns false for file/exists', () => {
      expect(middleware.appliesTo('file/exists')).toBe(false);
    });

    test('returns false for chat/send', () => {
      expect(middleware.appliesTo('chat/send')).toBe(false);
    });

    test('returns false for unknown methods', () => {
      expect(middleware.appliesTo('unknown/method')).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // validate - Basic
  // ─────────────────────────────────────────────────────────────────────────

  describe('validate - basic', () => {
    let workspace: TempWorkspace;

    beforeEach(async () => {
      workspace = await createTempWorkspace();
      await middleware.init(workspace.path);
    });

    afterEach(async () => {
      await workspace.cleanup();
    });

    test('allows request with no files', async () => {
      const result = await middleware.validate({
        method: 'file/write',
        params: {},
        workspaceRoot: workspace.path,
        metadata: {},
      });

      expect(result.allowed).toBe(true);
    });

    test('allows request when no linter detected', async () => {
      await workspace.writeFile('test.ts', 'const x = 1;');

      const result = await middleware.validate({
        method: 'file/write',
        params: { path: `${workspace.path}/test.ts` },
        workspaceRoot: workspace.path,
        metadata: {},
      });

      expect(result.allowed).toBe(true);
    });

    test('extracts path from file/write params', async () => {
      const result = await middleware.validate({
        method: 'file/write',
        params: { path: '/some/path/file.ts' },
        workspaceRoot: workspace.path,
        metadata: {},
      });

      // Should not fail even if file doesn't exist (no linter)
      expect(result.allowed).toBe(true);
    });

    test('extracts uri from document/save params', async () => {
      const result = await middleware.validate({
        method: 'document/save',
        params: { uri: 'file:///some/path/file.ts' },
        workspaceRoot: workspace.path,
        metadata: {},
      });

      expect(result.allowed).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // validate - Semantic Rules
  // ─────────────────────────────────────────────────────────────────────────

  describe('validate - semantic rules', () => {
    let workspace: TempWorkspace;

    beforeEach(async () => {
      workspace = await createTempWorkspace();
    });

    afterEach(async () => {
      await workspace.cleanup();
    });

    test('blocks file violating import rules', async () => {
      // Set up validation rules - use ** to match any path
      await workspace.mkdir('validation');
      await workspace.writeFile(
        'validation/context.md',
        `
# Rules

\`\`\`rule:no-internal
disallow-imports: **/internal/*
message: "Cannot import from internal modules"
severity: error
\`\`\`
`
      );

      // Create violating file
      await workspace.mkdir('src');
      await workspace.writeFile(
        'src/component.ts',
        `import { secret } from '../internal/secrets';
export const x = secret;`
      );

      // Initialize middleware with fresh instance to load rules
      middleware = createValidationMiddleware();
      await middleware.init(workspace.path);

      const result = await middleware.validate({
        method: 'file/write',
        params: { path: `${workspace.path}/src/component.ts` },
        workspaceRoot: workspace.path,
        metadata: {},
      });

      expect(result.allowed).toBe(false);
      expect(result.feedback).toContain('internal');
      expect((result.errorData as { code: number })?.code).toBe(MiddlewareErrorCodes.RuleViolation);
    });

    test('allows file passing all rules', async () => {
      // Set up validation rules
      await workspace.mkdir('validation/src');
      await workspace.writeFile(
        'validation/src/context.md',
        `
\`\`\`rule:no-internal
files: src/**/*.ts
disallow-imports: **/internal/*
message: "Cannot import from internal modules"
\`\`\`
`
      );

      // Create valid file
      await workspace.mkdir('src');
      await workspace.writeFile(
        'src/component.ts',
        `
import { util } from './utils';
export const x = util;
`
      );

      await middleware.init(workspace.path);

      const result = await middleware.validate({
        method: 'file/write',
        params: { path: `${workspace.path}/src/component.ts` },
        workspaceRoot: workspace.path,
        metadata: {},
      });

      expect(result.allowed).toBe(true);
    });

    test('respects disabled semantic rules', async () => {
      // Set up config to disable semantic rules
      await workspace.mkdir('.ultra');
      await workspace.writeFile(
        '.ultra/validation.json',
        JSON.stringify({
          semanticRules: { enabled: false },
        })
      );

      // Set up rules that would fail
      await workspace.mkdir('validation');
      await workspace.writeFile(
        'validation/context.md',
        `
\`\`\`rule:strict
disallow-imports: **/*
message: "No imports allowed!"
\`\`\`
`
      );

      await workspace.writeFile(
        'test.ts',
        `import { x } from './somewhere';`
      );

      // Re-init middleware to pick up config
      const newMiddleware = createValidationMiddleware();
      await newMiddleware.init(workspace.path);

      const result = await newMiddleware.validate({
        method: 'file/write',
        params: { path: `${workspace.path}/test.ts` },
        workspaceRoot: workspace.path,
        metadata: {},
      });

      // Should be allowed because semantic rules are disabled
      expect(result.allowed).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createValidationMiddleware
// ─────────────────────────────────────────────────────────────────────────────

describe('createValidationMiddleware', () => {
  test('creates middleware instance', () => {
    const middleware = createValidationMiddleware();
    expect(middleware).toBeInstanceOf(ValidationMiddleware);
  });

  test('creates independent instances', () => {
    const m1 = createValidationMiddleware();
    const m2 = createValidationMiddleware();
    expect(m1).not.toBe(m2);
  });
});
