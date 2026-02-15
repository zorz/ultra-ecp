/**
 * Validation Middleware Types
 *
 * Core type definitions for the validation middleware system.
 * Supports static validators, AI critics, and hierarchical context.
 */

import type { AIProviderType } from '../ai/types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Trigger Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * When validation should be triggered.
 */
export type ValidationTrigger =
  | 'pre-tool'     // Before any tool executes
  | 'on-change'    // When coder proposes a change
  | 'pre-write'    // Before file modifications are written
  | 'post-tool'    // After tool execution completes
  | 'pre-commit'   // Before changes are committed
  | 'periodic'     // At intervals during long sessions
  | 'on-demand';   // Explicitly requested

/**
 * Type of validator.
 */
export type ValidatorType =
  | 'static'      // Rule-based: linting, type checking, formatting
  | 'ai-critic'   // LLM-based critique
  | 'custom'      // User-defined validation logic
  | 'composite';  // Combines multiple validators

// ─────────────────────────────────────────────────────────────────────────────
// Context Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Git status information.
 */
export interface GitStatus {
  /** Current branch */
  branch: string;
  /** Files with changes */
  changedFiles: string[];
  /** Staged files */
  stagedFiles: string[];
  /** Untracked files */
  untrackedFiles: string[];
}

/**
 * A tool call being validated.
 */
export interface ToolCall {
  /** Tool use ID */
  id: string;
  /** Tool name */
  name: string;
  /** Tool input parameters */
  input: Record<string, unknown>;
}

/**
 * Result of a tool execution.
 */
export interface ToolResult {
  /** Whether execution succeeded */
  success: boolean;
  /** Result data */
  result?: unknown;
  /** Error message if failed */
  error?: string;
}

/**
 * Historical action for context.
 */
export interface ActionHistory {
  /** Timestamp of action */
  timestamp: number;
  /** Action type */
  type: string;
  /** Action details */
  details: Record<string, unknown>;
}

/**
 * File context for validation.
 */
export interface FileContext {
  /** File path */
  path: string;
  /** Full file content */
  content: string;
  /** Changes only (unified diff format) */
  diff?: string;
  /** Detected language */
  language?: string;
  /** Related files (imports, tests, etc.) */
  relatedFiles?: string[];
  /** Hierarchical context from validation/ */
  hierarchicalContext?: HierarchicalContext;
}

/**
 * Configuration for what context to include.
 */
export interface ValidatorContextConfig {
  /** Include full file content */
  includeFullFile: boolean;
  /** Include file diff */
  includeDiff: boolean;
  /** Include git diff */
  includeGitDiff: boolean;
  /** Include related files (imports, tests) */
  includeRelatedFiles: boolean;
  /** How many levels of imports to include */
  relatedFileDepth: number;
  /** Token/char limit for context */
  maxContextSize?: number;
}

/**
 * Default context configuration.
 */
export const DEFAULT_CONTEXT_CONFIG: ValidatorContextConfig = {
  includeFullFile: true,
  includeDiff: true,
  includeGitDiff: true,
  includeRelatedFiles: false,
  relatedFileDepth: 1,
};

/**
 * Full validation context.
 */
