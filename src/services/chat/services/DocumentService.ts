/**
 * DocumentService - CRUD Operations for Documents
 *
 * Manages structured documents that agents create and consume:
 * PRDs, assessments, vulnerabilities, specs, plans, reports, etc.
 *
 * Documents form a knowledge base that persists across sessions,
 * enabling agents to build on each other's work.
 */

import { Database } from 'bun:sqlite';
import { debugLog } from '../../../debug.ts';
import type {
  Document,
  DocumentType,
  DocumentStatus,
  DocumentSeverity,
  DocumentReviewStatus,
  CreateDocumentOptions,
  UpdateDocumentOptions,
  ListDocumentsOptions,
} from '../../../shared/types/documents.ts';

/**
 * Stored document row (matches database schema).
 */
interface StoredDocument {
  id: string;
  session_id: string | null;
  agent_id: string | null;
  doc_type: DocumentType;
  title: string;
  content: string;
  summary: string | null;
  metadata: string | null;
  parent_id: string | null;
  status: DocumentStatus;
  severity: DocumentSeverity | null;
  priority: number;
  reviewed_by_agent_id: string | null;
  review_status: DocumentReviewStatus | null;
  file_path: string | null;
  validation_criteria: string | null;
  created_at: number;
  updated_at: number | null;
}

/**
 * Document with children (for hierarchy queries).
 */
export interface DocumentWithChildren extends Document {
  children: Document[];
}

/**
 * DocumentService handles CRUD operations for all document types.
 */
export class DocumentService {
  constructor(private db: Database) {}

