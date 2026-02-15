import { describe, expect, test } from 'bun:test';
import { MiddlewareErrorCodes, createMiddlewareError } from '../../../src/server/middleware/types.ts';

describe('MiddlewareErrorCodes', () => {
  test('has expected error codes', () => {
    expect(MiddlewareErrorCodes.ValidationFailed).toBe(-32003);
    expect(MiddlewareErrorCodes.LintFailed).toBe(-32004);
    expect(MiddlewareErrorCodes.RuleViolation).toBe(-32005);
  });

  test('all codes are unique', () => {
    const values = Object.values(MiddlewareErrorCodes);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  test('codes do not collide with auth error codes', () => {
    const { AuthErrorCodes } = require('../../../src/protocol/auth.ts');
    const authCodes = new Set(Object.values(AuthErrorCodes) as number[]);
    for (const code of Object.values(MiddlewareErrorCodes)) {
      expect(authCodes.has(code)).toBe(false);
    }
  });
});

describe('createMiddlewareError', () => {
  test('creates error with code and message', () => {
    const err = createMiddlewareError(MiddlewareErrorCodes.ValidationFailed, 'blocked');
    expect(err.code).toBe(-32003);
    expect(err.message).toBe('blocked');
    expect(err.data).toBeUndefined();
  });

  test('includes optional data', () => {
    const err = createMiddlewareError(
      MiddlewareErrorCodes.LintFailed,
      'lint failed',
      { errors: ['e1'] },
    );
    expect(err.data).toEqual({ errors: ['e1'] });
  });
});
