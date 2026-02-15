/**
 * CCA Session Controller
 *
 * Manages a complete CCA workflow session including:
 * - Coder agent with tool execution
 * - Validation critics
 * - Human arbiter integration
 * - Permission handling
 */

import { EventEmitter } from 'node:events';
import { debugLog, isDebugEnabled } from '../../../debug.ts';
import { createCCAWorkflow, type CCAWorkflowDependencies, type ArbiterDecisionRequest } from './workflow.ts';
import type { CCAWorkflow } from './workflow.ts';
import type {
  CCASessionState,
  ArbiterDecision,
} from './types.ts';
import { createAgentInstance, type AgentInstance } from '../agent-instance.ts';
import { createSharedFeed, type SharedFeed } from '../shared-feed.ts';
import type { ValidationPipeline } from '../../validation/pipeline.ts';
import { createValidationPipeline } from '../../validation/pipeline.ts';
import { createToolExecutor, type ToolExecutor } from '../tools/executor.ts';
import type { PermissionResponse } from '../permissions/types.ts';
import type { APIProvider } from '../providers/api-base.ts';
import type { AgentDefinition, FeedEntry } from '../types.ts';
import type { Unsubscribe } from '../types.ts';
import type { ToolDefinition, AIProviderType } from '../../ai/types.ts';
import { createCodeReviewCritic } from '../../validation/ai-critic.ts';
import type { ValidatorDefinition } from '../../validation/types.ts';
import { getCCAStorage } from './storage.ts';

// ============================================
// Types
// ============================================

/**
 * Critic configuration for CCA.
 */
export interface CriticConfig {
  /** Critic ID */
  id: string;
  /** Display name */
  name: string;
  /** AI provider type */
  provider: AIProviderType;
  /** Model to use (optional, uses provider default) */
  model?: string;
  /** Whether this critic is enabled */
  enabled?: boolean;
}

/**
 * CCA Session events.
 */
export interface CCASessionEvents {
  'session:started': [string]; // sessionId
  'session:ended': [string, CCASessionState];
  'state:changed': [CCASessionState];
  'feed:entry': [FeedEntry];
  'permission:required': [
    string, // tool
    string, // description
    string, // input
    string, // riskLevel
    Array<{ scope: 'once' | 'session' | 'folder' | 'global'; label: string; description: string }>,
    boolean, // doubleConfirm
    CriticReviewDisplay[] | undefined // critic reviews
  ];
  'arbiter:required': [ArbiterDecisionRequest];
  'error': [Error];
}

/**
 * Critic review info for permission display.
 */
export interface CriticReviewDisplay {
  criticId: string;
  verdict: 'approve' | 'reject' | 'concerns' | 'error';
  comments: string[];
  issues?: Array<{ severity: string; message: string; line?: number }>;
}

/**
 * Handlers for external integration.
 */
export interface CCASessionHandlers {
  /** Called when permission is required - returns response or null to deny */
  onPermissionRequired?: (
    tool: string,
    description: string,
    input: string,
    riskLevel: string,
    scopeOptions: Array<{ scope: 'once' | 'session' | 'folder' | 'global'; label: string; description: string }>,
    doubleConfirm: boolean,
    /** Raw tool input for showing content/diff */
    rawInput?: Record<string, unknown>,
    /** Critic reviews for this change */
    criticReviews?: CriticReviewDisplay[]
  ) => Promise<PermissionResponse | null>;

  /** Called when arbiter decision is required */
  onArbiterRequired?: (request: ArbiterDecisionRequest) => Promise<ArbiterDecision>;
}

/**
 * Configuration for CCA session.
 */
export interface CCASessionConfig {
  /** Session ID (generated if not provided) */
  sessionId?: string;
  /** Coder agent definition */
  coderAgent: AgentDefinition;
  /** API provider for the coder */
  coderProvider: APIProvider;
  /** Validation pipeline (optional, created with default critics if not provided) */
  validationPipeline?: ValidationPipeline;
  /** AI critics to use (defaults to OpenAI and Gemini if not specified) */
  critics?: CriticConfig[];
  /** Session handlers */
  handlers?: CCASessionHandlers;
  /** Maximum iterations */
  maxIterations?: number;
  /** Workspace path for storage (defaults to cwd) */
  workspacePath?: string;
}

/**
 * Default AI critics for CCA.
 */
