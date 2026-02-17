/**
 * ECP WebSocket Server
 *
 * Provides WebSocket transport for ECP, enabling web clients to connect
 * to the ECP server over HTTP/WebSocket.
 *
 * Authentication Protocol:
 *   1. Client connects to ws://host:port/ws (no credentials in URL)
 *   2. Server sends auth/required notification with timeout
 *   3. Client sends auth/handshake with token
 *   4. Server validates and responds (success or close)
 *   5. Normal JSON-RPC traffic begins
 *
 * Legacy support: Clients may still pass ?token= in the URL. If
 * allowLegacyAuth is true (default), these are auto-authenticated
 * with a deprecation warning logged.
 */

import type { ServerWebSocket } from 'bun';
import { resolve, relative } from 'path';
import { ECPServer } from './ecp-server.ts';
import {
  type ECPRequest,
  type ECPResponse,
  type ECPNotification,
  type Unsubscribe,
  ECPErrorCodes,
  createErrorResponse,
  createNotification,
} from '../protocol/types.ts';
import {
  type AuthConfig,
  type AuthenticatedClientData,
  AuthErrorCodes,
  buildAuthRequiredNotification,
  validateHandshake,
  buildNotAuthenticatedError,
  isHandshakeRequest,
  getHandshakeTimeout,
  getHeartbeatInterval,
  validateLegacyToken,
  generateSessionId,
} from './auth/index.ts';
import { debugLog as globalDebugLog } from '../debug.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WebSocket server options.
 */
export interface WebSocketServerOptions {
  /** Port to listen on */
  port: number;
  /**
   * Hostname to bind to.
   * Default: '127.0.0.1' (localhost only - secure default)
   * Use '0.0.0.0' to expose to network (requires allowedOrigins for security)
   */
  hostname?: string;
  /** Directory to serve static files from (for production mode) */
  staticDir?: string;
  /** Enable CORS for dev mode */
  enableCors?: boolean;
  /** Workspace root for ECP server */
  workspaceRoot?: string;
  /**
   * Authentication token required for WebSocket connections.
   * Used as the shared secret for the auth/handshake protocol.
   */
  authToken?: string;
  /**
   * Allowed origins for WebSocket connections.
   * If not specified, only same-origin connections are allowed.
   * Use ['*'] to allow all origins (not recommended for production).
   * Example: ['http://localhost:3000', 'https://myapp.example.com']
   */
  allowedOrigins?: string[];
  /**
   * Enable verbose connection logging to console.
   * Useful for headless server mode to see connection attempts in real time.
   */
  verboseLogging?: boolean;
  /**
   * Maximum number of concurrent client connections.
   * If set, new connections will be rejected when limit is reached.
   */
  maxConnections?: number;
  /**
   * Allow legacy query-param auth (?token=...) for backward compatibility.
   * Default: true. Set to false to require auth/handshake protocol only.
   */
  allowLegacyAuth?: boolean;
  /**
   * Timeout for auth handshake in milliseconds.
   * Unauthenticated connections are closed after this duration.
   * Default: 10000 (10 seconds).
   */
  handshakeTimeout?: number;
  /**
   * Heartbeat interval in milliseconds.
   * Server sends ping frames to detect stale connections.
   * Default: 30000 (30 seconds). Set to 0 to disable.
   */
  heartbeatInterval?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Server
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ECP WebSocket Server.
 *
 * Wraps an ECPServer and exposes it over WebSocket with secure authentication.
 */
export class ECPWebSocketServer {
  private server: ReturnType<typeof Bun.serve<AuthenticatedClientData>> | null = null;
  private ecpServer: ECPServer;
  private clients: Map<string, ServerWebSocket<AuthenticatedClientData>> = new Map();
  private notificationUnsubscribe: Unsubscribe | null = null;
  private clientIdCounter = 0;
  private options: WebSocketServerOptions;
  private authConfig: AuthConfig | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(ecpServer: ECPServer, options: WebSocketServerOptions) {
    this.ecpServer = ecpServer;
    this.options = options;

    // Build auth config from options
    if (options.authToken) {
      this.authConfig = {
        token: options.authToken,
        handshakeTimeout: options.handshakeTimeout,
        allowLegacyAuth: options.allowLegacyAuth ?? true,
        heartbeatInterval: options.heartbeatInterval,
      };
    }
  }

