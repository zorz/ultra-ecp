/**
 * CCA Workflow Controller
 *
 * Implements the Coder-Critic-Arbiter workflow pattern.
 * Coordinates between AI coder, validation critics, and human arbiter.
 */

import type {
  CCAWorkflowState,
  CCASessionState,
  CCAWorkflowOptions,
  CCAIteration,
  ProposedChange,
  CriticReview,
  CriticIssue,
  ArbiterDecision,
  CCAEvent,
  CCAEventCallback,
} from './types.ts';
import { DEFAULT_CCA_OPTIONS } from './types.ts';
import type { AgentInstance } from '../agent-instance.ts';
import type { SharedFeed } from '../shared-feed.ts';
import type { ValidationPipeline } from '../../validation/pipeline.ts';
import type { ValidationResult } from '../../validation/types.ts';
import type { APIProvider } from '../providers/api-base.ts';
import type { Unsubscribe } from '../types.ts';
import type { ToolExecutor } from '../tools/executor.ts';
import type { ToolDefinition, ChatMessage, MessageContent, ToolUseContent, ToolResultContent } from '../../ai/types.ts';
import { generateMessageId } from '../../ai/types.ts';
import { debugLog, isDebugEnabled } from '../../../debug.ts';
import type { CCAStorage } from './storage.ts';

/**
 * Dependencies for the CCA workflow.
 */
export interface CCAWorkflowDependencies {
  /** The coder agent */
  coder: AgentInstance;
  /** API provider for the coder */
  coderProvider: APIProvider;
  /** Validation pipeline (critics) */
  validationPipeline: ValidationPipeline;
  /** Shared feed for communication */
  feed: SharedFeed;
  /** Tool executor for running tools */
  toolExecutor: ToolExecutor;
  /** Tool definitions for the coder */
  toolDefinitions: ToolDefinition[];
  /** Optional storage for session persistence */
  storage?: CCAStorage;
  /** Coder agent name for storage */
  coderAgentName?: string;
  /** Coder model name for storage */
  coderModelName?: string;
  /** Workspace path for storage */
  workspacePath?: string;
}

/**
 * Result of human arbiter decision request.
 */
export interface ArbiterDecisionRequest {
  /** Request ID */
  id: string;
  /** Summary for the arbiter */
  summary: string;
  /** Proposed changes */
  changes: ProposedChange[];
  /** Reviews from critics */
  reviews: CriticReview[];
  /** Available actions */
  actions: Array<'approve' | 'reject' | 'iterate' | 'abort'>;
  /** Default suggested action */
  suggested?: 'approve' | 'reject' | 'iterate';
}

/**
 * CCA Workflow Controller.
 */
export class CCAWorkflow {
  private options: CCAWorkflowOptions;
  private deps: CCAWorkflowDependencies;
  private state: CCASessionState;
  private eventCallbacks: Set<CCAEventCallback> = new Set();
  private arbiterResolver: ((decision: ArbiterDecision) => void) | null = null;
  private aborted = false;

  constructor(
    deps: CCAWorkflowDependencies,
    options: Partial<CCAWorkflowOptions> = {}
  ) {
    this.deps = deps;
    this.options = { ...DEFAULT_CCA_OPTIONS, ...options };
    this.state = this.createInitialState('');
  }

