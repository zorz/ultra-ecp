/**
 * TestChatHarness - End-to-End Test Setup
 *
 * Wires together MockAIProvider + in-memory database + ChatServiceAdapter
 * + DocumentService for end-to-end chat scenario testing.
 */

import { Database } from 'bun:sqlite';
import { migration005UnifiedSchema } from '../../src/services/chat/migrations/005-unified-schema.ts';
import { DocumentService } from '../../src/services/chat/services/DocumentService.ts';
import { MockAIProvider, type ScriptedResponse } from './mock-ai-provider.ts';

/**
 * Simplified notification record for assertions.
 */
export interface TestNotification {
  method: string;
  params: unknown;
  timestamp: number;
}

/**
 * Response from a chat message send operation.
 */
export interface ChatResponse {
  /** The text content of the response */
  content: string;
  /** The message ID */
  messageId: string;
  /** Whether the AI called any tools */
  hasToolUse: boolean;
  /** Stop reason */
  stopReason: string;
  /** Token usage */
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * TestChatHarness for end-to-end scenario testing.
 */
export class TestChatHarness {
  /** Mock AI provider for scripting responses */
  readonly provider: MockAIProvider;
  /** In-memory SQLite database */
  readonly db: Database;
  /** Document service for CRUD operations */
  readonly documentService: DocumentService;
  /** Captured notifications */
  private notifications: TestNotification[] = [];
  /** Monotonic counter for unique IDs */
  private idCounter = 0;

  private constructor() {
    this.provider = new MockAIProvider();
    this.db = new Database(':memory:');
    this.db.run('PRAGMA foreign_keys = ON');
    migration005UnifiedSchema.up(this.db);
    this.documentService = new DocumentService(this.db);
  }

  /**
   * Create a new test harness.
   */
  static create(): TestChatHarness {
    return new TestChatHarness();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Scripting API (delegates to MockAIProvider)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Queue responses for the mock provider.
   */
  queueResponses(...responses: Array<string | ScriptedResponse>): void {
    for (const r of responses) {
      if (typeof r === 'string') {
        this.provider.queueResponse(r);
      } else {
        this.provider.queueResponse(
          r.content.filter(c => c.type === 'text').map(c => (c as { text: string }).text).join(''),
          r.stopReason,
        );
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Session Management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a chat session in the database.
   */
  createSession(
    sessionId: string,
    options?: { title?: string; provider?: string; model?: string },
  ): void {
    const now = Date.now();
    this.db.run(
      `INSERT INTO sessions (id, title, provider, model, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      [
        sessionId,
        options?.title ?? null,
        options?.provider ?? 'claude',
        options?.model ?? 'mock-model',
        now,
        now,
      ],
    );
  }

  /**
   * Get a session from the database.
   */
  getSession(sessionId: string): Record<string, unknown> | null {
    return this.db.query('SELECT * FROM sessions WHERE id = ?').get(sessionId) as any;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Message Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Simulate sending a user message and getting an AI response.
   */
  async sendMessage(sessionId: string, content: string): Promise<ChatResponse> {
    const seq = this.idCounter++;
    // Use counter-based timestamps to guarantee ordering across rapid calls
    const baseTs = Date.now() * 1000 + seq * 2;

    // Store user message
    const userMsgId = `msg-user-${seq}`;
    this.db.run(
      `INSERT INTO messages (id, session_id, role, content, created_at)
       VALUES (?, ?, 'user', ?, ?)`,
      [userMsgId, sessionId, content, baseTs],
    );

    // Get AI response from mock provider
    const response = await this.provider.chat({
      messages: [
        {
          id: userMsgId,
          role: 'user',
          content: [{ type: 'text', text: content }],
          timestamp: baseTs,
        },
      ],
    });

    // Extract text content
    const textContent = response.message.content
      .filter(b => b.type === 'text')
      .map(b => (b as { text: string }).text)
      .join('');

    const hasToolUse = response.message.content.some(b => b.type === 'tool_use');

    // Store assistant message
    const assistantMsgId = response.message.id;
    this.db.run(
      `INSERT INTO messages (id, session_id, role, content, created_at)
       VALUES (?, ?, 'assistant', ?, ?)`,
      [assistantMsgId, sessionId, textContent, baseTs + 1],
    );

    // Emit notification
    this.captureNotification('chat/activity', {
      activityType: 'message_added',
      entityId: assistantMsgId,
      sessionId,
    });

    return {
      content: textContent,
      messageId: assistantMsgId,
      hasToolUse,
      stopReason: response.stopReason,
      usage: response.usage,
    };
  }

  /**
   * Get all messages for a session.
   */
  getMessages(sessionId: string): Array<Record<string, unknown>> {
    return this.db.query(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC',
    ).all(sessionId) as any[];
  }

  /**
   * Search messages using FTS.
   */
  searchMessages(query: string, sessionId?: string): Array<Record<string, unknown>> {
    let sql = `SELECT m.* FROM messages m
               JOIN messages_fts ON messages_fts.rowid = m.rowid
               WHERE messages_fts MATCH ?`;
    const vals: (string | number)[] = [query];

    if (sessionId) {
      sql += ' AND m.session_id = ?';
      vals.push(sessionId);
    }
    sql += ' ORDER BY m.created_at DESC LIMIT 50';

    return this.db.query(sql).all(...vals) as any[];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Todo Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Write todos to the database.
   */
  writeTodos(
    sessionId: string | null,
    todos: Array<{ content: string; status: string; activeForm?: string }>,
  ): void {
    const now = Date.now();
    const seq = this.idCounter++;

    this.db.run('BEGIN TRANSACTION');
    try {
      if (sessionId) {
        this.db.run('DELETE FROM todos WHERE session_id = ?', [sessionId]);
      } else {
        this.db.run('DELETE FROM todos WHERE session_id IS NULL');
      }

      for (let i = 0; i < todos.length; i++) {
        const todo = todos[i]!;
        this.db.run(
          `INSERT INTO todos (id, session_id, content, status, active_form, order_index, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [`todo-${now}-${seq}-${i}`, sessionId, todo.content, todo.status, todo.activeForm ?? null, i, now, now],
        );
      }

      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }

    this.captureNotification('chat/todo/replaced', { sessionId, count: todos.length });
  }

  /**
   * Read todos from the database.
   */
  readTodos(sessionId: string | null): Array<{
    id: string;
    content: string;
    status: string;
    activeForm: string | null;
    orderIndex: number;
  }> {
    let sql = 'SELECT * FROM todos WHERE ';
    const vals: (string | number)[] = [];

    if (sessionId) {
      sql += 'session_id = ?';
      vals.push(sessionId);
    } else {
      sql += 'session_id IS NULL';
    }
    sql += ' ORDER BY order_index ASC, created_at ASC';

    return (this.db.query(sql).all(...vals) as any[]).map(r => ({
      id: r.id,
      content: r.content,
      status: r.status,
      activeForm: r.active_form,
      orderIndex: r.order_index,
    }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Notification Helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Capture a notification.
   */
  private captureNotification(method: string, params: unknown): void {
    this.notifications.push({ method, params, timestamp: Date.now() });
  }

  /**
   * Get captured notifications, optionally filtered by method.
   */
  getNotifications(method?: string): TestNotification[] {
    if (!method) return [...this.notifications];
    return this.notifications.filter(n => n.method === method);
  }

  /**
   * Clear captured notifications.
   */
  clearNotifications(): void {
    this.notifications = [];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Shutdown and clean up.
   */
  shutdown(): void {
    this.db.close();
    this.provider.reset();
    this.notifications = [];
  }
}