export const DEFAULT_CRITICS: CriticConfig[] = [
  {
    id: 'openai-critic',
    name: 'GPT-5.2',
    provider: 'openai',
    model: 'gpt-5.2',
    enabled: true,
  },
  {
    id: 'gemini-critic',
    name: 'Gemini 3 Pro',
    provider: 'gemini',
    model: 'gemini-3-pro-preview',
    enabled: true,
  },
];

// ============================================
// Tool Definitions
// ============================================

/**
 * Create tool definitions for the coder agent.
 */
function createCoderToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'Read',
      description: 'Read the contents of a file. Use this to understand existing code before making changes.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'The absolute path to the file to read',
          },
        },
        required: ['file_path'],
      },
    },
    {
      name: 'Write',
      description: 'Write content to a file. Creates the file if it does not exist, or overwrites if it does.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'The absolute path to the file to write',
          },
          content: {
            type: 'string',
            description: 'The content to write to the file',
          },
        },
        required: ['file_path', 'content'],
      },
    },
    {
      name: 'Edit',
      description: 'Make a precise edit to a file by replacing a specific string with a new string.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'The absolute path to the file to edit',
          },
          old_string: {
            type: 'string',
            description: 'The exact string to find and replace (must be unique in the file)',
          },
          new_string: {
            type: 'string',
            description: 'The string to replace it with',
          },
          replace_all: {
            type: 'boolean',
            description: 'Whether to replace all occurrences (default: false)',
          },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
    {
      name: 'Glob',
      description: 'Find files matching a glob pattern.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'The glob pattern to match (e.g., "**/*.ts", "src/**/*.js")',
          },
          path: {
            type: 'string',
            description: 'The directory to search in (defaults to current directory)',
          },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'Grep',
      description: 'Search for a pattern in file contents.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'The regex pattern to search for',
          },
          path: {
            type: 'string',
            description: 'The file or directory to search in',
          },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'Bash',
      description: 'Execute a bash command. Use for running tests, installing dependencies, git operations, etc.',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The bash command to execute',
          },
          timeout: {
            type: 'number',
            description: 'Timeout in milliseconds (default: 120000)',
          },
        },
        required: ['command'],
      },
    },
    {
      name: 'GetStoredResult',
      description: 'Retrieve the full content of a previously truncated result. When tool results are too large, they are truncated and stored with an ID. Use this tool to retrieve the full content.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'The context store ID (e.g., "ctx-1234567890-1") from the truncated result',
          },
          offset: {
            type: 'number',
            description: 'Starting character offset for pagination (default: 0)',
          },
          limit: {
            type: 'number',
            description: 'Maximum characters to return (default: 50000)',
          },
        },
        required: ['id'],
      },
    },
  ];
}

// ============================================
// CCA Session Controller
// ============================================

/**
 * Controller for a complete CCA session.
 */
export class CCASession extends EventEmitter {
  private sessionId: string;
  private config: CCASessionConfig;
  private workflow: CCAWorkflow | null = null;
  private coder: AgentInstance;
  private feed: SharedFeed;
  private validationPipeline: ValidationPipeline;
  private toolExecutor: ToolExecutor;
  private toolDefinitions: ToolDefinition[];
  private state: 'idle' | 'running' | 'paused' | 'completed' | 'error' = 'idle';
  private unsubscribers: Unsubscribe[] = [];

