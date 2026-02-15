/**
 * Review Panel Types
 *
 * Defines the structure for multi-reviewer code review panels.
 * Supports weighted voting, multiple strategies, and outcome routing.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Vote Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vote types a reviewer can cast.
 */
export type ReviewVote =
  | 'critical'        // Must be fixed immediately - blocks progress
  | 'request_changes' // Should be addressed - can be queued for later
  | 'approve'         // Looks good for this aspect
  | 'abstain';        // Outside reviewer's domain/expertise

/**
 * Individual review from a single reviewer.
 */
export interface ReviewerVote {
  /** Unique ID for this vote */
  id: string;
  /** ID of the review panel execution */
  panelExecutionId: string;
  /** Agent ID of the reviewer */
  reviewerId: string;
  /** The vote cast */
  vote: ReviewVote;
  /** Feedback/rationale for the vote */
  feedback: string;
  /** Specific issues identified (optional structured data) */
  issues?: ReviewIssue[];
  /** Weight applied to this vote (from reviewer config) */
  weight: number;
  /** When the vote was cast */
  createdAt: number;
}

/**
 * Structured issue identified by a reviewer.
 */
export interface ReviewIssue {
  /** Severity: critical, major, minor, suggestion */
  severity: 'critical' | 'major' | 'minor' | 'suggestion';
  /** Category: security, correctness, performance, style, etc. */
  category: string;
  /** Description of the issue */
  description: string;
  /** File path if applicable */
  file?: string;
  /** Line number(s) if applicable */
  lines?: { start: number; end?: number };
  /** Suggested fix if available */
  suggestion?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel Configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for a reviewer in the panel.
 */
export interface ReviewerConfig {
  /** Agent ID to use as reviewer */
  agent: string;
  /** Weight for this reviewer's votes (default: 1) */
  weight?: number;
  /** Custom prompt override for this reviewer */
  prompt?: string;
  /** Whether this reviewer is required (must not abstain) */
  required?: boolean;
}

/**
 * Voting strategy for aggregating results.
 */
export type VotingStrategy =
  | 'any_critical'        // Any critical vote triggers immediate action
  | 'weighted_threshold'  // Weighted voting with configurable thresholds
  | 'unanimous'           // All reviewers must approve
  | 'majority'            // Simple majority rules
  | 'quorum';             // Minimum number of approvals needed

/**
 * Threshold configuration for weighted voting.
 */
export interface VotingThresholds {
  /** Whether any single critical vote blocks progress */
  criticalBlocks?: boolean;
  /** Weighted threshold for request_changes to trigger action (0-1) */
  changesThreshold?: number;
  /** Weighted threshold for approval (0-1) */
  approveThreshold?: number;
  /** Minimum number of non-abstain votes required */
  quorum?: number;
}

/**
 * Outcome routing configuration.
 */
export interface OutcomeConfig {
  /** Action to take */
  action: 'loop' | 'continue' | 'pause' | 'complete';
  /** Target node for loop/continue actions */
  target?: string;
  /** Message to include with outcome */
  message?: string;
}

/**
 * Complete review panel configuration.
 */
export interface ReviewPanelConfig {
  /** List of reviewers */
  reviewers: ReviewerConfig[];
  /** Voting strategy */
  voting: {
    strategy: VotingStrategy;
    thresholds?: VotingThresholds;
  };
  /** Outcome routing based on aggregated result */
  outcomes: {
    /** Route when critical issues found */
    address_critical?: OutcomeConfig;
    /** Route when changes requested but not critical */
    queue_changes?: OutcomeConfig;
    /** Route when approved */
    approved?: OutcomeConfig;
    /** Route when escalation needed (conflicting/unclear) */
    escalate?: OutcomeConfig;
  };
  /** Maximum time to wait for all reviews (ms) */
  timeout?: number;
  /** Whether to run reviewers in parallel (default: true) */
  parallel?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel Execution State
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Possible outcomes from vote aggregation.
 */
export type PanelOutcome =
  | 'address_critical'  // Critical issues must be fixed
  | 'queue_changes'     // Changes requested, queued for later
  | 'approved'          // Panel approves the code
  | 'escalate';         // Needs human decision

/**
 * Status of a review panel execution.
 */
export type PanelStatus =
  | 'pending'           // Not yet started
  | 'collecting'        // Collecting votes from reviewers
  | 'aggregating'       // Computing final outcome
  | 'completed'         // Outcome determined
  | 'timeout'           // Timed out waiting for votes
  | 'error';            // Error during execution

/**
 * State of a review panel execution.
 */
export interface ReviewPanelExecution {
  /** Unique ID for this panel execution */
  id: string;
  /** Node execution ID this panel belongs to */
  nodeExecutionId: string;
  /** Workflow execution ID */
  executionId: string;
  /** Panel configuration used */
  config: ReviewPanelConfig;
  /** Current status */
  status: PanelStatus;
  /** Collected votes */
  votes: ReviewerVote[];
  /** Final outcome (when completed) */
  outcome?: PanelOutcome;
  /** Aggregation summary */
  summary?: AggregationSummary;
  /** When panel started */
  startedAt: number;
  /** When panel completed */
  completedAt?: number;
  /** Error message if failed */
  error?: string;
}

/**
 * Summary of vote aggregation.
 */
export interface AggregationSummary {
  /** Total weight of all voters (excluding abstains) */
  totalWeight: number;
  /** Weight that voted critical */
  criticalWeight: number;
  /** Weight that requested changes */
  changesWeight: number;
  /** Weight that approved */
  approveWeight: number;
  /** Number of abstentions */
  abstainCount: number;
  /** Percentage of weighted approval */
  approvalPercentage: number;
  /** Percentage of weighted changes requested */
  changesPercentage: number;
  /** Whether quorum was met */
  quorumMet: boolean;
  /** Reason for final outcome */
  outcomeReason: string;
  /** All critical issues collected */
  criticalIssues: ReviewIssue[];
  /** All non-critical issues collected */
  otherIssues: ReviewIssue[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow Step Extension
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extended workflow step for review panel nodes.
 */
export interface ReviewPanelStep {
  id: string;
  type: 'review_panel';
  depends?: string[];
  /** Inline reviewer configuration */
  reviewers?: ReviewerConfig[];
  /** Or reference a named panel preset */
  panel?: string;
  /** Voting configuration */
  voting?: {
    strategy: VotingStrategy;
    thresholds?: VotingThresholds;
  };
  /** Outcome routing */
  outcomes?: ReviewPanelConfig['outcomes'];
  /** Whether to run reviewers in parallel (default: true) */
  parallel?: boolean;
  /** Maximum time to wait for all reviews (ms) */
  timeout?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input to parse reviewer response into structured vote.
 */
export interface ReviewerResponse {
  /** Raw response text from reviewer agent */
  rawResponse: string;
  /** Parsed vote (if extraction successful) */
  vote?: ReviewVote;
  /** Parsed feedback */
  feedback?: string;
  /** Parsed issues */
  issues?: ReviewIssue[];
}

/**
 * Options for creating a review panel execution.
 */
export interface CreatePanelOptions {
  nodeExecutionId: string;
  executionId: string;
  config: ReviewPanelConfig;
}

/**
 * Options for adding a vote to a panel.
 */
export interface AddVoteOptions {
  panelExecutionId: string;
  reviewerId: string;
  vote: ReviewVote;
  feedback: string;
  issues?: ReviewIssue[];
  weight: number;
}
