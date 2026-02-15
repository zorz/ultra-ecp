/**
 * ECP Middleware
 *
 * Middleware chain management for the ECP server.
 */

export * from './types.ts';

import { debugLog } from '../../debug.ts';
import type {
  ECPMiddleware,
  MiddlewareContext,
  MiddlewareChainResult,
} from './types.ts';

/**
 * Middleware chain manager.
 *
 * Manages a list of middleware and runs them in priority order.
 */
export class MiddlewareChain {
  private middlewares: ECPMiddleware[] = [];
  private initialized = false;
  private workspaceRoot: string = '';

  /**
   * Register a middleware.
   * Middleware are sorted by priority (lower runs first).
   */
  use(middleware: ECPMiddleware): void {
    this.middlewares.push(middleware);
    this.middlewares.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    debugLog(`[MiddlewareChain] Registered middleware: ${middleware.name}`);
  }

  /**
   * Remove a middleware by name.
   */
  remove(name: string): boolean {
    const index = this.middlewares.findIndex((m) => m.name === name);
    if (index !== -1) {
      this.middlewares.splice(index, 1);
      debugLog(`[MiddlewareChain] Removed middleware: ${name}`);
      return true;
    }
    return false;
  }

  /**
   * Get all registered middleware names.
   */
  getMiddlewareNames(): string[] {
    return this.middlewares.map((m) => m.name);
  }

  /**
   * Initialize all middleware.
   */
  async init(workspaceRoot: string): Promise<void> {
    this.workspaceRoot = workspaceRoot;

    for (const middleware of this.middlewares) {
      if (middleware.init) {
        try {
          await middleware.init(workspaceRoot);
          debugLog(`[MiddlewareChain] Initialized middleware: ${middleware.name}`);
        } catch (error) {
          debugLog(
            `[MiddlewareChain] Failed to init middleware ${middleware.name}: ${error}`
          );
        }
      }
    }

    this.initialized = true;
  }

  /**
   * Shutdown all middleware.
   */
  async shutdown(): Promise<void> {
    for (const middleware of this.middlewares) {
      if (middleware.shutdown) {
        try {
          await middleware.shutdown();
          debugLog(`[MiddlewareChain] Shutdown middleware: ${middleware.name}`);
        } catch (error) {
          debugLog(
            `[MiddlewareChain] Failed to shutdown middleware ${middleware.name}: ${error}`
          );
        }
      }
    }

    this.initialized = false;
  }

  /**
   * Run the middleware chain for a request.
   *
   * Runs each applicable middleware's validate() in priority order.
   * Stops on first rejection.
   */
  async run(
    method: string,
    params: unknown,
    options: {
      sessionId?: string;
      clientId?: string;
    } = {}
  ): Promise<MiddlewareChainResult> {
    const ctx: MiddlewareContext = {
      method,
      params,
      workspaceRoot: this.workspaceRoot,
      sessionId: options.sessionId,
      clientId: options.clientId,
      metadata: {},
    };

    let currentParams = params;

    for (const middleware of this.middlewares) {
      if (!middleware.appliesTo(method)) {
        continue;
      }

      try {
        const result = await middleware.validate({
          ...ctx,
          params: currentParams,
        });

        if (!result.allowed) {
          debugLog(
            `[MiddlewareChain] Request blocked by ${middleware.name}: ${result.feedback}`
          );

          return {
            allowed: false,
            blockedBy: middleware.name,
            feedback: result.feedback,
            errorData: result.errorData,
            finalParams: currentParams,
            metadata: ctx.metadata,
          };
        }

        // Apply any param transformations
        if (result.modifiedParams !== undefined) {
          currentParams = result.modifiedParams;
        }
      } catch (error) {
        debugLog(
          `[MiddlewareChain] Middleware ${middleware.name} threw error: ${error}`
        );

        // Treat errors as rejections
        return {
          allowed: false,
          blockedBy: middleware.name,
          feedback: `Middleware error: ${error instanceof Error ? error.message : String(error)}`,
          finalParams: currentParams,
          metadata: ctx.metadata,
        };
      }
    }

    return {
      allowed: true,
      finalParams: currentParams,
      metadata: ctx.metadata,
    };
  }

  /**
   * Run afterExecute hooks for all applicable middleware.
   */
  async runAfterExecute(
    method: string,
    params: unknown,
    result: unknown,
    options: {
      sessionId?: string;
      clientId?: string;
    } = {}
  ): Promise<void> {
    const ctx: MiddlewareContext = {
      method,
      params,
      workspaceRoot: this.workspaceRoot,
      sessionId: options.sessionId,
      clientId: options.clientId,
      metadata: {},
    };

    for (const middleware of this.middlewares) {
      if (!middleware.appliesTo(method) || !middleware.afterExecute) {
        continue;
      }

      try {
        await middleware.afterExecute(ctx, result);
      } catch (error) {
        debugLog(
          `[MiddlewareChain] afterExecute error in ${middleware.name}: ${error}`
        );
      }
    }
  }
}

/**
 * Create a new middleware chain.
 */
export function createMiddlewareChain(): MiddlewareChain {
  return new MiddlewareChain();
}