  constructor(config: CCASessionConfig) {
    super();
    this.config = config;
    this.sessionId = config.sessionId || this.generateSessionId();

    // Create tool definitions
    this.toolDefinitions = createCoderToolDefinitions();

    // Create shared feed
    this.feed = createSharedFeed();

    // Create validation pipeline with AI critics
    this.validationPipeline = config.validationPipeline || createValidationPipeline();

    // Register default or configured critics
    const critics = config.critics ?? DEFAULT_CRITICS;
    this.registerCritics(critics);

    // Create coder agent with tool definitions
    this.coder = createAgentInstance({
      definition: config.coderAgent,
      tools: this.toolDefinitions,
    });

    // Create tool executor with permission handling
    this.toolExecutor = createToolExecutor({
      sessionId: this.sessionId,
      onPermissionPrompt: async (tool, desc, input, risk, scopes, double, rawInput, criticReviews) => {
        if (config.handlers?.onPermissionRequired) {
          return config.handlers.onPermissionRequired(tool, desc, input, risk, scopes, double, rawInput, criticReviews);
        }
        // Emit event for external handling
        this.emit('permission:required', tool, desc, input, risk, scopes, double, criticReviews);
        return null; // Deny by default if no handler
      },
    });

    // Subscribe to feed updates
    const feedUnsub = this.feed.subscribe((entry) => {
      this.emit('feed:entry', entry);
    });
    this.unsubscribers.push(feedUnsub);
  }

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[CCASession:${this.sessionId}] ${msg}`);
    }
  }

  private generateSessionId(): string {
    return `cca-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Register AI critics with the validation pipeline.
   */
  private registerCritics(critics: CriticConfig[]): void {
    for (const critic of critics) {
      if (!critic.enabled) continue;

      const validator: ValidatorDefinition = createCodeReviewCritic({
        id: critic.id,
        name: critic.name,
        provider: critic.provider,
        model: critic.model,
        enabled: true,
        triggers: ['on-change'],
        behavior: {
          onFailure: 'warning',
          blockOnFailure: false,
          required: false,
          timeoutMs: 60000,
          onTimeout: 'warning',
          cacheable: true,
        },
      });

      this.validationPipeline.registerValidator(validator);
      this.log(`Registered AI critic: ${critic.name} (${critic.provider}/${critic.model || 'default'})`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get session ID.
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Get current state.
   */
  getState(): 'idle' | 'running' | 'paused' | 'completed' | 'error' {
    return this.state;
  }

  /**
   * Get the shared feed.
   */
  getFeed(): SharedFeed {
    return this.feed;
  }

  /**
   * Get recent feed entries.
   */
  getFeedEntries(limit?: number): FeedEntry[] {
    return this.feed.getEntries({ limit });
  }

  /**
   * Get the workflow state.
   */
  getWorkflowState(): CCASessionState | null {
    return this.workflow?.getState() ?? null;
  }

  /**
   * Get the tool executor.
   */
  getToolExecutor(): ToolExecutor {
    return this.toolExecutor;
  }

  /**
   * Get tool definitions.
   */
  getToolDefinitions(): ToolDefinition[] {
    return this.toolDefinitions;
  }

  /**
   * Get registered critics.
   */
  getCritics(): CriticConfig[] {
    return this.config.critics ?? DEFAULT_CRITICS;
  }

  /**
   * Start the CCA workflow with a task.
   */
  async start(task: string): Promise<CCASessionState> {
    if (this.state !== 'idle') {
      throw new Error(`Cannot start session in state: ${this.state}`);
    }

    this.log(`Starting CCA session with task: ${task.substring(0, 50)}...`);
    this.state = 'running';

    try {
      // Initialize storage for session persistence
      const workspacePath = this.config.workspacePath || process.cwd();
      const storage = await getCCAStorage(workspacePath);
      this.log(`Storage initialized at ${workspacePath}/.ultra/cca.db`);

      // Create workflow dependencies
      const deps: CCAWorkflowDependencies = {
        coder: this.coder,
        coderProvider: this.config.coderProvider,
        validationPipeline: this.validationPipeline,
        feed: this.feed,
        toolExecutor: this.toolExecutor,
        toolDefinitions: this.toolDefinitions,
        storage,
        coderAgentName: this.config.coderAgent.role,
        coderModelName: this.config.coderAgent.model,
        workspacePath,
      };

      // Create workflow
      this.workflow = createCCAWorkflow(deps, {
        maxIterations: this.config.maxIterations ?? 5,
      });

      // Subscribe to workflow events
      const workflowUnsub = this.workflow.onEvent((event) => {
        this.log(`Workflow event: ${event.type}`);

        if (event.type === 'cca:awaiting_arbiter') {
          this.handleArbiterRequest(event.data as { request: ArbiterDecisionRequest });
        }
      });
      this.unsubscribers.push(workflowUnsub);

      // Emit session started
      this.emit('session:started', this.sessionId);

      // Run the workflow
      const result = await this.workflow.run(task, this.sessionId);

      this.state = 'completed';
      this.emit('session:ended', this.sessionId, result);

      return result;
    } catch (error) {
      this.state = 'error';
      const err = error instanceof Error ? error : new Error(String(error));
      this.log(`Session error: ${err.message}\n${err.stack || ''}`);
      // Post error to feed for visibility
      this.feed.post({
        type: 'error',
        source: 'system',
        content: {
          code: 'SESSION_ERROR',
          message: err.message,
          details: { stack: err.stack },
        },
      });
      this.emit('error', err);
      throw error;
    }
  }

  /**
   * Handle arbiter request.
   */
  private async handleArbiterRequest(data: { request: ArbiterDecisionRequest }): Promise<void> {
    const request = data.request;

    if (this.config.handlers?.onArbiterRequired) {
      try {
        const decision = await this.config.handlers.onArbiterRequired(request);
        this.workflow?.submitArbiterDecision(decision, this.sessionId);
      } catch (error) {
        this.log(`Arbiter handler error: ${error}`);
        // Default to abort on error
        this.workflow?.submitArbiterDecision({
          id: request.id,
          type: 'abort',
          feedback: 'Error in arbiter handler',
          decidedAt: Date.now(),
        }, this.sessionId);
      }
    } else {
      // Emit event for external handling
      this.emit('arbiter:required', request);
    }
  }

  /**
   * Submit an arbiter decision.
   */
  submitArbiterDecision(decision: ArbiterDecision): void {
    if (!this.workflow) {
      throw new Error('No active workflow');
    }

    this.workflow.submitArbiterDecision(decision, this.sessionId);
  }

  /**
   * Pause the session.
   */
  pause(): void {
    if (this.state !== 'running') return;

    this.state = 'paused';
    this.log('Session paused');
  }

  /**
   * Resume the session.
   */
  resume(): void {
    if (this.state !== 'paused') return;

    this.state = 'running';
    this.log('Session resumed');
  }

  /**
   * Abort the session.
   */
  abort(): void {
    if (this.workflow) {
      this.workflow.abort();
    }
    this.state = 'completed';
    this.log('Session aborted');
  }

  /**
   * Send a human message/interjection.
   */
  sendMessage(message: string): void {
    this.feed.postMessage(message, 'human');
  }

  /**
   * Continue the workflow with human feedback.
   * This injects the feedback into the workflow and runs another iteration.
   */
  async continueWithFeedback(feedback: string): Promise<void> {
    if (!this.workflow) {
      this.log('Cannot continue with feedback: no workflow');
      return;
    }

    this.state = 'running';
    this.emit('state:changed', { workflowState: 'coding' });

    try {
      await this.workflow.continueWithFeedback(this.sessionId, feedback);
      this.state = 'completed';
      this.emit('session:ended', this.sessionId, this.workflow.getState());
    } catch (error) {
      this.state = 'error';
      this.emit('error', error);
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Serialization for session persistence
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Serializable session state.
   */
  serialize(): SerializedCCASession {
    return {
      sessionId: this.sessionId,
      state: this.state,
      workflowState: this.workflow?.getState() || null,
      feedEntries: this.feed.getEntries(),
      config: {
        coderAgentId: this.config.coderAgent.id,
        coderAgentRole: this.config.coderAgent.role,
        coderModel: this.config.coderAgent.model,
        maxIterations: this.config.maxIterations,
        critics: this.config.critics || DEFAULT_CRITICS,
      },
      timestamp: Date.now(),
    };
  }

  /**
   * Check if session can be resumed.
   */
  canResume(): boolean {
    return this.state === 'paused' || this.state === 'idle';
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    this.toolExecutor.abortAll();
    this.feed.clear();
    this.workflow = null;

    this.log('Session disposed');
  }
}

/**
 * Serialized CCA session for persistence.
 */
export interface SerializedCCASession {
  sessionId: string;
  state: 'idle' | 'running' | 'paused' | 'completed' | 'error';
  workflowState: CCASessionState | null;
  feedEntries: FeedEntry[];
  config: {
    coderAgentId: string;
    coderAgentRole: string;
    coderModel: string;
    maxIterations?: number;
    critics?: CriticConfig[];
  };
  timestamp: number;
}

/**
 * Create a CCA session.
 */
export function createCCASession(config: CCASessionConfig): CCASession {
  return new CCASession(config);
}

/**
 * Restored session data from storage.
 */
export interface RestoredSessionData {
  sessionId: string;
  task: string;
  feedEntries: FeedEntry[];
  iterationCount: number;
  lastIterationNumber: number;
  status: 'idle' | 'running' | 'paused' | 'completed' | 'error';
  coderAgent: string;
  coderModel: string;
}

/**
 * Check if there's a resumable session for a workspace.
 */
export async function getResumableSession(workspacePath: string): Promise<RestoredSessionData | null> {
  // Dynamic import to avoid circular dependency
  const { getCCAStorage } = await import('./storage.ts');
  const storage = await getCCAStorage();

  const session = storage.getResumableSession(workspacePath);
  if (!session) return null;

  const iterations = storage.getIterations(session.id);
  const feedEntries = storage.getFeedEntries(session.id);

  // Convert stored feed entries to FeedEntry format
  const convertedFeedEntries: FeedEntry[] = feedEntries.map(entry => ({
    id: entry.id,
    type: entry.entryType as FeedEntry['type'],
    source: entry.source as FeedEntry['source'],
    content: entry.content as FeedEntry['content'],
    timestamp: entry.createdAt,
  }));

  return {
    sessionId: session.id,
    task: session.task,
    feedEntries: convertedFeedEntries,
    iterationCount: iterations.length,
    lastIterationNumber: iterations.length > 0 ? iterations[iterations.length - 1]!.iterationNumber : 0,
    status: session.status,
    coderAgent: session.coderAgent,
    coderModel: session.coderModel,
  };
}

/**
 * Get recent sessions for a workspace.
 */
export async function getRecentSessions(workspacePath: string, limit: number = 10): Promise<Array<{
  id: string;
  task: string;
  status: string;
  coderModel: string;
  iterationCount: number;
  createdAt: number;
  updatedAt: number;
}>> {
  const { getCCAStorage } = await import('./storage.ts');
  const storage = await getCCAStorage();

  return storage.getRecentSessions(workspacePath, limit);
}

/**
 * Get context for a new task based on past sessions.
 */
export async function getTaskContext(taskDescription: string): Promise<{
  similarTasks: Array<{
    task: string;
    outcome: string;
    keyLearnings: string[];
  }>;
  relevantPatterns: Array<{
    pattern: string;
    frequency: number;
  }>;
}> {
  const { getCCAStorage } = await import('./storage.ts');
  const storage = await getCCAStorage();

  const contextSessions = storage.getContextForTask(taskDescription, 5);

  const similarTasks = contextSessions.map(ctx => {
    // Extract key learnings from reviews and decisions
    const keyLearnings: string[] = [];

    for (const review of ctx.relevantReviews.slice(0, 3)) {
      if (review.verdict === 'reject' || review.verdict === 'concerns') {
        keyLearnings.push(review.message);
      }
    }

    for (const decision of ctx.keyDecisions) {
      if (decision.feedback) {
        keyLearnings.push(`Arbiter: ${decision.feedback}`);
      }
    }

    return {
      task: ctx.session.task,
      outcome: ctx.session.status,
      keyLearnings: keyLearnings.slice(0, 5),
    };
  });

  // Find common patterns in rejected reviews
  const reviewPatterns = storage.findReviewPatterns({ verdict: 'reject', limit: 50 });
  const patternCounts = new Map<string, number>();

  for (const { review } of reviewPatterns) {
    // Extract key phrases from rejection messages
    const words = review.message.toLowerCase().split(/\s+/);
    for (let i = 0; i < words.length - 1; i++) {
      const phrase = `${words[i]} ${words[i + 1]}`;
      patternCounts.set(phrase, (patternCounts.get(phrase) || 0) + 1);
    }
  }

  // Get top patterns
  const relevantPatterns = [...patternCounts.entries()]
    .filter(([_, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([pattern, frequency]) => ({ pattern, frequency }));

  return { similarTasks, relevantPatterns };
}

/**
 * Get file history for context.
 */
export async function getFileHistory(filePath: string, limit: number = 10): Promise<Array<{
  sessionTask: string;
  changeType: string;
  reviewVerdict: string;
  arbiterDecision?: string;
  timestamp: number;
}>> {
  const { getCCAStorage } = await import('./storage.ts');
  const storage = await getCCAStorage();

  const history = storage.findFileHistory(filePath, limit);

  return history.map(h => ({
    sessionTask: h.task,
    changeType: h.change.operation,
    reviewVerdict: h.reviews.length > 0
      ? h.reviews.map(r => r.verdict).join(', ')
      : 'no review',
    arbiterDecision: h.decision?.decisionType,
    timestamp: h.timestamp,
  }));
}
