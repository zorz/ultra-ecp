/**
 * Test Utilities for Chat Service Tests
 *
 * Provides helper functions and database setup for testing chat stores.
 * Uses the unified schema from migration 005.
 */

import { Database } from 'bun:sqlite';
import { migration005UnifiedSchema } from '../../../src/services/chat/migrations/005-unified-schema.ts';

/**
 * Create a fresh in-memory test database with the unified schema.
 */
export function createTestDatabase(): Database {
  const db = new Database(':memory:');

  // Enable foreign keys
  db.run('PRAGMA foreign_keys = ON');

  // Run unified schema migration
  migration005UnifiedSchema.up(db);

  return db;
}

/**
 * Create a test session with default values.
 */
export function createTestSession(
  db: Database,
  overrides: Partial<{
    id: string;
    title: string | null;
    systemPrompt: string | null;
    provider: string;
    model: string;
    status: string;
    createdAt: number;
    updatedAt: number;
  }> = {}
): string {
  const now = Date.now();
  const id = overrides.id ?? crypto.randomUUID();

  db.run(
    `INSERT INTO sessions (id, title, system_prompt, provider, model, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      overrides.title ?? null,
      overrides.systemPrompt ?? null,
      overrides.provider ?? 'claude',
      overrides.model ?? 'claude-sonnet-4-20250514',
      overrides.status ?? 'active',
      overrides.createdAt ?? now,
      overrides.updatedAt ?? now,
    ]
  );

  return id;
}

/**
 * Create a test message with default values.
 */
export function createTestMessage(
  db: Database,
  sessionId: string,
  overrides: Partial<{
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    model: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    durationMs: number | null;
    createdAt: number;
    agentId: string | null;
    agentName: string | null;
  }> = {}
): string {
  const now = Date.now();
  const id = overrides.id ?? crypto.randomUUID();

  db.run(
    `INSERT INTO messages (id, session_id, role, content, model, input_tokens, output_tokens, duration_ms, created_at, agent_id, agent_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      sessionId,
      overrides.role ?? 'user',
      overrides.content ?? 'Test message',
      overrides.model ?? null,
      overrides.inputTokens ?? null,
      overrides.outputTokens ?? null,
      overrides.durationMs ?? null,
      overrides.createdAt ?? now,
      overrides.agentId ?? null,
      overrides.agentName ?? null,
    ]
  );

  return id;
}

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
