/**
 * CCA TUI Integration
 *
 * Connects CCA sessions to the TUI components:
 * - Ensemble panel for feed display
 * - Permission dialog for tool approvals
 * - Arbiter dialog for decisions
 */

import { debugLog, isDebugEnabled } from '../../../debug.ts';
import { createCCASession, type CCASession, type CCASessionConfig } from './session.ts';
import { getCCAStorage, CCAStorage } from './storage.ts';
import type { ArbiterDecisionRequest } from './workflow.ts';
import type { ArbiterDecision } from './types.ts';
// TUI types are stubbed for headless server builds (no TUI dependency)
// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface EnsemblePanel {
  addFeedEntry(entry: any): void;
  addToReviewQueue(tool: string, filePath: string | undefined, feedback: string): void;
  requestPermission(opts: any): Promise<any>;
  requestArbiterDecision(opts: any): Promise<any>;
  setSession(sessionId: string, state: string, task: string): void;
  setEnsembleConfig(config: any): void;
  updateSessionState(state: string): void;
  updateValidationStatus(status: string): void;
  updateCriticStatus(criticId: string, state: string): void;
  clearFeed(): void;
  setCallbacks(callbacks: any): void;
  getState(): any;
}
// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface DialogManager {}
import type { PermissionResponse, PermissionRequest } from '../permissions/types.ts';

// ============================================
// Types
// ============================================

/**
 * Configuration for CCA TUI integration.
 */
export interface CCATUIConfig extends Omit<CCASessionConfig, 'handlers'> {
  /** The ensemble panel to update */
  panel: EnsemblePanel;
  /** The dialog manager for permissions and decisions */
  dialogManager: DialogManager;
}

/**
 * CCA TUI controller.
 */
export interface CCATUIController {
  /** The underlying CCA session */
  session: CCASession;
  /** Start the workflow with a task */
  start: (task: string) => Promise<void>;
  /** Continue from a previous session (preserves feed history) */
  continueSession: (task: string) => Promise<void>;
  /** Pause the workflow */
  pause: () => void;
  /** Resume the workflow */
  resume: () => void;
  /** Abort the workflow */
  abort: () => void;
  /** Send a human message */
  sendMessage: (message: string) => void;
  /** Clean up resources */
  dispose: () => void;
}

// ============================================
// Integration
// ============================================

/**
 * Create a CCA session integrated with TUI components.
 */
