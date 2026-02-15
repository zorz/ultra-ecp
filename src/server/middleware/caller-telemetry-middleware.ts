/**
 * Caller Telemetry Middleware
 *
 * Minimal logging for caller context on mutating operations.
 *
 * Phase 2 requirement: log caller.type + agentId (if present) so we can
 * verify requests are correctly tagged without changing behavior.
 */

import { debugLog } from '../../debug.ts';
import type { ECPMiddleware, MiddlewareContext, MiddlewareResult } from './types.ts';

const MUTATING_FILE_METHODS = new Set([
  'file/write',
  'file/edit',
  'file/delete',
  'file/deleteDir',
  'file/rename',
  'file/create',
  'file/createDir',
  'file/createDirectory',
]);

function getCaller(ctx: MiddlewareContext): { type: 'human' } | { type: 'agent'; agentId?: string; executionId?: string } {
  const asserted = ctx.metadata['caller'] as Record<string, unknown> | undefined;
  if (asserted?.type === 'agent') {
    return {
      type: 'agent',
      agentId: typeof asserted.agentId === 'string' ? asserted.agentId : undefined,
      executionId: typeof asserted.executionId === 'string' ? asserted.executionId : undefined,
    };
  }
  return { type: 'human' };
}

export class CallerTelemetryMiddleware implements ECPMiddleware {
  name = 'caller-telemetry';
  priority = 20;

  appliesTo(method: string): boolean {
    // Keep minimal: only file mutations for now.
    return MUTATING_FILE_METHODS.has(method);
  }

  async validate(_ctx: MiddlewareContext): Promise<MiddlewareResult> {
    return { allowed: true };
  }

  async afterExecute(ctx: MiddlewareContext, _result: unknown): Promise<void> {
    const caller = getCaller(ctx);
    if (caller.type === 'agent') {
      debugLog(`[ECP] ${ctx.method} caller=agent agentId=${caller.agentId ?? 'unknown'} executionId=${caller.executionId ?? ''}`);
    } else {
      debugLog(`[ECP] ${ctx.method} caller=human`);
    }
  }
}

export function createCallerTelemetryMiddleware(): CallerTelemetryMiddleware {
  return new CallerTelemetryMiddleware();
}
