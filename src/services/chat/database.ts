/**
 * ChatDatabase - Unified Database Layer
 *
 * Replaces the legacy ChatStorage with a clean, unified database interface.
 * Handles database lifecycle: creation, backup, migration, and access.
 *
 * On initialization:
 * - If no database exists, creates fresh with unified schema
 * - If old schema detected (missing unified tables), backs up and creates fresh
 * - If unified schema present, opens normally and runs pending migrations
 */

import { Database } from 'bun:sqlite';
import { join } from 'path';
import { mkdir, rename, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import { debugLog } from '../../debug.ts';
import { migrations } from './migrations/index.ts';
import { migrateUp } from './migrations/runner.ts';

const DB_DIR = '.ultra';
const DB_FILE = 'chat.db';

/**
 * ChatDatabase manages the SQLite connection and schema lifecycle.
 */
export class ChatDatabase {
  private db: Database | null = null;
  private dbPath: string;
  private workspacePath: string;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.dbPath = join(workspacePath, DB_DIR, DB_FILE);
  }

  /**
   * Initialize the database - handles backup and migration.
   */
  async init(): Promise<void> {
    const dbDir = join(this.workspacePath, DB_DIR);

    // Ensure .ultra directory exists
    await mkdir(dbDir, { recursive: true });

    // Check if database exists and needs migration
    if (existsSync(this.dbPath)) {
      await this.handleExistingDatabase();
    } else {
      await this.createFreshDatabase();
    }
  }

  /**
   * Handle an existing database - backup if old schema, migrate if needed.
   */
  private async handleExistingDatabase(): Promise<void> {
    // Open temporarily to check schema state
    const checkDb = new Database(this.dbPath, { readonly: true });
    let hasUnifiedSchema = false;

    try {
      // Check if the unified schema tables actually exist.
      // We can't rely on version numbers alone because old databases may have
      // schema_migrations entries from legacy migrations (001-006) that used
      // the same version numbers. The old migration 5 is different from the
      // current unified migration005, so checking for a key unified table
      // is more reliable.
      const result = checkDb.query(
        "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='sessions'"
      ).get() as { count: number };
      hasUnifiedSchema = result.count > 0;
    } catch {
      // If we can't query, treat as needing fresh creation
      hasUnifiedSchema = false;
    } finally {
      checkDb.close();
    }

    if (!hasUnifiedSchema) {
      // Back up old database and create fresh with unified schema
      debugLog('[ChatDatabase] Unified schema not detected (missing sessions table), backing up and creating fresh');
      await this.backupAndCreateFresh();
    } else {
      // Open normally - unified schema exists
      this.db = new Database(this.dbPath);
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA foreign_keys = ON');

      // Run any pending migrations
      const result = migrateUp(this.db, migrations);
      if (!result.success) {
        throw new Error(`Migration failed: ${result.error}`);
      }
    }
  }

  /**
   * Back up old database and create a fresh one.
   */
  private async backupAndCreateFresh(): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${this.dbPath}.backup-${timestamp}`;

    debugLog(`[ChatDatabase] Backing up ${this.dbPath} to ${backupPath}`);

    try {
      await copyFile(this.dbPath, backupPath);
      debugLog(`[ChatDatabase] Backup created at ${backupPath}`);
    } catch (err) {
      debugLog(`[ChatDatabase] Warning: backup failed, renaming instead: ${err}`);
      try {
        await rename(this.dbPath, backupPath);
      } catch (renameErr) {
        debugLog(`[ChatDatabase] Warning: rename also failed: ${renameErr}`);
      }
    }

    // Remove old database files (WAL, SHM)
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${this.dbPath}${suffix}`;
      if (existsSync(file)) {
        try {
          const { unlink } = await import('fs/promises');
          await unlink(file);
        } catch {
          // Best effort
        }
      }
    }

    await this.createFreshDatabase();
  }

  /**
   * Create a fresh database with the unified schema.
   */
  private async createFreshDatabase(): Promise<void> {
    debugLog('[ChatDatabase] Creating fresh database with unified schema');

    this.db = new Database(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');

    const result = migrateUp(this.db, migrations);
    if (!result.success) {
      throw new Error(`Fresh database migration failed: ${result.error}`);
    }

    debugLog(`[ChatDatabase] Fresh database created at version ${result.toVersion}`);
  }

  /**
   * Get the underlying Database instance.
   * Throws if not initialized.
   */
  getDb(): Database {
    if (!this.db) {
      throw new Error('ChatDatabase not initialized. Call init() first.');
    }
    return this.db;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Check if the database is initialized and open.
   */
  isOpen(): boolean {
    return this.db !== null;
  }

  /**
   * Get the database file path.
   */
  getPath(): string {
    return this.dbPath;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton Management
// ─────────────────────────────────────────────────────────────────────────────

const instances = new Map<string, ChatDatabase>();

/**
 * Get or create a ChatDatabase instance for a workspace.
 */
export async function getChatDatabase(workspacePath: string): Promise<ChatDatabase> {
  const existing = instances.get(workspacePath);
  if (existing?.isOpen()) {
    return existing;
  }

  const db = new ChatDatabase(workspacePath);
  await db.init();
  instances.set(workspacePath, db);
  return db;
}

/**
 * Close a specific ChatDatabase instance.
 */
export function closeChatDatabase(workspacePath: string): void {
  const instance = instances.get(workspacePath);
  if (instance) {
    instance.close();
    instances.delete(workspacePath);
  }
}

/**
 * Close all ChatDatabase instances.
 */
export function closeAllChatDatabases(): void {
  for (const [path, instance] of instances) {
    instance.close();
    instances.delete(path);
  }
}
