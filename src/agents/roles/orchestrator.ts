/**
 * Orchestrator Role Hierarchy
 *
 * Meta-agents that coordinate other agents and manage workflows.
 * These are the highest-level agents that can spawn agents and modify workflows.
 *
 * Inheritance:
 *   OrchestratorRole (abstract)
 *   ├── CoordinatorRole (manages agent teams)
 *   ├── WorkflowOptimizerRole (improves workflows)
 *   └── SupervisorRole (oversees agent performance)
 */

import type {
  RoleMetadata,
  RoleConfig,
  ExecutionContext,
  ExecutionResult,
  AgentMessage,
} from './base.ts';
import { BaseRole, roleRegistry } from './base.ts';
import type { AgentCapabilities } from '../capabilities/index.ts';
import { createCapabilities } from '../capabilities/index.ts';
import type { AgentPersistentState } from '../state/index.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Orchestration Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Status of an orchestrated agent.
 */
export type OrchestrationStatus =
  | 'pending'
  | 'assigned'
  | 'working'
  | 'completed'
  | 'failed'
  | 'blocked';

/**
 * An agent being orchestrated.
 */
export interface OrchestratedAgent {
  /** Agent ID */
  agentId: string;
  /** Role type */
  roleType: string;
  /** Current status */
  status: OrchestrationStatus;
  /** Assigned task/work */
  assignment?: string;
  /** Dependencies (agent IDs that must complete first) */
  dependencies?: string[];
  /** Progress (0-100) */
  progress?: number;
  /** Last update */
  lastUpdate: Date;
}

/**
 * A workflow being managed.
 */
export interface ManagedWorkflow {
  /** Workflow ID */
  workflowId: string;
  /** Workflow name */
  name: string;
  /** Current phase */
  phase: string;
  /** Agents involved */
  agents: OrchestratedAgent[];
  /** Start time */
  startedAt: Date;
  /** Estimated completion */
  estimatedCompletion?: Date;
  /** Performance metrics */
  metrics?: Record<string, number>;
}

/**
 * Request to spawn a new agent.
 */
export interface SpawnAgentRequest {
  /** Role type to instantiate */
  roleType: string;
  /** Display name */
  name: string;
  /** Initial assignment */
  assignment?: string;
  /** Configuration */
  config?: RoleConfig;
  /** Dependencies */
  dependencies?: string[];
}

/**
 * Result of orchestration cycle.
 */
export interface OrchestrationResult {
  /** Summary of actions taken */
  summary: string;
  /** Agents spawned */
  spawnedAgents?: SpawnAgentRequest[];
  /** Task assignments made */
  assignments?: { agentId: string; task: string }[];
  /** Messages sent to agents */
  sentMessages?: AgentMessage[];
  /** Workflow modifications */
  workflowChanges?: { type: string; description: string }[];
  /** Recommendations for improvement */
  recommendations?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator Role (Abstract)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Abstract base for all orchestrator roles.
 * These are meta-agents with elevated capabilities.
 */
export abstract class OrchestratorRole extends BaseRole {
  /** Agents currently being orchestrated */
  protected orchestratedAgents = new Map<string, OrchestratedAgent>();

  /** Active workflows */
  protected activeWorkflows = new Map<string, ManagedWorkflow>();

  /** Maximum agents this orchestrator can manage */
  protected maxAgents: number = 10;

  /** Orchestration strategy */
  protected strategy: 'sequential' | 'parallel' | 'adaptive' = 'adaptive';

  constructor(
    agentId: string,
    config?: RoleConfig & {
      maxAgents?: number;
      strategy?: OrchestratorRole['strategy'];
    },
    existingState?: AgentPersistentState
  ) {
    super(agentId, config, existingState);
    if (config?.maxAgents !== undefined) {
      this.maxAgents = config.maxAgents;
    }
    if (config?.strategy) {
      this.strategy = config.strategy;
    }

    // Restore orchestrated agents from preferences
    const stored = existingState?.preferences?.['orchestratedAgents'] as
      | OrchestratedAgent[]
      | undefined;
    if (stored) {
      for (const agent of stored) {
        this.orchestratedAgents.set(agent.agentId, agent);
      }
    }
  }

