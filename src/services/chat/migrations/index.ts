/**
 * Chat Database Migrations
 *
 * Export all migrations in version order.
 *
 * NOTE: Migration 005 is a clean break. For new databases, only migration 005
 * is applied. For existing databases (version < 5), the database file is
 * backed up and a fresh one is created with migration 005.
 */

export * from './runner.ts';

// Legacy migrations (kept for reference, not applied to new databases)
// import { migration001WorkflowSchema } from './001-workflow-schema.ts';
// import { migration002ExecutionMessages } from './002-execution-messages.ts';
// import { migration003AgentRegistry } from './003-agent-registry.ts';
// import { migration004ReviewPanel } from './004-review-panel.ts';

// Unified schema (clean break)
import { migration005UnifiedSchema } from './005-unified-schema.ts';
// Incremental migrations
import { migration006PersonaAgency } from './006-persona-agency.ts';
import type { Migration } from './runner.ts';

/**
 * All available migrations for new databases.
 * Unified schema + incremental migrations.
 */
export const migrations: Migration[] = [
  migration005UnifiedSchema,
  migration006PersonaAgency,
];

/**
 * Get migrations up to a specific version.
 */
export function getMigrationsUpTo(targetVersion: number): Migration[] {
  return migrations.filter((m) => m.version <= targetVersion);
}

/**
 * Get the latest migration version.
 */
export function getLatestVersion(): number {
  if (migrations.length === 0) return 0;
  return Math.max(...migrations.map((m) => m.version));
}

/**
 * Schema version that represents the clean break.
 * Any database with a version below this needs backup + fresh creation.
 */
export const UNIFIED_SCHEMA_VERSION = 5;