  private debugLog(msg: string): void {
    globalDebugLog(`[ECPWebSocketServer] ${msg}`);
  }

  private verboseLog(msg: string): void {
    if (this.options.verboseLogging) {
      const timestamp = new Date().toLocaleTimeString();
      console.log(`  [${timestamp}] ${msg}`);
    }
  }

  /**
   * Validate that a request origin is allowed.
   */
  private isOriginAllowed(origin: string | null, host: string): boolean {
    const { allowedOrigins } = this.options;

    // If no origin header, it's likely a same-origin request or non-browser client
    if (!origin) {
      return true;
    }

    // If allowedOrigins is explicitly set
    if (allowedOrigins) {
      // Allow all origins if '*' is in the list
      if (allowedOrigins.includes('*')) {
        return true;
      }
      // Check if origin is in the allowed list
      return allowedOrigins.some(allowed => origin === allowed || origin.startsWith(allowed));
    }

    // Default: only allow same-origin (localhost) connections
    // This protects against cross-site WebSocket hijacking
    try {
      const originUrl = new URL(origin);
      const isLocalhost = originUrl.hostname === 'localhost' ||
                          originUrl.hostname === '127.0.0.1' ||
                          originUrl.hostname === host;
      return isLocalhost;
    } catch (error) {
      globalDebugLog(`[ECPWebSocketServer] Invalid origin URL: ${origin}, error: ${error}`);
      return false;
    }
  }