  /** Current stored iteration ID for storage updates */
  private currentStoredIterationId: string | null = null;

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[CCAWorkflow] ${msg}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Storage Helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Generate a storage ID.
   */
  private generateStorageId(prefix: string): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 9);
    return `${prefix}-${timestamp}-${random}`;
  }

  /**
   * Save session to storage.
   */
  private saveSession(sessionId: string, status: 'running' | 'paused' | 'completed' | 'error'): void {
    if (!this.deps.storage) return;

    try {
      const existingSession = this.deps.storage.getSession(sessionId);
      if (existingSession) {
        this.deps.storage.updateSession(sessionId, {
          status,
          completedAt: status === 'completed' || status === 'error' ? Date.now() : undefined,
        });
      } else {
        this.deps.storage.createSession({
          id: sessionId,
          task: this.state.task,
          status,
          coderAgent: this.deps.coderAgentName || 'coder',
          coderModel: this.deps.coderModelName || 'unknown',
          workspacePath: this.deps.workspacePath || process.cwd(),
          config: {
            maxIterations: this.options.maxIterations,
          },
        });
      }
    } catch (error) {
      this.log(`Storage error (saveSession): ${error}`);
    }
  }

  /**
   * Save iteration to storage.
   */
  private saveIteration(sessionId: string, iteration: CCAIteration, status: 'coding' | 'reviewing' | 'deciding' | 'completed'): void {
    if (!this.deps.storage) return;

    try {
      if (!this.currentStoredIterationId) {
        this.currentStoredIterationId = this.generateStorageId('iter');
        this.deps.storage.createIteration({
          id: this.currentStoredIterationId,
          sessionId,
          iterationNumber: iteration.number,
          status,
        });
      } else {
        this.deps.storage.updateIteration(this.currentStoredIterationId, {
          status,
          completedAt: status === 'completed' ? Date.now() : undefined,
        });
      }
    } catch (error) {
      this.log(`Storage error (saveIteration): ${error}`);
    }
  }

  /**
   * Save a proposed change to storage.
   */
  private saveChange(change: ProposedChange): string | null {
    if (!this.deps.storage || !this.currentStoredIterationId) return null;

    try {
      const changeId = this.generateStorageId('change');
      // Map 'edit' to 'modify' for storage
      const operation = change.type === 'edit' ? 'modify' : change.type;
      this.deps.storage.createChange({
        id: changeId,
        iterationId: this.currentStoredIterationId,
        filePath: change.path,
        operation: operation as 'create' | 'modify' | 'delete',
        diff: change.diff,
        originalContent: change.originalContent,
        newContent: change.newContent,
        status: 'pending',
      });
      return changeId;
    } catch (error) {
      this.log(`Storage error (saveChange): ${error}`);
      return null;
    }
  }

  /**
   * Save a critic review to storage.
   */
  private saveReview(review: CriticReview, changeId: string): void {
    if (!this.deps.storage) return;

    try {
      this.deps.storage.createCriticReview({
        id: this.generateStorageId('review'),
        changeId,
        criticId: review.criticId,
        criticName: review.criticId, // Use ID as name
        provider: review.type === 'ai-critic' ? 'ai' : 'static',
        verdict: review.verdict,
        message: review.comments.join('\n'),
        issues: review.issues?.map(i => ({
          severity: i.severity,
          message: i.message,
          line: i.line,
        })),
      });
    } catch (error) {
      this.log(`Storage error (saveReview): ${error}`);
    }
  }

  /**
   * Save an arbiter decision to storage.
   */
  private saveArbiterDecision(decision: ArbiterDecision): void {
    if (!this.deps.storage || !this.currentStoredIterationId) return;

    try {
      this.deps.storage.createArbiterDecision({
        id: this.generateStorageId('decision'),
        iterationId: this.currentStoredIterationId,
        decisionType: decision.type,
        feedback: decision.feedback,
        decidedAt: decision.decidedAt,
        decidedBy: 'human', // Always human for now
      });
    } catch (error) {
      this.log(`Storage error (saveArbiterDecision): ${error}`);
    }
  }

  /**
   * Save a feed entry to storage.
   */
  private saveFeedEntry(sessionId: string, type: string, source: string, content: unknown): void {
    if (!this.deps.storage) return;

    try {
      this.deps.storage.createFeedEntry({
        id: this.generateStorageId('feed'),
        sessionId,
        entryType: type,
        source,
        content,
      });
    } catch (error) {
      this.log(`Storage error (saveFeedEntry): ${error}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // State Management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create initial state.
   */
  private createInitialState(task: string): CCASessionState {
    return {
      workflowState: 'idle',
      task,
      iterations: [],
      currentIteration: 0,
      maxIterations: this.options.maxIterations,
      consensusReached: false,
    };
  }

  /**
   * Try to restore state from storage.
   * Returns the restored state if there's a pending arbiter decision, null otherwise.
   */
  private tryRestoreState(sessionId: string): {
    state: CCASessionState;
    pendingArbiterIteration: number;
  } | null {
    if (!this.deps.storage) return null;

    const snapshot = this.deps.storage.getSessionSnapshot(sessionId);
    if (!snapshot) return null;

    // Check if any iteration is in 'deciding' status (awaiting arbiter)
    const pendingIteration = snapshot.iterations.find(i => i.status === 'deciding');
    if (!pendingIteration) return null;

    // Mark as resumed session
    this.isResumedSession = true;

    this.log(`Found pending arbiter decision for iteration ${pendingIteration.iterationNumber}`);

    // Restore the state
    const iterations: CCAIteration[] = [];
    for (const storedIter of snapshot.iterations) {
      const iterChanges = snapshot.changes.get(storedIter.id) || [];

      // Build changes array
      const changes: ProposedChange[] = iterChanges.map(c => ({
        id: c.id,
        path: c.filePath,
        type: c.operation === 'modify' ? 'edit' : c.operation,
        originalContent: c.originalContent,
        newContent: c.newContent,
        diff: c.diff,
        proposedAt: storedIter.startedAt,
        status: c.status === 'approved' ? 'approved' :
                c.status === 'rejected' ? 'rejected' : 'proposed',
      }));

      // Build reviews array
      const reviews: CriticReview[] = [];
      for (const change of iterChanges) {
        const changeReviews = snapshot.reviews.get(change.id) || [];
        for (const r of changeReviews) {
          reviews.push({
            criticId: r.criticId,
            type: 'ai-critic',
            approved: r.verdict === 'approve',
            verdict: r.verdict,
            comments: [r.message],
            issues: (r.issues || []).map(i => ({
              severity: i.severity as 'error' | 'warning' | 'suggestion' | 'info',
              message: i.message,
              line: i.line,
              blocking: i.severity === 'error',
            })),
            reviewedAt: r.createdAt,
          });
        }
      }

      // Build arbiter decision if any
      const decisions = snapshot.decisions.get(storedIter.id) || [];
      const arbiterDecision = decisions.length > 0 ? {
        id: decisions[0]!.id,
        type: decisions[0]!.decisionType as 'approve' | 'reject' | 'iterate' | 'abort',
        feedback: decisions[0]!.feedback,
        decidedAt: decisions[0]!.decidedAt,
      } : undefined;

      iterations.push({
        number: storedIter.iterationNumber,
        changes,
        reviews,
        arbiterDecision,
        startedAt: storedIter.startedAt,
        completedAt: storedIter.completedAt,
      });
    }

    const state: CCASessionState = {
      workflowState: 'awaiting-arbiter',
      task: snapshot.session.task,
      iterations,
      currentIteration: pendingIteration.iterationNumber,
      maxIterations: snapshot.session.config.maxIterations || this.options.maxIterations,
      consensusReached: false,
    };

    return { state, pendingArbiterIteration: pendingIteration.iterationNumber };
  }

  /**
   * Load session history from storage for continuation (not pending arbiter).
   * Returns iterations from previous session or null if no history.
   */
  private loadSessionHistory(sessionId: string): { iterations: CCAIteration[] } | null {
    if (!this.deps.storage) return null;

    const snapshot = this.deps.storage.getSessionSnapshot(sessionId);
    if (!snapshot || snapshot.iterations.length === 0) return null;

    // Don't load if there's a pending arbiter (handled by tryRestoreState)
    const pendingIteration = snapshot.iterations.find(i => i.status === 'deciding');
    if (pendingIteration) return null;

    this.log(`Loading session history: ${snapshot.iterations.length} iterations`);

    // Build iterations from storage
    const iterations: CCAIteration[] = [];
    for (const storedIter of snapshot.iterations) {
      const iterChanges = snapshot.changes.get(storedIter.id) || [];

      // Build changes array
      const changes: ProposedChange[] = iterChanges.map(c => ({
        id: c.id,
        path: c.filePath,
        type: c.operation === 'modify' ? 'edit' : c.operation,
        originalContent: c.originalContent,
        newContent: c.newContent,
        diff: c.diff,
        proposedAt: storedIter.startedAt,
        status: c.status === 'approved' ? 'approved' :
                c.status === 'rejected' ? 'rejected' : 'proposed',
      }));

      // Build reviews array
      const reviews: CriticReview[] = [];
      for (const change of iterChanges) {
        const changeReviews = snapshot.reviews.get(change.id) || [];
        for (const r of changeReviews) {
          reviews.push({
            criticId: r.criticId,
            type: 'ai-critic',
            approved: r.verdict === 'approve',
            verdict: r.verdict,
            comments: [r.message],
            issues: (r.issues || []).map(i => ({
              severity: i.severity as 'error' | 'warning' | 'suggestion' | 'info',
              message: i.message,
              line: i.line,
              blocking: i.severity === 'error',
            })),
            reviewedAt: r.createdAt,
          });
        }
      }

      // Build arbiter decision if any
      const decisions = snapshot.decisions.get(storedIter.id) || [];
      const arbiterDecision = decisions.length > 0 ? {
        id: decisions[0]!.id,
        type: decisions[0]!.decisionType as 'approve' | 'reject' | 'iterate' | 'abort',
        feedback: decisions[0]!.feedback,
        decidedAt: decisions[0]!.decidedAt,
      } : undefined;

      iterations.push({
        number: storedIter.iterationNumber,
        changes,
        reviews,
        arbiterDecision,
        startedAt: storedIter.startedAt,
        completedAt: storedIter.completedAt,
      });
    }

    return { iterations };
  }

  /**
   * Get current state.
   */
  getState(): CCASessionState {
    return { ...this.state };
  }

  /**
   * Get current workflow state.
   */
  getWorkflowState(): CCAWorkflowState {
    return this.state.workflowState;
  }

  /**
   * Run the CCA workflow for a task.
   */
  async run(task: string, sessionId: string): Promise<CCASessionState> {
    this.aborted = false;

    // Try to restore state if there's a pending arbiter decision
    const restored = this.tryRestoreState(sessionId);
    if (restored) {
      this.state = restored.state;
      this.log(`Restored state with pending arbiter for iteration ${restored.pendingArbiterIteration}`);

      // Post message about restoring
      this.deps.feed.postSystem('workflow_step', {
        step: 'session_resumed',
        message: `Resuming from iteration ${restored.pendingArbiterIteration} - awaiting arbiter decision`,
        iteration: restored.pendingArbiterIteration,
      });

      // Re-request arbiter decision for the pending iteration
      await this.requestArbiterDecision(sessionId, false);

      // Continue the workflow from where we left off
      if (!this.aborted && !this.state.consensusReached) {
        // Continue with remaining iterations if needed
        while (
          !this.aborted &&
          !this.state.consensusReached &&
          this.state.currentIteration < this.options.maxIterations
        ) {
          await this.runIteration(sessionId);
        }
      }

      this.setWorkflowState('completed');
      this.saveSession(sessionId, 'completed');
      return this.state;
    }

    // Check if there's an existing session to continue from
    const existingHistory = this.loadSessionHistory(sessionId);
    if (existingHistory) {
      // Continue from existing session
      this.state = this.createInitialState(task);
      this.state.iterations = existingHistory.iterations;
      this.state.currentIteration = existingHistory.iterations.length;
      this.isResumedSession = true;
      this.log(`Continuing session with ${existingHistory.iterations.length} previous iterations`);

      // Post message about continuing
      this.deps.feed.postSystem('workflow_step', {
        step: 'session_continued',
        message: `Continuing from iteration ${existingHistory.iterations.length}`,
        previousIterations: existingHistory.iterations.length,
      });
    } else {
      // Fresh start
      this.state = this.createInitialState(task);
      this.log(`Starting CCA workflow for task: ${task.substring(0, 50)}...`);
    }

    // Save session to storage
    this.saveSession(sessionId, 'running');
    this.saveFeedEntry(sessionId, 'message', 'system', {
      text: existingHistory
        ? `Continuing CCA workflow: ${task}`
        : `Starting CCA workflow for task: ${task}`,
    });

    try {
      // Run iterations until consensus, max iterations, or abort
      while (
        !this.aborted &&
        !this.state.consensusReached &&
        this.state.currentIteration < this.options.maxIterations
      ) {
        await this.runIteration(sessionId);
      }

      // Check if we hit max iterations without consensus
      if (
        !this.state.consensusReached &&
        this.state.currentIteration >= this.options.maxIterations
      ) {
        this.emitEvent({
          type: 'cca:max_iterations_reached',
          sessionId,
          iteration: this.state.currentIteration,
          timestamp: Date.now(),
        });

        // Force arbiter decision
        this.setWorkflowState('awaiting-arbiter');
        await this.requestArbiterDecision(sessionId, true);
      }

      this.setWorkflowState('completed');
      this.saveSession(sessionId, 'completed');
      return this.state;
    } catch (error) {
      this.setWorkflowState('error');
      const err = error instanceof Error ? error : new Error(String(error));
      this.log(`Workflow error: ${err.message}\n${err.stack || ''}`);
      // Post error to feed for visibility
      this.deps.feed.post({
        type: 'error',
        source: 'system',
        content: {
          code: 'WORKFLOW_ERROR',
          message: err.message,
          details: { stack: err.stack },
        },
      });
      this.saveSession(sessionId, 'error');
      throw error;
    }
  }

  /**
   * Run a single CCA iteration.
   */
  private async runIteration(sessionId: string): Promise<void> {
    this.state.currentIteration++;
    this.currentStoredIterationId = null; // Reset for new iteration

    const iteration: CCAIteration = {
      number: this.state.currentIteration,
      changes: [],
      reviews: [],
      startedAt: Date.now(),
    };
    this.state.iterations.push(iteration);

    this.emitEvent({
      type: 'cca:iteration_started',
      sessionId,
      iteration: iteration.number,
      timestamp: Date.now(),
    });

    // Save iteration to storage
    this.saveIteration(sessionId, iteration, 'coding');
    this.saveFeedEntry(sessionId, 'iteration', 'system', {
      action: 'started',
      number: iteration.number,
    });

    // Phase 1: Coder produces changes
    this.setWorkflowState('coding');
    await this.runCoderPhase(sessionId, iteration);

    if (this.aborted) return;

    // Phase 2: Critics review (validation)
    this.log(`Checking review phase: validateAfterCoding=${this.options.validateAfterCoding}, changes=${iteration.changes.length}`);
    if (this.options.validateAfterCoding && iteration.changes.length > 0) {
      this.log(`Starting review phase with ${iteration.changes.length} changes`);
      this.setWorkflowState('reviewing');
      this.saveIteration(sessionId, iteration, 'reviewing');
      await this.runReviewPhase(sessionId, iteration);
    } else if (iteration.changes.length === 0) {
      this.log('Skipping review phase: no changes');
    } else {
      this.log('Skipping review phase: validation disabled');
    }

    if (this.aborted) return;

    // Phase 3: Check consensus or request arbiter
    // If there are no changes, ask arbiter if they want to continue or end
    if (iteration.changes.length === 0) {
      this.log('No changes in iteration - asking arbiter to decide');

      // Post to feed so user knows what happened
      this.deps.feed.postSystem('workflow_step', {
        step: 'no_changes',
        iteration: iteration.number,
        message: 'Coder completed without making file changes. You can provide additional instructions or end the session.',
      });

      // Request arbiter decision - they can iterate with new instructions or end
      this.setWorkflowState('awaiting-arbiter');
      this.saveIteration(sessionId, iteration, 'deciding');
      const decision = await this.requestArbiterDecision(sessionId, false);

      iteration.arbiterDecision = decision;
      this.saveArbiterDecision(decision);
      this.saveFeedEntry(sessionId, 'decision', 'arbiter', {
        type: decision.type,
        feedback: decision.feedback,
        iteration: iteration.number,
      });

      switch (decision.type) {
        case 'approve':
        case 'reject':
          // End workflow
          this.state.consensusReached = true;
          break;
        case 'iterate':
          // Continue with new instructions
          this.setWorkflowState('iterating');
          break;
        case 'abort':
          this.aborted = true;
          break;
      }

      iteration.completedAt = Date.now();
      this.saveIteration(sessionId, iteration, 'completed');

      this.emitEvent({
        type: 'cca:iteration_completed',
        sessionId,
        iteration: iteration.number,
        data: { duration: iteration.completedAt - iteration.startedAt, noChanges: true },
        timestamp: Date.now(),
      });

      return;
    }

    const consensusResult = this.checkConsensus(iteration);

    if (consensusResult.consensus && this.options.autoApplyOnConsensus) {
      // Auto-approve: apply changes
      this.state.consensusReached = true;
      this.setWorkflowState('applying');
      await this.applyChanges(sessionId, iteration);

      this.emitEvent({
        type: 'cca:consensus_reached',
        sessionId,
        iteration: iteration.number,
        data: { automatic: true },
        timestamp: Date.now(),
      });
    } else {
      // Request human arbiter
      this.setWorkflowState('awaiting-arbiter');
      this.saveIteration(sessionId, iteration, 'deciding');
      const decision = await this.requestArbiterDecision(sessionId, false);

      iteration.arbiterDecision = decision;

      // Save arbiter decision to storage
      this.saveArbiterDecision(decision);
      this.saveFeedEntry(sessionId, 'decision', 'arbiter', {
        type: decision.type,
        feedback: decision.feedback,
        iteration: iteration.number,
      });

      // Handle arbiter decision
      switch (decision.type) {
        case 'approve':
          this.state.consensusReached = true;
          this.setWorkflowState('applying');
          await this.applyChanges(sessionId, iteration);
          break;

        case 'reject':
          // End workflow without applying
          this.state.consensusReached = true; // Consensus to reject
          break;

        case 'iterate':
          // Continue to next iteration with feedback
          this.setWorkflowState('iterating');
          // Feedback is passed to coder in next iteration
          break;

        case 'abort':
          this.aborted = true;
          break;
      }
    }

    iteration.completedAt = Date.now();

    // Mark iteration as completed in storage
    this.saveIteration(sessionId, iteration, 'completed');

    this.emitEvent({
      type: 'cca:iteration_completed',
      sessionId,
      iteration: iteration.number,
      data: { duration: iteration.completedAt - iteration.startedAt },
      timestamp: Date.now(),
    });
  }

  /**
   * Run the coder phase.
   * Implements the agentic tool loop: call API -> execute tools -> return results -> repeat.
   */
  private async runCoderPhase(
    sessionId: string,
    iteration: CCAIteration
  ): Promise<void> {
    this.emitEvent({
      type: 'cca:coding_started',
      sessionId,
      iteration: iteration.number,
      timestamp: Date.now(),
    });

    // Build prompt for coder
    const prompt = this.buildCoderPrompt(iteration);

    // If this is a follow-up iteration, show detailed feedback being addressed
    if (iteration.number > 1) {
      const prevIteration = this.state.iterations[iteration.number - 2];
      if (prevIteration?.arbiterDecision) {
        const decision = prevIteration.arbiterDecision;

        // Collect all critic issues with full details
        const criticIssues: Array<{
          criticId: string;
          verdict: string;
          issues: Array<{ severity: string; message: string; line?: number; file?: string }>;
        }> = [];

        for (const review of prevIteration.reviews) {
          if (review.verdict === 'reject' || review.verdict === 'concerns') {
            criticIssues.push({
              criticId: review.criticId,
              verdict: review.verdict,
              issues: (review.issues || []).map(issue => ({
                severity: issue.severity,
                message: issue.message,
                line: issue.line,
                path: issue.path,
              })),
            });
          }
        }

        // Collect previous iteration's changes for context
        const previousChanges = prevIteration.changes.map(change => ({
          path: change.path,
          type: change.type,
        }));

        // Post detailed iteration summary
        this.deps.feed.postSystem('workflow_step', {
          step: 'iteration_summary',
          iteration: iteration.number,
          previousIteration: iteration.number - 1,
          message: `Iteration ${iteration.number}: Addressing feedback from iteration ${iteration.number - 1}`,
          arbiterFeedback: decision.feedback || null,
          arbiterIssues: decision.addressIssues || [],
          criticIssues,
          previousChanges,
        });
      }
    }

    // Post the task to the feed
    this.deps.feed.postMessage(prompt, 'human', { sourceId: 'system' });

    // Build initial messages array
    const messages: ChatMessage[] = [
      {
        id: generateMessageId(),
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        timestamp: Date.now(),
      },
    ];

    // Agentic loop: call API, execute tools, return results, repeat
    let continueLoop = true;
    let maxToolLoops = this.options.maxToolLoops; // Configurable safety limit

    // Track inline reviews for audit trail (iteration 2+)
    const inlineReviewsForAudit: Array<{
      filePath: string;
      changeType: string;
      diff: string;
      reviews: Array<{
        criticId: string;
        verdict: 'approve' | 'reject' | 'concerns' | 'error';
        issues: Array<{ severity: string; message: string; line?: number }>;
      }>;
    }> = [];

    while (continueLoop && maxToolLoops > 0) {
      maxToolLoops--;

      if (this.aborted) {
        this.log('Coder phase aborted');
        break;
      }

      // Send to coder via API provider
      const response = await this.deps.coderProvider.chat({
        messages,
        systemPrompt: this.deps.coder.getContext().systemPrompt,
        tools: this.deps.toolDefinitions,
        maxTokens: 8192,
      });

      // Add assistant response to messages
      messages.push(response.message);

      // Post coder response text to feed
      const responseText = response.message.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('\n');

      if (responseText) {
        this.deps.feed.postMessage(responseText, 'agent', {
          sourceId: this.deps.coder.id,
        });
      }

      // Check if response has tool calls
      const toolCalls = response.message.content.filter(
        (c): c is ToolUseContent => c.type === 'tool_use'
      );

      if (toolCalls.length === 0 || response.stopReason !== 'tool_use') {
        // No more tool calls - coder is done
        continueLoop = false;
        this.log(`Coder finished with stop reason: ${response.stopReason}`);
      } else {
        // Execute tools and collect results
        const toolResults: ToolResultContent[] = [];

        for (const toolCall of toolCalls) {
          this.log(`Executing tool: ${toolCall.name}`);

          // For Write/Edit, run critics first before requesting permission
          let criticReviewInfos: Array<{
            criticId: string;
            verdict: 'approve' | 'reject' | 'concerns' | 'error';
            comments: string[];
            issues?: Array<{ severity: 'error' | 'warning' | 'suggestion' | 'info'; message: string; line?: number }>;
          }> | undefined;

          let changeInfoForAudit: { filePath: string; changeType: string; diff: string } | undefined;

          if (toolCall.name === 'Write' || toolCall.name === 'Edit') {
            const reviews = await this.runCriticsForChange(sessionId, toolCall, iteration);
            if (reviews.length > 0) {
              criticReviewInfos = reviews.map(r => ({
                criticId: r.criticId,
                verdict: r.verdict,
                comments: r.comments,
                issues: r.issues.map(i => ({
                  severity: i.severity,
                  message: i.message,
                  line: i.line,
                })),
              }));

              // Track for audit trail
              const input = toolCall.input as Record<string, unknown>;
              const filePath = (input.file_path as string) || (input.path as string) || '';
              const extractedChange = this.extractChangeFromToolCall(toolCall);
              changeInfoForAudit = {
                filePath,
                changeType: toolCall.name,
                diff: extractedChange?.diff || '',
              };
            }
          }

          // Execute the tool (will request permission for Write/Edit)
          const result = await this.deps.toolExecutor.execute({
            id: toolCall.id,
            sessionId,
            agentId: this.deps.coder.id,
            tool: toolCall.name,
            input: toolCall.input,
            targetPath: this.extractTargetPath(toolCall),
            timestamp: Date.now(),
            // Pass critic reviews to be shown with permission request
            criticReviews: criticReviewInfos,
          });

          // Collect the result
          const resultContent: string = result.success
            ? (typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2))
            : `Error: ${result.error || 'Unknown error'}${result.permissionDenied ? ' (Permission denied)' : ''}`;

          toolResults.push({
            type: 'tool_result',
            toolUseId: toolCall.id,
            content: resultContent,
            isError: !result.success,
          });

          // Track file changes for Write/Edit tools
          if (result.success && (toolCall.name === 'Write' || toolCall.name === 'Edit')) {
            const change = this.extractChangeFromToolCall(toolCall);
            if (change) {
              change.status = 'applied'; // Tool was executed
              iteration.changes.push(change);

              // Track for audit trail if we have reviews
              if (changeInfoForAudit && criticReviewInfos) {
                inlineReviewsForAudit.push({
                  filePath: changeInfoForAudit.filePath,
                  changeType: changeInfoForAudit.changeType,
                  diff: change.diff || changeInfoForAudit.diff,
                  reviews: criticReviewInfos.map(r => ({
                    criticId: r.criticId,
                    verdict: r.verdict,
                    issues: (r.issues || []).map(i => ({
                      severity: i.severity,
                      message: i.message,
                      line: i.line,
                    })),
                  })),
                });
              }

              // Save change to storage
              this.saveChange(change);
              this.saveFeedEntry(sessionId, 'change', 'coder', {
                path: change.path,
                type: change.type,
                status: 'applied',
              });

              this.deps.feed.postChange(
                change.type === 'delete' ? 'file_delete' : 'file_edit',
                'agent',
                {
                  sourceId: this.deps.coder.id,
                  path: change.path,
                  diff: change.diff,
                  status: 'applied',
                }
              );

              this.emitEvent({
                type: 'cca:change_proposed',
                sessionId,
                iteration: iteration.number,
                data: { change },
                timestamp: Date.now(),
              });
            }
          }

          // Post tool result to feed
          this.deps.feed.postSystem('workflow_step', {
            step: 'tool_executed',
            tool: toolCall.name,
            input: toolCall.input,
            success: result.success,
            result: result.success ? resultContent.substring(0, 500) : undefined,
            error: result.error,
          });
        }

        // Add tool results as a user message to continue the conversation
        const toolResultMessage: ChatMessage = {
          id: generateMessageId(),
          role: 'user',
          content: toolResults as MessageContent[],
          timestamp: Date.now(),
        };
        messages.push(toolResultMessage);
      }
    }

    if (maxToolLoops === 0) {
      this.log('Coder phase hit max tool loops limit');
      // Post to feed so user knows why the coder stopped
      this.deps.feed.postSystem('workflow_step', {
        step: 'max_tool_loops',
        message: 'Coder reached maximum tool loop limit (20). May need to continue in another iteration.',
        iteration: iteration.number,
      });
    }

    // Generate audit trail for iteration 2+ showing how feedback was addressed
    if (iteration.number > 1 && inlineReviewsForAudit.length > 0) {
      const prevIteration = this.state.iterations[iteration.number - 2];
      if (prevIteration) {
        // Collect all concerns from previous iteration with their sources
        const prevConcerns: Array<{
          message: string;
          file?: string;
          line?: number;
          criticId: string;
          severity?: string;
        }> = [];

        for (const review of prevIteration.reviews) {
          if (review.verdict === 'reject' || review.verdict === 'concerns') {
            for (const issue of review.issues || []) {
              prevConcerns.push({
                message: issue.message,
                file: issue.path,
                line: issue.line,
                criticId: review.criticId,
                severity: issue.severity,
              });
            }
            for (const comment of review.comments) {
              prevConcerns.push({
                message: comment,
                criticId: review.criticId,
              });
            }
          }
        }

        // Add arbiter issues
        if (prevIteration.arbiterDecision?.addressIssues) {
          for (const issue of prevIteration.arbiterDecision.addressIssues) {
            prevConcerns.push({
              message: issue,
              criticId: 'arbiter',
            });
          }
        }

        // Build audit entries: map concerns to changes and new verdicts
        const auditEntries: Array<{
          concern: {
            message: string;
            source: string;
            file?: string;
            line?: number;
          };
          resolution: {
            file: string;
            changeType: string;
            diffSnippet: string;
            linesChanged: string;
          } | null;
          outcome: {
            verdict: string;
            approvalCount: number;
            totalCritics: number;
            newIssues: string[];
          };
        }> = [];

        for (const concern of prevConcerns) {
          // Find the change that addresses this concern (by file match)
          const matchingChange = inlineReviewsForAudit.find(c => {
            if (!concern.file) return false;
            return c.filePath === concern.file ||
              c.filePath.endsWith('/' + concern.file.split('/').pop());
          });

          if (matchingChange) {
            // Extract a relevant snippet from the diff
            const diffLines = matchingChange.diff.split('\n');
            // Find lines around the concern's line number if available
            let relevantDiff = '';
            if (concern.line && diffLines.length > 0) {
              // Look for the hunk containing this line
              const hunkStart = diffLines.findIndex(l =>
                l.startsWith('@@') && l.includes(`+${concern.line}`) || l.includes(`-${concern.line}`)
              );
              if (hunkStart >= 0) {
                relevantDiff = diffLines.slice(hunkStart, hunkStart + 8).join('\n');
              }
            }
            if (!relevantDiff) {
              // Just take first few meaningful lines
              relevantDiff = diffLines
                .filter(l => l.startsWith('+') || l.startsWith('-'))
                .slice(0, 6)
                .join('\n');
            }

            // Count the lines changed
            const additions = diffLines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
            const deletions = diffLines.filter(l => l.startsWith('-') && !l.startsWith('---')).length;

            // Get the outcome from the new reviews
            const approvals = matchingChange.reviews.filter(r => r.verdict === 'approve').length;
            const newIssues = matchingChange.reviews
              .flatMap(r => r.issues || [])
              .map(i => i.message)
              .slice(0, 3);

            auditEntries.push({
              concern: {
                message: concern.message,
                source: concern.criticId,
                file: concern.file,
                line: concern.line,
              },
              resolution: {
                file: matchingChange.filePath,
                changeType: matchingChange.changeType,
                diffSnippet: relevantDiff.slice(0, 300),
                linesChanged: `+${additions}/-${deletions}`,
              },
              outcome: {
                verdict: approvals === matchingChange.reviews.length ? 'approved' :
                  approvals > 0 ? 'partial' : 'concerns',
                approvalCount: approvals,
                totalCritics: matchingChange.reviews.length,
                newIssues,
              },
            });
          } else {
            // Concern wasn't addressed by any change
            auditEntries.push({
              concern: {
                message: concern.message,
                source: concern.criticId,
                file: concern.file,
                line: concern.line,
              },
              resolution: null,
              outcome: {
                verdict: 'not_addressed',
                approvalCount: 0,
                totalCritics: 0,
                newIssues: [],
              },
            });
          }
        }

        // Post the audit trail
        this.deps.feed.post({
          type: 'system',
          source: 'agent',
          sourceId: 'audit-trail',
          content: {
            event: 'workflow_step',
            details: {
              step: 'feedback_audit_trail',
              iteration: iteration.number,
              previousIteration: iteration.number - 1,
              totalConcerns: prevConcerns.length,
              addressedCount: auditEntries.filter(e => e.resolution !== null).length,
              fullyApprovedCount: auditEntries.filter(e => e.outcome.verdict === 'approved').length,
              entries: auditEntries,
            },
          },
        });
      }
    } else if (iteration.changes.length > 0) {
      // For iteration 1 or no inline reviews, just show changes summary
      this.deps.feed.post({
        type: 'system',
        source: 'agent',
        sourceId: 'coder-summary',
        content: {
          event: 'workflow_step',
          details: {
            step: 'coder_changes_summary',
            iteration: iteration.number,
            changes: iteration.changes.map(c => ({
              path: c.path,
              type: c.type,
              diffPreview: c.diff ? c.diff.split('\n').slice(0, 5).join('\n') : undefined,
            })),
            totalChanges: iteration.changes.length,
          },
        },
      });
    }

    this.emitEvent({
      type: 'cca:coding_completed',
      sessionId,
      iteration: iteration.number,
      data: { changesCount: iteration.changes.length },
      timestamp: Date.now(),
    });
  }

  /**
   * Extract target path from a tool call for permission checking.
   */
  private extractTargetPath(toolCall: ToolUseContent): string | undefined {
    const input = toolCall.input;
    if (toolCall.name === 'Read' || toolCall.name === 'Write' || toolCall.name === 'Edit') {
      return (input.file_path as string) || (input.path as string);
    }
    if (toolCall.name === 'Glob' || toolCall.name === 'Grep') {
      return (input.path as string);
    }
    return undefined;
  }

  /** Flag indicating this is a resumed session */
  private isResumedSession = false;

  /** Pending human feedback to be included in next iteration */
  private pendingHumanFeedback: string | null = null;

  /**
   * Continue the workflow with human feedback.
   * This injects the feedback and runs another iteration.
   */
  async continueWithFeedback(sessionId: string, feedback: string): Promise<CCASessionState> {
    this.log(`Continuing with human feedback: ${feedback.substring(0, 100)}...`);

    // Store the feedback to be picked up by buildCoderPrompt
    this.pendingHumanFeedback = feedback;

    // Reset aborted flag so we can continue after an abort decision
    this.aborted = false;

    // Reset consensus so the loop continues
    this.state.consensusReached = false;

    // Post to feed
    this.deps.feed.postSystem('workflow_step', {
      step: 'continuing_with_feedback',
      message: 'Addressing queued feedback',
      feedbackLength: feedback.length,
    });

    // Run iterations until done
    while (
      !this.aborted &&
      !this.state.consensusReached &&
      this.state.currentIteration < this.options.maxIterations
    ) {
      await this.runIteration(sessionId);
    }

    this.setWorkflowState('completed');
    this.saveSession(sessionId, 'completed');
    return this.state;
  }

  /**
   * Build prompt for the coder.
   */
  private buildCoderPrompt(iteration: CCAIteration): string {
    let prompt = '';

    // If there's pending human feedback, use that
    if (this.pendingHumanFeedback) {
      const feedback = this.pendingHumanFeedback;
      this.pendingHumanFeedback = null; // Clear after use

      prompt = this.state.task;
      prompt += '\n\n--- Human Feedback to Address ---\n';
      prompt += feedback;
      prompt += '\n\nPlease address the feedback above and make the necessary changes.';
      return prompt;
    }

    // If this is a resumed session, add comprehensive context
    if (this.isResumedSession && iteration.number === 1) {
      prompt = this.buildResumedSessionPrompt();
      this.isResumedSession = false; // Only add resume context once
      return prompt;
    }

    prompt = this.state.task;

    // Add context from previous iteration feedback
    if (iteration.number > 1) {
      const prevIteration = this.state.iterations[iteration.number - 2];
      if (prevIteration?.arbiterDecision) {
        const decision = prevIteration.arbiterDecision;

        prompt += '\n\n--- Previous Iteration Feedback ---\n';

        if (decision.feedback) {
          prompt += `Arbiter feedback: ${decision.feedback}\n`;
        }

        if (decision.addressIssues && decision.addressIssues.length > 0) {
          prompt += `Issues to address:\n${decision.addressIssues.map((i) => `- ${i}`).join('\n')}\n`;
        }

        if (decision.focusFiles && decision.focusFiles.length > 0) {
          prompt += `Focus on files: ${decision.focusFiles.join(', ')}\n`;
        }

        // Add previous reviews
        if (prevIteration.reviews.length > 0) {
          prompt += '\nCritic reviews from previous iteration:\n';
          for (const review of prevIteration.reviews) {
            prompt += `\n[${review.criticId}] ${review.verdict}:\n`;
            for (const comment of review.comments) {
              prompt += `  - ${comment}\n`;
            }
          }
        }
      }
    }

    return prompt;
  }

  /**
   * Build a comprehensive prompt for resumed sessions.
   * Includes context about what was done so the coder doesn't start over.
   */
  private buildResumedSessionPrompt(): string {
    const sections: string[] = [];

    // Original task
    sections.push(`# Continuing Task\n\nOriginal task: ${this.state.task}`);

    // Session summary - what was done in previous iterations
    if (this.state.iterations.length > 0) {
      sections.push('\n## Previous Session Summary\n');
      sections.push('You are RESUMING a previous session. DO NOT start over. Review what was done and continue from where you left off.\n');

      for (const iter of this.state.iterations) {
        const changes = iter.changes.map(c => `  - ${c.type}: ${c.path}`).join('\n');
        const reviews = iter.reviews.map(r => `  - [${r.criticId}] ${r.verdict}`).join('\n');

        sections.push(`### Iteration ${iter.number}`);
        if (changes) {
          sections.push(`Changes made:\n${changes}`);
        }
        if (reviews) {
          sections.push(`Critic reviews:\n${reviews}`);
        }
        if (iter.arbiterDecision) {
          sections.push(`Arbiter decision: ${iter.arbiterDecision.type}`);
          if (iter.arbiterDecision.feedback) {
            sections.push(`Arbiter feedback: ${iter.arbiterDecision.feedback}`);
          }
        }
      }
    }

    // Files that were touched
    const allFiles = new Set<string>();
    for (const iter of this.state.iterations) {
      for (const change of iter.changes) {
        allFiles.add(change.path);
      }
    }
    if (allFiles.size > 0) {
      sections.push(`\n## Files Modified in Previous Session\n${[...allFiles].map(f => `- ${f}`).join('\n')}`);
    }

    // Last feedback if any
    const lastIter = this.state.iterations[this.state.iterations.length - 1];
    if (lastIter?.arbiterDecision?.feedback) {
      sections.push(`\n## Latest Feedback to Address\n${lastIter.arbiterDecision.feedback}`);
    }

    // Instructions
    sections.push('\n## Instructions\n');
    sections.push('1. Review the above summary to understand what was done');
    sections.push('2. DO NOT re-read files you already read unless necessary');
    sections.push('3. DO NOT repeat changes that were already made');
    sections.push('4. Continue from where the session left off');
    sections.push('5. If there is feedback to address, focus on that');

    return sections.join('\n');
  }

  /**
   * Extract a proposed change from a tool call.
   */
  private extractChangeFromToolCall(
    toolCall: { id: string; name: string; input: Record<string, unknown> }
  ): ProposedChange | null {
    const { name, input } = toolCall;

    // Map tool names to change types
    if (name === 'Write') {
      const content = input.content as string || '';
      const filePath = input.file_path as string || input.path as string || '';

      // For Write, the diff is the entire new content
      const diff = this.createAdditionDiff(filePath, content);

      return {
        id: `change-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        path: filePath,
        type: 'create',
        newContent: content,
        diff,
        proposedAt: Date.now(),
        status: 'proposed',
      };
    }

    if (name === 'Edit') {
      const oldString = input.old_string as string || '';
      const newString = input.new_string as string || '';
      const filePath = input.file_path as string || input.path as string || '';

      // Create a unified diff from old_string to new_string
      const diff = this.createEditDiff(filePath, oldString, newString);

      return {
        id: `change-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        path: filePath,
        type: 'edit',
        newContent: newString,
        originalContent: oldString,
        diff,
        proposedAt: Date.now(),
        status: 'proposed',
      };
    }

    // Add more tool mappings as needed

    return null;
  }

  /**
   * Create a diff showing all lines as additions (for new files).
   */
  private createAdditionDiff(filePath: string, content: string): string {
    const lines = content.split('\n');
    const diffLines = [
      `--- /dev/null`,
      `+++ ${filePath}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map(line => `+${line}`),
    ];
    return diffLines.join('\n');
  }

  /**
   * Create a unified diff from old content to new content.
   */
  private createEditDiff(filePath: string, oldContent: string, newContent: string): string {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    const diffLines = [
      `--- ${filePath}`,
      `+++ ${filePath}`,
      `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ];

    // Add old lines as deletions
    for (const line of oldLines) {
      diffLines.push(`-${line}`);
    }

    // Add new lines as additions
    for (const line of newLines) {
      diffLines.push(`+${line}`);
    }

    return diffLines.join('\n');
  }

  /**
   * Run critics for a single proposed change before permission is requested.
   */
  private async runCriticsForChange(
    sessionId: string,
    toolCall: ToolUseContent,
    iteration: CCAIteration
  ): Promise<CriticReview[]> {
    const input = toolCall.input as Record<string, unknown>;
    const filePath = (input.file_path as string) || '';
    const content = (input.content as string) || (input.new_string as string) || '';
    const diff = this.extractChangeFromToolCall(toolCall)?.diff || '';

    this.log(`Running critics for proposed change to: ${filePath}`);

    // Post to feed that we're running critics
    this.deps.feed.postSystem('workflow_step', {
      step: 'critics_reviewing',
      tool: toolCall.name,
      path: filePath,
    });

    try {
      // Run validation pipeline for this single file
      const summary = await this.deps.validationPipeline.validate('on-change', {
        trigger: 'on-change',
        timestamp: Date.now(),
        sessionId,
        files: [{
          path: filePath,
          content: content,
          diff: diff,
        }],
      });

      // Convert to critic reviews
      const reviews: CriticReview[] = [];
      for (const result of summary.results) {
        const review = this.convertValidationToReview(result);
        reviews.push(review);
        this.log(`Critic ${review.criticId}: ${review.verdict} - ${review.comments.join('; ')}`);
      }

      // Post each review as a separate feed entry for visibility
      for (const review of reviews) {
        // Get a friendly name from the critic ID
        const criticName = review.criticId.replace(/-critic$/, '').replace(/-/g, ' ');
        const modelName = review.type === 'ai-critic' ? ` (${review.criticId})` : '';

        // Format the review message
        let message = '';
        if (review.comments.length > 0) {
          message = review.comments.join('\n');
        }
        if (review.issues && review.issues.length > 0) {
          const issueText = review.issues
            .map(i => `• [${i.severity}] ${i.message}${i.line ? ` (line ${i.line})` : ''}`)
            .join('\n');
          message = message ? `${message}\n${issueText}` : issueText;
        }
        if (!message) {
          message = review.verdict === 'approve' ? 'Approved' :
                   review.verdict === 'reject' ? 'Rejected' :
                   review.verdict === 'concerns' ? 'Has concerns' : 'Review complete';
        }

        this.deps.feed.post({
          type: 'critic',
          source: 'critic',
          sourceId: review.criticId,
          content: {
            criticId: review.criticId,
            criticName: `${criticName}${modelName}`,
            verdict: review.verdict,
            message,
            path: filePath,
            issues: review.issues,
          },
        });
      }

      // Post consolidated review summary after all individual reviews
      if (reviews.length > 0) {
        const approvals = reviews.filter(r => r.verdict === 'approve').length;
        const rejections = reviews.filter(r => r.verdict === 'reject').length;
        const concerns = reviews.filter(r => r.verdict === 'concerns').length;
        const allIssues = reviews.flatMap(r => r.issues || []);
        const blockingIssues = allIssues.filter(i => i.blocking);
        const consensusReached = rejections === 0 && blockingIssues.length === 0;

        // Get previous iteration info if this is a follow-up
        let previousFeedback: {
          arbiterFeedback?: string;
          arbiterIssues?: string[];
          criticIssuesCount: number;
          resolved: boolean;
        } | undefined;

        if (iteration.number > 1) {
          const prevIteration = this.state.iterations[iteration.number - 2];
          if (prevIteration?.arbiterDecision) {
            const prevRejections = prevIteration.reviews.filter(r => r.verdict === 'reject').length;
            const prevConcerns = prevIteration.reviews.filter(r => r.verdict === 'concerns').length;
            const prevIssueCount = prevRejections + prevConcerns;

            previousFeedback = {
              arbiterFeedback: prevIteration.arbiterDecision.feedback,
              arbiterIssues: prevIteration.arbiterDecision.addressIssues,
              criticIssuesCount: prevIssueCount,
              // Resolved if we now have consensus (or fewer blocking issues)
              resolved: consensusReached || (rejections < prevRejections),
            };
          }
        }

        this.deps.feed.post({
          type: 'validation',
          source: 'validator',
          sourceId: 'review-summary',
          content: {
            event: 'workflow_step',
            details: {
              step: 'review_summary',
              iteration: iteration.number,
              total: reviews.length,
              approvals,
              rejections,
              concerns,
              consensusReached,
              issues: allIssues.map(i => ({
                severity: i.severity,
                message: i.message,
                path: i.path,
                line: i.line,
                blocking: i.blocking,
              })),
              blockingCount: blockingIssues.length,
              previousFeedback,
            },
          },
        });
      }

      return reviews;
    } catch (error) {
      this.log(`Error running critics: ${error}`);
      // Post error to feed but don't block the operation
      this.deps.feed.post({
        type: 'error',
        source: 'system',
        content: {
          code: 'CRITIC_ERROR',
          message: `Failed to run critics: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
      return [];
    }
  }

  /**
   * Run the review phase (critics/validation).
   */
  private async runReviewPhase(
    sessionId: string,
    iteration: CCAIteration
  ): Promise<void> {
    const validators = this.deps.validationPipeline.getValidators();
    this.log(`Review phase starting with ${validators.length} registered validators`);
    for (const v of validators) {
      this.log(`  - ${v.name} (${v.id}): type=${v.type}, enabled=${v.enabled}, triggers=${v.triggers.join(',')}`);
    }

    this.emitEvent({
      type: 'cca:review_started',
      sessionId,
      iteration: iteration.number,
      timestamp: Date.now(),
    });

    // Run validation pipeline
    const summary = await this.deps.validationPipeline.validate('on-change', {
      trigger: 'on-change',
      timestamp: Date.now(),
      sessionId,
      files: iteration.changes.map((c) => ({
        path: c.path,
        content: c.newContent || '',
        diff: c.diff,
      })),
    });

    this.state.lastValidationSummary = summary;

    // Convert validation results to critic reviews
    for (const result of summary.results) {
      const review = this.convertValidationToReview(result);
      iteration.reviews.push(review);

      // Save review to storage - associate with first change as a placeholder
      // In a more sophisticated system, we'd match reviews to specific changes
      if (iteration.changes.length > 0) {
        const changeId = iteration.changes[0]!.id;
        this.saveReview(review, changeId);
      }
    }

    // Save review summary to feed
    this.saveFeedEntry(sessionId, 'validation', 'critics', {
      overallStatus: summary.overallStatus,
      reviewCount: summary.results.length,
      consensusReached: summary.consensusReached,
    });

    // Post validation summary to feed
    this.deps.feed.post({
      type: 'validation',
      source: 'validator',
      content: {
        summary: {
          overallStatus: summary.overallStatus,
          results: summary.results,
          requiresHumanDecision: summary.requiresHumanDecision,
          consensusReached: summary.consensusReached,
          warnings: summary.warnings,
          errors: summary.errors,
        },
        trigger: 'on-change',
      },
    });

    // Post a consolidated review summary for visibility
    const approvals = iteration.reviews.filter(r => r.verdict === 'approve').length;
    const rejections = iteration.reviews.filter(r => r.verdict === 'reject').length;
    const concerns = iteration.reviews.filter(r => r.verdict === 'concerns').length;
    const allIssues: Array<{ criticId: string; severity: string; message: string; line?: number; path?: string }> = [];

    for (const review of iteration.reviews) {
      for (const issue of review.issues) {
        allIssues.push({
          criticId: review.criticId,
          severity: issue.severity,
          message: issue.message,
          line: issue.line,
          path: issue.path,
        });
      }
    }

    this.deps.feed.postSystem('workflow_step', {
      step: 'review_summary',
      iteration: iteration.number,
      approvals,
      rejections,
      concerns,
      total: iteration.reviews.length,
      consensusReached: summary.consensusReached,
      allIssues,
    });

    this.emitEvent({
      type: 'cca:review_completed',
      sessionId,
      iteration: iteration.number,
      data: {
        reviewsCount: iteration.reviews.length,
        overallStatus: summary.overallStatus,
      },
      timestamp: Date.now(),
    });

    // If this is a follow-up iteration, post a comparison summary
    if (iteration.number > 1) {
      const prevIteration = this.state.iterations[iteration.number - 2];
      if (prevIteration) {
        const prevApprovals = prevIteration.reviews.filter(r => r.verdict === 'approve').length;
        const prevRejections = prevIteration.reviews.filter(r => r.verdict === 'reject').length;
        const prevConcerns = prevIteration.reviews.filter(r => r.verdict === 'concerns').length;
        const prevTotal = prevIteration.reviews.length;

        const currApprovals = iteration.reviews.filter(r => r.verdict === 'approve').length;
        const currRejections = iteration.reviews.filter(r => r.verdict === 'reject').length;
        const currConcerns = iteration.reviews.filter(r => r.verdict === 'concerns').length;
        const currTotal = iteration.reviews.length;

        // Check which critics changed their verdict
        const verdictChanges: Array<{ criticId: string; from: string; to: string }> = [];
        for (const currReview of iteration.reviews) {
          const prevReview = prevIteration.reviews.find(r => r.criticId === currReview.criticId);
          if (prevReview && prevReview.verdict !== currReview.verdict) {
            verdictChanges.push({
              criticId: currReview.criticId,
              from: prevReview.verdict,
              to: currReview.verdict,
            });
          }
        }

        // Post comparison to feed
        this.deps.feed.postSystem('workflow_step', {
          step: 'reviews_comparison',
          iteration: iteration.number,
          previousIteration: iteration.number - 1,
          previous: {
            approvals: prevApprovals,
            rejections: prevRejections,
            concerns: prevConcerns,
            total: prevTotal,
          },
          current: {
            approvals: currApprovals,
            rejections: currRejections,
            concerns: currConcerns,
            total: currTotal,
          },
          verdictChanges,
          improved: currApprovals > prevApprovals || currRejections < prevRejections,
        });
      }
    }
  }

  /**
   * Convert a validation result to a critic review.
   */
  private convertValidationToReview(result: ValidationResult): CriticReview {
    // Build issues from the AI critic's detailed response
    const issues: CriticIssue[] = [];

    // Check for detailed issues from AI critic (stored in metadata.allIssues)
    const allIssues = result.metadata?.allIssues as Array<{
      file?: string;
      line?: number;
      issue: string;
      suggestion?: string;
      blocking?: boolean;
    }> | undefined;

    if (allIssues && allIssues.length > 0) {
      // Use the full issues from the AI critic
      for (const issue of allIssues) {
        issues.push({
          severity: issue.blocking ? 'error' : result.severity === 'error' ? 'error' : 'warning',
          message: issue.issue + (issue.suggestion ? ` (Suggestion: ${issue.suggestion})` : ''),
          path: issue.file,
          line: issue.line,
          blocking: issue.blocking ?? (result.severity === 'error'),
        });
      }
    } else {
      // Fall back to creating a single issue from the result
      const details = result.details as { file?: string; line?: number; reasoning?: string } | undefined;

      if (result.severity === 'error' || result.severity === 'warning') {
        issues.push({
          severity: result.severity,
          message: result.message,
          path: details?.file,
          line: details?.line,
          blocking: result.severity === 'error',
        });
      }
    }

    // Map validation status to critic verdict
    let verdict: CriticReview['verdict'];
    let approved = false;
    if (result.status === 'approved') {
      verdict = 'approve';
      approved = true;
    } else if (result.status === 'rejected') {
      verdict = 'reject';
      approved = false;
    } else if (result.status === 'needs-revision') {
      verdict = 'concerns';
      approved = false;
    } else {
      verdict = 'error';
      approved = false;
    }

    // Include reasoning in comments if available
    const details = result.details as { reasoning?: string } | undefined;
    const comments = [result.message];
    if (details?.reasoning) {
      comments.push(details.reasoning);
    }

    return {
      criticId: result.validator,
      type: allIssues ? 'ai-critic' : 'static',
      approved,
      verdict,
      comments,
      issues,
      reviewedAt: Date.now(),
    };
  }

  /**
   * Check if consensus was reached.
   */
  private checkConsensus(iteration: CCAIteration): { consensus: boolean; ratio: number } {
    if (iteration.reviews.length === 0) {
      return { consensus: true, ratio: 1.0 };
    }

    const approvals = iteration.reviews.filter((r) => r.verdict === 'approve').length;
    const ratio = approvals / iteration.reviews.length;

    return {
      consensus: ratio >= this.options.autoApplyThreshold,
      ratio,
    };
  }

  /**
   * Request decision from human arbiter.
   */
  private async requestArbiterDecision(
    sessionId: string,
    forced: boolean
  ): Promise<ArbiterDecision> {
    const currentIteration = this.state.iterations[this.state.currentIteration - 1];
    if (!currentIteration) {
      throw new Error('No current iteration');
    }

    // Build request
    const request: ArbiterDecisionRequest = {
      id: `decision-${Date.now()}`,
      summary: this.buildArbiterSummary(currentIteration, forced),
      changes: currentIteration.changes,
      reviews: currentIteration.reviews,
      actions: ['approve', 'reject', 'iterate', 'abort'],
      suggested: this.suggestAction(currentIteration),
    };

    // Post decision request to feed as a workflow step
    this.deps.feed.postSystem('workflow_step', {
      step: 'arbiter_decision_requested',
      requestId: request.id,
      summary: request.summary,
      suggested: request.suggested,
      changesCount: request.changes.length,
      reviewsCount: request.reviews.length,
    });

    this.emitEvent({
      type: 'cca:awaiting_arbiter',
      sessionId,
      iteration: currentIteration.number,
      data: { request },
      timestamp: Date.now(),
    });

    // Wait for decision
    return new Promise((resolve) => {
      this.arbiterResolver = resolve;

      // Handle timeout if configured
      if (this.options.arbiterTimeout > 0) {
        setTimeout(() => {
          if (this.arbiterResolver) {
            // Default to iterate on timeout
            this.arbiterResolver({
              id: request.id,
              type: 'iterate',
              feedback: 'Timeout - automatically continuing iteration',
              decidedAt: Date.now(),
            });
            this.arbiterResolver = null;
          }
        }, this.options.arbiterTimeout);
      }
    });
  }

  /**
   * Build summary for the arbiter.
   */
  private buildArbiterSummary(iteration: CCAIteration, forced: boolean): string {
    const parts: string[] = [];

    if (forced) {
      parts.push(`Maximum iterations (${this.options.maxIterations}) reached. Decision required.`);
    }

    if (iteration.changes.length === 0) {
      parts.push(`Iteration ${iteration.number}: No file changes were made.`);
      parts.push('The coder responded without modifying files. Choose "Iterate" to provide additional instructions, or "Reject" to end.');
    } else {
      parts.push(`Iteration ${iteration.number}: ${iteration.changes.length} changes proposed.`);
    }

    // Summarize reviews
    const approvals = iteration.reviews.filter((r) => r.verdict === 'approve').length;
    const rejections = iteration.reviews.filter((r) => r.verdict === 'reject').length;
    const concerns = iteration.reviews.filter((r) => r.verdict === 'concerns').length;

    parts.push(`Reviews: ${approvals} approve, ${rejections} reject, ${concerns} with concerns.`);

    // Highlight blocking issues
    const blockingIssues = iteration.reviews
      .flatMap((r) => r.issues)
      .filter((i) => i.blocking);

    if (blockingIssues.length > 0) {
      parts.push(`Blocking issues: ${blockingIssues.length}`);
      for (const issue of blockingIssues.slice(0, 3)) {
        parts.push(`  - ${issue.message}`);
      }
      if (blockingIssues.length > 3) {
        parts.push(`  ... and ${blockingIssues.length - 3} more`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Suggest an action based on reviews.
   */
  private suggestAction(iteration: CCAIteration): 'approve' | 'reject' | 'iterate' | undefined {
    const hasBlockingErrors = iteration.reviews.some((r) =>
      r.issues.some((i) => i.blocking && i.severity === 'error')
    );

    if (hasBlockingErrors) {
      return 'iterate';
    }

    const approvals = iteration.reviews.filter((r) => r.verdict === 'approve').length;
    const ratio = iteration.reviews.length > 0 ? approvals / iteration.reviews.length : 1;

    if (ratio >= 0.8) {
      return 'approve';
    } else if (ratio <= 0.2) {
      return 'reject';
    } else {
      return 'iterate';
    }
  }

  /**
   * Apply approved changes.
   */
  private async applyChanges(
    sessionId: string,
    iteration: CCAIteration
  ): Promise<void> {
    for (const change of iteration.changes) {
      change.status = 'applied';

      this.deps.feed.postChange(
        change.type === 'delete' ? 'file_delete' : 'file_edit',
        'system',
        {
          path: change.path,
          status: 'applied',
        }
      );
    }

    this.emitEvent({
      type: 'cca:changes_applied',
      sessionId,
      iteration: iteration.number,
      data: { changesCount: iteration.changes.length },
      timestamp: Date.now(),
    });
  }

  /**
   * Submit arbiter decision.
   */
  submitArbiterDecision(decision: ArbiterDecision, sessionId: string): void {
    if (this.arbiterResolver) {
      this.emitEvent({
        type: 'cca:arbiter_decided',
        sessionId,
        iteration: this.state.currentIteration,
        data: { decision },
        timestamp: Date.now(),
      });

      this.arbiterResolver(decision);
      this.arbiterResolver = null;
    }
  }

  /**
   * Abort the workflow.
   */
  abort(): void {
    this.aborted = true;
    if (this.arbiterResolver) {
      this.arbiterResolver({
        id: `abort-${Date.now()}`,
        type: 'abort',
        decidedAt: Date.now(),
      });
      this.arbiterResolver = null;
    }
  }

  /**
   * Set workflow state.
   */
  private setWorkflowState(state: CCAWorkflowState): void {
    this.state.workflowState = state;
    this.log(`Workflow state: ${state}`);
  }

  /**
   * Subscribe to CCA events.
   */
  onEvent(callback: CCAEventCallback): Unsubscribe {
    this.eventCallbacks.add(callback);
    return () => {
      this.eventCallbacks.delete(callback);
    };
  }

  /**
   * Emit a CCA event.
   */
  private emitEvent(event: CCAEvent): void {
    for (const callback of this.eventCallbacks) {
      try {
        callback(event);
      } catch (error) {
        this.log(`Event callback error: ${error}`);
      }
    }
  }
}

/**
 * Create a CCA workflow controller.
 */
export function createCCAWorkflow(
  deps: CCAWorkflowDependencies,
  options?: Partial<CCAWorkflowOptions>
): CCAWorkflow {
  return new CCAWorkflow(deps, options);
}
