/**
 * Review Panel Service
 *
 * Manages multi-reviewer code review panels with vote collection,
 * aggregation, and outcome determination.
 */

import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import type {
  ReviewVote,
  ReviewerVote,
  ReviewIssue,
  ReviewPanelConfig,
  ReviewPanelExecution,
  PanelOutcome,
  PanelStatus,
  AggregationSummary,
  VotingStrategy,
  VotingThresholds,
  CreatePanelOptions,
  AddVoteOptions,
  ReviewerResponse,
} from '../types/review-panel.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Database Schema Types
// ─────────────────────────────────────────────────────────────────────────────

interface StoredPanelExecution {
  id: string;
  node_execution_id: string;
  session_id: string;
  config: string; // JSON
  status: PanelStatus;
  outcome: PanelOutcome | null;
  summary: string | null; // JSON
  started_at: number;
  completed_at: number | null;
  error: string | null;
}

interface StoredVote {
  id: string;
  panel_id: string;
  reviewer_id: string;
  vote: ReviewVote;
  feedback: string;
  issues: string | null; // JSON
  weight: number;
  created_at: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Review Panel Service
// ─────────────────────────────────────────────────────────────────────────────

export class ReviewPanelService {
  constructor(private db: Database) {}

  // ─────────────────────────────────────────────────────────────────────────────
  // Panel Execution CRUD
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a new review panel execution.
   */
  createPanelExecution(options: CreatePanelOptions): ReviewPanelExecution {
    const id = randomUUID();
    const now = Date.now();

    this.db.run(
      `INSERT INTO review_panels
       (id, node_execution_id, session_id, config, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        options.nodeExecutionId,
        options.executionId,
        JSON.stringify(options.config),
        'pending',
        now,
      ]
    );

    return {
      id,
      nodeExecutionId: options.nodeExecutionId,
      executionId: options.executionId,
      config: options.config,
      status: 'pending',
      votes: [],
      startedAt: now,
    };
  }

  /**
   * Get a panel execution by ID.
   */
  getPanelExecution(id: string): ReviewPanelExecution | null {
    const row = this.db.query(
      'SELECT * FROM review_panels WHERE id = ?'
    ).get(id) as StoredPanelExecution | null;

    if (!row) return null;

    const votes = this.getVotesForPanel(id);

    return {
      id: row.id,
      nodeExecutionId: row.node_execution_id,
      executionId: row.session_id,
      config: JSON.parse(row.config),
      status: row.status,
      votes,
      outcome: row.outcome ?? undefined,
      summary: row.summary ? JSON.parse(row.summary) : undefined,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      error: row.error ?? undefined,
    };
  }

  /**
   * Get panel executions for a workflow execution.
   */
  listPanelExecutions(executionId: string): ReviewPanelExecution[] {
    const rows = this.db.query(
      'SELECT * FROM review_panels WHERE session_id = ? ORDER BY started_at ASC'
    ).all(executionId) as StoredPanelExecution[];

    return rows.map((row) => {
      const votes = this.getVotesForPanel(row.id);
      return {
        id: row.id,
        nodeExecutionId: row.node_execution_id,
        executionId: row.session_id,
        config: JSON.parse(row.config),
        status: row.status,
        votes,
        outcome: row.outcome ?? undefined,
        summary: row.summary ? JSON.parse(row.summary) : undefined,
        startedAt: row.started_at,
        completedAt: row.completed_at ?? undefined,
        error: row.error ?? undefined,
      };
    });
  }

  /**
   * Update panel status.
   */
  updatePanelStatus(id: string, status: PanelStatus, error?: string): boolean {
    const result = this.db.run(
      'UPDATE review_panels SET status = ?, error = ? WHERE id = ?',
      [status, error ?? null, id]
    );
    return result.changes > 0;
  }

  /**
   * Start collecting votes (transition to collecting status).
   */
  startCollecting(id: string): boolean {
    return this.updatePanelStatus(id, 'collecting');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Vote Management
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Add a vote to a panel.
   */
  addVote(options: AddVoteOptions): ReviewerVote {
    const id = randomUUID();
    const now = Date.now();

    this.db.run(
      `INSERT INTO review_votes
       (id, panel_id, reviewer_id, vote, feedback, issues, weight, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        options.panelExecutionId,
        options.reviewerId,
        options.vote,
        options.feedback,
        options.issues ? JSON.stringify(options.issues) : null,
        options.weight,
        now,
      ]
    );

    return {
      id,
      panelExecutionId: options.panelExecutionId,
      reviewerId: options.reviewerId,
      vote: options.vote,
      feedback: options.feedback,
      issues: options.issues,
      weight: options.weight,
      createdAt: now,
    };
  }

