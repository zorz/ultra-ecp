/**
 * Framework Pipeline Types
 *
 * Types for the middleware pipeline that processes AI requests and responses.
 */

import type {
  ChatSession,
  SendMessageOptions,
  AIResponse,
  ToolUseContent,
  ToolExecutionResult,
  MiddlewareAction,
  MiddlewareContext,
  MiddlewareDefinition,
  PipelineConfig,
  PipelineResult,
  PipelineStage,
} from '../types.ts';

// Re-export core types
export type {
  MiddlewareAction,
  MiddlewareContext,
  MiddlewareDefinition,
  PipelineConfig,
  PipelineResult,
  PipelineStage,
};

/**
 * Built-in middleware types.
 */
export type BuiltInMiddleware =
  | 'validator'      // Validates responses against rules
  | 'critic'         // Uses another AI to critique responses
  | 'filter'         // Filters/redacts sensitive content
  | 'logger'         // Logs requests and responses
  | 'ratelimit'      // Rate limiting
  | 'approval'       // Requires user approval
  | 'linter';        // Code linting for code responses

/**
 * Validator middleware options.
 */
export interface ValidatorMiddlewareOptions {
  /** Maximum response length */
  maxLength?: number;
  /** Disallowed patterns (regex) */
  disallowedPatterns?: string[];
  /** Required patterns (regex) */
  requiredPatterns?: string[];
  /** Custom validation function */
  customValidator?: (response: AIResponse) => { valid: boolean; reason?: string };
}

/**
 * Critic middleware options.
 */
export interface CriticMiddlewareOptions {
  /** Provider to use for critique (e.g., 'claude', 'openai') */
  provider: string;
  /** Model to use */
  model?: string;
  /** Critique prompt template */
  promptTemplate?: string;
  /** Minimum score to pass (0-100) */
  minScore?: number;
  /** What to do when critique fails */
  onFail: 'block' | 'warn' | 'retry';
  /** Maximum retries if onFail is 'retry' */
  maxRetries?: number;
}

/**
 * Filter middleware options.
 */
export interface FilterMiddlewareOptions {
  /** Patterns to redact */
  redactPatterns?: Array<{
    pattern: string;
    replacement: string;
  }>;
  /** Whether to filter API keys, secrets, etc. */
  filterSecrets?: boolean;
  /** Whether to filter PII */
  filterPII?: boolean;
}

/**
 * Logger middleware options.
 */
export interface LoggerMiddlewareOptions {
  /** Log level */
  level: 'debug' | 'info' | 'warn' | 'error';
  /** What to log */
  logRequest?: boolean;
  logResponse?: boolean;
  logTools?: boolean;
  /** Custom log handler */
  handler?: (entry: LogEntry) => void;
}

/**
 * Log entry.
 */
export interface LogEntry {
  timestamp: number;
  stage: PipelineStage;
  sessionId: string;
  data: unknown;
}

/**
 * Rate limit middleware options.
 */
export interface RateLimitMiddlewareOptions {
  /** Maximum requests per window */
  maxRequests: number;
  /** Window duration in milliseconds */
  windowMs: number;
  /** What to do when rate limited */
  onLimit: 'block' | 'wait';
}

/**
 * Approval middleware options.
 */
export interface ApprovalMiddlewareOptions {
  /** Which stages require approval */
  stages: PipelineStage[];
  /** Approval timeout in milliseconds */
  timeout: number;
  /** What to do on timeout */
  onTimeout: 'block' | 'approve';
  /** Approval callback */
  onApprovalRequired?: (
    context: MiddlewareContext,
    approve: () => void,
    reject: (reason: string) => void
  ) => void;
}

/**
 * Linter middleware options.
 */
export interface LinterMiddlewareOptions {
  /** Languages to lint */
  languages?: string[];
  /** Linter commands by language */
  linters?: Record<string, {
    command: string;
    args: string[];
  }>;
  /** Whether to block on linter errors */
  blockOnError: boolean;
  /** Whether to auto-fix */
  autoFix?: boolean;
}

/**
 * Middleware factory function.
 */
export type MiddlewareFactory<T> = (options: T) => MiddlewareDefinition;

/**
 * Approval gate state.
 */
export interface ApprovalGate {
  id: string;
  context: MiddlewareContext;
  stage: PipelineStage;
  message: string;
  status: 'pending' | 'approved' | 'rejected';
  resolve?: (approved: boolean, reason?: string) => void;
  createdAt: number;
  timeout: number;
}