  /**
   * Start the WebSocket server.
   */
  async start(): Promise<void> {
    // Default to 127.0.0.1 for security - only expose to localhost
    // Use '0.0.0.0' explicitly if network access is needed
    const { port, hostname = '127.0.0.1', staticDir, enableCors } = this.options;

    // Warn if binding to all interfaces without origin restrictions
    if (hostname === '0.0.0.0' && !this.options.allowedOrigins) {
      console.warn(
        '[ECPWebSocketServer] WARNING: Binding to 0.0.0.0 without allowedOrigins. ' +
        'This may expose the server to cross-site WebSocket hijacking attacks. ' +
        'Consider setting allowedOrigins or using hostname: "127.0.0.1".'
      );
    }

    // Subscribe to ECP notifications and broadcast to all clients
    this.notificationUnsubscribe = this.ecpServer.onNotification((method, params) => {
      this.broadcast(createNotification(method, params));
    });

    const self = this;

    this.server = Bun.serve<AuthenticatedClientData>({
      port,
      hostname,

      // HTTP request handler (for static files and health check)
      async fetch(req, server) {
        const url = new URL(req.url);

        // WebSocket upgrade
        if (url.pathname === '/ws') {
          const clientIP = req.headers.get('x-forwarded-for') || 'localhost';
          self.verboseLog(`Connection attempt from ${clientIP}`);

          // Check connection limit
          if (self.options.maxConnections !== undefined && self.clients.size >= self.options.maxConnections) {
            self.verboseLog(`Connection REJECTED: Max connections reached (${self.options.maxConnections})`);
            return new Response('Service Unavailable: Max connections reached', { status: 503 });
          }

          // Check for legacy query-param token
          const legacyToken = url.searchParams.get('token');
          const legacyAuthenticated = self.authConfig &&
            self.authConfig.allowLegacyAuth !== false &&
            legacyToken &&
            validateLegacyToken(legacyToken, self.authConfig);

          const clientId = `client-${++self.clientIdCounter}`;
          const now = Date.now();

          const upgraded = server.upgrade(req, {
            data: {
              id: clientId,
              connectedAt: now,
              authState: legacyAuthenticated ? 'authenticated' : (self.authConfig ? 'pending' : 'authenticated'),
              sessionId: legacyAuthenticated ? generateSessionId() : undefined,
              lastActivity: now,
            } satisfies AuthenticatedClientData,
          });

          if (upgraded) {
            if (legacyAuthenticated) {
              self.verboseLog(`Token validated via query param (deprecated) for ${clientId}`);
            }
            return undefined;
          }

          return new Response('WebSocket upgrade failed', { status: 500 });
        }

        // CORS preflight
        if (req.method === 'OPTIONS' && enableCors) {
          return new Response(null, {
            headers: self.corsHeaders(),
          });
        }

        // Health check endpoint
        if (url.pathname === '/health') {
          return new Response(JSON.stringify({
            status: 'ok',
            clients: self.clients.size,
            uptime: process.uptime(),
          }), {
            headers: {
              'Content-Type': 'application/json',
              ...self.corsHeaders(),
            },
          });
        }

        // Serve static files if configured
        if (staticDir) {
          let filePath = url.pathname;
          if (filePath === '/') {
            filePath = '/index.html';
          }

          // Security: Prevent path traversal attacks
          // Resolve the full path and ensure it's within staticDir
          const resolvedStaticDir = resolve(staticDir);
          const requestedPath = resolve(resolvedStaticDir, '.' + filePath);
          const relativePath = relative(resolvedStaticDir, requestedPath);

          // Check for path traversal: relative path should not start with '..' or be absolute
          if (relativePath.startsWith('..') || relativePath.startsWith('/')) {
            return new Response('Forbidden', { status: 403 });
          }

          const file = Bun.file(requestedPath);
          if (await file.exists()) {
            return new Response(file, {
              headers: {
                'Content-Type': self.getMimeType(filePath),
                ...self.corsHeaders(),
              },
            });
          }

          // SPA fallback - serve index.html for unmatched routes
          const indexFile = Bun.file(`${resolvedStaticDir}/index.html`);
          if (await indexFile.exists()) {
            return new Response(indexFile, {
              headers: {
                'Content-Type': 'text/html',
                ...self.corsHeaders(),
              },
            });
          }
        }

        return new Response('Not Found', { status: 404 });
      },

      // WebSocket handlers
      websocket: {
        // Disable Bun's built-in idle timeout — we have our own heartbeat/stale detection
        idleTimeout: 960, // 16 minutes (max Bun allows); our heartbeat handles detection
        sendPings: false, // We send our own pings in startHeartbeat()

        open(ws) {
          self.clients.set(ws.data.id, ws);
          self.debugLog(`Client connected: ${ws.data.id} (total: ${self.clients.size})`);
          self.verboseLog(`Client CONNECTED: ${ws.data.id} (total clients: ${self.clients.size})`);

          if (ws.data.authState === 'authenticated') {
            // Legacy auth or no auth required — send welcome immediately
            self.sendWelcome(ws);
          } else {
            // New auth flow — send auth/required and start timeout
            self.sendAuthRequired(ws);
          }
        },

        async message(ws, message) {
          const messageStr = typeof message === 'string' ? message : new TextDecoder().decode(message);

          // Update activity timestamp
          ws.data.lastActivity = Date.now();

          try {
            const parsed = JSON.parse(messageStr);

            // ── Auth gate ────────────────────────────────────────────────
            if (ws.data.authState === 'pending') {
              if (isHandshakeRequest(parsed)) {
                self.handleHandshake(ws, parsed);
              } else {
                // Reject non-auth messages before authentication
                ws.send(buildNotAuthenticatedError(parsed?.id ?? null));
              }
              return;
            }

            if (ws.data.authState === 'rejected') {
              // Connection should have been closed, but just in case
              ws.close(4001, 'Authentication failed');
              return;
            }

            // ── Normal message routing (authenticated) ───────────────────

            // Validate JSON-RPC request
            if (!self.isValidRequest(parsed)) {
              ws.send(JSON.stringify(createErrorResponse(
                parsed?.id ?? null,
                ECPErrorCodes.InvalidRequest,
                'Invalid JSON-RPC request'
              )));
              return;
            }

            // Route to ECP server
            const response = await self.ecpServer.requestRaw(parsed.method, parsed.params);

            // Ensure the response ID matches the request
            const responseWithId: ECPResponse = {
              ...response,
              id: parsed.id,
            };

            ws.send(JSON.stringify(responseWithId));
          } catch (error) {
            self.debugLog(`Message parse error: ${error}`);
            ws.send(JSON.stringify(createErrorResponse(
              null,
              ECPErrorCodes.ParseError,
              'Failed to parse JSON'
            )));
          }
        },

        pong(ws) {
          // Client responded to our ping — update activity so heartbeat doesn't kill it
          ws.data.lastActivity = Date.now();
        },

        close(ws) {
          // Clear auth timeout if still pending
          if (ws.data.authTimeout) {
            clearTimeout(ws.data.authTimeout);
          }
          self.clients.delete(ws.data.id);
          self.debugLog(`Client disconnected: ${ws.data.id} (total: ${self.clients.size})`);
          self.verboseLog(`Client DISCONNECTED: ${ws.data.id} (total clients: ${self.clients.size})`);
        },
      },
    });

    // Start heartbeat timer
    this.startHeartbeat();

    this.debugLog(`WebSocket server listening on ws://${hostname}:${port}/ws`);
  }

