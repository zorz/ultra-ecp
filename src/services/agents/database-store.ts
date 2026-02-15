/**
 * Agent Database Store
 *
 * SQLite-based persistence for agents, their state, and memory.
 * Integrates with the existing chat.db schema.
 */

import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { debugLog } from '../../debug.ts';
import type { AgentScope, AgentRuntimeStatus } from './types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stored agent record.
 */
export interface StoredAgent {
  id: string;
  roleType: string;
  name: string;
  description: string | null;
  scope: AgentScope;
  config: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/**
 * Stored agent state record.
 */
export interface StoredAgentState {
  agentId: string;
  status: AgentRuntimeStatus;
  currentAction: string | null;
  contextJson: string | null;
  updatedAt: number;
}

/**
 * Agent memory entry types.
 */
export type AgentMemoryType = 'fact' | 'instruction' | 'context' | 'conversation' | 'task';

/**
 * Stored agent memory record.
 */
export interface StoredAgentMemory {
  id: string;
  agentId: string;
  memoryType: AgentMemoryType;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: number;
  expiresAt: number | null;
}

/**
 * Agent metrics record.
 */
export interface StoredAgentMetrics {
  agentId: string;
  runCount: number;
  tasksCompleted: number;
  tasksFailed: number;
  totalTokens: number;
  avgResponseTimeMs: number;
  lastRunAt: number | null;
  updatedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

const AGENT_SCHEMA = `
-- Agents table - core agent definitions
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  role_type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  scope TEXT NOT NULL CHECK(scope IN ('global', 'project')),
  config JSON NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agents_role_type ON agents(role_type);
CREATE INDEX IF NOT EXISTS idx_agents_scope ON agents(scope);
CREATE INDEX IF NOT EXISTS idx_agents_updated ON agents(updated_at DESC);

-- Agent state table - runtime state (status, context)
CREATE TABLE IF NOT EXISTS agent_state (
  agent_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'thinking', 'executing', 'waiting', 'error', 'completed')),
  current_action TEXT,
  context_json TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_state_status ON agent_state(status);

-- Agent memory table - persistent memory entries
CREATE TABLE IF NOT EXISTS agent_memory (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  memory_type TEXT NOT NULL CHECK(memory_type IN ('fact', 'instruction', 'context', 'conversation', 'task')),
  content TEXT NOT NULL,
  metadata JSON,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_agent ON agent_memory(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_type ON agent_memory(agent_id, memory_type);
CREATE INDEX IF NOT EXISTS idx_agent_memory_expires ON agent_memory(expires_at);

-- Agent metrics table - usage statistics
CREATE TABLE IF NOT EXISTS agent_metrics (
  agent_id TEXT PRIMARY KEY,
  run_count INTEGER NOT NULL DEFAULT 0,
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  tasks_failed INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  avg_response_time_ms REAL NOT NULL DEFAULT 0,
  last_run_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- Agent messages table - inter-agent communication
CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  message_type TEXT NOT NULL,
  content TEXT NOT NULL,
  data JSON,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  FOREIGN KEY (from_agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (to_agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_to ON agent_messages(to_agent_id, acknowledged);
CREATE INDEX IF NOT EXISTS idx_agent_messages_from ON agent_messages(from_agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_messages_created ON agent_messages(created_at DESC);

-- Shared memory table - context shared between agents
CREATE TABLE IF NOT EXISTS agent_shared_memory (
  context_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSON NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  written_by TEXT NOT NULL,
  written_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (context_id, key),
  FOREIGN KEY (written_by) REFERENCES agents(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_shared_memory_context ON agent_shared_memory(context_id);
CREATE INDEX IF NOT EXISTS idx_agent_shared_memory_expires ON agent_shared_memory(expires_at);
`;

// ─────────────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────────────

function log(msg: string): void {
  debugLog(`[AgentDatabaseStore] ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Database Store Class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SQLite-based agent storage.
 */
export class AgentDatabaseStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.initSchema();
  }

  private initSchema(): void {
    // Run migrations first for existing databases
    this.runMigrations();
    // Then create schema for new databases
    this.db.exec(AGENT_SCHEMA);
    log('Schema initialized');
  }

  /**
   * Run database migrations for schema changes.
   */
  private runMigrations(): void {
    // Check if agents table exists
    const tableExists = this.db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='agents'"
    ).get();

    if (!tableExists) {
      // New database, no migrations needed
      return;
    }

    // Get current columns
    const columns = this.db.query<{ name: string }, []>(
      "PRAGMA table_info(agents)"
    ).all();
    const columnNames = new Set(columns.map(col => col.name));

    // Migration 1: Add role_type column if missing
    if (!columnNames.has('role_type')) {
      log('Migration: Adding role_type column to agents table');
      this.db.exec("ALTER TABLE agents ADD COLUMN role_type TEXT NOT NULL DEFAULT 'general'");
      log('Migration: role_type column added');
    }

    // Migration 2: Add scope column if missing
    if (!columnNames.has('scope')) {
      log('Migration: Adding scope column to agents table');
      this.db.exec("ALTER TABLE agents ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'");
      log('Migration: scope column added');
    }

    // Migration 3: Add config column if missing
    if (!columnNames.has('config')) {
      log('Migration: Adding config column to agents table');
      this.db.exec("ALTER TABLE agents ADD COLUMN config JSON NOT NULL DEFAULT '{}'");
      log('Migration: config column added');
    }

    // Migration 4: Add created_at column if missing
    if (!columnNames.has('created_at')) {
      log('Migration: Adding created_at column to agents table');
      const now = Date.now();
      this.db.exec(`ALTER TABLE agents ADD COLUMN created_at INTEGER NOT NULL DEFAULT ${now}`);
      log('Migration: created_at column added');
    }

    // Migration 5: Add updated_at column if missing
    if (!columnNames.has('updated_at')) {
      log('Migration: Adding updated_at column to agents table');
      const now = Date.now();
      this.db.exec(`ALTER TABLE agents ADD COLUMN updated_at INTEGER NOT NULL DEFAULT ${now}`);
      log('Migration: updated_at column added');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Agent CRUD Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a new agent.
   */
  createAgent(agent: Omit<StoredAgent, 'createdAt' | 'updatedAt'>): StoredAgent {
    const now = Date.now();
    const stored: StoredAgent = {
      ...agent,
      createdAt: now,
      updatedAt: now,
    };

    this.db.run(
      `INSERT INTO agents (id, role_type, name, description, scope, config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stored.id,
        stored.roleType,
        stored.name,
        stored.description,
        stored.scope,
        JSON.stringify(stored.config),
        stored.createdAt,
        stored.updatedAt,
      ]
    );

    // Initialize state and metrics
    this.db.run(
      `INSERT INTO agent_state (agent_id, status, updated_at) VALUES (?, 'idle', ?)`,
      [stored.id, now]
    );
    this.db.run(
      `INSERT INTO agent_metrics (agent_id, updated_at) VALUES (?, ?)`,
      [stored.id, now]
    );

    log(`Created agent: ${stored.id} (${stored.name})`);
    return stored;
  }

