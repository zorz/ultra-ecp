/**
 * TodoStore - Task/Todo Management
 *
 * Handles CRUD operations for todos with transactional batch operations.
 */

import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { withTransaction } from '../transactions.ts';

/**
 * Todo status values.
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/**
 * Todo record as stored in the database.
 */
export interface IStoredTodo {
  id: string;
  sessionId: string | null;
  planId: string | null;
  content: string;
  status: TodoStatus;
  activeForm: string | null;
  orderIndex: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

/**
 * Options for creating a todo.
 */
export interface ICreateTodoOptions {
  id: string;
  sessionId?: string | null;
  planId?: string | null;
  content: string;
  status?: TodoStatus;
  activeForm?: string | null;
  orderIndex?: number;
}

/**
 * Options for updating a todo.
 */
export interface IUpdateTodoOptions {
  content?: string;
  status?: TodoStatus;
  activeForm?: string | null;
  orderIndex?: number;
  planId?: string | null;
}

/**
 * Options for listing todos.
 */
export interface IListTodosOptions {
  sessionId?: string | null;
  planId?: string | null;
  status?: TodoStatus;
}

/**
 * TodoStore - manages todos in the database with transactional support.
 */
export class TodoStore {
  constructor(private db: Database) {}

  /**
   * Create a new todo.
   */
  create(options: ICreateTodoOptions): IStoredTodo {
    const now = Date.now();
    const todo: IStoredTodo = {
      id: options.id,
      sessionId: options.sessionId ?? null,
      planId: options.planId ?? null,
      content: options.content,
      status: options.status ?? 'pending',
      activeForm: options.activeForm ?? null,
      orderIndex: options.orderIndex ?? 0,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };

    this.db.run(
      `INSERT INTO todos (id, session_id, document_id, content, status, active_form, order_index, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        todo.id,
        todo.sessionId,
        todo.planId,
        todo.content,
        todo.status,
        todo.activeForm,
        todo.orderIndex,
        todo.createdAt,
        todo.updatedAt,
        todo.completedAt,
      ]
    );

    return todo;
  }

  /**
   * Get a todo by ID.
   */
  get(id: string): IStoredTodo | null {
    const row = this.db.query(
      `SELECT id, session_id, document_id, content, status, active_form, order_index, created_at, updated_at, completed_at
       FROM todos WHERE id = ?`
    ).get(id) as Record<string, unknown> | null;

    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * Update a todo.
   */
  update(id: string, updates: IUpdateTodoOptions): IStoredTodo | null {
    const existing = this.get(id);
    if (!existing) return null;

    const now = Date.now();
    const sets: string[] = ['updated_at = ?'];
    const values: SQLQueryBindings[] = [now];

    if (updates.content !== undefined) {
      sets.push('content = ?');
      values.push(updates.content);
    }

    if (updates.status !== undefined) {
      sets.push('status = ?');
      values.push(updates.status);

      // Set completedAt when status becomes 'completed'
      if (updates.status === 'completed') {
        sets.push('completed_at = ?');
        values.push(now);
      } else if (existing.status === 'completed') {
        // Clear completedAt if moving away from completed
        sets.push('completed_at = NULL');
      }
    }

    if (updates.activeForm !== undefined) {
      sets.push('active_form = ?');
      values.push(updates.activeForm);
    }

    if (updates.orderIndex !== undefined) {
      sets.push('order_index = ?');
      values.push(updates.orderIndex);
    }

    if (updates.planId !== undefined) {
      sets.push('document_id = ?');
      values.push(updates.planId);
    }

    values.push(id);
    this.db.run(`UPDATE todos SET ${sets.join(', ')} WHERE id = ?`, values);

    return this.get(id);
  }

  /**
   * Update todo status.
   */
  updateStatus(id: string, status: TodoStatus): IStoredTodo | null {
    return this.update(id, { status });
  }

  /**
   * Delete a todo.
   */
  delete(id: string): boolean {
    const result = this.db.run('DELETE FROM todos WHERE id = ?', [id]);
    return (result as { changes?: number })?.changes === 1;
  }

  /**
   * List todos with optional filtering.
   */
  list(options: IListTodosOptions = {}): IStoredTodo[] {
    let query = `
      SELECT id, session_id, document_id, content, status, active_form, order_index, created_at, updated_at, completed_at
      FROM todos
    `;
    const values: SQLQueryBindings[] = [];
    const conditions: string[] = [];

    if (options.sessionId !== undefined) {
      if (options.sessionId === null) {
        conditions.push('session_id IS NULL');
      } else {
        conditions.push('session_id = ?');
        values.push(options.sessionId);
      }
    }

    if (options.planId !== undefined) {
      if (options.planId === null) {
        conditions.push('document_id IS NULL');
      } else {
        conditions.push('document_id = ?');
        values.push(options.planId);
      }
    }

    if (options.status !== undefined) {
      conditions.push('status = ?');
      values.push(options.status);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY order_index ASC, created_at ASC';

    const rows = this.db.query(query).all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Replace all todos for a session atomically.
   * This is the primary method for bulk updates from AI.
   */
  replaceForSession(
    sessionId: string | null,
    todos: Array<Omit<ICreateTodoOptions, 'sessionId'>>
  ): IStoredTodo[] {
    const now = Date.now();

    return withTransaction(this.db, () => {
      // Delete existing todos for this session
      if (sessionId === null) {
        this.db.run('DELETE FROM todos WHERE session_id IS NULL');
      } else {
        this.db.run('DELETE FROM todos WHERE session_id = ?', [sessionId]);
      }

      // Prepare insert statement
      const insertStmt = this.db.prepare(
        `INSERT INTO todos (id, session_id, document_id, content, status, active_form, order_index, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      // Insert new todos
      const result: IStoredTodo[] = [];
      let orderIdx = 0;
      for (const todo of todos) {
        const stored: IStoredTodo = {
          id: todo.id,
          sessionId,
          planId: todo.planId ?? null,
          content: todo.content,
          status: todo.status ?? 'pending',
          activeForm: todo.activeForm ?? null,
          orderIndex: todo.orderIndex ?? orderIdx,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        };
        orderIdx++;

        insertStmt.run(
          stored.id,
          stored.sessionId,
          stored.planId,
          stored.content,
          stored.status,
          stored.activeForm,
          stored.orderIndex,
          stored.createdAt,
          stored.updatedAt,
          stored.completedAt
        );

        result.push(stored);
      }

      return result;
    });
  }