  /**
   * Send the auth/required notification to a newly connected client.
   */
  private sendAuthRequired(ws: ServerWebSocket<AuthenticatedClientData>): void {
    if (!this.authConfig) return;

    // Send challenge
    ws.send(buildAuthRequiredNotification(this.authConfig));

    // Start auth timeout
    const timeout = getHandshakeTimeout(this.authConfig);
    ws.data.authTimeout = setTimeout(() => {
      if (ws.data.authState === 'pending') {
        this.debugLog(`Auth timeout for ${ws.data.id} after ${timeout}ms`);
        this.verboseLog(`Client TIMEOUT: ${ws.data.id} (auth handshake not completed)`);
        ws.data.authState = 'rejected';
        ws.send(JSON.stringify(createErrorResponse(
          null,
          AuthErrorCodes.HandshakeTimeout,
          `Authentication timeout: handshake not completed within ${timeout}ms`,
        )));
        ws.close(4000, 'Auth timeout');
      }
    }, timeout);
  }

  /**
   * Handle an auth/handshake request from a client.
   */
  private handleHandshake(
    ws: ServerWebSocket<AuthenticatedClientData>,
    request: { id: string | number; params?: unknown },
  ): void {
    if (!this.authConfig) return;

    // Clear auth timeout
    if (ws.data.authTimeout) {
      clearTimeout(ws.data.authTimeout);
      ws.data.authTimeout = undefined;
    }

    const { response, authenticated } = validateHandshake(
      request,
      this.authConfig,
      ws.data,
      this.options.workspaceRoot,
    );

    ws.send(response);

    if (authenticated) {
      this.verboseLog(`Client AUTHENTICATED: ${ws.data.id} (client: ${ws.data.clientInfo?.name ?? 'unknown'})`);
    } else {
      this.verboseLog(`Client AUTH FAILED: ${ws.data.id}`);
      ws.data.authState = 'rejected';
      // Close after a brief delay to let the error response be sent
      setTimeout(() => {
        ws.close(4001, 'Authentication failed');
      }, 100);
    }
  }

