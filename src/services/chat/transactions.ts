/**
 * Transaction Utilities for Chat Storage
 *
 * Provides atomic transaction wrappers for bun:sqlite operations.
 * Ensures multi-statement operations complete atomically or roll back entirely.
 */

import { Database } from 'bun:sqlite';

/**
 * Execute a function within a database transaction.
 * If the function throws, the transaction is rolled back.
 * If the function succeeds, the transaction is committed.
 *
 * Uses IMMEDIATE mode to acquire a write lock at the start,
 * preventing deadlocks when upgrading from a read lock.
 *
 * @example
 * ```typescript
 * withTransaction(db, () => {
 *   db.run('DELETE FROM todos WHERE session_id = ?', [sessionId]);
 *   for (const todo of todos) {
 *     db.run('INSERT INTO todos ...', [...]);
 *   }
 * });
 * ```
 */
export function withTransaction<T>(db: Database, fn: () => T): T {
  db.run('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.run('COMMIT');
    return result;
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

/**
 * Execute an async function within a database transaction.
 * Note: SQLite is synchronous, but this wrapper allows async
 * operations between database calls within the transaction.
 *
 * IMPORTANT: The database lock is held for the entire duration
 * of the async operation. Keep async work minimal to avoid
 * blocking other connections.
 *
 * @example
 * ```typescript
 * await withTransactionAsync(db, async () => {
 *   const data = await fetchExternalData();
 *   db.run('INSERT INTO table ...', [data]);
 * });
 * ```
 */
export async function withTransactionAsync<T>(
  db: Database,
  fn: () => Promise<T>
): Promise<T> {
  db.run('BEGIN IMMEDIATE');
  try {
    const result = await fn();
    db.run('COMMIT');
    return result;
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

/**
 * Check if we're currently inside a transaction.
 * Useful for nested operations that should not start a new transaction.
 */
export function isInTransaction(db: Database): boolean {
  // SQLite's autocommit is 0 when inside a transaction
  const result = db.query('PRAGMA autocommit').get() as { autocommit: number } | null;
  return result?.autocommit === 0;
}

/**
 * Execute a function within a transaction, unless already in one.
 * This is useful for methods that can be called standalone or as part
 * of a larger transaction.
 *
 * @example
 * ```typescript
 * // Can be called directly (will create transaction)
 * maybeTransaction(db, () => doWork());
 *
 * // Or within an existing transaction (will reuse it)
 * withTransaction(db, () => {
 *   maybeTransaction(db, () => doWork()); // No nested transaction
 * });
 * ```
 */
export function maybeTransaction<T>(db: Database, fn: () => T): T {
  if (isInTransaction(db)) {
    // Already in a transaction, just run the function
    return fn();
  }
  // Not in a transaction, wrap it
  return withTransaction(db, fn);
}
