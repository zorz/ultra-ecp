/**
 * Ensemble Orchestrator
 *
 * Central coordinator for multi-agent sessions.
 * Manages agents, workflow execution, and human interaction.
 */

import type {
  FrameworkDefinition,
  EnsembleSession,
  EnsembleSessionState,
  AgentStatus,
  PendingDecision,
  WorkflowStep,
  EnsembleEvent,
  EnsembleEventCallback,
  Unsubscribe,
} from './types.ts';
import {
  generateEnsembleSessionId,
  generateDecisionId,
  DEFAULT_FRAMEWORK_SETTINGS,
  DEFAULT_HUMAN_ROLE,
} from './types.ts';
import { SharedFeed, createSharedFeed } from './shared-feed.ts';
import { AgentInstance, createAgentInstance } from './agent-instance.ts';
import type { ToolDefinition } from '../ai/types.ts';
import { ValidationPipeline, createValidationPipeline } from '../validation/pipeline.ts';
import { debugLog, isDebugEnabled } from '../../debug.ts';

/**
 * Options for creating an orchestrator.
 */
export interface OrchestratorOptions {
  /** Tool definitions available to agents */
  tools: ToolDefinition[];
  /** Custom validation pipeline (optional) */
  validationPipeline?: ValidationPipeline;
}

/**
 * Decision response from human.
 */
export interface DecisionResult {
  /** Decision ID */
  decisionId: string;
  /** Choice made */
  choice: 'approve' | 'reject' | 'defer' | string;
  /** Feedback or reason */
  feedback?: string;
}

/**
 * Orchestrator for multi-agent sessions.
 */
export class EnsembleOrchestrator {
  private framework: FrameworkDefinition;
  private agents: Map<string, AgentInstance> = new Map();
  private feed: SharedFeed;
  private validationPipeline: ValidationPipeline;
  private tools: ToolDefinition[];

  private session: EnsembleSession | null = null;
  private eventCallbacks: Set<EnsembleEventCallback> = new Set();
  private decisionResolvers: Map<string, (result: DecisionResult) => void> = new Map();