  /**
   * Send the welcome/connected notification.
   * This is the same message as before, maintaining backward compatibility.
   */
  private sendWelcome(ws: ServerWebSocket<AuthenticatedClientData>): void {
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'server/connected',
      params: {
        clientId: ws.data.id,
        sessionId: ws.data.sessionId,
        serverVersion: '1.0.0',
        workspaceRoot: this.options.workspaceRoot,
      },
    }));
  }

  /**
   * Start the heartbeat timer for detecting stale connections.
   * Runs regardless of auth config to keep connections alive during long operations.
   */
  private startHeartbeat(): void {
    const interval = this.authConfig
      ? getHeartbeatInterval(this.authConfig)
      : 30_000; // Default 30s if no auth config
    if (interval <= 0) return;

    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      // Stale threshold: 5x heartbeat interval (2.5 min) to tolerate long-running operations
      const staleThreshold = interval * 5;

      for (const [id, ws] of this.clients) {
        // Skip clients still in auth handshake (they have their own timeout)
        if (ws.data.authState === 'pending') continue;

        const idleTime = now - ws.data.lastActivity;
        if (idleTime > staleThreshold) {
          this.debugLog(`Closing stale connection ${id} (idle for ${Math.round(idleTime / 1000)}s)`);
          ws.close(1001, 'Connection stale');
          continue;
        }

        // Send WebSocket ping frame to keep connection alive
        try {
          ws.ping();
        } catch {
          // Connection already dead
          this.clients.delete(id);
        }
      }
    }, interval);
  }

  /**
   * Stop the WebSocket server.
   */
  async stop(): Promise<void> {
    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.notificationUnsubscribe) {
      this.notificationUnsubscribe();
      this.notificationUnsubscribe = null;
    }

    // Close all client connections
    for (const ws of this.clients.values()) {
      try {
        // Clear any pending auth timeouts
        if (ws.data.authTimeout) {
          clearTimeout(ws.data.authTimeout);
        }
        ws.close(1000, 'Server shutting down');
      } catch (error) {
        this.debugLog(`Error closing client connection: ${error}`);
      }
    }
    this.clients.clear();

    if (this.server) {
      this.server.stop();
      this.server = null;
    }

    this.debugLog('WebSocket server stopped');
  }

  /**
   * Broadcast a notification to all connected and authenticated clients.
   */
  broadcast(notification: ECPNotification): void {
    const message = JSON.stringify(notification);

    // Log workflow notifications for debugging
    if (notification.method.startsWith('workflow/')) {
      console.log(`[ECPWebSocketServer] Broadcasting workflow notification: ${notification.method} to ${this.clients.size} clients`);
    }

    for (const [id, ws] of this.clients) {
      // Only broadcast to authenticated clients
      if (ws.data.authState !== 'authenticated') continue;

      try {
        ws.send(message);
      } catch (error) {
        this.debugLog(`Failed to send to ${id}: ${error}`);
      }
    }
  }

  /**
   * Get the number of connected clients.
   */
  getConnectionCount(): number {
    return this.clients.size;
  }

  /**
   * Get the number of authenticated clients.
   */
  getAuthenticatedCount(): number {
    let count = 0;
    for (const ws of this.clients.values()) {
      if (ws.data.authState === 'authenticated') count++;
    }
    return count;
  }

  /**
   * Get the actual server port (resolved from OS if port 0 was used).
   */
  getPort(): number {
    return this.server?.port ?? this.options.port;
  }

  /**
   * Check if a request is a valid JSON-RPC 2.0 request.
   */
  private isValidRequest(request: unknown): request is ECPRequest {
    if (typeof request !== 'object' || request === null) {
      return false;
    }

    const req = request as Record<string, unknown>;

    // Validate JSON-RPC 2.0 base shape.
    // Note: we allow additional fields for forward-compat (e.g., `caller`).
    return (
      req.jsonrpc === '2.0' &&
      typeof req.method === 'string' &&
      (req.id === undefined || typeof req.id === 'string' || typeof req.id === 'number')
    );
  }

  /**
   * Get CORS headers.
   */
  private corsHeaders(): Record<string, string> {
    if (!this.options.enableCors) {
      return {};
    }

    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
  }

  /**
   * Get MIME type for a file path.
   */
  private getMimeType(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';

    const mimeTypes: Record<string, string> = {
      html: 'text/html',
      css: 'text/css',
      js: 'application/javascript',
      mjs: 'application/javascript',
      json: 'application/json',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      ico: 'image/x-icon',
      woff: 'font/woff',
      woff2: 'font/woff2',
      ttf: 'font/ttf',
      eot: 'application/vnd.ms-fontobject',
    };

    return mimeTypes[ext] ?? 'application/octet-stream';
  }
}

/**
 * Create and start a WebSocket server.
 */
export async function createWebSocketServer(
  ecpServer: ECPServer,
  options: WebSocketServerOptions
): Promise<ECPWebSocketServer> {
  const wsServer = new ECPWebSocketServer(ecpServer, options);
  await wsServer.start();
  return wsServer;
}
