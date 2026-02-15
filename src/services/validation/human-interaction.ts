/**
 * Human Interaction Handler
 *
 * Manages human decision requests during validation.
 * Provides event-based communication for UI integration.
 */

import type {
  ValidationSummary,
  ValidationResult,
  ValidationFeedEntry,
  ValidationTrigger,
  Unsubscribe,
} from './types.ts';
import { debugLog, isDebugEnabled } from '../../debug.ts';

/**
 * Decision request types.
 */
export type DecisionType =
  | 'approve-reject'    // Simple approve or reject
  | 'select-option'     // Choose from multiple options
  | 'provide-feedback'  // Request additional context
  | 'override';         // Override a validation result

/**
 * A pending decision request.
 */
export interface DecisionRequest {
  /** Unique request ID */
  id: string;
  /** Type of decision needed */
  type: DecisionType;
  /** Human-readable title */
  title: string;
  /** Detailed description of what needs to be decided */
  description: string;
  /** The validation summary that triggered this request */
  validationSummary: ValidationSummary;
  /** Specific results requiring attention */
  relevantResults: ValidationResult[];
  /** Available options (for select-option type) */
  options?: Array<{
    id: string;
    label: string;
    description?: string;
  }>;
  /** When this request was created */
  createdAt: number;
  /** Request timeout (ms) - null means no timeout */
  timeoutMs: number | null;
  /** Context for the decision */
  context?: Record<string, unknown>;
}

/**
 * A decision response from the human.
 */
export interface DecisionResponse {
  /** Request ID this responds to */
  requestId: string;
  /** Decision made */
  decision: 'approve' | 'reject' | 'override' | 'defer';
  /** Selected option ID (for select-option type) */
  selectedOption?: string;
  /** Feedback or reasoning */
  feedback?: string;
  /** Override values (for override type) */
  overrides?: Record<string, unknown>;
  /** When decision was made */
  respondedAt: number;
}

/**
 * Callback for decision requests.
 */
export type DecisionRequestCallback = (request: DecisionRequest) => void;

/**
 * Callback for feed entries.
 */
export type FeedEntryCallback = (entry: ValidationFeedEntry) => void;

/**
 * Options for the human interaction handler.
 */
export interface HumanInteractionOptions {
  /** Default timeout for decisions (ms) */
  defaultTimeoutMs: number;
  /** Whether to auto-reject on timeout */
  autoRejectOnTimeout: boolean;
  /** Whether to emit feed entries */
  emitFeedEntries: boolean;
}

/**
 * Default options.
 */
const DEFAULT_OPTIONS: HumanInteractionOptions = {
  defaultTimeoutMs: 5 * 60 * 1000, // 5 minutes
  autoRejectOnTimeout: false,
  emitFeedEntries: true,
};

/**
 * Manages human interaction during validation.
 */
export class HumanInteractionHandler {
  private options: HumanInteractionOptions;
  private pendingRequests: Map<string, DecisionRequest> = new Map();
  private requestCallbacks: Set<DecisionRequestCallback> = new Set();
  private feedCallbacks: Set<FeedEntryCallback> = new Set();
  private resolvers: Map<string, (response: DecisionResponse) => void> = new Map();
  private timeouts: Map<string, Timer> = new Map();
  private requestCounter = 0;

