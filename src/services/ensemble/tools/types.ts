/**
 * Tool Executor Types
 *
 * Type definitions for the ensemble tool executor.
 */

import type { PermissionResponse } from '../permissions/types.ts';

// ============================================
// Tool Execution Types
// ============================================

/**
 * Critic review for a proposed change.
 */
export interface CriticReviewInfo {
  /** Critic ID */
  criticId: string;
  /** Critic verdict */
  verdict: 'approve' | 'reject' | 'concerns' | 'error';
  /** Review comments */
  comments: string[];
  /** Specific issues */
  issues?: Array<{
    severity: 'error' | 'warning' | 'suggestion' | 'info';
    message: string;
    line?: number;
  }>;
}

/**
 * Tool execution request.
 */
export interface ToolExecutionRequest {
  /** Request ID */
  id: string;
  /** Session ID */
  sessionId: string;
  /** Agent ID that requested the tool */
  agentId: string;
  /** Tool name */
  tool: string;
  /** Tool input parameters */
  input: Record<string, unknown>;
  /** Target path (for file operations) */
  targetPath?: string;
  /** Timestamp */
  timestamp: number;
  /** Critic reviews for Write/Edit (if critics were run) */
  criticReviews?: CriticReviewInfo[];
}

/**
 * Tool execution result.
 */
export interface ToolExecutionResult {
  /** Request ID */
  requestId: string;
  /** Whether execution was successful */
  success: boolean;
  /** Result content (may be truncated/summarized) */
  result: string | Record<string, unknown>;
  /** Error message if failed */
  error?: string;
  /** Whether permission was denied */
  permissionDenied?: boolean;
  /** Duration in ms */
  duration: number;
  /** Whether result was truncated/summarized */
  truncated?: boolean;
  /** ID to retrieve full result from context store */
  fullResultId?: string;
}

/**
 * Tool handler function.
 */
export type ToolHandler = (input: Record<string, unknown>) => Promise<string | Record<string, unknown>>;

/**
 * Tool definition for executor.
 */
export interface ExecutorToolDefinition {
  /** Tool name */
  name: string;
  /** Tool description */
  description: string;
  /** Handler function */
  handler: ToolHandler;
  /** Whether tool requires permission */
  requiresPermission: boolean;
  /** Default permission description template */
  permissionDescription?: string;
}

/**
 * Permission prompt handler.
 * Called when a tool needs permission approval.
 */
export type PermissionPromptHandler = (
  tool: string,
  description: string,
  input: string,
  riskLevel: string,
  scopeOptions: Array<{
    scope: 'once' | 'session' | 'folder' | 'global';
    label: string;
    description: string;
  }>,
  doubleConfirm: boolean,
  /** Raw tool input for showing content/diff */
  rawInput?: Record<string, unknown>,
  /** Critic reviews for the proposed change */
  criticReviews?: CriticReviewInfo[]
) => Promise<PermissionResponse | null>;

/**
 * Size limits for result processing.
 */
export interface ResultSizeLimits {
  /** Max characters for file content (Read) */
  maxFileContent?: number;
  /** Max files to return from Glob */
  maxGlobFiles?: number;
  /** Max matches to return from Grep */
  maxGrepMatches?: number;
  /** Max characters for Bash output */
  maxBashOutput?: number;
  /** Max characters for generic results */
  maxGenericResult?: number;
}

/**
 * Tool executor configuration.
 */
export interface ToolExecutorConfig {
  /** Session ID */
  sessionId: string;
  /** Permission prompt handler */
  onPermissionPrompt?: PermissionPromptHandler;
  /** Timeout for tool execution (ms) */
  executionTimeout?: number;
  /** Whether to log tool executions */
  logExecutions?: boolean;
  /** Result size limits for truncation/summarization */
  resultSizeLimits?: ResultSizeLimits;
  /** Max results to store in context store */
  maxStoredResults?: number;
}
