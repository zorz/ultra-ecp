/**
 * Migration Runner
 *
 * Applies database schema migrations with version tracking.
 * Supports up/down migrations for safe rollback.
 */

import { Database } from 'bun:sqlite';
import { debugLog } from '../../../debug.ts';

/**
 * Migration interface for individual migrations.
 */
export interface Migration {
  /** Migration version number */
  version: number;
  /** Human-readable name */
  name: string;
  /** Apply the migration */
  up(db: Database): void;
  /** Rollback the migration */
  down(db: Database): void;
}

/**
 * Migration status returned by getMigrationStatus.
 */
export interface MigrationStatus {
  currentVersion: number;
  pendingMigrations: Migration[];
  appliedMigrations: number[];
}

/**
 * Migration result.
 */
export interface MigrationResult {
  success: boolean;
  fromVersion: number;
  toVersion: number;
  appliedMigrations: number[];
  error?: string;
}

/**
 * Initialize migration tracking table.
 */
export function initMigrations(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);
}

/**
 * Get current schema version.
 */
export function getCurrentVersion(db: Database): number {
  initMigrations(db);

  const result = db.query('SELECT MAX(version) as version FROM schema_migrations').get() as { version: number | null };
  return result?.version ?? 0;
}

/**
 * Check if a specific migration has been applied.
 */
export function isMigrationApplied(db: Database, version: number): boolean {
  initMigrations(db);

  const result = db.query('SELECT 1 FROM schema_migrations WHERE version = ?').get(version);
  return result !== null;
}

/**
 * Record that a migration was applied.
 */
function recordMigration(db: Database, migration: Migration): void {
  db.run(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
    [migration.version, migration.name, Date.now()]
  );
}

/**
 * Remove a migration record (for rollback).
 */
function removeMigrationRecord(db: Database, version: number): void {
  db.run('DELETE FROM schema_migrations WHERE version = ?', [version]);
}

/**
 * Get migration status.
 */
export function getMigrationStatus(db: Database, migrations: Migration[]): MigrationStatus {
  const currentVersion = getCurrentVersion(db);

  // Get all applied versions
  initMigrations(db);
  const appliedRows = db.query('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
  const appliedMigrations = appliedRows.map((r) => r.version);

  // Find pending migrations
  const pendingMigrations = migrations.filter((m) => !appliedMigrations.includes(m.version));

  return {
    currentVersion,
    pendingMigrations,
    appliedMigrations,
  };
}

/**
 * Apply all pending migrations.
 */
export function migrateUp(db: Database, migrations: Migration[]): MigrationResult {
  const status = getMigrationStatus(db, migrations);
  const fromVersion = status.currentVersion;
  const appliedMigrations: number[] = [];

  // Sort pending migrations by version
  const pending = [...status.pendingMigrations].sort((a, b) => a.version - b.version);

  try {
    for (const migration of pending) {
      debugLog(`[Migration] Applying: ${migration.version} - ${migration.name}`);

      // Run in transaction
      db.run('BEGIN TRANSACTION');
      try {
        migration.up(db);
        recordMigration(db, migration);
        db.run('COMMIT');
        appliedMigrations.push(migration.version);
        debugLog(`[Migration] Applied: ${migration.version}`);
      } catch (error) {
        db.run('ROLLBACK');
        throw error;
      }
    }

    const toVersion = appliedMigrations.length > 0 ? Math.max(...appliedMigrations) : fromVersion;

    return {
      success: true,
      fromVersion,
      toVersion,
      appliedMigrations,
    };
  } catch (error) {
    return {
      success: false,
      fromVersion,
      toVersion: appliedMigrations.length > 0 ? Math.max(...appliedMigrations) : fromVersion,
      appliedMigrations,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Rollback to a specific version.
 */
export function migrateDown(db: Database, migrations: Migration[], targetVersion: number): MigrationResult {
  const status = getMigrationStatus(db, migrations);
  const fromVersion = status.currentVersion;
  const rolledBack: number[] = [];

  // Get migrations to rollback (in reverse order)
  const toRollback = migrations
    .filter((m) => status.appliedMigrations.includes(m.version) && m.version > targetVersion)
    .sort((a, b) => b.version - a.version);

  try {
    for (const migration of toRollback) {
      debugLog(`[Migration] Rolling back: ${migration.version} - ${migration.name}`);

      // Run in transaction
      db.run('BEGIN TRANSACTION');
      try {
        migration.down(db);
        removeMigrationRecord(db, migration.version);
        db.run('COMMIT');
        rolledBack.push(migration.version);
        debugLog(`[Migration] Rolled back: ${migration.version}`);
      } catch (error) {
        db.run('ROLLBACK');
        throw error;
      }
    }

    return {
      success: true,
      fromVersion,
      toVersion: targetVersion,
      appliedMigrations: rolledBack,
    };
  } catch (error) {
    const currentVersion = getCurrentVersion(db);
    return {
      success: false,
      fromVersion,
      toVersion: currentVersion,
      appliedMigrations: rolledBack,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Migrate to a specific version (up or down).
 */
export function migrateTo(db: Database, migrations: Migration[], targetVersion: number): MigrationResult {
  const currentVersion = getCurrentVersion(db);

  if (targetVersion > currentVersion) {
    // Filter to only migrations up to target
    const migrationsToApply = migrations.filter((m) => m.version <= targetVersion);
    return migrateUp(db, migrationsToApply);
  } else if (targetVersion < currentVersion) {
    return migrateDown(db, migrations, targetVersion);
  }

  // Already at target version
  return {
    success: true,
    fromVersion: currentVersion,
    toVersion: currentVersion,
    appliedMigrations: [],
  };
}

/**
 * Validate migrations array.
 */
export function validateMigrations(migrations: Migration[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const versions = new Set<number>();

  for (const migration of migrations) {
    if (versions.has(migration.version)) {
      errors.push(`Duplicate migration version: ${migration.version}`);
    }
    versions.add(migration.version);

    if (migration.version <= 0) {
      errors.push(`Invalid migration version: ${migration.version} (must be positive)`);
    }

    if (!migration.name || migration.name.trim() === '') {
      errors.push(`Migration ${migration.version} has no name`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
