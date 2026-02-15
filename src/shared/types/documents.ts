/**
 * Shared Document Types
 *
 * Types for the unified documents system - PRDs, assessments,
 * vulnerabilities, specs, plans, and other structured documents
 * that agents create and consume.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Document Type Definitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Types of documents that can be created.
 */
export type DocumentType =
  | 'prd'              // Product Requirements Document
  | 'assessment'       // Code review assessment
  | 'vulnerability'    // Security vulnerability finding
  | 'spec'             // Technical specification
  | 'plan'             // Implementation plan
  | 'report'           // General analysis report
  | 'decision'         // Architecture decision record (ADR)
  | 'runbook'          // Operational runbook
  | 'review'           // Code review summary
  | 'note';            // General note or annotation

/**
 * Document status lifecycle.
 */
export type DocumentStatus =
  | 'draft'
  | 'active'
  | 'in_review'
  | 'approved'
  | 'rejected'
  | 'completed'
  | 'archived';

/**
 * Severity levels for documents (vulnerabilities, assessments).
 */
export type DocumentSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

/**
 * Review status for documents.
 */
export type DocumentReviewStatus = 'pending' | 'approved' | 'changes_requested' | 'critical';

// ─────────────────────────────────────────────────────────────────────────────
// Document Entry Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A document in the system.
 */
export interface Document {
  id: string;
  sessionId: string | null;
  agentId: string | null;
  docType: DocumentType;
  title: string;
  content: string;
  summary: string | null;
  metadata: Record<string, unknown> | null;
  parentId: string | null;
  status: DocumentStatus;
  severity: DocumentSeverity | null;
  priority: number;
  reviewedByAgentId: string | null;
  reviewStatus: DocumentReviewStatus | null;
  filePath: string | null;
  validationCriteria: string | null;
  createdAt: number;
  updatedAt: number | null;
}

/**
 * Options for creating a document.
 */
export interface CreateDocumentOptions {
  sessionId?: string;
  agentId?: string;
  docType: DocumentType;
  title: string;
  content: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  parentId?: string;
  status?: DocumentStatus;
  severity?: DocumentSeverity;
  priority?: number;
  filePath?: string;
  validationCriteria?: string;
}

/**
 * Options for updating a document.
 */
export interface UpdateDocumentOptions {
  title?: string;
  content?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  status?: DocumentStatus;
  severity?: DocumentSeverity;
  priority?: number;
  reviewedByAgentId?: string;
  reviewStatus?: DocumentReviewStatus;
  filePath?: string;
  validationCriteria?: string;
}

/**
 * Options for listing documents.
 */
export interface ListDocumentsOptions {
  sessionId?: string;
  agentId?: string;
  docType?: DocumentType;
  status?: DocumentStatus;
  parentId?: string;
  severity?: DocumentSeverity;
  reviewStatus?: DocumentReviewStatus;
  limit?: number;
  offset?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Document Metadata Schemas (by type)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PRD metadata.
 */
export interface PRDMetadata {
  features?: string[];
  acceptanceCriteria?: string[];
  stakeholders?: string[];
  targetRelease?: string;
}

/**
 * Vulnerability metadata.
 */
export interface VulnerabilityMetadata {
  cwe?: string;
  affectedFiles?: string[];
  attackVector?: string;
  cvssScore?: number;
  remediation?: string;
  reproducible?: boolean;
}

/**
 * Assessment metadata.
 */
export interface AssessmentMetadata {
  score?: number;
  areas?: string[];
  recommendations?: string[];
  filesReviewed?: string[];
}

/**
 * Plan metadata.
 */
export interface PlanMetadata {
  phases?: string[];
  dependencies?: string[];
  estimates?: Record<string, string>;
  risks?: string[];
}

/**
 * Decision (ADR) metadata.
 */
export interface DecisionMetadata {
  decisionDate?: string;
  alternatives?: string[];
  rationale?: string;
  consequences?: string[];
  supersedes?: string;
}
