import { describe, expect, test } from 'bun:test';
import {
  generateSessionId,
  buildAuthRequiredNotification,
  validateHandshake,
  buildNotAuthenticatedError,
  isHandshakeRequest,
  getHandshakeTimeout,
  getHeartbeatInterval,
  validateLegacyToken,
} from '../../../src/server/auth/handshake.ts';
import type { AuthConfig, AuthenticatedClientData } from '../../../src/server/auth/types.ts';
import { AuthErrorCodes } from '../../../src/protocol/auth.ts';

function makeConfig(token = 'test-secret'): AuthConfig {
  return { token };
}

function makeClientData(overrides?: Partial<AuthenticatedClientData>): AuthenticatedClientData {
  return {
    id: 'client-1',
    connectedAt: Date.now(),
    authState: 'pending',
    lastActivity: Date.now(),
    ...overrides,
  };
}

describe('generateSessionId', () => {
  test('returns a 32-char hex string', () => {
    const id = generateSessionId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  test('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateSessionId()));
    expect(ids.size).toBe(100);
  });
});

describe('buildAuthRequiredNotification', () => {
  test('returns valid JSON notification', () => {
    const config = makeConfig();
    const json = buildAuthRequiredNotification(config);
    const parsed = JSON.parse(json);
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.method).toBe('auth/required');
    expect(parsed.params.serverVersion).toBe('1.0.0');
    expect(parsed.params.timeout).toBe(10_000); // default
  });

  test('uses custom timeout', () => {
    const config = makeConfig();
    config.handshakeTimeout = 5000;
    const json = buildAuthRequiredNotification(config);
    const parsed = JSON.parse(json);
    expect(parsed.params.timeout).toBe(5000);
  });
});

describe('validateHandshake', () => {
  test('succeeds with correct token', () => {
    const config = makeConfig('secret-123');
    const client = makeClientData();
    const { response, authenticated } = validateHandshake(
      { id: 1, params: { token: 'secret-123' } },
      config,
      client,
      '/workspace',
    );

    expect(authenticated).toBe(true);
    const parsed = JSON.parse(response);
    expect(parsed.result.clientId).toBe('client-1');
    expect(parsed.result.sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(parsed.result.serverVersion).toBe('1.0.0');
    expect(parsed.result.workspaceRoot).toBe('/workspace');

    // Client data should be updated
    expect(client.authState).toBe('authenticated');
    expect(client.sessionId).toBeDefined();
  });

  test('rejects missing token', () => {
    const config = makeConfig();
    const client = makeClientData();
    const { response, authenticated } = validateHandshake(
      { id: 1, params: {} },
      config,
      client,
    );

    expect(authenticated).toBe(false);
    const parsed = JSON.parse(response);
    expect(parsed.error.code).toBe(AuthErrorCodes.InvalidToken);
    expect(client.authState).toBe('pending'); // unchanged
  });

  test('rejects wrong token', () => {
    const config = makeConfig('correct');
    const client = makeClientData();
    const { response, authenticated } = validateHandshake(
      { id: 1, params: { token: 'wrong' } },
      config,
      client,
    );

    expect(authenticated).toBe(false);
    const parsed = JSON.parse(response);
    expect(parsed.error.code).toBe(AuthErrorCodes.InvalidToken);
  });

  test('stores client info when provided', () => {
    const config = makeConfig('tok');
    const client = makeClientData();
    validateHandshake(
      { id: 1, params: { token: 'tok', client: { name: 'flex-gui', version: '1.0' } } },
      config,
      client,
    );
    expect(client.clientInfo).toEqual({ name: 'flex-gui', version: '1.0' });
  });

  test('rejects undefined params', () => {
    const config = makeConfig();
    const client = makeClientData();
    const { authenticated } = validateHandshake(
      { id: 1 },
      config,
      client,
    );
    expect(authenticated).toBe(false);
  });
});

describe('buildNotAuthenticatedError', () => {
  test('returns valid JSON error response', () => {
    const json = buildNotAuthenticatedError(5);
    const parsed = JSON.parse(json);
    expect(parsed.error.code).toBe(AuthErrorCodes.NotAuthenticated);
    expect(parsed.error.message).toContain('Not authenticated');
    expect(parsed.id).toBe(5);
  });
});

describe('isHandshakeRequest', () => {
  test('recognizes auth/handshake', () => {
    expect(isHandshakeRequest({ method: 'auth/handshake' })).toBe(true);
  });

  test('rejects other methods', () => {
    expect(isHandshakeRequest({ method: 'file/read' })).toBe(false);
    expect(isHandshakeRequest({})).toBe(false);
  });
});

describe('getHandshakeTimeout', () => {
  test('returns default timeout', () => {
    expect(getHandshakeTimeout(makeConfig())).toBe(10_000);
  });

  test('returns custom timeout', () => {
    const config = makeConfig();
    config.handshakeTimeout = 5000;
    expect(getHandshakeTimeout(config)).toBe(5000);
  });
});

describe('getHeartbeatInterval', () => {
  test('returns default interval', () => {
    expect(getHeartbeatInterval(makeConfig())).toBe(30_000);
  });

  test('returns custom interval', () => {
    const config = makeConfig();
    config.heartbeatInterval = 15000;
    expect(getHeartbeatInterval(config)).toBe(15000);
  });
});

describe('validateLegacyToken', () => {
  test('accepts valid token', () => {
    expect(validateLegacyToken('secret', makeConfig('secret'))).toBe(true);
  });

  test('rejects invalid token', () => {
    expect(validateLegacyToken('wrong', makeConfig('secret'))).toBe(false);
  });

  test('rejects null token', () => {
    expect(validateLegacyToken(null, makeConfig())).toBe(false);
  });
});
