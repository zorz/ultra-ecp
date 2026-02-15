/**
 * ECP Authentication Types
 *
 * Types for the WebSocket authentication handshake protocol.
 *
 * Protocol flow:
 *   1. Client connects to ws://host:port/ws (no token in URL)
 *   2. Server marks connection as PENDING_AUTH, starts auth timeout
 *   3. Server sends: { method: "auth/required", params: { serverVersion, timeout } }
 *   4. Client sends: { method: "auth/handshake", id: "...", params: { token, client } }
 *   5. Server validates token:
 *      - Success: responds with { result: { clientId, sessionId, ... } }
 *      - Failure: responds with error, closes connection
 *   6. Normal JSON-RPC traffic begins
 *   7. Server sends periodic heartbeat pings
 */

// ─────────────────────────────────────────────────────────────────────────────
// Client → Server
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Client information sent during handshake.
 */
export interface HandshakeClientInfo {
  /** Client type identifier (e.g., 'flex-gui', 'headless-cli', 'tauri') */
  name: string;
  /** Client version */
  version?: string;
}

/**
 * Parameters for the auth/handshake request.
 */
export interface HandshakeParams {
  /** The authentication token (shared secret) */
  token: string;
  /** Optional client information */
  client?: HandshakeClientInfo;
}

// ─────────────────────────────────────────────────────────────────────────────
// Server → Client
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parameters for the auth/required notification (sent on connect).
 */
export interface AuthRequiredParams {
  /** Server version */
  serverVersion: string;
  /** Milliseconds until unauthenticated connection is closed */
  timeout: number;
}

/**
 * Successful handshake response result.
 */
export interface HandshakeResult {
  /** Unique client ID for this connection */
  clientId: string;
  /** Session identifier (survives reconnection within expiry) */
  sessionId: string;
  /** Server version */
  serverVersion: string;
  /** Workspace root path */
  workspaceRoot?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection State
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Authentication state for a client connection.
 */
export type AuthState = 'pending' | 'authenticated' | 'rejected';

/**
 * Extended client data attached to each WebSocket connection.
 */
export interface AuthenticatedClientData {
  /** Unique client ID */
  id: string;
  /** When the client connected */
  connectedAt: number;
  /** Authentication state */
  authState: AuthState;
  /** Session ID (set after successful handshake) */
  sessionId?: string;
  /** Client info (set after successful handshake) */
  clientInfo?: HandshakeClientInfo;
  /** Last time we received any message from this client */
  lastActivity: number;
  /** Auth timeout handle (cleared on successful auth) */
  authTimeout?: ReturnType<typeof setTimeout>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Authentication configuration for the WebSocket server.
 */
export interface AuthConfig {
  /** Static auth token (shared secret, generated per server instance) */
  token: string;
  /** Timeout for completing auth handshake in ms (default: 10000) */
  handshakeTimeout?: number;
  /**
   * Allow legacy query-param auth (?token=...) for backward compatibility.
   * When true, clients passing a valid token in the URL are auto-authenticated
   * but a deprecation warning is logged. Default: true.
   */
  allowLegacyAuth?: boolean;
  /** Heartbeat interval in ms (default: 30000). Set to 0 to disable. */
  heartbeatInterval?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Codes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Authentication-specific error codes.
 * Using -32010 to -32019 range to avoid collision with middleware codes.
 */
export const AuthErrorCodes = {
  /** Client is not authenticated */
  NotAuthenticated: -32010,
  /** Invalid or missing auth token */
  InvalidToken: -32011,
  /** Auth handshake timed out */
  HandshakeTimeout: -32012,
  /** Connection rejected (e.g., max connections reached) */
  ConnectionRejected: -32013,
} as const;

export type AuthErrorCode = (typeof AuthErrorCodes)[keyof typeof AuthErrorCodes];
