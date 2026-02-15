/**
 * Settings Snapshot Middleware
 *
 * Captures ECP config settings into ctx.metadata so downstream middleware
 * can make decisions without reaching into adapters/services.
 */

import type { ECPMiddleware, MiddlewareContext, MiddlewareResult } from './types.ts';

/**
 * Settings provider interface.
 * Injected at construction time so this middleware doesn't import config/ directly.
 */
export interface SettingsProvider {
  getAll(): Record<string, unknown>;
}

export class SettingsSnapshotMiddleware implements ECPMiddleware {
  name = 'settings-snapshot';
  priority = 10;

  constructor(private settingsProvider: SettingsProvider) {}

  appliesTo(_method: string): boolean {
    // Cheap enough to run for all requests.
    return true;
  }

  async validate(ctx: MiddlewareContext): Promise<MiddlewareResult> {
    // Snapshot current settings at request time.
    ctx.metadata['settings'] = this.settingsProvider.getAll();

    // Caller identity is asserted by the server boundary.
    // We mirror it into metadata for downstream middleware.
    const p = (ctx.params ?? {}) as Record<string, unknown>;
    if (p.caller && typeof p.caller === 'object') {
      ctx.metadata['caller'] = p.caller;
    }

    return { allowed: true };
  }
}

export function createSettingsSnapshotMiddleware(provider: SettingsProvider): SettingsSnapshotMiddleware {
  return new SettingsSnapshotMiddleware(provider);
}
