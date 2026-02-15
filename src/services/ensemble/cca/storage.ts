/**
 * CCA Session Storage
 *
 * SQLite-based storage for CCA sessions with JSON columns for flexible data.
 * Enables session resume, time travel, and queryable context for agents.
 */

import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { debugLog, isDebugEnabled } from '../../../debug.ts';

// ============================================
// Types
// ============================================

/**
 * Stored session record.
 */
export interface StoredSession {
  id: string;
  task: string;
  status: 'idle' | 'running' | 'paused' | 'completed' | 'error';
  coderAgent: string;
  coderModel: string;
  workspacePath: string;
  config: {
    maxIterations?: number;
    critics?: Array<{
      id: string;
      name: string;
      provider: string;
      model?: string;
      enabled?: boolean;
    }>;
  };
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

/**
 * Stored iteration record.
 */
export interface StoredIteration {
  id: string;
  sessionId: string;
  iterationNumber: number;
  status: 'pending' | 'coding' | 'reviewing' | 'deciding' | 'completed';
  startedAt: number;
  completedAt?: number;
  coderResponse?: unknown;
}

/**
 * Stored change record.
 */
export interface StoredChange {
  id: string;
  iterationId: string;
  filePath: string;
  operation: 'create' | 'modify' | 'delete';
  diff?: string;
  originalContent?: string;
  newContent?: string;
  status: 'pending' | 'approved' | 'rejected';
}

/**
 * Stored critic review record.
 */
export interface StoredCriticReview {
  id: string;
  changeId: string;
  criticId: string;
  criticName: string;
  provider: string;
  model?: string;
  verdict: 'approve' | 'reject' | 'concerns' | 'error';
  message: string;
  issues?: Array<{
    severity: string;
    message: string;
    line?: number;
    suggestion?: string;
  }>;
  createdAt: number;
}

/**
 * Stored arbiter decision record.
 */
export interface StoredArbiterDecision {
  id: string;
  iterationId: string;
  decisionType: 'approve' | 'reject' | 'iterate' | 'abort';
  feedback?: string;
  decidedAt: number;
  decidedBy: 'human' | 'auto';
}

/**
 * Stored feed entry record.
 */
export interface StoredFeedEntry {
  id: string;
  sessionId: string;
  entryType: string;
  source: string;
  content: unknown;
  createdAt: number;
}

/**
 * Stored tool execution record.
 */
export interface StoredToolExecution {
  id: string;
  iterationId: string;
  toolName: string;
  input: unknown;
  output?: string;
  status: 'pending' | 'approved' | 'denied' | 'executed' | 'error';
  permissionScope?: 'once' | 'session' | 'folder' | 'global';
  startedAt: number;
  completedAt?: number;
}

/**
 * Stored permission record.
 */
export interface StoredPermission {
  id: string;
  sessionId: string;
  toolName: string;
  scope: 'once' | 'session' | 'folder' | 'global';
  pattern?: string;
  folderPath?: string;
  description?: string;
  createdAt: number;
  expiresAt?: number;
}

/**
 * Session summary for listing.
 */
export interface SessionSummary {
  id: string;
  task: string;
  status: string;
  coderModel: string;
  iterationCount: number;
  changeCount: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Query options for searching.
 */
export interface QueryOptions {
  sessionId?: string;
  filePath?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

// ============================================
// Schema
// ============================================

const SCHEMA = `
-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  coder_agent TEXT NOT NULL,
  coder_model TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  config JSON,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_path);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

-- Iterations table
CREATE TABLE IF NOT EXISTS iterations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  iteration_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  coder_response JSON,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  UNIQUE(session_id, iteration_number)
);

CREATE INDEX IF NOT EXISTS idx_iterations_session ON iterations(session_id);

-- Changes table
CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY,
  iteration_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  operation TEXT NOT NULL,
  diff TEXT,
  original_content TEXT,
  new_content TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  FOREIGN KEY (iteration_id) REFERENCES iterations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_changes_iteration ON changes(iteration_id);
CREATE INDEX IF NOT EXISTS idx_changes_file ON changes(file_path);

-- Critic reviews table
CREATE TABLE IF NOT EXISTS critic_reviews (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL,
  critic_id TEXT NOT NULL,
  critic_name TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  verdict TEXT NOT NULL,
  message TEXT,
  issues JSON,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (change_id) REFERENCES changes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_critic_reviews_change ON critic_reviews(change_id);
CREATE INDEX IF NOT EXISTS idx_critic_reviews_critic ON critic_reviews(critic_id);

-- Arbiter decisions table
CREATE TABLE IF NOT EXISTS arbiter_decisions (
  id TEXT PRIMARY KEY,
  iteration_id TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  feedback TEXT,
  decided_at INTEGER NOT NULL,
  decided_by TEXT NOT NULL,
  FOREIGN KEY (iteration_id) REFERENCES iterations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_arbiter_decisions_iteration ON arbiter_decisions(iteration_id);

-- Feed entries table
CREATE TABLE IF NOT EXISTS feed_entries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  source TEXT NOT NULL,
  content JSON NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_feed_entries_session ON feed_entries(session_id);
CREATE INDEX IF NOT EXISTS idx_feed_entries_type ON feed_entries(entry_type);

-- Tool executions table
CREATE TABLE IF NOT EXISTS tool_executions (
  id TEXT PRIMARY KEY,
  iteration_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input JSON NOT NULL,
  output TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  permission_scope TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (iteration_id) REFERENCES iterations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tool_executions_iteration ON tool_executions(iteration_id);
CREATE INDEX IF NOT EXISTS idx_tool_executions_tool ON tool_executions(tool_name);

-- Permissions table for persisting approval rules
CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  scope TEXT NOT NULL,
  pattern TEXT,
  folder_path TEXT,
  description TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_permissions_session ON permissions(session_id);
CREATE INDEX IF NOT EXISTS idx_permissions_tool ON permissions(tool_name);
CREATE INDEX IF NOT EXISTS idx_permissions_scope ON permissions(scope);

-- Full-text search virtual table for feed entries
CREATE VIRTUAL TABLE IF NOT EXISTS feed_entries_fts USING fts5(
  content,
  content=feed_entries,
  content_rowid=rowid
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS feed_entries_ai AFTER INSERT ON feed_entries BEGIN
  INSERT INTO feed_entries_fts(rowid, content)
  VALUES (NEW.rowid, json_extract(NEW.content, '$.text') || ' ' || COALESCE(json_extract(NEW.content, '$.message'), ''));
END;

CREATE TRIGGER IF NOT EXISTS feed_entries_ad AFTER DELETE ON feed_entries BEGIN
  INSERT INTO feed_entries_fts(feed_entries_fts, rowid, content)
  VALUES('delete', OLD.rowid, json_extract(OLD.content, '$.text') || ' ' || COALESCE(json_extract(OLD.content, '$.message'), ''));
END;
`;

// ============================================
// Storage Class
// ============================================

/**
 * CCA Session Storage using SQLite.
 */
export class CCAStorage {
  private db: Database;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.initSchema();
  }

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[CCAStorage] ${msg}`);
    }
  }

  private initSchema(): void {
    this.db.exec(SCHEMA);
    this.log('Schema initialized');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Session Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a new session.
   */
  createSession(session: Omit<StoredSession, 'createdAt' | 'updatedAt'>): StoredSession {
    const now = Date.now();
    const stored: StoredSession = {
      ...session,
      createdAt: now,
      updatedAt: now,
    };

    this.db.run(
      `INSERT INTO sessions (id, task, status, coder_agent, coder_model, workspace_path, config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stored.id,
        stored.task,
        stored.status,
        stored.coderAgent,
        stored.coderModel,
        stored.workspacePath,
        JSON.stringify(stored.config),
        stored.createdAt,
        stored.updatedAt,
      ]
    );