  /**
   * Create or update a todo (upsert).
   */
  upsert(options: ICreateTodoOptions): IStoredTodo {
    const existing = this.get(options.id);

    if (existing) {
      const updated = this.update(options.id, {
        content: options.content,
        status: options.status,
        activeForm: options.activeForm,
        orderIndex: options.orderIndex,
        planId: options.planId,
      });
      return updated!;
    }

    return this.create(options);
  }

  /**
   * Batch create todos within a transaction.
   */
  createBatch(todos: ICreateTodoOptions[]): IStoredTodo[] {
    if (todos.length === 0) return [];

    return withTransaction(this.db, () => {
      const now = Date.now();
      const results: IStoredTodo[] = [];

      const stmt = this.db.prepare(
        `INSERT INTO todos (id, session_id, document_id, content, status, active_form, order_index, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const options of todos) {
        const todo: IStoredTodo = {
          id: options.id,
          sessionId: options.sessionId ?? null,
          planId: options.planId ?? null,
          content: options.content,
          status: options.status ?? 'pending',
          activeForm: options.activeForm ?? null,
          orderIndex: options.orderIndex ?? 0,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        };

        stmt.run(
          todo.id,
          todo.sessionId,
          todo.planId,
          todo.content,
          todo.status,
          todo.activeForm,
          todo.orderIndex,
          todo.createdAt,
          todo.updatedAt,
          todo.completedAt
        );

        results.push(todo);
      }

      return results;
    });
  }

  /**
   * Delete all todos for a session.
   */
  deleteBySession(sessionId: string | null): number {
    let query = 'DELETE FROM todos';
    const values: SQLQueryBindings[] = [];

    if (sessionId === null) {
      query += ' WHERE session_id IS NULL';
    } else {
      query += ' WHERE session_id = ?';
      values.push(sessionId);
    }

    const result = this.db.run(query, values);
    return (result as { changes?: number })?.changes ?? 0;
  }

  /**
   * Delete all todos for a plan.
   */
  deleteByPlan(planId: string): number {
    const result = this.db.run('DELETE FROM todos WHERE document_id = ?', [planId]);
    return (result as { changes?: number })?.changes ?? 0;
  }

  /**
   * Get todo count.
   */
  count(options?: { sessionId?: string | null; status?: TodoStatus }): number {
    let query = 'SELECT COUNT(*) as count FROM todos WHERE 1=1';
    const values: SQLQueryBindings[] = [];

    if (options?.sessionId !== undefined) {
      if (options.sessionId === null) {
        query += ' AND session_id IS NULL';
      } else {
        query += ' AND session_id = ?';
        values.push(options.sessionId);
      }
    }

    if (options?.status) {
      query += ' AND status = ?';
      values.push(options.status);
    }

    const result = this.db.query(query).get(...values) as { count: number };
    return result.count;
  }

  /**
   * Get completion statistics.
   */
  getStats(sessionId?: string | null): { total: number; completed: number; inProgress: number; pending: number } {
    let baseWhere = '1=1';
    const values: SQLQueryBindings[] = [];

    if (sessionId !== undefined) {
      if (sessionId === null) {
        baseWhere = 'session_id IS NULL';
      } else {
        baseWhere = 'session_id = ?';
        values.push(sessionId);
      }
    }

    const result = this.db.query(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
       FROM todos
       WHERE ${baseWhere}`
    ).get(...values) as Record<string, number>;

    return {
      total: result.total ?? 0,
      completed: result.completed ?? 0,
      inProgress: result.in_progress ?? 0,
      pending: result.pending ?? 0,
    };
  }

  /**
   * Map a database row to a stored todo object.
   */
  private mapRow(row: Record<string, unknown>): IStoredTodo {
    return {
      id: row.id as string,
      sessionId: row.session_id as string | null,
      planId: row.document_id as string | null,
      content: row.content as string,
      status: row.status as TodoStatus,
      activeForm: row.active_form as string | null,
      orderIndex: row.order_index as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      completedAt: row.completed_at as number | null,
    };
  }
}