  /**
   * Get an agent by ID.
   */
  getAgent(id: string): StoredAgent | null {
    const row = this.db.query(
      `SELECT id, role_type, name, description, scope, config, created_at, updated_at
       FROM agents WHERE id = ?`
    ).get(id) as Record<string, unknown> | null;

    if (!row) return null;

    return {
      id: row.id as string,
      roleType: row.role_type as string,
      name: row.name as string,
      description: row.description as string | null,
      scope: row.scope as AgentScope,
      config: JSON.parse(row.config as string),
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  /**
   * Update an agent.
   */
  updateAgent(
    id: string,
    updates: Partial<Pick<StoredAgent, 'name' | 'description' | 'config'>>
  ): boolean {
    const now = Date.now();
    const sets: string[] = ['updated_at = ?'];
    const values: SQLQueryBindings[] = [now];

    if (updates.name !== undefined) {
      sets.push('name = ?');
      values.push(updates.name);
    }
    if (updates.description !== undefined) {
      sets.push('description = ?');
      values.push(updates.description);
    }
    if (updates.config !== undefined) {
      sets.push('config = ?');
      values.push(JSON.stringify(updates.config));
    }

    values.push(id);
    const result = this.db.run(
      `UPDATE agents SET ${sets.join(', ')} WHERE id = ?`,
      values
    );

    const updated = (result as { changes?: number })?.changes === 1;
    if (updated) {
      log(`Updated agent: ${id}`);
    }
    return updated;
  }

  /**
   * Delete an agent.
   */
  deleteAgent(id: string): boolean {
    const result = this.db.run('DELETE FROM agents WHERE id = ?', [id]);
    const deleted = (result as { changes?: number })?.changes === 1;
    if (deleted) {
      log(`Deleted agent: ${id}`);
    }
    return deleted;
  }

  /**
   * List agents with optional filters.
   */
  listAgents(options: {
    roleType?: string;
    scope?: AgentScope;
    limit?: number;
    offset?: number;
  } = {}): { agents: StoredAgent[]; total: number } {
    const { roleType, scope, limit = 50, offset = 0 } = options;

    let countQuery = 'SELECT COUNT(*) as count FROM agents WHERE 1=1';
    let query = `
      SELECT id, role_type, name, description, scope, config, created_at, updated_at
      FROM agents WHERE 1=1
    `;
    const values: SQLQueryBindings[] = [];

    if (roleType) {
      countQuery += ' AND role_type = ?';
      query += ' AND role_type = ?';
      values.push(roleType);
    }
    if (scope) {
      countQuery += ' AND scope = ?';
      query += ' AND scope = ?';
      values.push(scope);
    }

    const countRow = this.db.query(countQuery).get(...values) as { count: number };
    const total = countRow.count;

    query += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
    const queryValues = [...values, limit, offset];

    const rows = this.db.query(query).all(...queryValues) as Array<Record<string, unknown>>;

    const agents = rows.map((row) => ({
      id: row.id as string,
      roleType: row.role_type as string,
      name: row.name as string,
      description: row.description as string | null,
      scope: row.scope as AgentScope,
      config: JSON.parse(row.config as string),
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }));

    return { agents, total };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Agent State Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get agent state.
   */
  getAgentState(agentId: string): StoredAgentState | null {
    const row = this.db.query(
      `SELECT agent_id, status, current_action, context_json, updated_at
       FROM agent_state WHERE agent_id = ?`
    ).get(agentId) as Record<string, unknown> | null;

    if (!row) return null;

    return {
      agentId: row.agent_id as string,
      status: row.status as AgentRuntimeStatus,
      currentAction: row.current_action as string | null,
      contextJson: row.context_json as string | null,
      updatedAt: row.updated_at as number,
    };
  }

  /**
   * Update agent state.
   */
  updateAgentState(
    agentId: string,
    updates: Partial<Pick<StoredAgentState, 'status' | 'currentAction' | 'contextJson'>>
  ): void {
    const now = Date.now();
    const sets: string[] = ['updated_at = ?'];
    const values: SQLQueryBindings[] = [now];

    if (updates.status !== undefined) {
      sets.push('status = ?');
      values.push(updates.status);
    }
    if (updates.currentAction !== undefined) {
      sets.push('current_action = ?');
      values.push(updates.currentAction);
    }
    if (updates.contextJson !== undefined) {
      sets.push('context_json = ?');
      values.push(updates.contextJson);
    }

    values.push(agentId);
    this.db.run(
      `UPDATE agent_state SET ${sets.join(', ')} WHERE agent_id = ?`,
      values
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Agent Memory Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Add a memory entry.
   */
  addMemory(memory: Omit<StoredAgentMemory, 'createdAt'>): StoredAgentMemory {
    const now = Date.now();
    const stored: StoredAgentMemory = {
      ...memory,
      createdAt: now,
    };

    this.db.run(
      `INSERT INTO agent_memory (id, agent_id, memory_type, content, metadata, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        stored.id,
        stored.agentId,
        stored.memoryType,
        stored.content,
        stored.metadata ? JSON.stringify(stored.metadata) : null,
        stored.createdAt,
        stored.expiresAt,
      ]
    );

    log(`Added memory for agent ${stored.agentId}: ${stored.memoryType}`);
    return stored;
  }

  /**
   * Get memory entries for an agent.
   */
  getMemory(
    agentId: string,
    options: {
      memoryType?: AgentMemoryType;
      limit?: number;
      includeExpired?: boolean;
    } = {}
  ): StoredAgentMemory[] {
    const { memoryType, limit = 100, includeExpired = false } = options;
    const now = Date.now();

    let query = `
      SELECT id, agent_id, memory_type, content, metadata, created_at, expires_at
      FROM agent_memory
      WHERE agent_id = ?
    `;
    const values: SQLQueryBindings[] = [agentId];

    if (memoryType) {
      query += ' AND memory_type = ?';
      values.push(memoryType);
    }
    if (!includeExpired) {
      query += ' AND (expires_at IS NULL OR expires_at > ?)';
      values.push(now);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    values.push(limit);

    const rows = this.db.query(query).all(...values) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      agentId: row.agent_id as string,
      memoryType: row.memory_type as AgentMemoryType,
      content: row.content as string,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
      createdAt: row.created_at as number,
      expiresAt: row.expires_at as number | null,
    }));
  }

  /**
   * Delete a memory entry.
   */
  deleteMemory(id: string): boolean {
    const result = this.db.run('DELETE FROM agent_memory WHERE id = ?', [id]);
    return (result as { changes?: number })?.changes === 1;
  }

  /**
   * Clear all memory for an agent.
   */
  clearMemory(agentId: string, memoryType?: AgentMemoryType): number {
    let query = 'DELETE FROM agent_memory WHERE agent_id = ?';
    const values: SQLQueryBindings[] = [agentId];

    if (memoryType) {
      query += ' AND memory_type = ?';
      values.push(memoryType);
    }

    const result = this.db.run(query, values);
    return (result as { changes?: number })?.changes ?? 0;
  }

  /**
   * Clean up expired memory entries.
   */
  cleanupExpiredMemory(): number {
    const now = Date.now();
    const result = this.db.run(
      'DELETE FROM agent_memory WHERE expires_at IS NOT NULL AND expires_at <= ?',
      [now]
    );
    const count = (result as { changes?: number })?.changes ?? 0;
    if (count > 0) {
      log(`Cleaned up ${count} expired memory entries`);
    }
    return count;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Agent Metrics Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get agent metrics.
   */
  getMetrics(agentId: string): StoredAgentMetrics | null {
    const row = this.db.query(
      `SELECT agent_id, run_count, tasks_completed, tasks_failed, total_tokens,
              avg_response_time_ms, last_run_at, updated_at
       FROM agent_metrics WHERE agent_id = ?`
    ).get(agentId) as Record<string, unknown> | null;

    if (!row) return null;

    return {
      agentId: row.agent_id as string,
      runCount: row.run_count as number,
      tasksCompleted: row.tasks_completed as number,
      tasksFailed: row.tasks_failed as number,
      totalTokens: row.total_tokens as number,
      avgResponseTimeMs: row.avg_response_time_ms as number,
      lastRunAt: row.last_run_at as number | null,
      updatedAt: row.updated_at as number,
    };
  }

  /**
   * Record a completed run.
   */
  recordRun(
    agentId: string,
    options: {
      success: boolean;
      tokens?: number;
      responseTimeMs?: number;
    }
  ): void {
    const now = Date.now();
    const { success, tokens = 0, responseTimeMs = 0 } = options;

    // Get current metrics to calculate new average
    const current = this.getMetrics(agentId);
    if (!current) return;

    const newRunCount = current.runCount + 1;
    const newAvgResponseTime =
      (current.avgResponseTimeMs * current.runCount + responseTimeMs) / newRunCount;

    this.db.run(
      `UPDATE agent_metrics SET
        run_count = run_count + 1,
        tasks_completed = tasks_completed + ?,
        tasks_failed = tasks_failed + ?,
        total_tokens = total_tokens + ?,
        avg_response_time_ms = ?,
        last_run_at = ?,
        updated_at = ?
       WHERE agent_id = ?`,
      [
        success ? 1 : 0,
        success ? 0 : 1,
        tokens,
        newAvgResponseTime,
        now,
        now,
        agentId,
      ]
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Agent Messages Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Send a message between agents.
   */
  sendMessage(message: {
    id: string;
    fromAgentId: string;
    toAgentId: string;
    messageType: string;
    content: string;
    data?: unknown;
  }): void {
    const now = Date.now();

    this.db.run(
      `INSERT INTO agent_messages (id, from_agent_id, to_agent_id, message_type, content, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        message.id,
        message.fromAgentId,
        message.toAgentId,
        message.messageType,
        message.content,
        message.data ? JSON.stringify(message.data) : null,
        now,
      ]
    );

    log(`Message sent: ${message.fromAgentId} -> ${message.toAgentId}`);
  }

  /**
   * Get messages for an agent.
   */
  getMessages(
    agentId: string,
    options: { pendingOnly?: boolean; limit?: number } = {}
  ): Array<{
    id: string;
    fromAgentId: string;
    toAgentId: string;
    messageType: string;
    content: string;
    data: unknown | null;
    acknowledged: boolean;
    createdAt: number;
    acknowledgedAt: number | null;
  }> {
    const { pendingOnly = false, limit = 50 } = options;

    let query = `
      SELECT id, from_agent_id, to_agent_id, message_type, content, data,
             acknowledged, created_at, acknowledged_at
      FROM agent_messages
      WHERE to_agent_id = ?
    `;
    const values: SQLQueryBindings[] = [agentId];

    if (pendingOnly) {
      query += ' AND acknowledged = 0';
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    values.push(limit);

    const rows = this.db.query(query).all(...values) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      fromAgentId: row.from_agent_id as string,
      toAgentId: row.to_agent_id as string,
      messageType: row.message_type as string,
      content: row.content as string,
      data: row.data ? JSON.parse(row.data as string) : null,
      acknowledged: Boolean(row.acknowledged),
      createdAt: row.created_at as number,
      acknowledgedAt: row.acknowledged_at as number | null,
    }));
  }

  /**
   * Acknowledge a message.
   */
  acknowledgeMessage(messageId: string): void {
    const now = Date.now();
    this.db.run(
      'UPDATE agent_messages SET acknowledged = 1, acknowledged_at = ? WHERE id = ?',
      [now, messageId]
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Shared Memory Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get a shared memory value.
   */
  getSharedMemory(
    contextId: string,
    key: string
  ): { value: unknown; version: number; writtenBy: string; writtenAt: number } | null {
    const now = Date.now();

    const row = this.db.query(
      `SELECT value, version, written_by, written_at
       FROM agent_shared_memory
       WHERE context_id = ? AND key = ?
         AND (expires_at IS NULL OR expires_at > ?)`
    ).get(contextId, key, now) as Record<string, unknown> | null;

    if (!row) return null;

    return {
      value: JSON.parse(row.value as string),
      version: row.version as number,
      writtenBy: row.written_by as string,
      writtenAt: row.written_at as number,
    };
  }

  /**
   * Set a shared memory value.
   */
  setSharedMemory(
    contextId: string,
    key: string,
    value: unknown,
    writtenBy: string,
    ttl?: number
  ): { version: number } {
    const now = Date.now();
    const expiresAt = ttl ? now + ttl : null;

    // Get current version
    const current = this.db.query(
      'SELECT version FROM agent_shared_memory WHERE context_id = ? AND key = ?'
    ).get(contextId, key) as { version: number } | null;

    const newVersion = (current?.version ?? 0) + 1;

    this.db.run(
      `INSERT INTO agent_shared_memory (context_id, key, value, version, written_by, written_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(context_id, key) DO UPDATE SET
         value = excluded.value,
         version = excluded.version,
         written_by = excluded.written_by,
         written_at = excluded.written_at,
         expires_at = excluded.expires_at`,
      [contextId, key, JSON.stringify(value), newVersion, writtenBy, now, expiresAt]
    );

    return { version: newVersion };
  }

  /**
   * Delete a shared memory value.
   */
  deleteSharedMemory(contextId: string, key: string): boolean {
    const result = this.db.run(
      'DELETE FROM agent_shared_memory WHERE context_id = ? AND key = ?',
      [contextId, key]
    );
    return (result as { changes?: number })?.changes === 1;
  }

  /**
   * List all keys in a shared memory context.
   */
  listSharedMemoryKeys(contextId: string): string[] {
    const now = Date.now();
    const rows = this.db.query(
      `SELECT key FROM agent_shared_memory
       WHERE context_id = ? AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY key`
    ).all(contextId, now) as Array<{ key: string }>;

    return rows.map((r) => r.key);
  }

  /**
   * Clean up expired shared memory entries.
   */
  cleanupExpiredSharedMemory(): number {
    const now = Date.now();
    const result = this.db.run(
      'DELETE FROM agent_shared_memory WHERE expires_at IS NOT NULL AND expires_at <= ?',
      [now]
    );
    const count = (result as { changes?: number })?.changes ?? 0;
    if (count > 0) {
      log(`Cleaned up ${count} expired shared memory entries`);
    }
    return count;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Full Agent with State/Metrics
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get agent with all related data.
   */
  getAgentFull(id: string): {
    agent: StoredAgent;
    state: StoredAgentState;
    metrics: StoredAgentMetrics;
  } | null {
    const agent = this.getAgent(id);
    if (!agent) return null;

    const state = this.getAgentState(id);
    const metrics = this.getMetrics(id);

    if (!state || !metrics) return null;

    return { agent, state, metrics };
  }

  /**
   * List agents with state for display.
   */
  listAgentsWithState(options: {
    roleType?: string;
    scope?: AgentScope;
    status?: AgentRuntimeStatus;
    limit?: number;
    offset?: number;
  } = {}): Array<{
    agent: StoredAgent;
    state: StoredAgentState;
    metrics: StoredAgentMetrics;
  }> {
    const { roleType, scope, status, limit = 50, offset = 0 } = options;

    let query = `
      SELECT
        a.id, a.role_type, a.name, a.description, a.scope, a.config, a.created_at, a.updated_at,
        s.status, s.current_action, s.context_json, s.updated_at as state_updated_at,
        m.run_count, m.tasks_completed, m.tasks_failed, m.total_tokens, m.avg_response_time_ms, m.last_run_at
      FROM agents a
      LEFT JOIN agent_state s ON a.id = s.agent_id
      LEFT JOIN agent_metrics m ON a.id = m.agent_id
      WHERE 1=1
    `;
    const values: SQLQueryBindings[] = [];

    if (roleType) {
      query += ' AND a.role_type = ?';
      values.push(roleType);
    }
    if (scope) {
      query += ' AND a.scope = ?';
      values.push(scope);
    }
    if (status) {
      query += ' AND s.status = ?';
      values.push(status);
    }

    query += ' ORDER BY a.updated_at DESC LIMIT ? OFFSET ?';
    values.push(limit, offset);

    const rows = this.db.query(query).all(...values) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      agent: {
        id: row.id as string,
        roleType: row.role_type as string,
        name: row.name as string,
        description: row.description as string | null,
        scope: row.scope as AgentScope,
        config: JSON.parse(row.config as string),
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
      },
      state: {
        agentId: row.id as string,
        status: (row.status as AgentRuntimeStatus) ?? 'idle',
        currentAction: row.current_action as string | null,
        contextJson: row.context_json as string | null,
        updatedAt: row.state_updated_at as number,
      },
      metrics: {
        agentId: row.id as string,
        runCount: (row.run_count as number) ?? 0,
        tasksCompleted: (row.tasks_completed as number) ?? 0,
        tasksFailed: (row.tasks_failed as number) ?? 0,
        totalTokens: (row.total_tokens as number) ?? 0,
        avgResponseTimeMs: (row.avg_response_time_ms as number) ?? 0,
        lastRunAt: row.last_run_at as number | null,
        updatedAt: row.updated_at as number,
      },
    }));
  }
}
