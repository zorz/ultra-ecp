/**
 * CCA Framework Types
 *
 * Type definitions specific to the Coder-Critic-Arbiter workflow.
 */

import type { ValidationSummary } from '../../validation/types.ts';

/**
 * CCA workflow state.
 */
export type CCAWorkflowState =
  | 'idle'
  | 'coding'
  | 'reviewing'
  | 'awaiting-arbiter'
  | 'applying'
  | 'iterating'
  | 'completed'
  | 'error';

/**
 * A code change proposed by the coder.
 */
export interface ProposedChange {
  /** Unique change ID */
  id: string;
  /** File path */
  path: string;
  /** Change type */
  type: 'create' | 'edit' | 'delete';
  /** Original content (for edit/delete) */
  originalContent?: string;
  /** New content (for create/edit) */
  newContent?: string;
  /** Unified diff */
  diff?: string;
  /** When the change was proposed */
  proposedAt: number;
  /** Current status */
  status: 'proposed' | 'approved' | 'rejected' | 'applied' | 'reverted';
}

/**
 * Review from a critic (validation result).
 */
export interface CriticReview {
  /** Critic/validator ID */
  criticId: string;
  /** Critic type */
  type: 'static' | 'ai-critic';
  /** Whether the changes are approved (explicit boolean) */
  approved: boolean;
  /** Overall verdict */
  verdict: 'approve' | 'reject' | 'concerns' | 'error';
  /** Confidence score (0-1) for AI critics */
  confidence?: number;
  /** Review comments */
  comments: string[];
  /** Specific issues found */
  issues: CriticIssue[];
  /** Timestamp */
  reviewedAt: number;
}

/**
 * An issue raised by a critic.
 */
export interface CriticIssue {
  /** Severity level */
  severity: 'error' | 'warning' | 'suggestion' | 'info';
  /** Issue message */
  message: string;
  /** File path (if applicable) */
  path?: string;
  /** Line number (if applicable) */
  line?: number;
  /** Column (if applicable) */
  column?: number;
  /** Rule or check that raised the issue */
  rule?: string;
  /** Whether this blocks approval */
  blocking: boolean;
}

/**
 * Arbiter (human) decision.
 */
export interface ArbiterDecision {
  /** Decision ID */
  id: string;
  /** Decision type */
  type: 'approve' | 'reject' | 'iterate' | 'abort';
  /** Feedback for the coder */
  feedback?: string;
  /** Specific issues to address (for iterate) */
  addressIssues?: string[];
  /** Files to focus on (for iterate) */
  focusFiles?: string[];
  /** Timestamp */
  decidedAt: number;
}

/**
 * CCA iteration context.
 */
export interface CCAIteration {
  /** Iteration number */
  number: number;
  /** Proposed changes in this iteration */
  changes: ProposedChange[];
  /** Reviews from critics */
  reviews: CriticReview[];
  /** Arbiter decision (if made) */
  arbiterDecision?: ArbiterDecision;
  /** Started at */
  startedAt: number;
  /** Completed at */
  completedAt?: number;
}

/**
 * CCA session state.
 */
export interface CCASessionState {
  /** Current workflow state */
  workflowState: CCAWorkflowState;
  /** Task being worked on */
  task: string;
  /** All iterations */
  iterations: CCAIteration[];
  /** Current iteration number */
  currentIteration: number;
  /** Maximum allowed iterations */
  maxIterations: number;
  /** Whether consensus was reached */
  consensusReached: boolean;
  /** Summary of last validation */
  lastValidationSummary?: ValidationSummary;
}

/**
 * Options for CCA workflow configuration.
 */
export interface CCAWorkflowOptions {
  /** Maximum number of iterations before forcing human decision */
  maxIterations: number;
  /** Maximum tool execution loops per iteration (for safety) */
  maxToolLoops: number;
  /** Whether to auto-apply changes if all critics approve */
  autoApplyOnConsensus: boolean;
  /** Minimum critic approval ratio for auto-apply (0-1) */
  autoApplyThreshold: number;
  /** Whether to run validation after coder response */
  validateAfterCoding: boolean;
  /** Timeout for coder response (ms) */
  coderTimeout: number;
  /** Timeout for validation (ms) */
  validationTimeout: number;
  /** Timeout for human decision (ms, 0 = no timeout) */
  arbiterTimeout: number;
  /** Whether to include file diffs in validation context */
  includeFileDiffs: boolean;
}

/**
 * Default CCA workflow options.
 */
export const DEFAULT_CCA_OPTIONS: CCAWorkflowOptions = {
  maxIterations: 5,
  maxToolLoops: 50, // Allow more tool loops for exploration tasks
  autoApplyOnConsensus: false, // Require human approval by default
  autoApplyThreshold: 1.0, // All critics must approve
  validateAfterCoding: true,
  coderTimeout: 120000, // 2 minutes
  validationTimeout: 60000, // 1 minute
  arbiterTimeout: 0, // No timeout by default
  includeFileDiffs: true,
};

/**
 * Event types specific to CCA workflow.
 */
export type CCAEventType =
  | 'cca:iteration_started'
  | 'cca:coding_started'
  | 'cca:coding_completed'
  | 'cca:change_proposed'
  | 'cca:review_started'
  | 'cca:review_completed'
  | 'cca:awaiting_arbiter'
  | 'cca:arbiter_decided'
  | 'cca:changes_applied'
  | 'cca:iteration_completed'
  | 'cca:consensus_reached'
  | 'cca:max_iterations_reached';

/**
 * CCA-specific event.
 */
export interface CCAEvent {
  type: CCAEventType;
  sessionId: string;
  iteration: number;
  data?: unknown;
  timestamp: number;
}

/**
 * Callback for CCA events.
 */
export type CCAEventCallback = (event: CCAEvent) => void;
