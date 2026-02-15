/**
 * Chat Service Adapter (Unified Schema)
 *
 * ECP adapter for chat storage operations against the unified schema.
 * Replaces the legacy adapter that used chat_* tables.
 *
 * All operations target the unified tables: sessions, messages,
 * tool_calls, documents, todos, permissions, compactions.
 */

import { Database } from 'bun:sqlite';
import { type HandlerResult, ECPErrorCodes, type NotificationHandler } from '../../protocol/types.ts';
import { ChatDatabase, getChatDatabase, closeChatDatabase } from './database.ts';
import { DocumentService } from './services/DocumentService.ts';
import { debugLog } from '../../debug.ts';

/**
 * Chat Service Adapter for ECP.
 */
export class ChatServiceAdapter {
  private workspacePath: string;
  private chatDb: ChatDatabase | null = null;
  private documentService: DocumentService | null = null;
  private notificationHandler?: NotificationHandler;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }

  setNotificationHandler(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  /**
   * Get the underlying database for sharing with other adapters.
   */
  getDatabase(): ChatDatabase | null {
    return this.chatDb;
  }

  /**
   * Get the raw SQLite database handle.
   */
  getDb(): Database | null {
    return this.chatDb?.getDb() ?? null;
  }

  private sendNotification(method: string, params: unknown): void {
    if (this.notificationHandler) {
      this.notificationHandler({ jsonrpc: '2.0', method, params });
    }
  }

  async init(): Promise<void> {
    try {
      this.chatDb = await getChatDatabase(this.workspacePath);
      this.documentService = new DocumentService(this.chatDb.getDb());
      debugLog('[ChatServiceAdapter] Initialized with unified schema');
    } catch (error) {
      debugLog(`[ChatServiceAdapter] Init failed (welcome mode): ${error}`);
    }
  }

  async setWorkspacePath(path: string): Promise<void> {
    if (this.workspacePath !== path) {
      this.workspacePath = path;
      try {
        this.chatDb = await getChatDatabase(path);
        this.documentService = new DocumentService(this.chatDb.getDb());
      } catch (err) {
        this.chatDb = null;
        this.documentService = null;
      }
    }
  }

  async handleRequest(method: string, params: unknown): Promise<HandlerResult> {
    if (!this.chatDb) {
      return {
        error: {
          code: ECPErrorCodes.ServerNotInitialized,
          message: 'Chat storage not initialized',
        },
      };
    }

    try {
      switch (method) {
        // ─── Session Operations ────────────────────────────────────────
        case 'chat/session/create':
          return { result: this.handleCreateSession(params) };
        case 'chat/session/get':
          return { result: this.handleGetSession(params) };
        case 'chat/session/update':
          return { result: this.handleUpdateSession(params) };
        case 'chat/session/delete':
          return { result: this.handleDeleteSession(params) };
        case 'chat/session/list':
          return { result: this.handleListSessions(params) };

        // ─── Message Operations ────────────────────────────────────────
        case 'chat/message/add':
          return { result: this.handleAddMessage(params) };
        case 'chat/message/update':
          return { result: this.handleUpdateMessage(params) };
        case 'chat/message/delete':
          return { result: this.handleDeleteMessage(params) };
        case 'chat/message/list':
          return { result: this.handleListMessages(params) };
        case 'chat/message/search':
          return { result: this.handleSearchMessages(params) };
        case 'chat/message/recent':
          return { result: this.handleRecentMessages(params) };

        // ─── Tool Call Operations ──────────────────────────────────────
        case 'chat/toolCall/add':
          return { result: this.handleAddToolCall(params) };
        case 'chat/toolCall/complete':
          return { result: this.handleCompleteToolCall(params) };
        case 'chat/toolCall/updateInput':
          return { result: this.handleUpdateToolCallInput(params) };
        case 'chat/toolCall/list':
          return { result: this.handleListToolCalls(params) };

        // ─── Permission Operations ─────────────────────────────────────
        case 'chat/permission/check':
          return { result: this.handleCheckPermission(params) };
        case 'chat/permission/grant':
          return { result: this.handleGrantPermission(params) };
        case 'chat/permission/revoke':
          return { result: this.handleRevokePermission(params) };
        case 'chat/permission/list':
          return { result: this.handleListPermissions(params) };

        // ─── Activity Log (reconstructed from data) ────────────────────
        case 'chat/activity/log':
          return { result: this.handleGetActivityLog(params) };
        case 'chat/activity/since':
          return { result: this.handleGetActivitySince(params) };
        case 'chat/activity/add':
          return { result: { success: true } }; // No-op: activity reconstructed from data

        // ─── Compaction Operations ─────────────────────────────────────
        case 'chat/compaction/create':
          return { result: this.handleCreateCompaction(params) };
        case 'chat/compaction/get':
          return { result: this.handleGetCompaction(params) };
        case 'chat/compaction/list':
          return { result: this.handleListCompactions(params) };
        case 'chat/compaction/expand':
          return { result: this.handleExpandCompaction(params) };
        case 'chat/compaction/collapse':
          return { result: this.handleCollapseCompaction(params) };
        case 'chat/compaction/delete':
          return { result: this.handleDeleteCompaction(params) };
        case 'chat/context/build':
          return { result: this.handleBuildContext(params) };

        // ─── Todo Operations ───────────────────────────────────────────
        case 'chat/todo/upsert':
          return { result: this.handleUpsertTodo(params) };
        case 'chat/todo/get':
          return { result: this.handleGetTodo(params) };
        case 'chat/todo/list':
          return { result: this.handleListTodos(params) };
        case 'chat/todo/update-status':
          return { result: this.handleUpdateTodoStatus(params) };
        case 'chat/todo/delete':
          return { result: this.handleDeleteTodo(params) };
        case 'chat/todo/replace':
          return { result: this.handleReplaceTodos(params) };

        // ─── Document Operations (NEW) ─────────────────────────────────
        case 'chat/document/create':
          return { result: this.handleCreateDocument(params) };
        case 'chat/document/get':
          return { result: this.handleGetDocument(params) };
        case 'chat/document/list':
          return { result: this.handleListDocuments(params) };
        case 'chat/document/update':
          return { result: this.handleUpdateDocument(params) };
        case 'chat/document/delete':
          return { result: this.handleDeleteDocument(params) };
        case 'chat/document/search':
          return { result: this.handleSearchDocuments(params) };
        case 'chat/document/hierarchy':
          return { result: this.handleGetDocumentHierarchy(params) };
        case 'chat/document/vulnerabilities':
          return { result: this.handleGetVulnerabilities(params) };
        case 'chat/document/pending-reviews':
          return { result: this.handleGetPendingReviews(params) };
        case 'chat/document/count-by-type':
          return { result: this.handleCountDocumentsByType(params) };

        // ─── Legacy Plan/Spec routes → Documents ───────────────────────
        case 'chat/plan/create':
          return { result: this.handleCreatePlanAsDocument(params) };
        case 'chat/plan/get':
          return { result: this.handleGetDocument({ id: (params as any)?.id }) };
        case 'chat/plan/list':
          return { result: this.handleListDocuments({ ...params as any, docType: 'plan' }) };
        case 'chat/plan/update':
          return { result: this.handleUpdateDocument(params) };
        case 'chat/plan/delete':
          return { result: this.handleDeleteDocument(params) };
        case 'chat/plan/content':
          return { result: this.handleGetDocumentContent(params) };
        case 'chat/spec/create':
          return { result: this.handleCreateSpecAsDocument(params) };
        case 'chat/spec/get':
          return { result: this.handleGetDocument({ id: (params as any)?.id }) };
        case 'chat/spec/list':
          return { result: this.handleListDocuments({ ...params as any, docType: 'spec' }) };
        case 'chat/spec/update':
          return { result: this.handleUpdateDocument(params) };
        case 'chat/spec/delete':
          return { result: this.handleDeleteDocument(params) };
        case 'chat/spec/hierarchy':
          return { result: this.handleGetDocumentHierarchy(params) };
        case 'chat/spec/link-plan':
          return { result: this.handleLinkDocuments(params) };

        // ─── Stats ─────────────────────────────────────────────────────
        case 'chat/stats':
          return { result: this.handleGetStats() };

        default:
          return { error: { code: ECPErrorCodes.MethodNotFound, message: `Method not found: ${method}` } };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: { code: ECPErrorCodes.InternalError, message } };
    }
  }

  shutdown(): void {
    closeChatDatabase(this.workspacePath);
    this.chatDb = null;
    this.documentService = null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Session Handlers
  // ═══════════════════════════════════════════════════════════════════════════

  private handleCreateSession(params: unknown) {
    const p = params as { id: string; title?: string; systemPrompt?: string; provider: string; model: string };
    const db = this.db();
    const now = Date.now();

    db.run(
      `INSERT OR REPLACE INTO sessions (id, title, provider, model, system_prompt, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      [p.id, p.title ?? null, p.provider, p.model, p.systemPrompt ?? null, now, now]
    );

    this.sendNotification('chat/activity', {
      id: crypto.randomUUID(),
      activityType: 'session_created', entityType: 'session', entityId: p.id,
      summary: `Session created: ${p.provider}/${p.model}`,
      createdAt: now,
    });

    return this.getSessionById(p.id);
  }

  private handleGetSession(params: unknown) {
    const p = params as { id: string };
    return this.getSessionById(p.id);
  }

  private handleUpdateSession(params: unknown) {
    const p = params as { id: string; title?: string; systemPrompt?: string; model?: string };
    const sets: string[] = ['updated_at = ?'];
    const vals: (string | number | null)[] = [Date.now()];

    if (p.title !== undefined) { sets.push('title = ?'); vals.push(p.title); }
    if (p.systemPrompt !== undefined) { sets.push('system_prompt = ?'); vals.push(p.systemPrompt); }
    if (p.model !== undefined) { sets.push('model = ?'); vals.push(p.model); }
    vals.push(p.id);

    this.db().run(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`, vals);
    return { success: true };
  }

  private handleDeleteSession(params: unknown) {
    const p = params as { id: string };
    this.db().run('DELETE FROM sessions WHERE id = ?', [p.id]);
    return { success: true };
  }

  private handleListSessions(params: unknown) {
    const p = (params || {}) as { provider?: string; limit?: number; offset?: number };
    let sql = `SELECT s.*, COUNT(m.id) as message_count,
               MAX(m.created_at) as last_message_at
               FROM sessions s LEFT JOIN messages m ON m.session_id = s.id
               WHERE 1=1`;
    const vals: (string | number)[] = [];

    if (p.provider) { sql += ' AND s.provider = ?'; vals.push(p.provider); }
    sql += ' GROUP BY s.id ORDER BY s.updated_at DESC LIMIT ? OFFSET ?';
    vals.push(p.limit ?? 50, p.offset ?? 0);

    return this.db().query(sql).all(...vals).map((row: any) => ({
      id: row.id,
      title: row.title,
      provider: row.provider,
      model: row.model,
      messageCount: row.message_count,
      lastMessageAt: row.last_message_at,
      createdAt: row.created_at,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Message Handlers
  // ═══════════════════════════════════════════════════════════════════════════

  private handleAddMessage(params: unknown) {
    const p = params as {
      id: string; sessionId: string; role: string; content: string;
      model?: string; inputTokens?: number; outputTokens?: number; durationMs?: number;
      agentId?: string; agentName?: string; agentRole?: string;
    };
    const db = this.db();

    db.run(
      `INSERT OR REPLACE INTO messages
       (id, session_id, role, content, model, input_tokens, output_tokens, duration_ms,
        agent_id, agent_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        p.id, p.sessionId, p.role === 'tool' ? 'tool_call' : p.role, p.content,
        p.model ?? null, p.inputTokens ?? null, p.outputTokens ?? null, p.durationMs ?? null,
        p.agentId ?? null, p.agentName ?? null, Date.now(),
      ]
    );

    // Update session timestamp
    db.run('UPDATE sessions SET updated_at = ? WHERE id = ?', [Date.now(), p.sessionId]);

    this.sendNotification('chat/activity', {
      id: crypto.randomUUID(),
      activityType: 'message_added', entityType: 'message', entityId: p.id,
      sessionId: p.sessionId,
      summary: `${p.agentName || p.role}: ${p.content.slice(0, 50)}`,
      details: { role: p.role, model: p.model, agentId: p.agentId, agentName: p.agentName, agentRole: p.agentRole, content: p.content },
      createdAt: Date.now(),
    });

    return this.getMessageById(p.id);
  }

  private handleUpdateMessage(params: unknown) {
    // Use INSERT OR REPLACE for upsert semantics
    return this.handleAddMessage(params);
  }

  private handleDeleteMessage(params: unknown) {
    const p = params as { id: string };
    const result = this.db().run('DELETE FROM messages WHERE id = ?', [p.id]);
    return { deleted: result.changes > 0 };
  }

  private handleListMessages(params: unknown) {
    const p = params as { sessionId: string; limit?: number; offset?: number };
    return this.db().query(
      `SELECT * FROM messages WHERE session_id = ? AND is_active = 1
       ORDER BY created_at ASC LIMIT ? OFFSET ?`
    ).all(p.sessionId, p.limit ?? 200, p.offset ?? 0).map((r: any) => this.mapMessage(r));
  }

  private handleSearchMessages(params: unknown) {
    const p = params as { query: string; sessionId?: string; limit?: number };
    let sql = `SELECT m.* FROM messages m
               JOIN messages_fts ON messages_fts.rowid = m.rowid
               WHERE messages_fts MATCH ?`;
    const vals: (string | number)[] = [p.query];

    if (p.sessionId) { sql += ' AND m.session_id = ?'; vals.push(p.sessionId); }
    sql += ' ORDER BY m.created_at DESC LIMIT ?';
    vals.push(p.limit ?? 50);

    return this.db().query(sql).all(...vals).map((r: any) => this.mapMessage(r));
  }

  private handleRecentMessages(params: unknown) {
    const p = (params || {}) as { limit?: number; provider?: string };
    let sql = `SELECT m.* FROM messages m
               JOIN sessions s ON s.id = m.session_id
               WHERE m.is_active = 1`;
    const vals: (string | number)[] = [];

    if (p.provider) { sql += ' AND s.provider = ?'; vals.push(p.provider); }
    sql += ' ORDER BY m.created_at DESC LIMIT ?';
    vals.push(p.limit ?? 50);

    return this.db().query(sql).all(...vals).map((r: any) => this.mapMessage(r));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool Call Handlers
  // ═══════════════════════════════════════════════════════════════════════════

  private handleAddToolCall(params: unknown) {
    const p = params as {
      id: string; messageId?: string; sessionId: string;
      toolName: string; input: unknown;
      agentId?: string; agentName?: string;
    };
    const now = Date.now();

    this.db().run(
      `INSERT OR REPLACE INTO tool_calls
       (id, session_id, message_id, tool_name, input, status, agent_id, agent_name, started_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
      [
        p.id, p.sessionId, p.messageId ?? null, p.toolName,
        JSON.stringify(p.input ?? {}), p.agentId ?? null, p.agentName ?? null, now,
      ]
    );

    this.sendNotification('chat/activity', {
      id: crypto.randomUUID(),
      activityType: 'tool_call_started', entityType: 'tool_call', entityId: p.id,
      sessionId: p.sessionId,
      summary: `Tool: ${p.toolName}`,
      details: { toolName: p.toolName, agentId: p.agentId, agentName: p.agentName },
      createdAt: now,
    });

    return { id: p.id, toolName: p.toolName, status: 'running', startedAt: now };
  }

  private handleCompleteToolCall(params: unknown) {
    const p = params as { id: string; sessionId?: string; output?: unknown; errorMessage?: string };
    const status = p.errorMessage ? 'error' : 'success';
    const now = Date.now();

    this.db().run(
      `UPDATE tool_calls SET status = ?, output = ?, error_message = ?, completed_at = ? WHERE id = ?`,
      [status, p.output ? JSON.stringify(p.output) : null, p.errorMessage ?? null, now, p.id]
    );

    this.sendNotification('chat/activity', {
      id: crypto.randomUUID(),
      activityType: 'tool_call_completed', entityType: 'tool_call', entityId: p.id,
      sessionId: p.sessionId, summary: `Tool completed: ${status}`,
      createdAt: now,
    });

    return { success: true };
  }

  private handleUpdateToolCallInput(params: unknown) {
    const p = params as { id: string; input: unknown };
    this.db().run(
      'UPDATE tool_calls SET input = ? WHERE id = ?',
      [JSON.stringify(p.input ?? {}), p.id]
    );
    return { success: true };
  }

  private handleListToolCalls(params: unknown) {
    const p = params as { sessionId: string; limit?: number };
    return this.db().query(
      `SELECT * FROM tool_calls WHERE session_id = ?
       ORDER BY started_at DESC LIMIT ?`
    ).all(p.sessionId, p.limit ?? 100).map((r: any) => ({
      id: r.id,
      sessionId: r.session_id,
      messageId: r.message_id,
      toolName: r.tool_name,
      input: r.input ? JSON.parse(r.input) : null,
      output: r.output ? JSON.parse(r.output) : null,
      status: r.status,
      errorMessage: r.error_message,
      agentId: r.agent_id,
      agentName: r.agent_name,
      startedAt: r.started_at,
      completedAt: r.completed_at,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Permission Handlers
  // ═══════════════════════════════════════════════════════════════════════════

  private handleCheckPermission(params: unknown) {
    const p = params as { toolName: string; input?: string; sessionId?: string };
    const row = this.db().query(
      `SELECT * FROM permissions WHERE tool_name = ? AND decision = 'approved'
       AND (session_id IS NULL OR session_id = ?)
       AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY CASE scope
         WHEN 'global' THEN 0 WHEN 'project' THEN 1
         WHEN 'workflow' THEN 2 WHEN 'session' THEN 3
         WHEN 'once' THEN 4 END
       LIMIT 1`
    ).get(p.toolName, p.sessionId ?? '', Date.now());

    return { approved: row !== null, permission: row };
  }

  private handleGrantPermission(params: unknown) {
    const p = params as {
      toolName: string; scope: string; sessionId?: string;
      pattern?: string; description?: string;
    };
    const id = `perm-${crypto.randomUUID()}`;

    this.db().run(
      `INSERT OR REPLACE INTO permissions (id, session_id, tool_name, pattern, scope, decision, granted_at)
       VALUES (?, ?, ?, ?, ?, 'approved', ?)`,
      [id, p.sessionId ?? null, p.toolName, p.pattern ?? null, p.scope, Date.now()]
    );

    return { id, toolName: p.toolName, scope: p.scope };
  }

  private handleRevokePermission(params: unknown) {
    const p = params as { id?: string; toolName?: string; sessionId?: string };
    if (p.id) {
      this.db().run('DELETE FROM permissions WHERE id = ?', [p.id]);
    } else if (p.toolName) {
      this.db().run(
        'DELETE FROM permissions WHERE tool_name = ? AND (session_id IS NULL OR session_id = ?)',
        [p.toolName, p.sessionId ?? '']
      );
    }
    return { success: true };
  }

  private handleListPermissions(params: unknown) {
    const p = (params || {}) as { sessionId?: string; scope?: string };
    let sql = 'SELECT * FROM permissions WHERE 1=1';
    const vals: (string | number)[] = [];

    if (p.sessionId) { sql += ' AND session_id = ?'; vals.push(p.sessionId); }
    if (p.scope) { sql += ' AND scope = ?'; vals.push(p.scope); }
    sql += ' ORDER BY granted_at DESC';

    return this.db().query(sql).all(...vals);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Activity Log (Reconstructed)
  // ═══════════════════════════════════════════════════════════════════════════

  private handleGetActivityLog(params: unknown) {
    const p = (params || {}) as { sessionId?: string; limit?: number; types?: string[] };
    return this.reconstructActivity(p.sessionId, p.limit ?? 100);
  }

  private handleGetActivitySince(params: unknown) {
    const p = (params || {}) as { sessionId?: string; since?: number };
    return this.reconstructActivity(p.sessionId, 100, p.since);
  }

  /**
   * Reconstruct activity from data tables instead of a separate activity log.
   * Returns entries sorted newest-first with numeric IDs for React keys.
   */
  private reconstructActivity(sessionId?: string, limit = 100, since?: number) {
    const db = this.db();
    const entries: any[] = [];
    let idCounter = 0;
    const nextId = () => ++idCounter;

    const sessionFilter = sessionId ? 'AND session_id = ?' : '';
    const sinceFilter = since ? 'AND started_at > ?' : '';
    const sinceFilterCreated = since ? 'AND created_at > ?' : '';

    // Helper for building param arrays
    const buildParams = () => {
      const params: (string | number)[] = [];
      if (sessionId) params.push(sessionId);
      if (since) params.push(since);
      params.push(limit);
      return params;
    };

    // ── Sessions ──────────────────────────────────────────────────────────
    try {
      const sessionParams: (string | number)[] = [];
      const idFilter = sessionId ? 'AND id = ?' : '';
      if (sessionId) sessionParams.push(sessionId);
      if (since) sessionParams.push(since);
      sessionParams.push(limit);

      const sessions = db.query(
        `SELECT id, title, provider, model, status, created_at, updated_at
         FROM sessions WHERE 1=1 ${idFilter} ${sinceFilterCreated}
         ORDER BY created_at DESC LIMIT ?`
      ).all(...sessionParams) as any[];

      for (const s of sessions) {
        entries.push({
          id: nextId(),
          sessionId: s.id,
          activityType: 'session_created',
          entityType: 'session',
          entityId: s.id,
          summary: `Session created: ${s.provider}/${s.model}`,
          details: { title: s.title, provider: s.provider, model: s.model, status: s.status },
          createdAt: s.created_at,
        });
      }
    } catch { /* table may not exist */ }

    // ── Messages ──────────────────────────────────────────────────────────
    try {
      const msgParams = buildParams();
      const messages = db.query(
        `SELECT id, session_id, role, content, agent_id, agent_name, model, created_at
         FROM messages WHERE is_active = 1 ${sessionFilter} ${sinceFilterCreated}
         ORDER BY created_at DESC LIMIT ?`
      ).all(...msgParams) as any[];

      for (const m of messages) {
        entries.push({
          id: nextId(),
          sessionId: m.session_id,
          activityType: 'message_added',
          entityType: 'message',
          entityId: m.id,
          summary: `${m.agent_name || m.role}: ${(m.content || '').slice(0, 80)}`,
          details: { role: m.role, model: m.model, agentId: m.agent_id, agentName: m.agent_name },
          createdAt: m.created_at,
          agentId: m.agent_id,
          agentName: m.agent_name,
        });
      }
    } catch { /* table may not exist */ }

    // ── Tool Calls ────────────────────────────────────────────────────────
    try {
      const toolParams = buildParams();
      const tools = db.query(
        `SELECT id, session_id, tool_name, status, agent_id, agent_name,
                started_at, completed_at, error_message
         FROM tool_calls WHERE 1=1 ${sessionFilter} ${sinceFilter}
         ORDER BY started_at DESC LIMIT ?`
      ).all(...toolParams) as any[];

      for (const tc of tools) {
        if (tc.started_at) {
          entries.push({
            id: nextId(),
            sessionId: tc.session_id,
            activityType: 'tool_call_started',
            entityType: 'tool_call',
            entityId: tc.id,
            summary: `Tool: ${tc.tool_name}`,
            details: { toolName: tc.tool_name, agentId: tc.agent_id, agentName: tc.agent_name },
            createdAt: tc.started_at,
            agentId: tc.agent_id,
            agentName: tc.agent_name,
          });
        }
        if (tc.completed_at) {
          entries.push({
            id: nextId(),
            sessionId: tc.session_id,
            activityType: 'tool_call_completed',
            entityType: 'tool_call',
            entityId: tc.id,
            summary: `Tool ${tc.status}: ${tc.tool_name}${tc.error_message ? ' - ' + tc.error_message : ''}`,
            details: { toolName: tc.tool_name, status: tc.status, error: tc.error_message },
            createdAt: tc.completed_at,
            agentId: tc.agent_id,
            agentName: tc.agent_name,
          });
        }
      }

      // Permission events from tool calls
      const permTools = db.query(
        `SELECT id, session_id, tool_name, status, agent_id, agent_name, started_at
         FROM tool_calls WHERE status IN ('awaiting_permission', 'approved', 'denied')
         ${sessionFilter} ${sinceFilter}
         ORDER BY started_at DESC LIMIT ?`
      ).all(...toolParams) as any[];

      for (const tc of permTools) {
        const type = tc.status === 'awaiting_permission' ? 'permission_requested'
          : tc.status === 'approved' ? 'permission_granted' : 'permission_denied';
        entries.push({
          id: nextId(),
          sessionId: tc.session_id,
          activityType: type,
          entityType: 'permission',
          entityId: tc.id,
          summary: `Permission ${tc.status}: ${tc.tool_name}`,
          details: { toolName: tc.tool_name },
          createdAt: tc.started_at,
          agentId: tc.agent_id,
          agentName: tc.agent_name,
        });
      }
    } catch { /* table may not exist */ }

    // ── Documents ─────────────────────────────────────────────────────────
    try {
      const docParams: (string | number)[] = [];
      if (sessionId) docParams.push(sessionId);
      if (since) docParams.push(since);
      docParams.push(limit);

      const docs = db.query(
        `SELECT id, session_id, agent_id, doc_type, title, status, severity, created_at
         FROM documents WHERE 1=1 ${sessionFilter} ${sinceFilterCreated}
         ORDER BY created_at DESC LIMIT ?`
      ).all(...docParams) as any[];

      for (const d of docs) {
        entries.push({
          id: nextId(),
          sessionId: d.session_id,
          activityType: 'document_created',
          entityType: 'document',
          entityId: d.id,
          summary: `${d.doc_type}: ${d.title}`,
          details: { docType: d.doc_type, status: d.status, severity: d.severity },
          createdAt: d.created_at,
          agentId: d.agent_id,
        });
      }
    } catch { /* table may not exist */ }

    // ── Todos ─────────────────────────────────────────────────────────────
    try {
      const todoParams: (string | number)[] = [];
      if (sessionId) todoParams.push(sessionId);
      if (since) todoParams.push(since);
      todoParams.push(limit);

      const todos = db.query(
        `SELECT id, session_id, agent_id, content, status, created_at
         FROM todos WHERE 1=1 ${sessionFilter} ${sinceFilterCreated}
         ORDER BY created_at DESC LIMIT ?`
      ).all(...todoParams) as any[];

      for (const t of todos) {
        entries.push({
          id: nextId(),
          sessionId: t.session_id,
          activityType: 'todo_updated',
          entityType: 'todo',
          entityId: t.id,
          summary: `Todo [${t.status}]: ${(t.content || '').slice(0, 60)}`,
          details: { status: t.status },
          createdAt: t.created_at,
          agentId: t.agent_id,
        });
      }
    } catch { /* table may not exist */ }

    // Sort by time descending and limit
    entries.sort((a, b) => b.createdAt - a.createdAt);
    return entries.slice(0, limit);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Compaction Handlers
  // ═══════════════════════════════════════════════════════════════════════════

  private handleCreateCompaction(params: unknown) {
    const p = params as {
      id?: string; sessionId: string; summary: string;
      startMessageId: string; endMessageId: string;
      messageCount?: number; tokensBefore?: number; tokensAfter?: number;
    };
    const id = p.id ?? `comp-${crypto.randomUUID()}`;
    const now = Date.now();

    this.db().run(
      `INSERT INTO compactions (id, session_id, summary, start_message_id, end_message_id,
       original_token_count, compressed_token_count, messages_compacted, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, p.sessionId, p.summary, p.startMessageId, p.endMessageId,
       p.tokensBefore ?? null, p.tokensAfter ?? null, p.messageCount ?? null, now]
    );

    // Mark compacted messages as inactive
    this.db().run(
      `UPDATE messages SET is_active = 0, compacted_into_id = ?
       WHERE session_id = ? AND created_at >= (SELECT created_at FROM messages WHERE id = ?)
       AND created_at <= (SELECT created_at FROM messages WHERE id = ?)`,
      [id, p.sessionId, p.startMessageId, p.endMessageId]
    );

    return { id, sessionId: p.sessionId, summary: p.summary, createdAt: now, isActive: true };
  }

  private handleGetCompaction(params: unknown) {
    const p = params as { id: string };
    return this.db().query('SELECT * FROM compactions WHERE id = ?').get(p.id);
  }

  private handleListCompactions(params: unknown) {
    const p = params as { sessionId: string };
    return this.db().query(
      'SELECT * FROM compactions WHERE session_id = ? ORDER BY created_at ASC'
    ).all(p.sessionId);
  }

  private handleExpandCompaction(params: unknown) {
    const p = params as { id: string; sessionId: string };
    this.db().run(
      `UPDATE messages SET is_active = 1, compacted_into_id = NULL
       WHERE compacted_into_id = ?`, [p.id]
    );
    return { success: true };
  }

  private handleCollapseCompaction(params: unknown) {
    const p = params as { id: string; sessionId: string };
    const comp = this.db().query('SELECT * FROM compactions WHERE id = ?').get(p.id) as any;
    if (comp) {
      this.db().run(
        `UPDATE messages SET is_active = 0, compacted_into_id = ?
         WHERE session_id = ? AND created_at >= (SELECT created_at FROM messages WHERE id = ?)
         AND created_at <= (SELECT created_at FROM messages WHERE id = ?)`,
        [p.id, p.sessionId, comp.start_message_id, comp.end_message_id]
      );
    }
    return { success: true };
  }

  private handleDeleteCompaction(params: unknown) {
    const p = params as { id: string };
    // Re-activate messages first
    this.db().run(
      `UPDATE messages SET is_active = 1, compacted_into_id = NULL
       WHERE compacted_into_id = ?`, [p.id]
    );
    this.db().run('DELETE FROM compactions WHERE id = ?', [p.id]);
    return { success: true };
  }

  private handleBuildContext(params: unknown) {
    const p = params as { sessionId: string; includeCompacted?: boolean };
    const db = this.db();

    // Get active messages (or all if includeCompacted)
    const activeFilter = p.includeCompacted ? '' : 'AND m.is_active = 1';
    const messages = db.query(
      `SELECT * FROM messages m WHERE m.session_id = ? ${activeFilter}
       ORDER BY m.created_at ASC`
    ).all(p.sessionId).map((r: any) => this.mapMessage(r));

    // Get compactions
    const compactions = db.query(
      'SELECT * FROM compactions WHERE session_id = ? ORDER BY created_at ASC'
    ).all(p.sessionId);

    // Estimate tokens
    const totalTokens = messages.reduce((sum: number, m: any) =>
      sum + Math.ceil((m.content?.length || 0) / 4), 0);

    return {
      messages,
      totalTokens,
      compactionsApplied: compactions.length,
      hasCompactedContent: compactions.length > 0,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Todo Handlers
  // ═══════════════════════════════════════════════════════════════════════════

  private handleUpsertTodo(params: unknown) {
    const p = params as {
      id?: string; sessionId?: string; content: string;
      status: string; activeForm?: string; orderIndex?: number;
      agentId?: string; assignedAgentId?: string; documentId?: string;
    };
    const id = p.id ?? `todo-${crypto.randomUUID()}`;
    const now = Date.now();

    this.db().run(
      `INSERT OR REPLACE INTO todos
       (id, session_id, document_id, agent_id, assigned_agent_id,
        content, active_form, status, order_index, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, p.sessionId ?? null, p.documentId ?? null,
        p.agentId ?? null, p.assignedAgentId ?? null,
        p.content, p.activeForm ?? null, p.status, p.orderIndex ?? 0, now, now,
      ]
    );

    const todo = this.db().query('SELECT * FROM todos WHERE id = ?').get(id);
    this.sendNotification('chat/todo/updated', { todo: this.mapTodo(todo) });
    return this.mapTodo(todo);
  }

  private handleGetTodo(params: unknown) {
    const p = params as { id: string };
    const row = this.db().query('SELECT * FROM todos WHERE id = ?').get(p.id);
    return row ? this.mapTodo(row) : null;
  }

  private handleListTodos(params: unknown) {
    const p = (params || {}) as { sessionId?: string; documentId?: string; limit?: number };
    let sql = 'SELECT * FROM todos WHERE 1=1';
    const vals: (string | number)[] = [];

    if (p.sessionId) { sql += ' AND session_id = ?'; vals.push(p.sessionId); }
    if (p.documentId) { sql += ' AND document_id = ?'; vals.push(p.documentId); }
    sql += ' ORDER BY order_index ASC, created_at ASC';
    if (p.limit) { sql += ' LIMIT ?'; vals.push(p.limit); }

    return this.db().query(sql).all(...vals).map((r: any) => this.mapTodo(r));
  }

  private handleUpdateTodoStatus(params: unknown) {
    const p = params as { id: string; status: string };
    const now = Date.now();
    const completedAt = p.status === 'completed' ? now : null;

    this.db().run(
      'UPDATE todos SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?',
      [p.status, now, completedAt, p.id]
    );

    const todo = this.db().query('SELECT * FROM todos WHERE id = ?').get(p.id);
    this.sendNotification('chat/todo/updated', { todo: this.mapTodo(todo) });
    return { success: true };
  }

  private handleDeleteTodo(params: unknown) {
    const p = params as { id: string };
    this.db().run('DELETE FROM todos WHERE id = ?', [p.id]);
    this.sendNotification('chat/todo/deleted', { id: p.id });
    return { success: true };
  }

  private handleReplaceTodos(params: unknown) {
    const p = params as { sessionId?: string; todos: any[] };
    const db = this.db();
    const sessionId = p.sessionId ?? null;

    db.run('BEGIN TRANSACTION');
    try {
      // Delete existing todos for this session
      if (sessionId) {
        db.run('DELETE FROM todos WHERE session_id = ?', [sessionId]);
      } else {
        db.run('DELETE FROM todos WHERE session_id IS NULL');
      }

      // Insert new todos
      const now = Date.now();
      for (const todo of p.todos) {
        const id = todo.id ?? `todo-${crypto.randomUUID()}`;
        db.run(
          `INSERT INTO todos (id, session_id, content, active_form, status, order_index,
           agent_id, assigned_agent_id, document_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id, sessionId, todo.content, todo.activeForm ?? null,
            todo.status ?? 'pending', todo.orderIndex ?? 0,
            todo.agentId ?? null, todo.assignedAgentId ?? null,
            todo.documentId ?? null, now, now,
          ]
        );
      }

      db.run('COMMIT');
    } catch (err) {
      db.run('ROLLBACK');
      throw err;
    }

    const result = this.handleListTodos({ sessionId });
    this.sendNotification('chat/todo/replaced', { sessionId, todos: result });
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Document Handlers (NEW)
  // ═══════════════════════════════════════════════════════════════════════════

  private handleCreateDocument(params: unknown) {
    const doc = this.documentService!.createDocument(params as any);
    this.sendNotification('chat/document/created', { document: doc });
    return doc;
  }

  private handleGetDocument(params: unknown) {
    const p = params as { id: string };
    return this.documentService!.getDocument(p.id);
  }

  private handleListDocuments(params: unknown) {
    return this.documentService!.listDocuments(params as any);
  }

  private handleUpdateDocument(params: unknown) {
    const p = params as { id: string; [key: string]: any };
    const { id, ...updates } = p;
    const doc = this.documentService!.updateDocument(id, updates as any);
    if (doc) this.sendNotification('chat/document/updated', { document: doc });
    return doc;
  }

  private handleDeleteDocument(params: unknown) {
    const p = params as { id: string };
    const deleted = this.documentService!.deleteDocument(p.id);
    if (deleted) this.sendNotification('chat/document/deleted', { id: p.id });
    return { success: deleted };
  }

  private handleSearchDocuments(params: unknown) {
    const p = params as { query: string; docType?: string; limit?: number };
    return this.documentService!.searchDocuments(p.query, {
      docType: p.docType as any,
      limit: p.limit,
    });
  }

  private handleGetDocumentHierarchy(params: unknown) {
    const p = params as { id: string };
    return this.documentService!.getDocumentHierarchy(p.id);
  }

  private handleGetVulnerabilities(params: unknown) {
    const p = (params || {}) as { sessionId?: string };
    return this.documentService!.getActiveVulnerabilities(p.sessionId);
  }

  private handleGetPendingReviews(_params: unknown) {
    return this.documentService!.getPendingReviews();
  }

  private handleCountDocumentsByType(_params: unknown) {
    return this.documentService!.countByType();
  }

  private handleGetDocumentContent(params: unknown) {
    const p = params as { id: string };
    const doc = this.documentService!.getDocument(p.id);
    return doc ? { id: doc.id, title: doc.title, content: doc.content } : null;
  }

  // ─── Legacy Plan/Spec → Document Adapters ────────────────────────────────

  private handleCreatePlanAsDocument(params: unknown) {
    const p = params as { sessionId?: string; title: string; content?: string; summary?: string; filePath?: string };
    return this.documentService!.createDocument({
      docType: 'plan',
      sessionId: p.sessionId,
      title: p.title,
      content: p.content ?? '',
      summary: p.summary,
      filePath: p.filePath,
      status: 'active',
    });
  }

  private handleCreateSpecAsDocument(params: unknown) {
    const p = params as { title: string; description?: string; content?: string; validationCriteria?: string; filePath?: string };
    return this.documentService!.createDocument({
      docType: 'spec',
      title: p.title,
      content: p.content ?? p.description ?? '',
      summary: p.description,
      validationCriteria: p.validationCriteria,
      filePath: p.filePath,
      status: 'active',
    });
  }

  private handleLinkDocuments(params: unknown) {
    const p = params as { childId: string; parentId: string };
    return this.documentService!.updateDocument(p.childId, { parentId: p.parentId } as any);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Stats
  // ═══════════════════════════════════════════════════════════════════════════

  private handleGetStats() {
    const db = this.db();
    const sessions = (db.query('SELECT COUNT(*) as c FROM sessions').get() as any).c;
    const messages = (db.query('SELECT COUNT(*) as c FROM messages').get() as any).c;
    const toolCalls = (db.query('SELECT COUNT(*) as c FROM tool_calls').get() as any).c;
    const documents = (db.query('SELECT COUNT(*) as c FROM documents').get() as any).c;
    const todos = (db.query('SELECT COUNT(*) as c FROM todos').get() as any).c;
    const agents = (db.query('SELECT COUNT(*) as c FROM agents').get() as any).c;

    return { sessions, messages, toolCalls, documents, todos, agents };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  private db(): Database {
    return this.chatDb!.getDb();
  }

  private getSessionById(id: string) {
    const row = this.db().query('SELECT * FROM sessions WHERE id = ?').get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      provider: row.provider,
      model: row.model,
      systemPrompt: row.system_prompt,
      status: row.status,
      workflowId: row.workflow_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private getMessageById(id: string) {
    const row = this.db().query('SELECT * FROM messages WHERE id = ?').get(id);
    return row ? this.mapMessage(row) : null;
  }

  private mapMessage(row: any) {
    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role === 'tool_call' ? 'tool' : row.role, // Map back to frontend expectation
      content: row.content,
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      durationMs: row.duration_ms,
      agentId: row.agent_id,
      agentName: row.agent_name,
      isActive: row.is_active === 1,
      isComplete: row.is_complete === 1,
      iterationNumber: row.iteration_number,
      createdAt: row.created_at,
    };
  }

  private mapTodo(row: any) {
    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.session_id,
      documentId: row.document_id,
      agentId: row.agent_id,
      assignedAgentId: row.assigned_agent_id,
      content: row.content,
      activeForm: row.active_form,
      status: row.status,
      orderIndex: row.order_index,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ChatStorage Compatibility (used by AIServiceAdapter)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get messages for a session (ChatStorage compatibility for AIServiceAdapter).
   */
  getMessages(sessionId: string, options: { limit?: number; offset?: number; after?: number } = {}) {
    if (!this.chatDb) return [];
    const { limit = 100, offset = 0, after } = options;
    const db = this.db();

    let sql = `SELECT * FROM messages WHERE session_id = ? AND is_active = 1`;
    const vals: (string | number)[] = [sessionId];

    if (after) { sql += ' AND created_at > ?'; vals.push(after); }
    sql += ' ORDER BY created_at ASC LIMIT ? OFFSET ?';
    vals.push(limit, offset);

    return db.query(sql).all(...vals).map((r: any) => this.mapMessage(r));
  }

  /**
   * Get agents currently in a session (ChatStorage compatibility for AIServiceAdapter).
   */
  getSessionAgents(sessionId: string, options: { includeLeft?: boolean } = {}) {
    if (!this.chatDb) return [];
    const { includeLeft = false } = options;
    const db = this.db();

    let sql = `SELECT session_id, agent_id, joined_at, left_at, role FROM session_agents WHERE session_id = ?`;
    const vals: (string | number)[] = [sessionId];

    if (!includeLeft) { sql += ' AND left_at IS NULL'; }
    sql += ' ORDER BY joined_at ASC';

    return db.query(sql).all(...vals).map((r: any) => ({
      sessionId: r.session_id,
      agentId: r.agent_id,
      joinedAt: r.joined_at,
      leftAt: r.left_at,
      role: r.role,
    }));
  }

  /**
   * Add an agent to a session (ChatStorage compatibility for AIServiceAdapter).
   * Ensures the agent exists in the agents table (for FK satisfaction) before
   * inserting into session_agents. This handles agents from file storage, the
   * orchestrator, or other non-DB sources.
   */
  addSessionAgent(sessionId: string, agentId: string, role: string, agentName?: string) {
    if (!this.chatDb) return null;
    const db = this.db();
    const now = Date.now();

    // Ensure the agent has a row in the agents table (FK target).
    // Uses INSERT OR IGNORE so existing rows are untouched.
    db.run(
      `INSERT OR IGNORE INTO agents (id, name, role, created_at) VALUES (?, ?, ?, ?)`,
      [agentId, agentName || agentId, role || 'primary', now]
    );

    db.run(
      `INSERT OR REPLACE INTO session_agents (session_id, agent_id, role, joined_at)
       VALUES (?, ?, ?, ?)`,
      [sessionId, agentId, role, now]
    );

    return { sessionId, agentId, joinedAt: now, leftAt: null, role };
  }

  /**
   * Remove an agent from a session (ChatStorage compatibility for AIServiceAdapter).
   */
  removeSessionAgent(sessionId: string, agentId: string) {
    if (!this.chatDb) return;
    const db = this.db();
    db.run(
      'UPDATE session_agents SET left_at = ? WHERE session_id = ? AND agent_id = ?',
      [Date.now(), sessionId, agentId]
    );
  }

}