  constructor(framework: FrameworkDefinition, options: OrchestratorOptions) {
    this.framework = this.normalizeFramework(framework);
    this.tools = options.tools;
    this.feed = createSharedFeed();
    this.validationPipeline = options.validationPipeline ?? createValidationPipeline();

    // Initialize agents
    this.initializeAgents();
  }

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[EnsembleOrchestrator] ${msg}`);
    }
  }

  /**
   * Normalize framework with defaults.
   */
  private normalizeFramework(framework: FrameworkDefinition): FrameworkDefinition {
    return {
      ...framework,
      settings: {
        ...DEFAULT_FRAMEWORK_SETTINGS,
        ...framework.settings,
      },
      humanRole: {
        ...DEFAULT_HUMAN_ROLE,
        ...framework.humanRole,
      },
    };
  }

  /**
   * Initialize agent instances.
   */
  private initializeAgents(): void {
    for (const agentDef of this.framework.agents) {
      // Filter tools to what the agent has access to
      const agentTools = this.tools.filter((t) =>
        agentDef.tools.includes(t.name.toLowerCase())
      );

      const agent = createAgentInstance({
        definition: agentDef,
        tools: agentTools,
        onStateChange: (state, activity) => {
          this.handleAgentStateChange(agentDef.id, state, activity);
        },
      });

      this.agents.set(agentDef.id, agent);
      this.log(`Initialized agent: ${agentDef.id} (${agentDef.role})`);
    }
  }

  /**
   * Handle agent state changes.
   */
  private handleAgentStateChange(
    agentId: string,
    state: AgentStatus['state'],
    activity?: string
  ): void {
    if (this.session) {
      const agentStatus = this.session.agents.find((a) => a.id === agentId);
      if (agentStatus) {
        agentStatus.state = state;
        agentStatus.currentActivity = activity;
        agentStatus.lastActivity = Date.now();
      }

      this.emitEvent({
        type: 'agent_state_changed',
        sessionId: this.session.id,
        data: { agentId, state, activity },
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Get the framework.
   */
  getFramework(): FrameworkDefinition {
    return this.framework;
  }

  /**
   * Get the shared feed.
   */
  getFeed(): SharedFeed {
    return this.feed;
  }

  /**
   * Get the validation pipeline.
   */
  getValidationPipeline(): ValidationPipeline {
    return this.validationPipeline;
  }

  /**
   * Get current session.
   */
  getSession(): EnsembleSession | null {
    return this.session;
  }

  /**
   * Get an agent by ID.
   */
  getAgent(agentId: string): AgentInstance | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Get all agents.
   */
  getAgents(): AgentInstance[] {
    return Array.from(this.agents.values());
  }

  /**
   * Start a new ensemble session.
   */
  async startSession(task: string): Promise<EnsembleSession> {
    this.log(`Starting session with task: ${task.substring(0, 50)}...`);

    // Create session
    const session: EnsembleSession = {
      id: generateEnsembleSessionId(),
      framework: this.framework,
      state: 'initializing',
      task,
      agents: Array.from(this.agents.values()).map((a) => a.getStatus()),
      pendingDecisions: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.session = session;

    // Post session start to feed
    this.feed.postSystem('session_start', {
      sessionId: session.id,
      task,
      framework: this.framework.id,
    });

    // Emit event
    this.emitEvent({
      type: 'session_created',
      sessionId: session.id,
      data: { task },
      timestamp: Date.now(),
    });

    // Update state to running
    this.updateSessionState('running');

    // Start the workflow
    await this.runWorkflow();

    return session;
  }

  /**
   * Run the workflow.
   */
  private async runWorkflow(): Promise<void> {
    if (!this.session) return;

    const workflow = this.framework.workflow;
    if (workflow.length === 0) {
      this.log('No workflow steps defined');
      this.updateSessionState('completed');
      return;
    }

    // Start with the first step
    await this.executeWorkflowStep(workflow[0]!);
  }

  /**
   * Execute a workflow step.
   */
  private async executeWorkflowStep(step: WorkflowStep): Promise<void> {
    if (!this.session) return;

    this.log(`Executing workflow step: ${step.step}`);
    this.session.currentStep = step.step;

    this.feed.postSystem('workflow_step', {
      step: step.step,
      action: step.action,
    });

    this.emitEvent({
      type: 'workflow_step_changed',
      sessionId: this.session.id,
      data: { step: step.step },
      timestamp: Date.now(),
    });

    // Check condition
    if (step.condition && step.condition !== 'always') {
      const conditionMet = this.evaluateCondition(step.condition);
      if (!conditionMet) {
        // Move to else step if defined
        if (step.else) {
          const elseStep = this.framework.workflow.find((s) => s.step === step.else);
          if (elseStep) {
            await this.executeWorkflowStep(elseStep);
          }
        }
        return;
      }
    }

    // Execute action
    switch (step.action) {
      case 'respond-to-task':
        if (step.agent) {
          await this.executeAgentResponse(step.agent);
        }
        break;

      case 'validate':
        if (step.validators) {
          await this.executeValidation(step.validators);
        }
        break;

      case 'prompt-arbiter':
        await this.promptHuman();
        break;

      case 'apply-changes':
        await this.applyChanges();
        break;

      case 'iterate':
        // Go back to the first step
        if (this.framework.workflow.length > 0) {
          await this.executeWorkflowStep(this.framework.workflow[0]!);
        }
        return;

      default:
        this.log(`Unknown action: ${step.action}`);
    }

    // Move to next step if defined
    if (step.next) {
      const nextStep = this.framework.workflow.find((s) => s.step === step.next);
      if (nextStep) {
        await this.executeWorkflowStep(nextStep);
      }
    } else {
      // Find next step in sequence
      const currentIndex = this.framework.workflow.findIndex((s) => s.step === step.step);
      if (currentIndex >= 0 && currentIndex < this.framework.workflow.length - 1) {
        await this.executeWorkflowStep(this.framework.workflow[currentIndex + 1]!);
      } else {
        // End of workflow
        this.updateSessionState('completed');
      }
    }
  }

  /**
   * Evaluate a workflow condition.
   */
  private evaluateCondition(condition: string): boolean {
    if (!this.session) return false;

    switch (condition) {
      case 'no-consensus':
        // Check if there are pending decisions
        return this.session.pendingDecisions.length > 0;

      case 'blocking-rejection':
        // Check feed for blocking rejections
        const recentValidation = this.feed.getEntries({
          types: ['validation'],
          limit: 1,
        })[0];
        if (recentValidation && recentValidation.type === 'validation') {
          const content = recentValidation.content as { summary?: { overallStatus?: string } };
          return content.summary?.overallStatus === 'blocked';
        }
        return false;

      case 'approved':
        const approvalEntry = this.feed.getEntries({
          types: ['decision'],
          limit: 1,
        })[0];
        if (approvalEntry && approvalEntry.type === 'decision') {
          const content = approvalEntry.content as { type?: string };
          return content.type === 'approve';
        }
        return false;

      case 'rejected':
        const rejectionEntry = this.feed.getEntries({
          types: ['decision'],
          limit: 1,
        })[0];
        if (rejectionEntry && rejectionEntry.type === 'decision') {
          const content = rejectionEntry.content as { type?: string };
          return content.type === 'reject';
        }
        return false;

      default:
        return true;
    }
  }

  /**
   * Execute an agent response.
   */
  private async executeAgentResponse(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      this.log(`Agent not found: ${agentId}`);
      return;
    }

    if (!this.session) return;

    // Get the task from the session
    const task = this.session.task;

    // Send task to agent
    const response = await agent.send(task);

    // Post response to feed
    this.feed.postMessage(
      response.message.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('\n'),
      'agent',
      { sourceId: agentId }
    );

    // Handle tool calls
    for (const toolCall of response.toolCalls) {
      const result = await agent.executeToolCall(toolCall);

      this.feed.postAction('tool_use', 'agent', {
        sourceId: agentId,
        toolName: toolCall.name,
        toolInput: toolCall.input,
        toolResult: result.result,
      });
    }
  }

  /**
   * Execute validation.
   */
  private async executeValidation(_validatorIds: string[]): Promise<void> {
    // This is a placeholder - actual implementation would run validators
    this.log('Running validation (placeholder)');

    // Post a placeholder validation result
    this.feed.post({
      type: 'validation',
      source: 'validator',
      content: {
        summary: {
          overallStatus: 'approved',
          results: [],
          requiresHumanDecision: false,
          consensusReached: true,
          warnings: [],
          errors: [],
        },
        trigger: 'on-demand',
      },
    });
  }

  /**
   * Prompt human for a decision.
   */
  private async promptHuman(): Promise<void> {
    if (!this.session) return;

    this.updateSessionState('waiting_human');

    const decision: PendingDecision = {
      id: generateDecisionId(),
      type: 'approve',
      prompt: 'Please review the proposed changes and approve or reject.',
      createdAt: Date.now(),
    };

    this.session.pendingDecisions.push(decision);

    this.emitEvent({
      type: 'decision_requested',
      sessionId: this.session.id,
      data: { decision },
      timestamp: Date.now(),
    });

    // Wait for decision
    await new Promise<DecisionResult>((resolve) => {
      this.decisionResolvers.set(decision.id, resolve);
    });

    // Remove from pending
    this.session.pendingDecisions = this.session.pendingDecisions.filter(
      (d) => d.id !== decision.id
    );

    this.updateSessionState('running');
  }

  /**
   * Apply pending changes.
   */
  private async applyChanges(): Promise<void> {
    // This is a placeholder - actual implementation would apply file changes
    this.log('Applying changes (placeholder)');

    // Update change entries in feed
    const changeEntries = this.feed.getEntries({ types: ['change'] });
    for (const entry of changeEntries) {
      if (entry.type === 'change') {
        const content = entry.content as { status?: string };
        if (content.status === 'proposed') {
          content.status = 'applied';
        }
      }
    }
  }

  /**
   * Human interjection.
   */
  async humanInterject(message: string): Promise<void> {
    if (!this.session) {
      throw new Error('No active session');
    }

    this.log(`Human interjection: ${message.substring(0, 50)}...`);

    // Post to feed
    this.feed.postMessage(message, 'human');

    // If there's a pending decision, treat this as feedback
    if (this.session.pendingDecisions.length > 0) {
      const latestDecision = this.session.pendingDecisions[this.session.pendingDecisions.length - 1];
      if (latestDecision) {
        await this.humanDecide({
          decisionId: latestDecision.id,
          choice: 'defer',
          feedback: message,
        });
      }
    }
  }

  /**
   * Human decision.
   */
  async humanDecide(result: DecisionResult): Promise<void> {
    if (!this.session) {
      throw new Error('No active session');
    }

    this.log(`Human decision: ${result.choice}`);

    // Post decision to feed
    this.feed.post({
      type: 'decision',
      source: 'human',
      content: {
        type: result.choice as 'approve' | 'reject' | 'defer' | 'redirect',
        reason: result.feedback,
        targetId: result.decisionId,
      },
    });

    this.emitEvent({
      type: 'decision_made',
      sessionId: this.session.id,
      data: result,
      timestamp: Date.now(),
    });

    // Resolve the decision promise
    const resolver = this.decisionResolvers.get(result.decisionId);
    if (resolver) {
      resolver(result);
      this.decisionResolvers.delete(result.decisionId);
    }
  }

  /**
   * Interrupt the current session.
   */
  async interrupt(): Promise<void> {
    if (!this.session) return;

    this.log('Session interrupted');

    this.feed.postAction('interrupt', 'human', {
      description: 'Session interrupted by user',
    });

    this.updateSessionState('paused');

    // Clear any pending decisions
    for (const decision of this.session.pendingDecisions) {
      const resolver = this.decisionResolvers.get(decision.id);
      if (resolver) {
        resolver({
          decisionId: decision.id,
          choice: 'defer',
          feedback: 'Session interrupted',
        });
      }
    }
    this.session.pendingDecisions = [];
  }

  /**
   * Resume a paused session.
   */
  async resume(): Promise<void> {
    if (!this.session || this.session.state !== 'paused') return;

    this.log('Session resumed');
    this.updateSessionState('running');

    // Resume workflow from current step
    if (this.session.currentStep) {
      const step = this.framework.workflow.find((s) => s.step === this.session!.currentStep);
      if (step) {
        await this.executeWorkflowStep(step);
      }
    }
  }

  /**
   * End the session.
   */
  async endSession(): Promise<void> {
    if (!this.session) return;

    this.log('Ending session');

    this.feed.postSystem('session_end', {
      sessionId: this.session.id,
    });

    this.updateSessionState('completed');

    this.emitEvent({
      type: 'session_ended',
      sessionId: this.session.id,
      timestamp: Date.now(),
    });
  }

  /**
   * Update session state.
   */
  private updateSessionState(state: EnsembleSessionState): void {
    if (this.session) {
      this.session.state = state;
      this.session.updatedAt = Date.now();

      this.emitEvent({
        type: 'session_updated',
        sessionId: this.session.id,
        data: { state },
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Subscribe to events.
   */
  onEvent(callback: EnsembleEventCallback): Unsubscribe {
    this.eventCallbacks.add(callback);
    return () => {
      this.eventCallbacks.delete(callback);
    };
  }

  /**
   * Emit an event.
   */
  private emitEvent(event: EnsembleEvent): void {
    for (const callback of this.eventCallbacks) {
      try {
        callback(event);
      } catch (error) {
        this.log(`Event callback error: ${error}`);
      }
    }
  }

  /**
   * Clean up resources.
   */
  cleanup(): void {
    this.agents.clear();
    this.feed.clear();
    this.decisionResolvers.clear();
    this.eventCallbacks.clear();
    this.session = null;
    this.log('Cleaned up');
  }
}

/**
 * Create a new ensemble orchestrator.
 */
export function createEnsembleOrchestrator(
  framework: FrameworkDefinition,
  options: OrchestratorOptions
): EnsembleOrchestrator {
  return new EnsembleOrchestrator(framework, options);
}
