/**
 * ECP Authentication Handshake
 *
 * Server-side handshake protocol handler. Validates client credentials
 * and manages the authentication lifecycle of WebSocket connections.
 */

import { randomBytes } from 'crypto';
import { debugLog as globalDebugLog } from '../../debug.ts';
import {
  type AuthConfig,
  type AuthenticatedClientData,
  type HandshakeParams,
  type HandshakeResult,
  type AuthRequiredParams,
  AuthErrorCodes,
} from './types.ts';
import {
  createErrorResponse,
  createNotification,
  type ECPErrorResponse,
  type ECPSuccessResponse,
} from '../../protocol/types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SERVER_VERSION = '1.0.0';
const DEFAULT_HANDSHAKE_TIMEOUT = 10_000; // 10 seconds
const DEFAULT_HEARTBEAT_INTERVAL = 30_000; // 30 seconds

// ─────────────────────────────────────────────────────────────────────────────
// Handshake Handler
// ─────────────────────────────────────────────────────────────────────────────

function debugLog(msg: string): void {
  globalDebugLog(`[ECPAuth] ${msg}`);
}

/**
 * Generate a random session ID.
 */
export function generateSessionId(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Build the auth/required notification sent to clients on connect.
 */
export function buildAuthRequiredNotification(config: AuthConfig): string {
  const timeout = config.handshakeTimeout ?? DEFAULT_HANDSHAKE_TIMEOUT;
  const params: AuthRequiredParams = {
    serverVersion: SERVER_VERSION,
    timeout,
  };
  return JSON.stringify(createNotification('auth/required', params));
}

/**
 * Validate a handshake request and return the response to send.
 *
 * @returns The JSON string to send back, and whether auth succeeded.
 */
export function validateHandshake(
  request: { id: string | number; params?: unknown },
  config: AuthConfig,
  clientData: AuthenticatedClientData,
  workspaceRoot?: string,
): { response: string; authenticated: boolean } {
  const params = request.params as Partial<HandshakeParams> | undefined;

  // Validate token is present
  if (!params?.token) {
    debugLog(`Handshake rejected for ${clientData.id}: missing token`);
    const error: ECPErrorResponse = createErrorResponse(
      request.id,
      AuthErrorCodes.InvalidToken,
      'Authentication failed: token is required',
    );
    return { response: JSON.stringify(error), authenticated: false };
  }

  // Constant-time token comparison to prevent timing attacks
  if (!timingSafeEqual(params.token, config.token)) {
    debugLog(`Handshake rejected for ${clientData.id}: invalid token`);
    const error: ECPErrorResponse = createErrorResponse(
      request.id,
      AuthErrorCodes.InvalidToken,
      'Authentication failed: invalid token',
    );
    return { response: JSON.stringify(error), authenticated: false };
  }

  // Auth succeeded — build success response
  const sessionId = generateSessionId();
  const result: HandshakeResult = {
    clientId: clientData.id,
    sessionId,
    serverVersion: SERVER_VERSION,
    workspaceRoot,
  };

  // Update client data
  clientData.authState = 'authenticated';
  clientData.sessionId = sessionId;
  if (params.client) {
    clientData.clientInfo = params.client;
  }

  debugLog(`Handshake accepted for ${clientData.id} (session: ${sessionId.substring(0, 8)}...)`);

  const success: ECPSuccessResponse = {
    jsonrpc: '2.0',
    id: request.id,
    result,
  };
  return { response: JSON.stringify(success), authenticated: true };
}

/**
 * Build an error response for unauthenticated requests.
 */
export function buildNotAuthenticatedError(requestId: string | number | null): string {
  return JSON.stringify(
    createErrorResponse(
      requestId,
      AuthErrorCodes.NotAuthenticated,
      'Not authenticated. Send auth/handshake first.',
    ),
  );
}

/**
 * Check if a request is an auth/handshake request.
 */
export function isHandshakeRequest(parsed: { method?: string }): boolean {
  return parsed.method === 'auth/handshake';
}

/**
 * Get the handshake timeout duration from config.
 */
export function getHandshakeTimeout(config: AuthConfig): number {
  return config.handshakeTimeout ?? DEFAULT_HANDSHAKE_TIMEOUT;
}

/**
 * Get the heartbeat interval from config.
 */
export function getHeartbeatInterval(config: AuthConfig): number {
  return config.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL;
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy Auth (query-param token)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a legacy query-param token.
 * Returns true if the token is valid, false otherwise.
 * Logs a deprecation warning on success.
 */
export function validateLegacyToken(token: string | null, config: AuthConfig): boolean {
  if (!token) return false;
  if (!timingSafeEqual(token, config.token)) return false;

  console.warn(
    '[ECPAuth] WARNING: Client authenticated via query-param token (deprecated). ' +
    'Please update the client to use auth/handshake protocol.',
  );
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do the comparison to keep constant time,
    // but we know the result will be false
    const buf = Buffer.from(a);
    const dummy = Buffer.alloc(buf.length);
    try { require('crypto').timingSafeEqual(buf, dummy); } catch {}
    return false;
  }

  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  try {
    return require('crypto').timingSafeEqual(bufA, bufB);
  } catch {
    // Fallback: this is not constant-time but better than nothing
    return a === b;
  }
}