export function createCCATUISession(config: CCATUIConfig): CCATUIController {
  const { panel, dialogManager, ...sessionConfig } = config;
  const workspacePath = sessionConfig.workspacePath || process.cwd();

  // Storage instance (lazily initialized)
  let storage: CCAStorage | null = null;
  const getStorage = async (): Promise<CCAStorage> => {
    if (!storage) {
      storage = await getCCAStorage(workspacePath);
    }
    return storage;
  };

  // Helper to save a permission to storage
  const savePermission = async (
    sessionId: string,
    tool: string,
    scope: 'once' | 'session' | 'folder' | 'global',
    description?: string,
    folderPath?: string
  ): Promise<void> => {
    try {
      const store = await getStorage();
      store.savePermission({
        id: `perm-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        sessionId,
        toolName: tool,
        scope,
        description,
        folderPath,
      });
    } catch (error) {
      debugLog(`[CCATUISession] Failed to save permission: ${error}`);
    }
  };

  const log = (msg: string): void => {
    if (isDebugEnabled()) {
      debugLog(`[CCATUISession] ${msg}`);
    }
  };

  // Always log errors to both debug and the panel feed
  const logError = (msg: string, error?: unknown): void => {
    const errorMsg = error instanceof Error ? error.message : String(error || '');
    const fullMsg = errorMsg ? `${msg}: ${errorMsg}` : msg;
    debugLog(`[CCATUISession] ERROR: ${fullMsg}`);
    // Also add to the feed so user can see it
    panel.addFeedEntry({
      id: `error-${Date.now()}`,
      type: 'error',
      source: 'system',
      content: {
        code: 'ENSEMBLE_ERROR',
        message: fullMsg,
        details: error instanceof Error ? { stack: error.stack } : undefined,
      },
      timestamp: Date.now(),
    });
  };

  // Create session with handlers
  const session = createCCASession({
    ...sessionConfig,
    handlers: {
      // Handle permission requests inline in the panel
      onPermissionRequired: async (
        tool,
        description,
        input,
        riskLevel,
        scopeOptions,
        _doubleConfirm,
        rawInput,
        criticReviews
      ): Promise<PermissionResponse | null> => {
        log(`Permission required: ${tool} - ${input}`);

        // Check stored permissions first
        try {
          const store = await getStorage();
          const storedPerm = store.checkPermission(session.getSessionId(), tool, input);
          if (storedPerm) {
            log(`Permission already granted (stored): ${tool} with scope ${storedPerm.scope}`);
            return {
              requestId: `perm-${Date.now()}`,
              granted: true,
              scope: storedPerm.scope,
              folderPath: storedPerm.folderPath,
              timestamp: Date.now(),
            };
          }
        } catch (error) {
          // Storage check failed, continue with normal flow
          log(`Storage check failed: ${error}`);
        }

        if (criticReviews && criticReviews.length > 0) {
          log(`Critics have reviewed: ${criticReviews.map(r => `${r.criticId}:${r.verdict}`).join(', ')}`);
        }

        // Count critic verdicts for auto-decision
        const approveCount = criticReviews?.filter(r => r.verdict === 'approve').length || 0;
        const rejectCount = criticReviews?.filter(r => r.verdict === 'reject' || r.verdict === 'concerns').length || 0;
        const totalCritics = criticReviews?.length || 0;

        // Auto-decision logic based on critic reviews (only for Write/Edit with critics)
        if (totalCritics >= 2 && (tool === 'Write' || tool === 'Edit')) {
          const filePath = (rawInput?.file_path as string) || (rawInput?.path as string);
          const requestId = `perm-${Date.now()}`;

          if (approveCount === totalCritics) {
            // All critics approve → auto-apply
            log(`Auto-applying: all ${totalCritics} critics approved`);
            panel.addFeedEntry({
              id: `auto-apply-${Date.now()}`,
              type: 'system',
              source: 'system',
              content: {
                event: 'workflow_step',
                details: {
                  step: 'auto_apply',
                  reason: `All ${totalCritics} critics approved`,
                  tool,
                  file: filePath,
                },
              },
              timestamp: Date.now(),
            });
            // Save permission to storage
            savePermission(session.getSessionId(), tool, 'session', description);
            return {
              requestId,
              granted: true,
              scope: 'session',
              timestamp: Date.now(),
            };
          } else if (approveCount > 0 && rejectCount > 0) {
            // Mixed reviews → auto-queue feedback and apply
            log(`Auto-queuing: mixed reviews (${approveCount} approve, ${rejectCount} concerns)`);

            // Generate feedback from the critics that had concerns
            const concernReviews = criticReviews?.filter(r => r.verdict === 'reject' || r.verdict === 'concerns') || [];
            const feedbackParts: string[] = [];
            for (const review of concernReviews) {
              if (review.issues && review.issues.length > 0) {
                for (const issue of review.issues) {
                  const lineRef = issue.line ? ` (line ${issue.line})` : '';
                  feedbackParts.push(`[${review.criticId}] ${issue.message}${lineRef}`);
                }
              } else if (review.comments && review.comments.length > 0) {
                feedbackParts.push(`[${review.criticId}] ${review.comments.join('; ')}`);
              }
            }

            // Queue the feedback for later review
            if (feedbackParts.length > 0) {
              panel.addToReviewQueue(tool, filePath, feedbackParts.join('\n'));
            }

            panel.addFeedEntry({
              id: `auto-queue-${Date.now()}`,
              type: 'system',
              source: 'system',
              content: {
                event: 'workflow_step',
                details: {
                  step: 'auto_queue',
                  reason: `Mixed reviews: ${approveCount} approve, ${rejectCount} concerns - feedback queued`,
                  tool,
                  file: filePath,
                },
              },
              timestamp: Date.now(),
            });
            // Save permission to storage
            savePermission(session.getSessionId(), tool, 'session', description);
            return {
              requestId,
              granted: true,
              scope: 'session',
              timestamp: Date.now(),
            };
          }
          // If all critics reject/have concerns, fall through to show UI
          log(`Requiring arbiter: ${rejectCount} critics have concerns`);
        }

        // Build the permission request for manual review
        const request: PermissionRequest = {
          id: `perm-${Date.now()}`,
          sessionId: session.getSessionId(),
          tool,
          description,
          input,
          riskLevel: riskLevel as PermissionRequest['riskLevel'],
          scopeOptions,
          doubleConfirm: false, // Inline doesn't support double confirm
          timestamp: Date.now(),
        };

        // Compute diff for Write/Edit operations
        let diff: string | undefined;
        let filePath: string | undefined;

        if (rawInput && (tool === 'Write' || tool === 'Edit')) {
          filePath = (rawInput.file_path as string) || (rawInput.path as string);

          if (tool === 'Write') {
            const content = rawInput.content as string || '';
            const lines = content.split('\n');
            diff = [
              `--- /dev/null`,
              `+++ ${filePath}`,
              `@@ -0,0 +1,${lines.length} @@`,
              ...lines.map(line => `+${line}`),
            ].join('\n');
          } else if (tool === 'Edit') {
            const oldStr = rawInput.old_string as string || '';
            const newStr = rawInput.new_string as string || '';
            const oldLines = oldStr.split('\n');
            const newLines = newStr.split('\n');
            diff = [
              `--- ${filePath}`,
              `+++ ${filePath}`,
              `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
              ...oldLines.map(line => `-${line}`),
              ...newLines.map(line => `+${line}`),
            ].join('\n');
          }
        }

        try {
          log(`Requesting permission with diff: ${diff ? 'yes' : 'no'}, rawInput: ${rawInput ? 'yes' : 'no'}, critics: ${criticReviews?.length || 0}`);
          // Use inline permission in the panel instead of a dialog
          const result = await panel.requestPermission({
            request,
            scopeOptions,
            diff,
            filePath,
            criticReviews,
          });

          if (result && result.granted) {
            log(`Permission granted: ${result.scope}`);
            // Save permission to storage
            if (result.scope && result.scope !== 'once') {
              savePermission(
                session.getSessionId(),
                tool,
                result.scope,
                description,
                result.folderPath
              );
            }
            return result;
          } else {
            // Return the result even when denied so feedback flows through to the coder
            log(`Permission denied by user${result?.feedback ? ' with feedback' : ''}`);
            return result || null;
          }
        } catch (error) {
          logError('Permission request failed', error);
          return null;
        }
      },

      // Handle arbiter decisions inline in the panel
      onArbiterRequired: async (request: ArbiterDecisionRequest): Promise<ArbiterDecision> => {
        log(`Arbiter decision required: ${request.id}`);

        try {
          // Use inline decision in the panel instead of a dialog
          const decision = await panel.requestArbiterDecision({
            id: request.id,
            summary: request.summary,
            changes: request.changes,
            reviews: request.reviews,
            suggested: request.suggested,
          });

          log(`Arbiter decided: ${decision.type}`);
          return decision;
        } catch (error) {
          logError('Arbiter decision failed', error);
          return {
            id: request.id,
            type: 'abort',
            feedback: `Error: ${error}`,
            decidedAt: Date.now(),
          };
        }
      },
    },
  });

  // Connect session to panel
  session.on('session:started', (sessionId: string) => {
    panel.setSession(sessionId, 'running', '');
    // Set ensemble configuration for display
    const coderAgent = sessionConfig.coderAgent;
    const coderName = coderAgent
      ? `${coderAgent.role}:${coderAgent.model.split('/').pop() || coderAgent.model}`
      : 'Claude';
    // Get critic names from session
    const sessionCritics = session.getCritics();
    const validatorNames = sessionCritics
      .filter(c => c.enabled !== false)
      .map(c => c.name);

    // Build critics status array for display
    // If the panel already has critics config (from health check), preserve their availability status
    const existingConfig = panel.getState() as { ensembleConfig?: { critics?: Array<{ id: string; available: boolean }> } };
    const existingCritics = existingConfig?.ensembleConfig?.critics || [];

    const criticsStatus = sessionCritics
      .filter(c => c.enabled !== false)
      .map(c => {
        // Check if we have existing availability info from health check
        const existing = existingCritics.find(ec => ec.id === c.provider);
        return {
          id: c.id,
          name: c.name,
          provider: c.provider,
          available: existing?.available ?? true,
          state: (existing?.available === false ? 'error' : 'idle') as 'idle' | 'reviewing' | 'done' | 'error',
        };
      });

    panel.setEnsembleConfig({
      coderName,
      validationEnabled: validatorNames.length > 0,
      validators: validatorNames.length > 0 ? validatorNames : ['None'],
      validationStatus: 'pending',
      arbiterMode: 'required',
      critics: criticsStatus,
    });
  });

  session.on('state:changed', (state) => {
    const sessionState = state.workflowState === 'completed' ? 'completed'
      : state.workflowState === 'error' ? 'error'
      : state.workflowState === 'awaiting-arbiter' ? 'waiting_human'
      : 'running';
    panel.updateSessionState(sessionState);

    // Update validation status based on workflow state
    if (state.workflowState === 'reviewing') {
      panel.updateValidationStatus('running');
    } else if (state.lastValidationSummary) {
      const status = state.lastValidationSummary.overallStatus;
      panel.updateValidationStatus(status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'passed');
    }
  });

  session.on('feed:entry', (entry) => {
    panel.addFeedEntry(entry);

    // Update critic status based on feed entries
    if (entry.type === 'system' && entry.content) {
      const content = entry.content as { event?: string; details?: Record<string, unknown> };
      if (content.event === 'workflow_step') {
        const details = content.details;
        if (details?.step === 'critics_reviewing') {
          // All critics are reviewing - set them to reviewing state
          const sessionCritics = session.getCritics();
          for (const critic of sessionCritics) {
            if (critic.enabled !== false) {
              panel.updateCriticStatus(critic.id, 'reviewing');
            }
          }
        }
      }
    }

    // When a critic posts its review, mark it as done
    if (entry.type === 'critic' && entry.content) {
      const content = entry.content as { criticId?: string };
      if (content.criticId) {
        panel.updateCriticStatus(content.criticId, 'done');
      }
    }
  });

  session.on('session:ended', (_sessionId, state) => {
    // Check if the last iteration was aborted
    const lastIteration = state.iterations[state.iterations.length - 1];
    const wasAborted = lastIteration?.arbiterDecision?.type === 'abort';

    const sessionState = state.consensusReached ? 'completed'
      : wasAborted ? 'aborted'
      : 'error';
    panel.updateSessionState(sessionState);
  });

  session.on('error', (error) => {
    panel.updateSessionState('error');
    logError('Session error', error);
  });

  // Create controller
  const controller: CCATUIController = {
    session,

    async start(task: string): Promise<void> {
      panel.setSession(session.getSessionId(), 'initializing', task);
      panel.clearFeed();

      try {
        await session.start(task);
      } catch (error) {
        logError('Failed to start CCA session', error);
        throw error;
      }
    },

    async continueSession(task: string): Promise<void> {
      // Like start() but preserves existing feed entries
      panel.setSession(session.getSessionId(), 'initializing', task);
      // DON'T clear the feed - we're continuing from history

      try {
        await session.start(task);
      } catch (error) {
        logError('Failed to continue CCA session', error);
        throw error;
      }
    },

    pause(): void {
      session.pause();
      panel.updateSessionState('paused');
    },

    resume(): void {
      session.resume();
      panel.updateSessionState('running');
    },

    abort(): void {
      session.abort();
      panel.updateSessionState('completed');
    },

    sendMessage(message: string): void {
      session.sendMessage(message);
    },

    dispose(): void {
      session.dispose();
    },
  };

  // Wire up panel callbacks
  panel.setSession(session.getSessionId(), 'idle', '');
  panel.setCallbacks({
    onAddressQueuedFeedback: async (feedback: string) => {
      log('Addressing queued feedback');
      // Continue the workflow with the feedback
      try {
        await session.continueWithFeedback(feedback);
      } catch (error) {
        logError('Failed to continue with feedback', error);
      }
    },
  });

  return controller;
}
