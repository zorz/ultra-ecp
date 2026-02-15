import { describe, expect, test } from 'bun:test';
import { AuthErrorCodes } from '../../src/protocol/auth.ts';

describe('AuthErrorCodes', () => {
  test('has expected error codes', () => {
    expect(AuthErrorCodes.NotAuthenticated).toBe(-32010);
    expect(AuthErrorCodes.InvalidToken).toBe(-32011);
    expect(AuthErrorCodes.HandshakeTimeout).toBe(-32012);
    expect(AuthErrorCodes.ConnectionRejected).toBe(-32013);
  });

  test('all codes are unique', () => {
    const values = Object.values(AuthErrorCodes);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  test('codes are in the -32010 to -32019 range', () => {
    for (const code of Object.values(AuthErrorCodes)) {
      expect(code).toBeGreaterThanOrEqual(-32019);
      expect(code).toBeLessThanOrEqual(-32010);
    }
  });
});