  /**
   * Get all votes for a panel.
   */
  getVotesForPanel(panelExecutionId: string): ReviewerVote[] {
    const rows = this.db.query(
      'SELECT * FROM review_votes WHERE panel_id = ? ORDER BY created_at ASC'
    ).all(panelExecutionId) as StoredVote[];

    return rows.map((row) => ({
      id: row.id,
      panelExecutionId: row.panel_id,
      reviewerId: row.reviewer_id,
      vote: row.vote,
      feedback: row.feedback,
      issues: row.issues ? JSON.parse(row.issues) : undefined,
      weight: row.weight,
      createdAt: row.created_at,
    }));
  }

  /**
   * Check if all expected votes have been collected.
   */
  hasAllVotes(panelExecutionId: string): boolean {
    const panel = this.getPanelExecution(panelExecutionId);
    if (!panel) return false;

    const expectedCount = panel.config.reviewers.length;
    return panel.votes.length >= expectedCount;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Vote Aggregation
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Aggregate votes and determine outcome.
   */
  aggregateVotes(panelExecutionId: string): { outcome: PanelOutcome; summary: AggregationSummary } {
    const panel = this.getPanelExecution(panelExecutionId);
    if (!panel) {
      throw new Error(`Panel execution not found: ${panelExecutionId}`);
    }

    const votes = panel.votes;
    const config = panel.config;
    const strategy = config.voting.strategy;
    const thresholds = config.voting.thresholds ?? {};

    // Calculate weighted totals
    let totalWeight = 0;
    let criticalWeight = 0;
    let changesWeight = 0;
    let approveWeight = 0;
    let abstainCount = 0;
    const criticalIssues: ReviewIssue[] = [];
    const otherIssues: ReviewIssue[] = [];

    for (const vote of votes) {
      if (vote.vote === 'abstain') {
        abstainCount++;
        continue;
      }

      totalWeight += vote.weight;

      switch (vote.vote) {
        case 'critical':
          criticalWeight += vote.weight;
          // Collect critical issues
          if (vote.issues) {
            criticalIssues.push(...vote.issues.filter(i => i.severity === 'critical'));
            otherIssues.push(...vote.issues.filter(i => i.severity !== 'critical'));
          }
          break;
        case 'request_changes':
          changesWeight += vote.weight;
          if (vote.issues) {
            otherIssues.push(...vote.issues);
          }
          break;
        case 'approve':
          approveWeight += vote.weight;
          break;
      }
    }

    // Calculate percentages
    const approvalPercentage = totalWeight > 0 ? approveWeight / totalWeight : 0;
    const changesPercentage = totalWeight > 0 ? changesWeight / totalWeight : 0;
    const criticalPercentage = totalWeight > 0 ? criticalWeight / totalWeight : 0;

    // Check quorum
    const quorum = thresholds.quorum ?? 1;
    const quorumMet = (votes.length - abstainCount) >= quorum;

    // Determine outcome based on strategy
    const { outcome, reason } = this.determineOutcome(
      strategy,
      thresholds,
      {
        criticalWeight,
        changesWeight,
        approveWeight,
        totalWeight,
        approvalPercentage,
        changesPercentage,
        criticalPercentage,
        quorumMet,
        votes,
      }
    );

    const summary: AggregationSummary = {
      totalWeight,
      criticalWeight,
      changesWeight,
      approveWeight,
      abstainCount,
      approvalPercentage,
      changesPercentage,
      quorumMet,
      outcomeReason: reason,
      criticalIssues,
      otherIssues,
    };

    // Update panel with outcome
    this.completePanelExecution(panelExecutionId, outcome, summary);

    return { outcome, summary };
  }

  /**
   * Determine outcome based on voting strategy.
   */
  private determineOutcome(
    strategy: VotingStrategy,
    thresholds: VotingThresholds,
    metrics: {
      criticalWeight: number;
      changesWeight: number;
      approveWeight: number;
      totalWeight: number;
      approvalPercentage: number;
      changesPercentage: number;
      criticalPercentage: number;
      quorumMet: boolean;
      votes: ReviewerVote[];
    }
  ): { outcome: PanelOutcome; reason: string } {
    const {
      criticalWeight,
      approvalPercentage,
      changesPercentage,
      quorumMet,
      votes,
    } = metrics;

    // Check quorum first
    if (!quorumMet) {
      return {
        outcome: 'escalate',
        reason: `Quorum not met: needed ${thresholds.quorum ?? 1} non-abstain votes`,
      };
    }

    // Critical always blocks if configured
    if (thresholds.criticalBlocks !== false && criticalWeight > 0) {
      return {
        outcome: 'address_critical',
        reason: `Critical issues found (weight: ${criticalWeight})`,
      };
    }

    switch (strategy) {
      case 'any_critical':
        // Already handled above
        if (changesPercentage > (thresholds.changesThreshold ?? 0.5)) {
          return {
            outcome: 'queue_changes',
            reason: `Changes requested (${(changesPercentage * 100).toFixed(0)}% weighted)`,
          };
        }
        return {
          outcome: 'approved',
          reason: 'No critical issues found',
        };

      case 'unanimous':
        const allApprove = votes.every(v => v.vote === 'approve' || v.vote === 'abstain');
        if (allApprove) {
          return { outcome: 'approved', reason: 'Unanimous approval' };
        }
        if (criticalWeight > 0) {
          return { outcome: 'address_critical', reason: 'Not unanimous - critical votes present' };
        }
        return { outcome: 'queue_changes', reason: 'Not unanimous - changes requested' };

      case 'majority':
        if (approvalPercentage > 0.5) {
          return { outcome: 'approved', reason: `Majority approved (${(approvalPercentage * 100).toFixed(0)}%)` };
        }
        if (changesPercentage > 0.5) {
          return { outcome: 'queue_changes', reason: `Majority requested changes (${(changesPercentage * 100).toFixed(0)}%)` };
        }
        return { outcome: 'escalate', reason: 'No clear majority' };

      case 'quorum':
        // Just needs minimum approvals
        const approveCount = votes.filter(v => v.vote === 'approve').length;
        if (approveCount >= (thresholds.quorum ?? 1)) {
          return { outcome: 'approved', reason: `Quorum of approvals met (${approveCount})` };
        }
        return { outcome: 'queue_changes', reason: 'Quorum of approvals not met' };

      case 'weighted_threshold':
      default:
        const approveThreshold = thresholds.approveThreshold ?? 0.7;
        const changesThreshold = thresholds.changesThreshold ?? 0.4;

        if (approvalPercentage >= approveThreshold) {
          return {
            outcome: 'approved',
            reason: `Approval threshold met (${(approvalPercentage * 100).toFixed(0)}% >= ${(approveThreshold * 100).toFixed(0)}%)`,
          };
        }
        if (changesPercentage >= changesThreshold) {
          return {
            outcome: 'queue_changes',
            reason: `Changes threshold met (${(changesPercentage * 100).toFixed(0)}% >= ${(changesThreshold * 100).toFixed(0)}%)`,
          };
        }
        return {
          outcome: 'escalate',
          reason: `Mixed results - approval: ${(approvalPercentage * 100).toFixed(0)}%, changes: ${(changesPercentage * 100).toFixed(0)}%`,
        };
    }
  }

  /**
   * Complete a panel execution with outcome.
   */
  private completePanelExecution(
    id: string,
    outcome: PanelOutcome,
    summary: AggregationSummary
  ): boolean {
    const now = Date.now();
    const result = this.db.run(
      `UPDATE review_panels
       SET status = ?, outcome = ?, summary = ?, completed_at = ?
       WHERE id = ?`,
      ['completed', outcome, JSON.stringify(summary), now, id]
    );
    return result.changes > 0;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Response Parsing
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Parse a reviewer's response into structured vote.
   * Expects format like:
   *   VOTE: approve|critical|request_changes|abstain
   *   FEEDBACK: <text>
   *   ISSUES: (optional JSON array)
   */
  parseReviewerResponse(rawResponse: string): ReviewerResponse {
    const result: ReviewerResponse = { rawResponse };

    // Extract VOTE
    const voteMatch = rawResponse.match(/VOTE:\s*(critical|request_changes|approve|abstain)/i);
    if (voteMatch && voteMatch[1]) {
      result.vote = voteMatch[1].toLowerCase() as ReviewVote;
    }

    // Extract FEEDBACK
    const feedbackMatch = rawResponse.match(/FEEDBACK:\s*(.+?)(?=\n(?:ISSUES:|$)|$)/is);
    if (feedbackMatch && feedbackMatch[1]) {
      result.feedback = feedbackMatch[1].trim();
    } else {
      // Use entire response as feedback if no explicit FEEDBACK section
      result.feedback = rawResponse;
    }

    // Extract ISSUES (JSON format)
    const issuesMatch = rawResponse.match(/ISSUES:\s*(\[[\s\S]*?\])/i);
    if (issuesMatch && issuesMatch[1]) {
      try {
        result.issues = JSON.parse(issuesMatch[1]);
      } catch {
        // Ignore parse errors
      }
    }

    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Statistics
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get statistics for review panels in an execution.
   */
  getPanelStats(executionId: string): {
    totalPanels: number;
    completed: number;
    approved: number;
    addressCritical: number;
    queueChanges: number;
    escalated: number;
    averageReviewers: number;
  } {
    const panels = this.listPanelExecutions(executionId);

    const completed = panels.filter(p => p.status === 'completed');
    const outcomes = completed.map(p => p.outcome);

    const totalVotes = panels.reduce((sum, p) => sum + p.votes.length, 0);

    return {
      totalPanels: panels.length,
      completed: completed.length,
      approved: outcomes.filter(o => o === 'approved').length,
      addressCritical: outcomes.filter(o => o === 'address_critical').length,
      queueChanges: outcomes.filter(o => o === 'queue_changes').length,
      escalated: outcomes.filter(o => o === 'escalate').length,
      averageReviewers: panels.length > 0 ? totalVotes / panels.length : 0,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createReviewPanelService(db: Database): ReviewPanelService {
  return new ReviewPanelService(db);
}