export interface ValidationContext {
  /** What triggered this validation */
  trigger: ValidationTrigger;
  /** When validation was triggered */
  timestamp: number;
  /** Files being validated */
  files: FileContext[];
  /** Git diff (if available and requested) */
  gitDiff?: string;
  /** Git status */
  gitStatus?: GitStatus;
  /** Session ID */
  sessionId: string;
  /** Recent actions */
  recentActions?: ActionHistory[];
  /** Tool call being validated (for tool-related triggers) */
  toolCall?: ToolCall;
  /** Tool result (for post-tool trigger) */
  toolResult?: ToolResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hierarchical Context Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A coding pattern to enforce.
 */
export interface Pattern {
  /** Unique identifier */
  id: string;
  /** Description of the pattern */
  description: string;
  /** Which context file defined this */
  source: string;
  /** Example code */
  examples?: string[];
}

/**
 * An anti-pattern to flag.
 */
export interface AntiPattern {
  /** Unique identifier */
  id: string;
  /** What to avoid */
  pattern: string;
  /** What to use instead */
  alternative: string;
  /** Why this is bad */
  reason?: string;
  /** Which context file defined this */
  source: string;
}

/**
 * A coding convention.
 */
export interface Convention {
  /** Unique identifier */
  id: string;
  /** Description of the convention */
  description: string;
  /** Which context file defined this */
  source: string;
}

/**
 * An override directive.
 */
export interface Override {
  /** Type of override */
  type: 'extend' | 'override' | 'disable';
  /** ID of the pattern/anti-pattern/convention being overridden */
  targetId: string;
  /** New value if extending or overriding */
  newValue?: string;
  /** Which context file defined this */
  source: string;
}

/**
 * Merged hierarchical context for a file.
 */
export interface HierarchicalContext {
  /** Patterns to enforce */
  patterns: Pattern[];
  /** Anti-patterns to flag */
  antiPatterns: AntiPattern[];
  /** Conventions to follow */
  conventions: Convention[];
  /** Architecture notes */
  architectureNotes: string;
  /** Override directives */
  overrides: Override[];
}

/**
 * Parsed context from a single context.md file.
 */
export interface ParsedContext {
  /** Patterns defined in this file */
  patterns: Pattern[];
  /** Anti-patterns defined in this file */
  antiPatterns: AntiPattern[];
  /** Conventions defined in this file */
  conventions: Convention[];
  /** Architecture notes */
  architectureNotes: string;
  /** Override directives */
  overrides: Override[];
  /** Source file path */
  source: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Result Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Status of a validation result.
 */
export type ValidationStatus =
  | 'approved'       // Passed validation
  | 'rejected'       // Failed validation
  | 'needs-revision' // Requires changes
  | 'skipped'        // Validator was skipped
  | 'timeout';       // Validator timed out

/**
 * Severity of a validation result.
 */
export type ValidationSeverity = 'error' | 'warning' | 'info' | 'suggestion';

/**
 * Details about a validation issue.
 */
export interface ValidationDetails {
  /** File with the issue */
  file?: string;
  /** Line number */
  line?: number;
  /** Column number */
  column?: number;
  /** Suggested fix */
  suggestedFix?: string;
  /** Reasoning (for AI critics) */
  reasoning?: string;
}

/**
 * Result from a single validator.
 */
export interface ValidationResult {
  /** Validation status */
  status: ValidationStatus;
  /** Validator that produced this result */
  validator: string;
  /** Severity level */
  severity: ValidationSeverity;
  /** Human-readable message */
  message: string;
  /** Optional details */
  details?: ValidationDetails;
  /** Time taken in milliseconds */
  durationMs: number;
  /** Whether this was from cache */
  cached: boolean;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Overall status from validation pipeline.
 */
export type OverallValidationStatus =
  | 'approved'       // All passed
  | 'rejected'       // At least one rejected
  | 'needs-revision' // Needs changes but not rejected
  | 'blocked';       // Blocked by a required validator

/**
 * Summary of all validation results.
 */
export interface ValidationSummary {
  /** Overall status */
  overallStatus: OverallValidationStatus;
  /** All results */
  results: ValidationResult[];
  /** Whether human needs to make a decision */
  requiresHumanDecision: boolean;
  /** Whether consensus was reached */
  consensusReached: boolean;
  /** IDs of validators that blocked */
  blockedBy?: string[];
  /** Warning results */
  warnings: ValidationResult[];
  /** Error results */
  errors: ValidationResult[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Validator Definition Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validator behavior configuration.
 */
export interface ValidatorBehavior {
  /** How failures are handled */
  onFailure: 'warning' | 'error';
  /** Whether to block on failure */
  blockOnFailure: boolean;
  /** Whether this validator is required (any issue blocks) */
  required: boolean;
  /** Timeout in milliseconds */
  timeoutMs: number;
  /** What to do on timeout */
  onTimeout: 'skip' | 'warning' | 'error';
  /** Whether results can be cached */
  cacheable: boolean;
  /** What determines cache key */
  cacheKeyFields?: string[];
  /** Whether consensus is required */
  requireConsensus?: boolean;
  /** Weight for weighted consensus */
  weight?: number;
}

/**
 * Default validator behavior.
 */
export const DEFAULT_VALIDATOR_BEHAVIOR: ValidatorBehavior = {
  onFailure: 'warning',
  blockOnFailure: false,
  required: false,
  timeoutMs: 30000,
  onTimeout: 'warning',
  cacheable: true,
};

/**
 * Complete validator definition.
 */
export interface ValidatorDefinition {
  /** Unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Validator type */
  type: ValidatorType;
  /** Whether validator is enabled */
  enabled: boolean;
  /** Priority (lower = runs first) */
  priority: number;
  /** AI provider (for ai-critic type) */
  provider?: AIProviderType;
  /** Model to use (for ai-critic type) */
  model?: string;
  /** System prompt (for ai-critic type) */
  systemPrompt?: string;
  /** API key for AI provider (for ai-critic type) */
  apiKey?: string;
  /** Base URL for AI provider (for ai-critic type) */
  baseUrl?: string;
  /** Maximum tokens for AI response (for ai-critic type) */
  maxTokens?: number;
  /** Temperature for AI generation (for ai-critic type) */
  temperature?: number;
  /** Shell command (for static type) */
  command?: string;
  /** Which triggers this validator responds to */
  triggers: ValidationTrigger[];
  /** Glob patterns for files to validate */
  filePatterns?: string[];
  /** Context configuration */
  contextConfig?: ValidatorContextConfig;
  /** Behavior configuration */
  behavior: ValidatorBehavior;
  /** Custom validation function (for custom type) */
  validate?: (context: ValidationContext) => Promise<ValidationResult>;
  /** Child validators (for composite type) */
  children?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Consensus Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strategy for reaching consensus.
 */
export type ConsensusStrategy =
  | 'unanimous'      // All must approve
  | 'majority'       // >50% must approve
  | 'any-approve'    // At least one approves
  | 'no-rejections'  // None explicitly reject
  | 'weighted';      // Based on validator weight

/**
 * Consensus configuration.
 */
export interface ConsensusConfig {
  /** Strategy to use */
  strategy: ConsensusStrategy;
  /** Minimum number of responses required */
  minimumResponses: number;
  /** Timeout for reaching consensus */
  timeoutMs: number;
  /** Whether to escalate to human on no consensus */
  escalateToHuman: boolean;
}

/**
 * Default consensus configuration.
 */
export const DEFAULT_CONSENSUS_CONFIG: ConsensusConfig = {
  strategy: 'majority',
  minimumResponses: 1,
  timeoutMs: 60000,
  escalateToHuman: true,
};

/**
 * Result of consensus evaluation.
 */
export interface ConsensusResult {
  /** Whether consensus was reached */
  reached: boolean;
  /** Whether the consensus is approval */
  approved?: boolean;
  /** Reason if consensus not reached */
  reason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline Configuration Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execution model for validators.
 */
export type ExecutionModel = 'turn-based' | 'parallel';

/**
 * Validation pipeline configuration.
 */
export interface ValidationPipelineConfig {
  /** Execution model */
  executionModel: ExecutionModel;
  /** Default timeout for validators */
  defaultTimeout: number;
  /** Whether caching is enabled */
  cacheEnabled: boolean;
  /** Maximum age for cached results (ms) */
  cacheMaxAge: number;
  /** Consensus configuration */
  consensus: ConsensusConfig;
  /** Path to validation context directory */
  contextDir: string;
  /** Validators loaded from configuration (optional) */
  validators?: ValidatorDefinition[];
}

/**
 * Default pipeline configuration.
 */
export const DEFAULT_PIPELINE_CONFIG: ValidationPipelineConfig = {
  executionModel: 'turn-based',
  defaultTimeout: 30000,
  cacheEnabled: true,
  cacheMaxAge: 5 * 60 * 1000, // 5 minutes
  consensus: DEFAULT_CONSENSUS_CONFIG,
  contextDir: 'validation',
};

// ─────────────────────────────────────────────────────────────────────────────
// Feed Integration Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validation entry for the shared feed.
 */
export interface ValidationFeedEntry {
  /** Entry type */
  type: 'validation';
  /** When this happened */
  timestamp: number;
  /** What triggered validation */
  trigger: ValidationTrigger;
  /** Context summary */
  context: {
    files: string[];
    changeDescription: string;
  };
  /** Validation summary */
  summary: ValidationSummary;
  /** Whether action is required */
  requiresAction: boolean;
  /** Type of action required */
  actionType?: 'decision' | 'permission' | 'review';
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unsubscribe function.
 */
export type Unsubscribe = () => void;

/**
 * Generate a unique validation ID.
 */
export function generateValidationId(): string {
  return `val-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}