    this.log(`Created session: ${stored.id}`);
    return stored;
  }

  /**
   * Get a session by ID.
   */
  getSession(id: string): StoredSession | null {
    const row = this.db.query(
      `SELECT id, task, status, coder_agent, coder_model, workspace_path, config,
              created_at, updated_at, completed_at
       FROM sessions WHERE id = ?`
    ).get(id) as Record<string, unknown> | null;

    if (!row) return null;

    return {
      id: row.id as string,
      task: row.task as string,
      status: row.status as StoredSession['status'],
      coderAgent: row.coder_agent as string,
      coderModel: row.coder_model as string,
      workspacePath: row.workspace_path as string,
      config: JSON.parse(row.config as string || '{}'),
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      completedAt: row.completed_at as number | undefined,
    };
  }

  /**
   * Update a session.
   */
  updateSession(id: string, updates: Partial<StoredSession>): void {
    const sets: string[] = ['updated_at = ?'];
    const values: SQLQueryBindings[] = [Date.now()];

    if (updates.status !== undefined) {
      sets.push('status = ?');
      values.push(updates.status);
    }
    if (updates.task !== undefined) {
      sets.push('task = ?');
      values.push(updates.task);
    }
    if (updates.config !== undefined) {
      sets.push('config = ?');
      values.push(JSON.stringify(updates.config));
    }
    if (updates.completedAt !== undefined) {
      sets.push('completed_at = ?');
      values.push(updates.completedAt);
    }

    values.push(id);
    this.db.run(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`, values);
    this.log(`Updated session: ${id}`);
  }

  /**
   * List sessions with optional filtering.
   */
  listSessions(options: {
    workspacePath?: string;
    status?: string;
    limit?: number;
    offset?: number;
  } = {}): SessionSummary[] {
    let sql = `
      SELECT s.id, s.task, s.status, s.coder_model, s.created_at, s.updated_at,
             (SELECT COUNT(*) FROM iterations WHERE session_id = s.id) as iteration_count,
             (SELECT COUNT(*) FROM changes c
              JOIN iterations i ON c.iteration_id = i.id
              WHERE i.session_id = s.id) as change_count
      FROM sessions s
      WHERE 1=1
    `;
    const params: SQLQueryBindings[] = [];

    if (options.workspacePath) {
      sql += ' AND s.workspace_path = ?';
      params.push(options.workspacePath);
    }
    if (options.status) {
      sql += ' AND s.status = ?';
      params.push(options.status);
    }

    sql += ' ORDER BY s.updated_at DESC';

    if (options.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }
    if (options.offset) {
      sql += ' OFFSET ?';
      params.push(options.offset);
    }

    const stmt = this.db.query(sql);
    const rows = (params.length > 0 ? stmt.all(...params as [SQLQueryBindings, ...SQLQueryBindings[]]) : stmt.all()) as Record<string, unknown>[];

    return rows.map(row => ({
      id: row.id as string,
      task: row.task as string,
      status: row.status as string,
      coderModel: row.coder_model as string,
      iterationCount: row.iteration_count as number,
      changeCount: row.change_count as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }));
  }

  /**
   * Delete a session and all related data.
   */
  deleteSession(id: string): void {
    this.db.run('DELETE FROM sessions WHERE id = ?', [id]);
    this.log(`Deleted session: ${id}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Iteration Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a new iteration.
   */
  createIteration(iteration: Omit<StoredIteration, 'startedAt'>): StoredIteration {
    const stored: StoredIteration = {
      ...iteration,
      startedAt: Date.now(),
    };

    this.db.run(
      `INSERT INTO iterations (id, session_id, iteration_number, status, started_at, coder_response)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        stored.id,
        stored.sessionId,
        stored.iterationNumber,
        stored.status,
        stored.startedAt,
        stored.coderResponse ? JSON.stringify(stored.coderResponse) : null,
      ]
    );

    this.log(`Created iteration: ${stored.id} (session: ${stored.sessionId}, #${stored.iterationNumber})`);
    return stored;
  }

  /**
   * Get iterations for a session.
   */
  getIterations(sessionId: string): StoredIteration[] {
    const rows = this.db.query(
      `SELECT id, session_id, iteration_number, status, started_at, completed_at, coder_response
       FROM iterations WHERE session_id = ? ORDER BY iteration_number`
    ).all(sessionId) as Record<string, unknown>[];

    return rows.map(row => ({
      id: row.id as string,
      sessionId: row.session_id as string,
      iterationNumber: row.iteration_number as number,
      status: row.status as StoredIteration['status'],
      startedAt: row.started_at as number,
      completedAt: row.completed_at as number | undefined,
      coderResponse: row.coder_response ? JSON.parse(row.coder_response as string) : undefined,
    }));
  }

  /**
   * Get a specific iteration.
   */
  getIteration(id: string): StoredIteration | null {
    const row = this.db.query(
      `SELECT id, session_id, iteration_number, status, started_at, completed_at, coder_response
       FROM iterations WHERE id = ?`
    ).get(id) as Record<string, unknown> | null;

    if (!row) return null;

    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      iterationNumber: row.iteration_number as number,
      status: row.status as StoredIteration['status'],
      startedAt: row.started_at as number,
      completedAt: row.completed_at as number | undefined,
      coderResponse: row.coder_response ? JSON.parse(row.coder_response as string) : undefined,
    };
  }

  /**
   * Update an iteration.
   */
  updateIteration(id: string, updates: Partial<StoredIteration>): void {
    const sets: string[] = [];
    const values: SQLQueryBindings[] = [];

    if (updates.status !== undefined) {
      sets.push('status = ?');
      values.push(updates.status);
    }
    if (updates.completedAt !== undefined) {
      sets.push('completed_at = ?');
      values.push(updates.completedAt);
    }
    if (updates.coderResponse !== undefined) {
      sets.push('coder_response = ?');
      values.push(JSON.stringify(updates.coderResponse));
    }

    if (sets.length === 0) return;

    values.push(id);
    this.db.run(`UPDATE iterations SET ${sets.join(', ')} WHERE id = ?`, values);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Change Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a change record.
   */
  createChange(change: StoredChange): void {
    this.db.run(
      `INSERT INTO changes (id, iteration_id, file_path, operation, diff, original_content, new_content, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        change.id,
        change.iterationId,
        change.filePath,
        change.operation,
        change.diff ?? null,
        change.originalContent ?? null,
        change.newContent ?? null,
        change.status,
      ]
    );
  }

  /**
   * Get changes for an iteration.
   */
  getChanges(iterationId: string): StoredChange[] {
    const rows = this.db.query(
      `SELECT id, iteration_id, file_path, operation, diff, original_content, new_content, status
       FROM changes WHERE iteration_id = ?`
    ).all(iterationId) as Record<string, unknown>[];

    return rows.map(row => ({
      id: row.id as string,
      iterationId: row.iteration_id as string,
      filePath: row.file_path as string,
      operation: row.operation as StoredChange['operation'],
      diff: row.diff as string | undefined,
      originalContent: row.original_content as string | undefined,
      newContent: row.new_content as string | undefined,
      status: row.status as StoredChange['status'],
    }));
  }

  /**
   * Update a change status.
   */
  updateChangeStatus(id: string, status: StoredChange['status']): void {
    this.db.run('UPDATE changes SET status = ? WHERE id = ?', [status, id]);
  }

  /**
   * Query changes by file path across sessions.
   */
  queryChangesByFile(filePath: string, options: QueryOptions = {}): StoredChange[] {
    let sql = `
      SELECT c.id, c.iteration_id, c.file_path, c.operation, c.diff, c.status
      FROM changes c
      JOIN iterations i ON c.iteration_id = i.id
      WHERE c.file_path LIKE ?
    `;
    const params: SQLQueryBindings[] = [`%${filePath}%`];

    if (options.sessionId) {
      sql += ' AND i.session_id = ?';
      params.push(options.sessionId);
    }

    sql += ' ORDER BY i.started_at DESC';

    if (options.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    const stmt = this.db.query(sql);
    const rows = stmt.all(...params as [SQLQueryBindings, ...SQLQueryBindings[]]) as Record<string, unknown>[];

    return rows.map(row => ({
      id: row.id as string,
      iterationId: row.iteration_id as string,
      filePath: row.file_path as string,
      operation: row.operation as StoredChange['operation'],
      diff: row.diff as string | undefined,
      status: row.status as StoredChange['status'],
    }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Critic Review Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a critic review.
   */
  createCriticReview(review: Omit<StoredCriticReview, 'createdAt'>): StoredCriticReview {
    const stored: StoredCriticReview = {
      ...review,
      createdAt: Date.now(),
    };

    this.db.run(
      `INSERT INTO critic_reviews (id, change_id, critic_id, critic_name, provider, model, verdict, message, issues, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stored.id,
        stored.changeId,
        stored.criticId,
        stored.criticName,
        stored.provider,
        stored.model ?? null,
        stored.verdict,
        stored.message,
        stored.issues ? JSON.stringify(stored.issues) : null,
        stored.createdAt,
      ]
    );

    return stored;
  }

  /**
   * Get reviews for a change.
   */
  getReviewsForChange(changeId: string): StoredCriticReview[] {
    const rows = this.db.query(
      `SELECT id, change_id, critic_id, critic_name, provider, model, verdict, message, issues, created_at
       FROM critic_reviews WHERE change_id = ?`
    ).all(changeId) as Record<string, unknown>[];

    return rows.map(row => ({
      id: row.id as string,
      changeId: row.change_id as string,
      criticId: row.critic_id as string,
      criticName: row.critic_name as string,
      provider: row.provider as string,
      model: row.model as string | undefined,
      verdict: row.verdict as StoredCriticReview['verdict'],
      message: row.message as string,
      issues: row.issues ? JSON.parse(row.issues as string) : undefined,
      createdAt: row.created_at as number,
    }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Arbiter Decision Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create an arbiter decision.
   */
  createArbiterDecision(decision: StoredArbiterDecision): void {
    this.db.run(
      `INSERT INTO arbiter_decisions (id, iteration_id, decision_type, feedback, decided_at, decided_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        decision.id,
        decision.iterationId,
        decision.decisionType,
        decision.feedback ?? null,
        decision.decidedAt,
        decision.decidedBy,
      ]
    );
  }

  /**
   * Get decisions for an iteration.
   */
  getDecisions(iterationId: string): StoredArbiterDecision[] {
    const rows = this.db.query(
      `SELECT id, iteration_id, decision_type, feedback, decided_at, decided_by
       FROM arbiter_decisions WHERE iteration_id = ?`
    ).all(iterationId) as Record<string, unknown>[];

    return rows.map(row => ({
      id: row.id as string,
      iterationId: row.iteration_id as string,
      decisionType: row.decision_type as StoredArbiterDecision['decisionType'],
      feedback: row.feedback as string | undefined,
      decidedAt: row.decided_at as number,
      decidedBy: row.decided_by as 'human' | 'auto',
    }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Feed Entry Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a feed entry.
   */
  createFeedEntry(entry: Omit<StoredFeedEntry, 'createdAt'>): StoredFeedEntry {
    const stored: StoredFeedEntry = {
      ...entry,
      createdAt: Date.now(),
    };

    this.db.run(
      `INSERT INTO feed_entries (id, session_id, entry_type, source, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        stored.id,
        stored.sessionId,
        stored.entryType,
        stored.source,
        JSON.stringify(stored.content),
        stored.createdAt,
      ]
    );

    return stored;
  }

  /**
   * Get feed entries for a session.
   */
  getFeedEntries(sessionId: string, options: { limit?: number; offset?: number } = {}): StoredFeedEntry[] {
    let sql = `
      SELECT id, session_id, entry_type, source, content, created_at
      FROM feed_entries WHERE session_id = ?
      ORDER BY created_at ASC
    `;
    const params: SQLQueryBindings[] = [sessionId];

    if (options.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }
    if (options.offset) {
      sql += ' OFFSET ?';
      params.push(options.offset);
    }

    const stmt = this.db.query(sql);
    const rows = stmt.all(...params as [SQLQueryBindings, ...SQLQueryBindings[]]) as Record<string, unknown>[];

    return rows.map(row => ({
      id: row.id as string,
      sessionId: row.session_id as string,
      entryType: row.entry_type as string,
      source: row.source as string,
      content: JSON.parse(row.content as string),
      createdAt: row.created_at as number,
    }));
  }

  /**
   * Search feed entries using full-text search.
   */
  searchFeedEntries(query: string, options: QueryOptions = {}): StoredFeedEntry[] {
    let sql = `
      SELECT f.id, f.session_id, f.entry_type, f.source, f.content, f.created_at
      FROM feed_entries f
      JOIN feed_entries_fts fts ON f.rowid = fts.rowid
      WHERE fts.content MATCH ?
    `;
    const params: SQLQueryBindings[] = [query];

    if (options.sessionId) {
      sql += ' AND f.session_id = ?';
      params.push(options.sessionId);
    }

    sql += ' ORDER BY f.created_at DESC';

    if (options.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    const stmt = this.db.query(sql);
    const rows = stmt.all(...params as [SQLQueryBindings, ...SQLQueryBindings[]]) as Record<string, unknown>[];

    return rows.map(row => ({
      id: row.id as string,
      sessionId: row.session_id as string,
      entryType: row.entry_type as string,
      source: row.source as string,
      content: JSON.parse(row.content as string),
      createdAt: row.created_at as number,
    }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tool Execution Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a tool execution record.
   */
  createToolExecution(execution: Omit<StoredToolExecution, 'startedAt'>): StoredToolExecution {
    const stored: StoredToolExecution = {
      ...execution,
      startedAt: Date.now(),
    };

    this.db.run(
      `INSERT INTO tool_executions (id, iteration_id, tool_name, input, output, status, permission_scope, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stored.id,
        stored.iterationId,
        stored.toolName,
        JSON.stringify(stored.input),
        stored.output ?? null,
        stored.status,
        stored.permissionScope ?? null,
        stored.startedAt,
      ]
    );

    return stored;
  }

  /**
   * Update a tool execution.
   */
  updateToolExecution(id: string, updates: Partial<StoredToolExecution>): void {
    const sets: string[] = [];
    const values: SQLQueryBindings[] = [];

    if (updates.status !== undefined) {
      sets.push('status = ?');
      values.push(updates.status);
    }
    if (updates.output !== undefined) {
      sets.push('output = ?');
      values.push(updates.output);
    }
    if (updates.completedAt !== undefined) {
      sets.push('completed_at = ?');
      values.push(updates.completedAt);
    }
    if (updates.permissionScope !== undefined) {
      sets.push('permission_scope = ?');
      values.push(updates.permissionScope);
    }

    if (sets.length === 0) return;

    values.push(id);
    this.db.run(`UPDATE tool_executions SET ${sets.join(', ')} WHERE id = ?`, values);
  }

  /**
   * Get tool executions for an iteration.
   */
  getToolExecutions(iterationId: string): StoredToolExecution[] {
    const rows = this.db.query(
      `SELECT id, iteration_id, tool_name, input, output, status, permission_scope, started_at, completed_at
       FROM tool_executions WHERE iteration_id = ? ORDER BY started_at`
    ).all(iterationId) as Record<string, unknown>[];

    return rows.map(row => ({
      id: row.id as string,
      iterationId: row.iteration_id as string,
      toolName: row.tool_name as string,
      input: JSON.parse(row.input as string),
      output: row.output as string | undefined,
      status: row.status as StoredToolExecution['status'],
      permissionScope: row.permission_scope as StoredToolExecution['permissionScope'],
      startedAt: row.started_at as number,
      completedAt: row.completed_at as number | undefined,
    }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Snapshot and Restore
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get a complete snapshot of a session at a specific iteration.
   */
  getSessionSnapshot(sessionId: string, iterationNumber?: number): {
    session: StoredSession;
    iterations: StoredIteration[];
    changes: Map<string, StoredChange[]>;
    reviews: Map<string, StoredCriticReview[]>;
    decisions: Map<string, StoredArbiterDecision[]>;
    feedEntries: StoredFeedEntry[];
  } | null {
    const session = this.getSession(sessionId);
    if (!session) return null;

    let iterations = this.getIterations(sessionId);

    // If specific iteration requested, filter to that point
    if (iterationNumber !== undefined) {
      iterations = iterations.filter(i => i.iterationNumber <= iterationNumber);
    }

    const changes = new Map<string, StoredChange[]>();
    const reviews = new Map<string, StoredCriticReview[]>();
    const decisions = new Map<string, StoredArbiterDecision[]>();

    for (const iteration of iterations) {
      changes.set(iteration.id, this.getChanges(iteration.id));
      decisions.set(iteration.id, this.getDecisions(iteration.id));

      for (const change of changes.get(iteration.id)!) {
        reviews.set(change.id, this.getReviewsForChange(change.id));
      }
    }

    const feedEntries = this.getFeedEntries(sessionId);

    return { session, iterations, changes, reviews, decisions, feedEntries };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Session Resume
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get the most recent resumable session for a workspace.
   * Returns the most recently updated session that isn't in an error state.
   */
  getResumableSession(workspacePath: string): StoredSession | null {
    const row = this.db.query(
      `SELECT id, task, status, coder_agent, coder_model, workspace_path, config,
              created_at, updated_at, completed_at
       FROM sessions
       WHERE workspace_path = ? AND status != 'error'
       ORDER BY updated_at DESC
       LIMIT 1`
    ).get(workspacePath) as Record<string, unknown> | null;

    if (!row) return null;

    return {
      id: row.id as string,
      task: row.task as string,
      status: row.status as StoredSession['status'],
      coderAgent: row.coder_agent as string,
      coderModel: row.coder_model as string,
      workspacePath: row.workspace_path as string,
      config: JSON.parse(row.config as string || '{}'),
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      completedAt: row.completed_at as number | undefined,
    };
  }

  /**
   * Get recent sessions for a workspace.
   */
  getRecentSessions(workspacePath: string, limit: number = 10): SessionSummary[] {
    return this.listSessions({ workspacePath, limit });
  }

  /**
   * Mark a session as paused (for resume later).
   */
  pauseSession(sessionId: string): void {
    this.updateSession(sessionId, { status: 'paused' });
    this.log(`Paused session: ${sessionId}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Agent Query Methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Find previous changes to a specific file across all sessions.
   * Useful for agents to understand file history.
   */
  findFileHistory(filePath: string, limit: number = 20): Array<{
    sessionId: string;
    task: string;
    change: StoredChange;
    reviews: StoredCriticReview[];
    decision?: StoredArbiterDecision;
    timestamp: number;
  }> {
    const rows = this.db.query(`
      SELECT c.*, i.session_id, i.started_at, s.task
      FROM changes c
      JOIN iterations i ON c.iteration_id = i.id
      JOIN sessions s ON i.session_id = s.id
      WHERE c.file_path = ?
      ORDER BY i.started_at DESC
      LIMIT ?
    `).all(filePath, limit) as Record<string, unknown>[];

    return rows.map(row => {
      const change: StoredChange = {
        id: row.id as string,
        iterationId: row.iteration_id as string,
        filePath: row.file_path as string,
        operation: row.operation as StoredChange['operation'],
        diff: row.diff as string | undefined,
        originalContent: row.original_content as string | undefined,
        newContent: row.new_content as string | undefined,
        status: row.status as StoredChange['status'],
      };

      const reviews = this.getReviewsForChange(change.id);
      const decisions = this.getDecisions(change.iterationId);

      return {
        sessionId: row.session_id as string,
        task: row.task as string,
        change,
        reviews,
        decision: decisions[0],
        timestamp: row.started_at as number,
      };
    });
  }

  /**
   * Find patterns in how critics review certain types of changes.
   * Helps agents learn from past reviews.
   */
  findReviewPatterns(options: {
    filePath?: string;
    verdict?: 'approve' | 'reject' | 'concerns';
    criticId?: string;
    limit?: number;
  } = {}): Array<{
    change: StoredChange;
    review: StoredCriticReview;
    task: string;
  }> {
    let sql = `
      SELECT cr.*, c.file_path, c.operation, c.diff, c.iteration_id, s.task
      FROM critic_reviews cr
      JOIN changes c ON cr.change_id = c.id
      JOIN iterations i ON c.iteration_id = i.id
      JOIN sessions s ON i.session_id = s.id
      WHERE 1=1
    `;
    const params: SQLQueryBindings[] = [];

    if (options.filePath) {
      sql += ' AND c.file_path LIKE ?';
      params.push(`%${options.filePath}%`);
    }
    if (options.verdict) {
      sql += ' AND cr.verdict = ?';
      params.push(options.verdict);
    }
    if (options.criticId) {
      sql += ' AND cr.critic_id = ?';
      params.push(options.criticId);
    }

    sql += ' ORDER BY cr.created_at DESC';

    if (options.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    const stmt = this.db.query(sql);
    const rows = (params.length > 0 ? stmt.all(...params as [SQLQueryBindings, ...SQLQueryBindings[]]) : stmt.all()) as Record<string, unknown>[];

    return rows.map(row => ({
      change: {
        id: row.change_id as string,
        iterationId: row.iteration_id as string,
        filePath: row.file_path as string,
        operation: row.operation as StoredChange['operation'],
        diff: row.diff as string | undefined,
        status: 'approved' as const,
      },
      review: {
        id: row.id as string,
        changeId: row.change_id as string,
        criticId: row.critic_id as string,
        criticName: row.critic_name as string,
        provider: row.provider as string,
        model: row.model as string | undefined,
        verdict: row.verdict as StoredCriticReview['verdict'],
        message: row.message as string,
        issues: row.issues ? JSON.parse(row.issues as string) : undefined,
        createdAt: row.created_at as number,
      },
      task: row.task as string,
    }));
  }

  /**
   * Find sessions where a specific issue was encountered.
   * Helps agents learn from past mistakes.
   */
  findSessionsWithIssue(searchTerm: string, limit: number = 10): Array<{
    session: SessionSummary;
    matchingFeedEntries: StoredFeedEntry[];
  }> {
    // Use FTS to find matching feed entries
    const feedEntries = this.searchFeedEntries(searchTerm, { limit: limit * 3 });

    // Group by session
    const sessionMap = new Map<string, StoredFeedEntry[]>();
    for (const entry of feedEntries) {
      if (!sessionMap.has(entry.sessionId)) {
        sessionMap.set(entry.sessionId, []);
      }
      sessionMap.get(entry.sessionId)!.push(entry);
    }

    const results: Array<{
      session: SessionSummary;
      matchingFeedEntries: StoredFeedEntry[];
    }> = [];

    for (const [sessionId, entries] of sessionMap) {
      const sessions = this.listSessions({ limit: 1 });
      const session = sessions.find(s => s.id === sessionId);
      if (session) {
        results.push({
          session,
          matchingFeedEntries: entries,
        });
      }
    }

    return results.slice(0, limit);
  }

  /**
   * Get context for a task based on similar past tasks.
   * Helps agents by providing relevant historical context.
   */
  getContextForTask(taskDescription: string, limit: number = 5): Array<{
    session: StoredSession;
    iterations: StoredIteration[];
    keyDecisions: StoredArbiterDecision[];
    relevantReviews: StoredCriticReview[];
  }> {
    // Search for sessions with similar tasks
    const words = taskDescription.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const searchQuery = words.join(' OR ');

    if (!searchQuery) return [];

    const feedMatches = this.searchFeedEntries(searchQuery, { limit: limit * 5 });
    const sessionIds = [...new Set(feedMatches.map(f => f.sessionId))];

    const results: Array<{
      session: StoredSession;
      iterations: StoredIteration[];
      keyDecisions: StoredArbiterDecision[];
      relevantReviews: StoredCriticReview[];
    }> = [];

    for (const sessionId of sessionIds.slice(0, limit)) {
      const session = this.getSession(sessionId);
      if (!session || session.status === 'running') continue;

      const iterations = this.getIterations(sessionId);
      const keyDecisions: StoredArbiterDecision[] = [];
      const relevantReviews: StoredCriticReview[] = [];

      for (const iteration of iterations) {
        keyDecisions.push(...this.getDecisions(iteration.id));
        const changes = this.getChanges(iteration.id);
        for (const change of changes) {
          relevantReviews.push(...this.getReviewsForChange(change.id));
        }
      }

      results.push({
        session,
        iterations,
        keyDecisions,
        relevantReviews: relevantReviews.slice(0, 10), // Limit reviews per session
      });
    }

    return results;
  }

  /**
   * Get statistics about past sessions.
   */
  getSessionStats(workspacePath?: string): {
    totalSessions: number;
    completedSessions: number;
    totalIterations: number;
    totalChanges: number;
    approvalRate: number;
    averageIterationsPerSession: number;
  } {
    let sessionFilter = '';
    const params: SQLQueryBindings[] = [];
    if (workspacePath) {
      sessionFilter = 'WHERE workspace_path = ?';
      params.push(workspacePath);
    }

    const sessionStats = this.db.query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
      FROM sessions ${sessionFilter}
    `).get(...params as []) as { total: number; completed: number };

    const iterationStats = this.db.query(`
      SELECT COUNT(*) as total
      FROM iterations i
      JOIN sessions s ON i.session_id = s.id
      ${sessionFilter}
    `).get(...params as []) as { total: number };

    const changeStats = this.db.query(`
      SELECT COUNT(*) as total
      FROM changes c
      JOIN iterations i ON c.iteration_id = i.id
      JOIN sessions s ON i.session_id = s.id
      ${sessionFilter}
    `).get(...params as []) as { total: number };

    const decisionStats = this.db.query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN decision_type = 'approve' THEN 1 ELSE 0 END) as approved
      FROM arbiter_decisions ad
      JOIN iterations i ON ad.iteration_id = i.id
      JOIN sessions s ON i.session_id = s.id
      ${sessionFilter}
    `).get(...params as []) as { total: number; approved: number };

    return {
      totalSessions: sessionStats.total,
      completedSessions: sessionStats.completed,
      totalIterations: iterationStats.total,
      totalChanges: changeStats.total,
      approvalRate: decisionStats.total > 0 ? decisionStats.approved / decisionStats.total : 0,
      averageIterationsPerSession: sessionStats.total > 0 ? iterationStats.total / sessionStats.total : 0,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Permissions
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Save a permission approval to storage.
   */
  savePermission(permission: Omit<StoredPermission, 'createdAt'>): StoredPermission {
    const now = Date.now();
    const stored: StoredPermission = {
      ...permission,
      createdAt: now,
    };

    this.db.run(
      `INSERT INTO permissions (id, session_id, tool_name, scope, pattern, folder_path, description, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stored.id,
        stored.sessionId,
        stored.toolName,
        stored.scope,
        stored.pattern ?? null,
        stored.folderPath ?? null,
        stored.description ?? null,
        stored.createdAt,
        stored.expiresAt ?? null,
      ]
    );

    this.log(`Saved permission: ${stored.toolName} (${stored.scope})`);
    return stored;
  }

  /**
   * Get permissions for a session.
   */
  getSessionPermissions(sessionId: string): StoredPermission[] {
    const rows = this.db.query(
      `SELECT id, session_id, tool_name, scope, pattern, folder_path, description, created_at, expires_at
       FROM permissions
       WHERE session_id = ? AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC`
    ).all(sessionId, Date.now()) as Record<string, unknown>[];

    return rows.map(row => ({
      id: row.id as string,
      sessionId: row.session_id as string,
      toolName: row.tool_name as string,
      scope: row.scope as StoredPermission['scope'],
      pattern: row.pattern as string | undefined,
      folderPath: row.folder_path as string | undefined,
      description: row.description as string | undefined,
      createdAt: row.created_at as number,
      expiresAt: row.expires_at as number | undefined,
    }));
  }

  /**
   * Get all permissions for a workspace (across all sessions).
   */
  getWorkspacePermissions(workspacePath: string): StoredPermission[] {
    const rows = this.db.query(
      `SELECT p.id, p.session_id, p.tool_name, p.scope, p.pattern, p.folder_path, p.description, p.created_at, p.expires_at
       FROM permissions p
       JOIN sessions s ON p.session_id = s.id
       WHERE s.workspace_path = ? AND (p.expires_at IS NULL OR p.expires_at > ?)
       ORDER BY p.created_at DESC`
    ).all(workspacePath, Date.now()) as Record<string, unknown>[];

    return rows.map(row => ({
      id: row.id as string,
      sessionId: row.session_id as string,
      toolName: row.tool_name as string,
      scope: row.scope as StoredPermission['scope'],
      pattern: row.pattern as string | undefined,
      folderPath: row.folder_path as string | undefined,
      description: row.description as string | undefined,
      createdAt: row.created_at as number,
      expiresAt: row.expires_at as number | undefined,
    }));
  }

  /**
   * Check if a tool is permitted based on stored permissions.
   */
  checkPermission(sessionId: string, toolName: string, input?: string): StoredPermission | null {
    // Check session-scoped permissions first
    const sessionPerm = this.db.query(
      `SELECT id, session_id, tool_name, scope, pattern, folder_path, description, created_at, expires_at
       FROM permissions
       WHERE session_id = ? AND tool_name = ? AND scope = 'session'
         AND (expires_at IS NULL OR expires_at > ?)
       LIMIT 1`
    ).get(sessionId, toolName, Date.now()) as Record<string, unknown> | null;

    if (sessionPerm) {
      return {
        id: sessionPerm.id as string,
        sessionId: sessionPerm.session_id as string,
        toolName: sessionPerm.tool_name as string,
        scope: sessionPerm.scope as StoredPermission['scope'],
        pattern: sessionPerm.pattern as string | undefined,
        folderPath: sessionPerm.folder_path as string | undefined,
        description: sessionPerm.description as string | undefined,
        createdAt: sessionPerm.created_at as number,
        expiresAt: sessionPerm.expires_at as number | undefined,
      };
    }

    // Check folder-scoped permissions if input contains a path
    if (input) {
      const folderPerms = this.db.query(
        `SELECT id, session_id, tool_name, scope, pattern, folder_path, description, created_at, expires_at
         FROM permissions
         WHERE session_id = ? AND tool_name = ? AND scope = 'folder'
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY LENGTH(folder_path) DESC`
      ).all(sessionId, toolName, Date.now()) as Record<string, unknown>[];

      for (const row of folderPerms) {
        const folderPath = row.folder_path as string;
        if (folderPath && input.startsWith(folderPath)) {
          return {
            id: row.id as string,
            sessionId: row.session_id as string,
            toolName: row.tool_name as string,
            scope: row.scope as StoredPermission['scope'],
            pattern: row.pattern as string | undefined,
            folderPath: row.folder_path as string | undefined,
            description: row.description as string | undefined,
            createdAt: row.created_at as number,
            expiresAt: row.expires_at as number | undefined,
          };
        }
      }
    }

    // Check global permissions
    const globalPerm = this.db.query(
      `SELECT id, session_id, tool_name, scope, pattern, folder_path, description, created_at, expires_at
       FROM permissions
       WHERE session_id = ? AND tool_name = ? AND scope = 'global'
         AND (expires_at IS NULL OR expires_at > ?)
       LIMIT 1`
    ).get(sessionId, toolName, Date.now()) as Record<string, unknown> | null;

    if (globalPerm) {
      return {
        id: globalPerm.id as string,
        sessionId: globalPerm.session_id as string,
        toolName: globalPerm.tool_name as string,
        scope: globalPerm.scope as StoredPermission['scope'],
        pattern: globalPerm.pattern as string | undefined,
        folderPath: globalPerm.folder_path as string | undefined,
        description: globalPerm.description as string | undefined,
        createdAt: globalPerm.created_at as number,
        expiresAt: globalPerm.expires_at as number | undefined,
      };
    }

    return null;
  }

  /**
   * Delete expired permissions.
   */
  cleanupExpiredPermissions(): number {
    const result = this.db.run(
      `DELETE FROM permissions WHERE expires_at IS NOT NULL AND expires_at <= ?`,
      [Date.now()]
    );
    const deleted = result.changes;
    if (deleted > 0) {
      this.log(`Cleaned up ${deleted} expired permissions`);
    }
    return deleted;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Utility
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
    this.log('Database closed');
  }

  /**
   * Generate a unique ID.
   */
  static generateId(prefix: string = ''): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 9);
    return prefix ? `${prefix}-${timestamp}-${random}` : `${timestamp}-${random}`;
  }
}

// ============================================
// Per-Project Storage Instances
// ============================================

/** Map of workspace path to storage instance */
const storageInstances = new Map<string, CCAStorage>();

/**
 * Get the storage directory for a project.
 * Creates .ultra directory in the project root.
 */
function getStorageDir(workspacePath: string): string {
  return join(workspacePath, '.ultra');
}

/**
 * Get the database path for a project.
 */
function getDbPath(workspacePath: string): string {
  return join(getStorageDir(workspacePath), 'cca.db');
}

/**
 * Get or create the CCA storage instance for a project.
 * Each project has its own database stored in {project}/.ultra/cca.db
 */
export async function getCCAStorage(workspacePath?: string): Promise<CCAStorage> {
  // Use provided path or current working directory
  const projectPath = workspacePath || process.cwd();

  // Check if we already have an instance for this project
  const existing = storageInstances.get(projectPath);
  if (existing) return existing;

  // Create .ultra directory in the project
  const storageDir = getStorageDir(projectPath);
  await mkdir(storageDir, { recursive: true });

  // Create storage instance
  const dbPath = getDbPath(projectPath);
  const storage = new CCAStorage(dbPath);
  storageInstances.set(projectPath, storage);

  // Add .ultra to .gitignore if it exists and doesn't already include it
  try {
    const gitignorePath = join(projectPath, '.gitignore');
    const { readFile, appendFile } = await import('fs/promises');
    try {
      const content = await readFile(gitignorePath, 'utf-8');
      if (!content.includes('.ultra/') && !content.includes('.ultra\n')) {
        await appendFile(gitignorePath, '\n# Ultra AI session data\n.ultra/\n');
      }
    } catch {
      // .gitignore doesn't exist, that's fine
    }
  } catch {
    // Ignore errors updating .gitignore
  }

  return storage;
}

/**
 * Close the storage instance for a project.
 */
export function closeCCAStorage(workspacePath?: string): void {
  const projectPath = workspacePath || process.cwd();
  const storage = storageInstances.get(projectPath);
  if (storage) {
    storage.close();
    storageInstances.delete(projectPath);
  }
}

/**
 * Close all storage instances.
 */
export function closeAllCCAStorage(): void {
  for (const [path, storage] of storageInstances) {
    storage.close();
    storageInstances.delete(path);
  }
}