  /**
   * Create a new document.
   */
  createDocument(options: CreateDocumentOptions): Document {
    const now = Date.now();
    const id = `doc-${crypto.randomUUID()}`;

    this.db.run(
      `INSERT INTO documents (
        id, session_id, agent_id, doc_type, title, content, summary,
        metadata, parent_id, status, severity, priority,
        file_path, validation_criteria, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        options.sessionId ?? null,
        options.agentId ?? null,
        options.docType,
        options.title,
        options.content,
        options.summary ?? null,
        options.metadata ? JSON.stringify(options.metadata) : null,
        options.parentId ?? null,
        options.status ?? 'draft',
        options.severity ?? null,
        options.priority ?? 0,
        options.filePath ?? null,
        options.validationCriteria ?? null,
        now,
        now,
      ] as (string | number | null)[]
    );

    debugLog(`[DocumentService] Created ${options.docType} document: ${id}`);
    return this.getDocument(id)!;
  }

  /**
   * Get a document by ID.
   */
  getDocument(id: string): Document | null {
    const row = this.db.query(
      `SELECT * FROM documents WHERE id = ?`
    ).get(id) as StoredDocument | null;

    if (!row) return null;
    return this.mapStoredToDocument(row);
  }

  /**
   * List documents with optional filtering.
   */
  listDocuments(options: ListDocumentsOptions = {}): Document[] {
    const { limit = 100, offset = 0 } = options;

    let query = 'SELECT * FROM documents WHERE 1=1';
    const params: (string | number | null)[] = [];

    if (options.sessionId) {
      query += ' AND session_id = ?';
      params.push(options.sessionId);
    }

    if (options.agentId) {
      query += ' AND agent_id = ?';
      params.push(options.agentId);
    }

    if (options.docType) {
      query += ' AND doc_type = ?';
      params.push(options.docType);
    }

    if (options.status) {
      query += ' AND status = ?';
      params.push(options.status);
    }

    if (options.parentId) {
      query += ' AND parent_id = ?';
      params.push(options.parentId);
    }

    if (options.severity) {
      query += ' AND severity = ?';
      params.push(options.severity);
    }

    if (options.reviewStatus) {
      query += ' AND review_status = ?';
      params.push(options.reviewStatus);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.db.query(query).all(...params) as StoredDocument[];
    return rows.map((row) => this.mapStoredToDocument(row));
  }

  /**
   * Update a document.
   */
  updateDocument(id: string, updates: UpdateDocumentOptions): Document | null {
    const existing = this.getDocument(id);
    if (!existing) return null;

    const now = Date.now();
    const sets: string[] = ['updated_at = ?'];
    const params: (string | number | null)[] = [now];

    if (updates.title !== undefined) {
      sets.push('title = ?');
      params.push(updates.title);
    }

    if (updates.content !== undefined) {
      sets.push('content = ?');
      params.push(updates.content);
    }

    if (updates.summary !== undefined) {
      sets.push('summary = ?');
      params.push(updates.summary ?? null);
    }

    if (updates.metadata !== undefined) {
      sets.push('metadata = ?');
      params.push(updates.metadata ? JSON.stringify(updates.metadata) : null);
    }

    if (updates.status !== undefined) {
      sets.push('status = ?');
      params.push(updates.status);
    }

    if (updates.severity !== undefined) {
      sets.push('severity = ?');
      params.push(updates.severity ?? null);
    }

    if (updates.priority !== undefined) {
      sets.push('priority = ?');
      params.push(updates.priority);
    }

    if (updates.reviewedByAgentId !== undefined) {
      sets.push('reviewed_by_agent_id = ?');
      params.push(updates.reviewedByAgentId ?? null);
    }

    if (updates.reviewStatus !== undefined) {
      sets.push('review_status = ?');
      params.push(updates.reviewStatus ?? null);
    }

    if (updates.filePath !== undefined) {
      sets.push('file_path = ?');
      params.push(updates.filePath ?? null);
    }

    if (updates.validationCriteria !== undefined) {
      sets.push('validation_criteria = ?');
      params.push(updates.validationCriteria ?? null);
    }

    params.push(id);
    this.db.run(`UPDATE documents SET ${sets.join(', ')} WHERE id = ?`, params);

    return this.getDocument(id);
  }

  /**
   * Delete a document.
   */
  deleteDocument(id: string): boolean {
    const result = this.db.run('DELETE FROM documents WHERE id = ?', [id]);
    return result.changes > 0;
  }

  /**
   * Get a document with its children (hierarchy).
   */
  getDocumentWithChildren(id: string): DocumentWithChildren | null {
    const doc = this.getDocument(id);
    if (!doc) return null;

    const children = this.listDocuments({ parentId: id });
    return { ...doc, children };
  }

  /**
   * Get the full document hierarchy starting from a root document.
   */
  getDocumentHierarchy(rootId: string): DocumentWithChildren | null {
    const root = this.getDocument(rootId);
    if (!root) return null;

    const buildHierarchy = (parentId: string): DocumentWithChildren[] => {
      const children = this.listDocuments({ parentId });
      return children.map((child) => ({
        ...child,
        children: buildHierarchy(child.id).map((c) => ({
          ...c,
        })),
      }));
    };

    return {
      ...root,
      children: buildHierarchy(rootId).map((c) => ({ ...c })),
    };
  }

  /**
   * List documents by type for a given session, or across all sessions.
   */
  listByType(docType: DocumentType, sessionId?: string): Document[] {
    return this.listDocuments({ docType, sessionId });
  }

  /**
   * Get active vulnerabilities (not archived/resolved).
   */
  getActiveVulnerabilities(sessionId?: string): Document[] {
    let query = `SELECT * FROM documents WHERE doc_type = 'vulnerability'
      AND status NOT IN ('archived', 'completed') ORDER BY
      CASE severity
        WHEN 'critical' THEN 0
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 3
        WHEN 'info' THEN 4
        ELSE 5
      END, created_at DESC`;
    const params: string[] = [];

    if (sessionId) {
      query = `SELECT * FROM documents WHERE doc_type = 'vulnerability'
        AND status NOT IN ('archived', 'completed')
        AND session_id = ? ORDER BY
        CASE severity
          WHEN 'critical' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
          WHEN 'info' THEN 4
          ELSE 5
        END, created_at DESC`;
      params.push(sessionId);
    }

    const rows = this.db.query(query).all(...params) as StoredDocument[];
    return rows.map((row) => this.mapStoredToDocument(row));
  }

  /**
   * Get documents pending review.
   */
  getPendingReviews(): Document[] {
    const rows = this.db.query(
      `SELECT * FROM documents WHERE review_status = 'pending'
       ORDER BY priority DESC, created_at ASC`
    ).all() as StoredDocument[];

    return rows.map((row) => this.mapStoredToDocument(row));
  }

  /**
   * Count documents by type.
   */
  countByType(): Record<DocumentType, number> {
    const rows = this.db.query(
      `SELECT doc_type, COUNT(*) as count FROM documents
       WHERE status != 'archived'
       GROUP BY doc_type`
    ).all() as Array<{ doc_type: DocumentType; count: number }>;

    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.doc_type] = row.count;
    }
    return counts as Record<DocumentType, number>;
  }

  /**
   * Search documents by title or content.
   */
  searchDocuments(query: string, options?: { docType?: DocumentType; limit?: number }): Document[] {
    const limit = options?.limit ?? 50;
    let sql = `SELECT * FROM documents WHERE (title LIKE ? OR content LIKE ?)`;
    const params: (string | number)[] = [`%${query}%`, `%${query}%`];

    if (options?.docType) {
      sql += ' AND doc_type = ?';
      params.push(options.docType);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.query(sql).all(...params) as StoredDocument[];
    return rows.map((row) => this.mapStoredToDocument(row));
  }

  /**
   * Map a stored document row to the domain Document type.
   */
  private mapStoredToDocument(stored: StoredDocument): Document {
    return {
      id: stored.id,
      sessionId: stored.session_id,
      agentId: stored.agent_id,
      docType: stored.doc_type,
      title: stored.title,
      content: stored.content,
      summary: stored.summary,
      metadata: stored.metadata ? JSON.parse(stored.metadata) : null,
      parentId: stored.parent_id,
      status: stored.status,
      severity: stored.severity,
      priority: stored.priority,
      reviewedByAgentId: stored.reviewed_by_agent_id,
      reviewStatus: stored.review_status,
      filePath: stored.file_path,
      validationCriteria: stored.validation_criteria,
      createdAt: stored.created_at,
      updatedAt: stored.updated_at,
    };
  }
}

/**
 * Create a new DocumentService instance.
 */
export function createDocumentService(db: Database): DocumentService {
  return new DocumentService(db);
}