  override getMetadata(): RoleMetadata {
    return {
      roleType: 'orchestrator',
      displayName: 'Orchestrator Agent',
      description: 'Base orchestrator role for coordinating agents',
      category: 'orchestrator',
      version: '1.0.0',
    };
  }

  override getDefaultCapabilities(): AgentCapabilities {
    return createCapabilities({
      communication: {
        canDirectMessage: true,
        canBroadcast: true, // Orchestrators can broadcast
        canReadSharedMemory: true,
        canWriteSharedMemory: true,
        canSpawnAgents: true, // Key capability
        canModifyWorkflows: true, // Key capability
      },
      resources: {
        maxTokensPerTurn: 8192,
        maxTotalTokens: 64000,
        maxExecutionTime: 300000, // 5 minutes for complex orchestration
        maxConcurrentTools: 10,
      },
    });
  }

  override getSystemPrompt(): string {
    return `You are an orchestrator agent responsible for coordinating other agents.

Your elevated capabilities:
- Spawn new agents of various roles
- Assign tasks to agents
- Modify workflow execution
- Monitor agent performance
- Optimize resource allocation

Orchestration strategy: ${this.strategy}
Max agents: ${this.maxAgents}

Principles:
- Delegate appropriately to specialized agents
- Balance workload across agents
- Monitor progress and intervene when needed
- Learn from outcomes to improve

You have meta-level control. Use it wisely.`;
  }

