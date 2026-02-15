/**
 * Shared ECP Types
 *
 * Re-exports ECP types for use by clients (Flex-GUI, TUI, etc.).
 * This provides a stable interface for client code without exposing
 * internal ECP implementation details.
 */

// ─────────────────────────────────────────────────────────────────────────────
// JSON-RPC 2.0 Types
// ─────────────────────────────────────────────────────────────────────────────

export type {
  ECPRequest,
  ECPSuccessResponse,
  ECPError,
  ECPErrorResponse,
  ECPResponse,
  ECPNotification,
  ECPErrorCode,
  HandlerResult,
  ServiceAdapter,
  NotificationHandler,
  NotificationListener,
  ECPServerOptions,
  ECPServerState,
  Unsubscribe,
} from '../../protocol/types.ts';

export {
  ECPErrorCodes,
  isErrorResponse,
  isSuccessResponse,
  createErrorResponse,
  createSuccessResponse,
  createNotification,
} from '../../protocol/types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Client-Friendly Message Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ECP message for client requests (extends ECPRequest with typed params).
 */
export interface ECPClientRequest<P = unknown> {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: P;
}

/**
 * Notification callback type for client subscriptions.
 */
export type NotificationCallback<P = unknown> = (params: P | undefined) => void;