  constructor(options: Partial<HumanInteractionOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[HumanInteraction] ${msg}`);
    }
  }

  /**
   * Subscribe to decision requests.
   */
  onDecisionRequest(callback: DecisionRequestCallback): Unsubscribe {
    this.requestCallbacks.add(callback);
    return () => {
      this.requestCallbacks.delete(callback);
    };
  }

  /**
   * Subscribe to feed entries.
   */
  onFeedEntry(callback: FeedEntryCallback): Unsubscribe {
    this.feedCallbacks.add(callback);
    return () => {
      this.feedCallbacks.delete(callback);
    };
  }

  /**
   * Request a decision from the human.
   * Returns a promise that resolves when the decision is made.
   */
  async requestDecision(
    type: DecisionType,
    title: string,
    description: string,
    validationSummary: ValidationSummary,
    options?: {
      relevantResults?: ValidationResult[];
      selectOptions?: DecisionRequest['options'];
      timeoutMs?: number;
      context?: Record<string, unknown>;
    }
  ): Promise<DecisionResponse> {
    const id = this.generateRequestId();
    const timeoutMs = options?.timeoutMs ?? this.options.defaultTimeoutMs;

    const request: DecisionRequest = {
      id,
      type,
      title,
      description,
      validationSummary,
      relevantResults: options?.relevantResults ?? validationSummary.results.filter(
        (r) => r.status === 'rejected' || r.status === 'needs-revision'
      ),
      options: options?.selectOptions,
      createdAt: Date.now(),
      timeoutMs,
      context: options?.context,
    };

    this.pendingRequests.set(id, request);
    this.log(`Created decision request: ${id} - ${title}`);

    // Emit feed entry
    if (this.options.emitFeedEntries) {
      this.emitFeedEntry({
        type: 'validation',
        timestamp: Date.now(),
        trigger: (validationSummary.results[0]?.metadata?.trigger as ValidationTrigger) ?? 'on-demand',
        context: {
          files: [],
          changeDescription: title,
        },
        summary: validationSummary,
        requiresAction: true,
        actionType: 'decision',
      });
    }

    // Create promise for response - must be done before notifying listeners
    // so that synchronous responses from callbacks work correctly
    const responsePromise = new Promise<DecisionResponse>((resolve) => {
      this.resolvers.set(id, resolve);

      // Set timeout if configured
      if (timeoutMs !== null && timeoutMs > 0) {
        const timeout = setTimeout(() => {
          this.handleTimeout(id);
        }, timeoutMs);
        this.timeouts.set(id, timeout);
      }
    });

    // Notify listeners (after resolver is set up)
    for (const callback of this.requestCallbacks) {
      try {
        callback(request);
      } catch (error) {
        this.log(`Decision request callback error: ${error}`);
      }
    }

    return responsePromise;
  }

  /**
   * Provide a decision response.
   */
  respond(response: DecisionResponse): boolean {
    const request = this.pendingRequests.get(response.requestId);
    if (!request) {
      this.log(`No pending request found: ${response.requestId}`);
      return false;
    }

    // Clear timeout
    const timeout = this.timeouts.get(response.requestId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(response.requestId);
    }

    // Resolve the promise
    const resolver = this.resolvers.get(response.requestId);
    if (resolver) {
      resolver({
        ...response,
        respondedAt: Date.now(),
      });
      this.resolvers.delete(response.requestId);
    }

    // Clean up
    this.pendingRequests.delete(response.requestId);

    this.log(`Decision received: ${response.requestId} - ${response.decision}`);

    // Emit feed entry for the decision
    if (this.options.emitFeedEntries) {
      this.emitFeedEntry({
        type: 'validation',
        timestamp: Date.now(),
        trigger: 'on-demand',
        context: {
          files: [],
          changeDescription: `Decision: ${response.decision}`,
        },
        summary: request.validationSummary,
        requiresAction: false,
      });
    }

    return true;
  }

  /**
   * Approve a validation (shorthand).
   */
  approve(requestId: string, feedback?: string): boolean {
    return this.respond({
      requestId,
      decision: 'approve',
      feedback,
      respondedAt: Date.now(),
    });
  }

  /**
   * Reject a validation (shorthand).
   */
  reject(requestId: string, feedback?: string): boolean {
    return this.respond({
      requestId,
      decision: 'reject',
      feedback,
      respondedAt: Date.now(),
    });
  }

  /**
   * Defer a decision (pass to someone else or delay).
   */
  defer(requestId: string, feedback?: string): boolean {
    return this.respond({
      requestId,
      decision: 'defer',
      feedback,
      respondedAt: Date.now(),
    });
  }

  /**
   * Get a pending request by ID.
   */
  getRequest(requestId: string): DecisionRequest | undefined {
    return this.pendingRequests.get(requestId);
  }

  /**
   * Get all pending requests.
   */
  getPendingRequests(): DecisionRequest[] {
    return Array.from(this.pendingRequests.values());
  }

  /**
   * Cancel a pending request.
   */
  cancelRequest(requestId: string): boolean {
    const request = this.pendingRequests.get(requestId);
    if (!request) {
      return false;
    }

    // Clear timeout
    const timeout = this.timeouts.get(requestId);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(requestId);
    }

    // Resolve with rejection
    const resolver = this.resolvers.get(requestId);
    if (resolver) {
      resolver({
        requestId,
        decision: 'reject',
        feedback: 'Request cancelled',
        respondedAt: Date.now(),
      });
      this.resolvers.delete(requestId);
    }

    this.pendingRequests.delete(requestId);
    this.log(`Request cancelled: ${requestId}`);

    return true;
  }

  /**
   * Handle request timeout.
   */
  private handleTimeout(requestId: string): void {
    const request = this.pendingRequests.get(requestId);
    if (!request) {
      return;
    }

    this.log(`Request timed out: ${requestId}`);
    this.timeouts.delete(requestId);

    if (this.options.autoRejectOnTimeout) {
      this.respond({
        requestId,
        decision: 'reject',
        feedback: 'Request timed out',
        respondedAt: Date.now(),
      });
    } else {
      // Still resolve but with defer decision
      this.respond({
        requestId,
        decision: 'defer',
        feedback: 'Request timed out - deferred',
        respondedAt: Date.now(),
      });
    }
  }

  /**
   * Emit a feed entry.
   */
  private emitFeedEntry(entry: ValidationFeedEntry): void {
    for (const callback of this.feedCallbacks) {
      try {
        callback(entry);
      } catch (error) {
        this.log(`Feed callback error: ${error}`);
      }
    }
  }

  /**
   * Generate a unique request ID.
   */
  private generateRequestId(): string {
    return `decision-${Date.now()}-${++this.requestCounter}`;
  }

  /**
   * Clean up all pending requests.
   */
  cleanup(): void {
    for (const [id] of this.pendingRequests) {
      this.cancelRequest(id);
    }
    this.pendingRequests.clear();
    this.resolvers.clear();
    this.timeouts.clear();
  }
}

/**
 * Create a human interaction handler instance.
 */
export function createHumanInteractionHandler(
  options?: Partial<HumanInteractionOptions>
): HumanInteractionHandler {
  return new HumanInteractionHandler(options);
}

/**
 * Helper to create a simple approve/reject decision request.
 */
export function createApprovalRequest(
  handler: HumanInteractionHandler,
  summary: ValidationSummary,
  title?: string
): Promise<DecisionResponse> {
  const blockedValidators = summary.blockedBy ?? [];
  const defaultTitle = blockedValidators.length > 0
    ? `Validation blocked by: ${blockedValidators.join(', ')}`
    : 'Validation requires approval';

  return handler.requestDecision(
    'approve-reject',
    title ?? defaultTitle,
    buildDecisionDescription(summary),
    summary
  );
}

/**
 * Build a description for a decision request.
 */
function buildDecisionDescription(summary: ValidationSummary): string {
  const lines: string[] = [];

  lines.push(`Overall status: ${summary.overallStatus}`);
  lines.push(`Results: ${summary.results.length} validators ran`);

  if (summary.errors.length > 0) {
    lines.push(`\nErrors (${summary.errors.length}):`);
    for (const error of summary.errors.slice(0, 5)) {
      lines.push(`  - [${error.validator}] ${error.message}`);
    }
    if (summary.errors.length > 5) {
      lines.push(`  ... and ${summary.errors.length - 5} more`);
    }
  }

  if (summary.warnings.length > 0) {
    lines.push(`\nWarnings (${summary.warnings.length}):`);
    for (const warning of summary.warnings.slice(0, 5)) {
      lines.push(`  - [${warning.validator}] ${warning.message}`);
    }
    if (summary.warnings.length > 5) {
      lines.push(`  ... and ${summary.warnings.length - 5} more`);
    }
  }

  return lines.join('\n');
}
