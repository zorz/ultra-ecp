/**
 * ECP Middleware Types
 *
 * Middleware sits between the ECP server and adapters, allowing
 * validation, transformation, and interception of requests.
 */

import type { ECPError } from '../../protocol/types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Middleware Context
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Context passed to middleware for each request.
 */
export interface MiddlewareContext {
  /** The method being called (e.g., "file/write", "ai/tool/execute") */
  method: string;

  /** The request parameters */
  params: unknown;

  /** Workspace root path */
  workspaceRoot: string;

  /** Optional session ID if available */
  sessionId?: string;

  /** Optional client ID if available */
  clientId?: string;

  /** Metadata that middleware can attach for downstream use */
  metadata: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Middleware Result
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result from middleware validation.
 */
export interface MiddlewareResult {
  /** Whether the request is allowed to proceed */
  allowed: boolean;

  /** Feedback message if blocked (shown to user/AI) */
  feedback?: string;

  /** Modified params (middleware can transform the request) */
  modifiedParams?: unknown;

  /** Additional data to include in error response */
  errorData?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Middleware Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ECP Middleware interface.
 *
 * Middleware can intercept requests to validate, transform, or block them.
 */
export interface ECPMiddleware {
  /** Unique name for this middleware */
  name: string;

  /** Priority (lower runs first, default 100) */
  priority?: number;

  /**
   * Check if this middleware applies to a given method.
   * Return true to have validate() called for this request.
   */
  appliesTo(method: string): boolean;

  /**
   * Validate the request before execution.
   * Return { allowed: false, feedback: "..." } to block.
   */
  validate(ctx: MiddlewareContext): Promise<MiddlewareResult>;

  /**
   * Optional: Called after successful execution.
   * Useful for logging, metrics, or post-processing.
   */
  afterExecute?(ctx: MiddlewareContext, result: unknown): Promise<void>;

  /**
   * Optional: Initialize the middleware.
   * Called once when middleware is registered.
   */
  init?(workspaceRoot: string): Promise<void>;

  /**
   * Optional: Shutdown the middleware.
   * Called when the server shuts down.
   */
  shutdown?(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Middleware Chain
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result from running the middleware chain.
 */
export interface MiddlewareChainResult {
  /** Whether all middleware allowed the request */
  allowed: boolean;

  /** The middleware that blocked (if any) */
  blockedBy?: string;

  /** Feedback from the blocking middleware */
  feedback?: string;

  /** Error data from the blocking middleware */
  errorData?: unknown;

  /** Final params after all transformations */
  finalParams: unknown;

  /** Merged metadata from all middleware */
  metadata: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Codes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Middleware-specific error codes.
 * Using -32003 to -32009 range (server errors).
 */
export const MiddlewareErrorCodes = {
  /** Request blocked by validation middleware */
  ValidationFailed: -32003,

  /** Linter reported errors */
  LintFailed: -32004,

  /** Rule violation detected */
  RuleViolation: -32005,
} as const;

export type MiddlewareErrorCode =
  (typeof MiddlewareErrorCodes)[keyof typeof MiddlewareErrorCodes];

/**
 * Create a middleware error.
 */
export function createMiddlewareError(
  code: MiddlewareErrorCode,
  message: string,
  data?: unknown
): ECPError {
  return { code, message, data };
}