  override getPersistentState(): AgentPersistentState {
    const baseState = super.getPersistentState();
    return {
      ...baseState,
      preferences: {
        ...baseState.preferences,
        orchestratedAgents: Array.from(this.orchestratedAgents.values()),
      },
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Agent Management
  // ───────────────────────────────────────────────────────────────────────────

  /** Register an agent for orchestration */
  protected registerAgent(
    agentId: string,
    roleType: string,
    assignment?: string
  ): OrchestratedAgent {
    const agent: OrchestratedAgent = {
      agentId,
      roleType,
      status: assignment ? 'assigned' : 'pending',
      assignment,
      lastUpdate: new Date(),
    };
    this.orchestratedAgents.set(agentId, agent);
    return agent;
  }

  /** Update agent status */
  protected updateAgentStatus(
    agentId: string,
    status: OrchestrationStatus,
    progress?: number
  ): void {
    const agent = this.orchestratedAgents.get(agentId);
    if (agent) {
      agent.status = status;
      if (progress !== undefined) {
        agent.progress = progress;
      }
      agent.lastUpdate = new Date();
    }
  }

  /** Assign task to agent */
  protected assignTask(agentId: string, task: string): void {
    const agent = this.orchestratedAgents.get(agentId);
    if (agent) {
      agent.assignment = task;
      agent.status = 'assigned';
      agent.lastUpdate = new Date();
    }
  }

  /** Get agents by status */
  protected getAgentsByStatus(status: OrchestrationStatus): OrchestratedAgent[] {
    return Array.from(this.orchestratedAgents.values()).filter(
      (a) => a.status === status
    );
  }

  /** Get available agents (not blocked or failed) */
  protected getAvailableAgents(): OrchestratedAgent[] {
    return Array.from(this.orchestratedAgents.values()).filter(
      (a) => a.status !== 'blocked' && a.status !== 'failed'
    );
  }

  /** Check if agent can start (dependencies met) */
  protected canStart(agent: OrchestratedAgent): boolean {
    if (!agent.dependencies || agent.dependencies.length === 0) {
      return true;
    }

    return agent.dependencies.every((depId) => {
      const dep = this.orchestratedAgents.get(depId);
      return dep?.status === 'completed';
    });
  }

  /** Create spawn request */
  protected createSpawnRequest(
    roleType: string,
    name: string,
    assignment?: string,
    config?: RoleConfig,
    dependencies?: string[]
  ): SpawnAgentRequest {
    return {
      roleType,
      name,
      assignment,
      config,
      dependencies,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Workflow Management
  // ───────────────────────────────────────────────────────────────────────────

  /** Start managing a workflow */
  protected startWorkflow(workflowId: string, name: string): ManagedWorkflow {
    const workflow: ManagedWorkflow = {
      workflowId,
      name,
      phase: 'initializing',
      agents: [],
      startedAt: new Date(),
    };
    this.activeWorkflows.set(workflowId, workflow);
    return workflow;
  }

  /** Update workflow phase */
  protected updateWorkflowPhase(workflowId: string, phase: string): void {
    const workflow = this.activeWorkflows.get(workflowId);
    if (workflow) {
      workflow.phase = phase;
    }
  }

  /** Add agent to workflow */
  protected addAgentToWorkflow(workflowId: string, agentId: string): void {
    const workflow = this.activeWorkflows.get(workflowId);
    const agent = this.orchestratedAgents.get(agentId);
    if (workflow && agent) {
      workflow.agents.push(agent);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Abstract Methods
  // ───────────────────────────────────────────────────────────────────────────

  /** Perform orchestration cycle */
  abstract orchestrate(context: ExecutionContext): Promise<OrchestrationResult>;

  override async execute(context: ExecutionContext): Promise<ExecutionResult> {
    try {
      this.setStatus('executing', 'Orchestrating...');

      const result = await this.orchestrate(context);

      // Store orchestration decision
      this.addMemory({
        type: 'decision',
        content: `Orchestration: ${result.summary}`,
        metadata: {
          spawnedCount: result.spawnedAgents?.length ?? 0,
          assignmentsCount: result.assignments?.length ?? 0,
          changesCount: result.workflowChanges?.length ?? 0,
        },
      });

      // Build outgoing messages
      const outgoingMessages = result.sentMessages ?? [];

      // Add assignment messages
      if (result.assignments) {
        for (const { agentId, task } of result.assignments) {
          outgoingMessages.push(
            this.createMessage(agentId, 'request', `Assignment: ${task}`, {
              type: 'assignment',
              task,
            })
          );
        }
      }

      return {
        success: true,
        output: result,
        outputs: {
          summary: result.summary,
          spawnedAgents: result.spawnedAgents,
          assignments: result.assignments,
          recommendations: result.recommendations,
        },
        outgoingMessages,
        // Special output for workflow executor to handle
        sharedMemoryUpdates: {
          [`orchestrator:${this.agentId}:spawnRequests`]: result.spawnedAgents,
          [`orchestrator:${this.agentId}:workflowChanges`]: result.workflowChanges,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Coordinator Role
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Role for managing agent teams and task distribution.
 */
export class CoordinatorRole extends OrchestratorRole {
  /** Team size preference */
  protected preferredTeamSize: number = 3;

  constructor(
    agentId: string,
    config?: RoleConfig & {
      preferredTeamSize?: number;
    },
    existingState?: AgentPersistentState
  ) {
    super(agentId, config, existingState);
    if (config?.preferredTeamSize !== undefined) {
      this.preferredTeamSize = config.preferredTeamSize;
    }
  }

  override getMetadata(): RoleMetadata {
    return {
      roleType: 'coordinator',
      displayName: 'Coordinator',
      description: 'Coordinates agent teams and distributes tasks',
      category: 'orchestrator',
      parentRole: 'orchestrator',
      version: '1.0.0',
      tags: ['coordination', 'team', 'management'],
    };
  }

  override getSystemPrompt(): string {
    return `You are a coordinator agent responsible for managing agent teams.

Team size preference: ${this.preferredTeamSize}

Your responsibilities:
- Form effective agent teams
- Distribute tasks based on agent capabilities
- Monitor team progress
- Facilitate inter-agent communication
- Resolve conflicts and blockers

Team management principles:
- Match tasks to agent strengths
- Avoid overloading individual agents
- Ensure clear communication channels
- Track dependencies between tasks`;
  }

  override async orchestrate(
    context: ExecutionContext
  ): Promise<OrchestrationResult> {
    const task = context.input['task'] as string | undefined;
    const availableRoles = context.input['availableRoles'] as string[] | undefined;

    if (!task) {
      return {
        summary: 'No task provided for coordination',
      };
    }

    // Analyze task and determine team composition
    const spawnedAgents: SpawnAgentRequest[] = [];
    const assignments: { agentId: string; task: string }[] = [];

    // Placeholder team formation - actual implementation would analyze task
    const neededRoles = availableRoles?.slice(0, this.preferredTeamSize) ?? [
      'coder',
      'code-reviewer',
    ];

    for (const roleType of neededRoles) {
      spawnedAgents.push(
        this.createSpawnRequest(
          roleType,
          `${roleType}-for-${task.substring(0, 20)}`,
          `Contribute to: ${task}`
        )
      );
    }

    return {
      summary: `Coordinating team of ${neededRoles.length} agents for: ${task}`,
      spawnedAgents,
      assignments,
      recommendations: [
        'Monitor agent progress regularly',
        'Be ready to reassign if agents are blocked',
      ],
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow Optimizer Role
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Role for analyzing and improving workflows.
 */
export class WorkflowOptimizerRole extends OrchestratorRole {
  /** Optimization targets */
  protected optimizationTargets: ('speed' | 'quality' | 'cost' | 'reliability')[] = [
    'quality',
    'reliability',
  ];

  constructor(
    agentId: string,
    config?: RoleConfig & {
      optimizationTargets?: WorkflowOptimizerRole['optimizationTargets'];
    },
    existingState?: AgentPersistentState
  ) {
    super(agentId, config, existingState);
    if (config?.optimizationTargets) {
      this.optimizationTargets = config.optimizationTargets;
    }
  }

  override getMetadata(): RoleMetadata {
    return {
      roleType: 'workflow-optimizer',
      displayName: 'Workflow Optimizer',
      description: 'Analyzes and improves workflow efficiency',
      category: 'orchestrator',
      parentRole: 'orchestrator',
      version: '1.0.0',
      tags: ['optimization', 'workflow', 'improvement'],
    };
  }

  override getSystemPrompt(): string {
    return `You are a workflow optimizer agent that improves workflow efficiency.

Optimization targets: ${this.optimizationTargets.join(', ')}

Your responsibilities:
- Analyze workflow execution patterns
- Identify bottlenecks and inefficiencies
- Suggest structural improvements
- Test optimizations safely
- Track improvement metrics

Optimization principles:
- Measure before optimizing
- Make incremental changes
- Maintain workflow correctness
- Document all changes`;
  }

  override async orchestrate(
    context: ExecutionContext
  ): Promise<OrchestrationResult> {
    const workflowId = context.input['workflowId'] as string | undefined;
    const metrics = context.input['metrics'] as Record<string, number> | undefined;

    if (!workflowId) {
      return {
        summary: 'No workflow specified for optimization',
      };
    }

    // Placeholder optimization analysis
    const workflowChanges: { type: string; description: string }[] = [];
    const recommendations: string[] = [];

    // Analyze metrics and suggest improvements
    if (metrics) {
      const executionTime = metrics['executionTime'] ?? 0;
      const errorRate = metrics['errorRate'] ?? 0;
      const tokenUsage = metrics['tokenUsage'] ?? 0;

      if (this.optimizationTargets.includes('speed') && executionTime > 60000) {
        workflowChanges.push({
          type: 'parallelize',
          description: 'Consider parallelizing independent steps',
        });
      }

      if (this.optimizationTargets.includes('quality') && errorRate > 0.1) {
        recommendations.push('Add additional review steps');
      }

      if (this.optimizationTargets.includes('cost') && tokenUsage > 10000) {
        recommendations.push('Consider using smaller models for simple tasks');
      }
    }

    return {
      summary: `Analyzed workflow ${workflowId} for ${this.optimizationTargets.join(', ')} optimization`,
      workflowChanges,
      recommendations,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Supervisor Role
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Role for overseeing agent performance and quality.
 */
export class SupervisorRole extends OrchestratorRole {
  /** Performance thresholds */
  protected performanceThresholds = {
    minSuccessRate: 0.8,
    maxResponseTime: 30000,
    minQualityScore: 0.7,
  };

  constructor(
    agentId: string,
    config?: RoleConfig & {
      performanceThresholds?: Partial<SupervisorRole['performanceThresholds']>;
    },
    existingState?: AgentPersistentState
  ) {
    super(agentId, config, existingState);
    if (config?.performanceThresholds) {
      this.performanceThresholds = {
        ...this.performanceThresholds,
        ...config.performanceThresholds,
      };
    }
  }

  override getMetadata(): RoleMetadata {
    return {
      roleType: 'supervisor',
      displayName: 'Supervisor',
      description: 'Oversees agent performance and quality',
      category: 'orchestrator',
      parentRole: 'orchestrator',
      version: '1.0.0',
      tags: ['supervision', 'quality', 'performance'],
    };
  }

  override getSystemPrompt(): string {
    return `You are a supervisor agent that oversees agent performance.

Performance thresholds:
- Min success rate: ${(this.performanceThresholds.minSuccessRate * 100).toFixed(0)}%
- Max response time: ${this.performanceThresholds.maxResponseTime}ms
- Min quality score: ${(this.performanceThresholds.minQualityScore * 100).toFixed(0)}%

Your responsibilities:
- Monitor agent performance metrics
- Identify underperforming agents
- Provide feedback and corrections
- Escalate issues when needed
- Ensure quality standards

Supervision principles:
- Be fair and objective
- Focus on improvement, not punishment
- Recognize good performance
- Address issues promptly`;
  }

  override async orchestrate(
    context: ExecutionContext
  ): Promise<OrchestrationResult> {
    const agentMetrics = context.input['agentMetrics'] as
      | { agentId: string; successRate: number; avgResponseTime: number; qualityScore: number }[]
      | undefined;

    if (!agentMetrics || agentMetrics.length === 0) {
      return {
        summary: 'No agent metrics provided for supervision',
      };
    }

    const sentMessages: AgentMessage[] = [];
    const recommendations: string[] = [];

    for (const metrics of agentMetrics) {
      const issues: string[] = [];

      if (metrics.successRate < this.performanceThresholds.minSuccessRate) {
        issues.push(`Success rate (${(metrics.successRate * 100).toFixed(0)}%) below threshold`);
      }

      if (metrics.avgResponseTime > this.performanceThresholds.maxResponseTime) {
        issues.push(`Response time (${metrics.avgResponseTime}ms) above threshold`);
      }

      if (metrics.qualityScore < this.performanceThresholds.minQualityScore) {
        issues.push(`Quality score (${(metrics.qualityScore * 100).toFixed(0)}%) below threshold`);
      }

      if (issues.length > 0) {
        sentMessages.push(
          this.createMessage(
            metrics.agentId,
            'feedback',
            `Performance review: ${issues.join('. ')}`,
            {
              type: 'performance_feedback',
              issues,
              metrics,
            }
          )
        );
        recommendations.push(
          `Agent ${metrics.agentId} needs attention: ${issues[0]}`
        );
      }
    }

    return {
      summary: `Supervised ${agentMetrics.length} agents. ${sentMessages.length} need attention.`,
      sentMessages,
      recommendations,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Register Role Types
// ─────────────────────────────────────────────────────────────────────────────

const registerOrchestratorRoles = () => {
  roleRegistry.register(
    new CoordinatorRole('_template_').getMetadata(),
    (id, config, state) => new CoordinatorRole(id, config, state)
  );

  roleRegistry.register(
    new WorkflowOptimizerRole('_template_').getMetadata(),
    (id, config, state) => new WorkflowOptimizerRole(id, config, state)
  );

  roleRegistry.register(
    new SupervisorRole('_template_').getMetadata(),
    (id, config, state) => new SupervisorRole(id, config, state)
  );
};

// Auto-register on module load
registerOrchestratorRoles();

export { registerOrchestratorRoles };
