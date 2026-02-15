/**
 * ECP Protocol
 *
 * The client-facing contract for the Editor Command Protocol.
 * Clients import ONLY from this package — never from server/.
 *
 * Re-exports:
 *   - types.ts      — JSON-RPC types, error codes, response shapes, helper functions
 *   - methods.ts    — method name constants (~240 methods across 22 namespaces)
 *   - schemas.ts    — Zod validation schemas for method parameters
 *   - notifications.ts — notification event name constants (~73 events)
 *   - auth.ts       — WebSocket handshake types and error codes
 */

export * from './types.ts';
export { Methods, type MethodName } from './methods.ts';
export { Notifications, type NotificationName } from './notifications.ts';
export * from './auth.ts';

// Schemas are exported individually so tree-shaking works well
export * from './schemas.ts';
