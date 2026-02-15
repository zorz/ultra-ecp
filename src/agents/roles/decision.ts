/**
 * Decision Role Hierarchy
 *
 * Roles that make choices, aggregate inputs, and produce decisions.
 *
 * Inheritance:
 *   DecisionRole (abstract)
 *   ├── AggregatorRole (combines multiple inputs)
 *   ├── RouterRole (routes to appropriate paths)
 *   └── GatekeeperRole (approve/reject decisions)
 */

import type {
  RoleMetadata,
  RoleConfig,
  ExecutionContext,
  ExecutionResult,
} from './base.ts';
import { BaseRole, roleRegistry } from './base.ts';
import type { AgentCapabilities } from '../capabilities/index.ts';
import { createCapabilities } from '../capabilities/index.ts';
import type { AgentPersistentState } from '../state/index.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Decision Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Confidence level for a decision.
 */
export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'uncertain';

/**
 * A single choice/option considered.
 */
export interface DecisionOption {
  /** Option identifier */
  id: string;
  /** Human-readable label */
  label: string;
  /** Why this option was considered */
  rationale?: string;
  /** Score/weight (0-1) */
  score: number;
  /** Pros of this option */
  pros?: string[];
  /** Cons of this option */
  cons?: string[];
  /** Associated data */
  data?: Record<string, unknown>;
}

/**
 * The decision made by the agent.
 */
export interface Decision {
  /** Unique decision ID */
  id: string;
  /** When the decision was made */
  timestamp: Date;
  /** What was decided */
  decision: string;
  /** Confidence in the decision */
  confidence: ConfidenceLevel;
  /** Confidence score (0-1) */
  confidenceScore: number;
  /** Options that were considered */
  options: DecisionOption[];
  /** The selected option (if from options) */
  selectedOption?: DecisionOption;
  /** Reasoning behind the decision */
  reasoning: string;
  /** Factors that influenced the decision */
  factors?: string[];
  /** Dissenting opinions or concerns */
  concerns?: string[];
  /** Whether the decision requires confirmation */
  requiresConfirmation: boolean;
  /** Metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Result of a decision process.
 */
export interface DecisionResult {
  /** The decision made */
  decision: Decision;
  /** Recommended actions based on the decision */
  recommendedActions?: string[];
  /** Alternative decisions if this one fails */
  fallbackDecisions?: Decision[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Confidence Calculation
// ─────────────────────────────────────────────────────────────────────────────

const CONFIDENCE_THRESHOLDS = {
  high: 0.85,
  medium: 0.65,
  low: 0.45,
};

function scoreToConfidenceLevel(score: number): ConfidenceLevel {
  if (score >= CONFIDENCE_THRESHOLDS.high) return 'high';
  if (score >= CONFIDENCE_THRESHOLDS.medium) return 'medium';
  if (score >= CONFIDENCE_THRESHOLDS.low) return 'low';
  return 'uncertain';
}

// ─────────────────────────────────────────────────────────────────────────────
// Decision Role (Abstract)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Abstract base for all decision-making roles.
 * Provides common decision infrastructure.
 */
export abstract class DecisionRole extends BaseRole {
  /** Minimum confidence required to make a decision */
  protected minConfidence: number = 0.5;

  /** Whether to require confirmation for low confidence decisions */
  protected requireConfirmationBelowConfidence: number = 0.65;

  /** Decision counter for IDs */
  private decisionCounter = 0;

  constructor(
    agentId: string,
    config?: RoleConfig & {
      minConfidence?: number;
      requireConfirmationBelowConfidence?: number;
    },
    existingState?: AgentPersistentState
  ) {
    super(agentId, config, existingState);
    if (config?.minConfidence !== undefined) {
      this.minConfidence = config.minConfidence;
    }
    if (config?.requireConfirmationBelowConfidence !== undefined) {
      this.requireConfirmationBelowConfidence =
        config.requireConfirmationBelowConfidence;
    }
  }

  override getMetadata(): RoleMetadata {
    return {
      roleType: 'decision',
      displayName: 'Decision Agent',
      description: 'Base decision-making role',
      category: 'decision',
      version: '1.0.0',
    };
  }

  override getDefaultCapabilities(): AgentCapabilities {
    return createCapabilities({
      communication: {
        canDirectMessage: true,
        canBroadcast: false,
        canReadSharedMemory: true,
        canWriteSharedMemory: true,
        canSpawnAgents: false,
        canModifyWorkflows: false,
      },
      resources: {
        maxTokensPerTurn: 4096,
        maxTotalTokens: 32000,
        maxExecutionTime: 120000, // 2 minutes for complex decisions
        maxConcurrentTools: 3,
      },
    });
  }

  override getSystemPrompt(): string {
    return `You are a decision-making agent responsible for analyzing options and making choices.

Your responsibilities:
- Analyze all available options thoroughly
- Weigh pros and cons objectively
- Consider risks and uncertainties
- Make clear, justified decisions
- Express confidence levels honestly
- Document reasoning clearly

Decision principles:
- Be decisive but not hasty
- Consider both short and long-term impacts
- Acknowledge when confidence is low
- Suggest alternatives when appropriate

Always explain your reasoning process.`;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Decision Helpers
  // ───────────────────────────────────────────────────────────────────────────

  /** Create a decision */
  protected createDecision(
    decision: string,
    reasoning: string,
    options: DecisionOption[],
    selectedOption?: DecisionOption,
    confidenceScore?: number
  ): Decision {
    // Calculate confidence score if not provided
    const score =
      confidenceScore ??
      (selectedOption
        ? this.calculateConfidenceFromOptions(options, selectedOption)
        : 0.5);

    return {
      id: `dec_${this.agentId}_${++this.decisionCounter}`,
      timestamp: new Date(),
      decision,
      confidence: scoreToConfidenceLevel(score),
      confidenceScore: score,
      options,
      selectedOption,
      reasoning,
      requiresConfirmation: score < this.requireConfirmationBelowConfidence,
    };
  }

  /** Create an option */
  protected createOption(
    id: string,
    label: string,
    score: number,
    details?: Partial<Omit<DecisionOption, 'id' | 'label' | 'score'>>
  ): DecisionOption {
    return {
      id,
      label,
      score: Math.max(0, Math.min(1, score)), // Clamp to 0-1
      ...details,
    };
  }

  /** Calculate confidence based on option scores */
  protected calculateConfidenceFromOptions(
    options: DecisionOption[],
    selected: DecisionOption
  ): number {
    if (options.length === 0) return 0.5;
    if (options.length === 1) return selected.score;

    // Confidence is based on:
    // 1. Selected option's score
    // 2. Gap between selected and next best option
    const sortedScores = options.map((o) => o.score).sort((a, b) => b - a);
    const firstScore = sortedScores[0] ?? 0;
    const secondScore = sortedScores[1] ?? 0;
    const gap = sortedScores.length > 1 ? firstScore - secondScore : 0;

    // Combine selected score with gap
    return selected.score * 0.7 + gap * 0.3;
  }

  /** Select the best option from a list */
  protected selectBestOption(options: DecisionOption[]): DecisionOption | undefined {
    if (options.length === 0) return undefined;
    return options.reduce((best, current) =>
      current.score > best.score ? current : best
    );
  }

  /** Check if decision meets minimum confidence */
  protected meetsMinConfidence(decision: Decision): boolean {
    return decision.confidenceScore >= this.minConfidence;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Abstract Methods
  // ───────────────────────────────────────────────────────────────────────────

  /** Make a decision based on context */
  abstract decide(context: ExecutionContext): Promise<DecisionResult>;

  override async execute(context: ExecutionContext): Promise<ExecutionResult> {
    try {
      this.setStatus('executing', 'Deciding...');

      const result = await this.decide(context);

      // Check confidence
      if (!this.meetsMinConfidence(result.decision)) {
        return {
          success: false,
          error: `Decision confidence (${result.decision.confidenceScore}) below minimum (${this.minConfidence})`,
          output: result,
        };
      }

      // Store decision in memory
      this.addMemory({
        type: 'decision',
        content: `Decision: ${result.decision.decision}`,
        metadata: {
          decisionId: result.decision.id,
          confidence: result.decision.confidence,
          confidenceScore: result.decision.confidenceScore,
          optionCount: result.decision.options.length,
        },
      });

      return {
        success: true,
        output: result,
        outputs: {
          decision: result.decision,
          confidence: result.decision.confidence,
          requiresConfirmation: result.decision.requiresConfirmation,
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
// Aggregator Role
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Role for aggregating multiple inputs into a unified decision.
 */
export class AggregatorRole extends DecisionRole {
  /** Aggregation strategy */
  protected strategy: 'majority' | 'weighted' | 'unanimous' | 'consensus' =
    'weighted';

  /** Weights for different input sources */
  protected sourceWeights: Record<string, number> = {};

  constructor(
    agentId: string,
    config?: RoleConfig & {
      strategy?: AggregatorRole['strategy'];
      sourceWeights?: Record<string, number>;
    },
    existingState?: AgentPersistentState
  ) {
    super(agentId, config, existingState);
    if (config?.strategy) {
      this.strategy = config.strategy;
    }
    if (config?.sourceWeights) {
      this.sourceWeights = config.sourceWeights;
    }
  }

  override getMetadata(): RoleMetadata {
    return {
      roleType: 'aggregator',
      displayName: 'Aggregator',
      description: 'Aggregates multiple inputs into unified decisions',
      category: 'decision',
      parentRole: 'decision',
      version: '1.0.0',
      tags: ['aggregation', 'consolidation', 'voting'],
    };
  }

  override getSystemPrompt(): string {
    return `You are an aggregator agent that combines multiple inputs into a unified decision.

Aggregation strategy: ${this.strategy}

Your responsibilities:
- Collect and weigh all inputs
- Identify consensus and disagreements
- Apply appropriate aggregation strategy
- Produce a clear, unified decision
- Document dissenting views

Strategies:
- MAJORITY: Go with what most inputs support
- WEIGHTED: Apply source weights to votes
- UNANIMOUS: Require all inputs to agree
- CONSENSUS: Find common ground among inputs`;
  }

  /** Aggregate votes using the configured strategy */
  protected aggregate(
    votes: { source: string; vote: string; confidence: number }[]
  ): { decision: string; confidenceScore: number; unanimous: boolean } {
    if (votes.length === 0) {
      return { decision: 'no_decision', confidenceScore: 0, unanimous: true };
    }

    // Count votes per option with weights
    const voteCounts = new Map<string, number>();
    const voteConfidences = new Map<string, number[]>();

    for (const { source, vote, confidence } of votes) {
      const weight = this.sourceWeights[source] ?? 1;
      const current = voteCounts.get(vote) ?? 0;
      voteCounts.set(vote, current + weight);

      if (!voteConfidences.has(vote)) {
        voteConfidences.set(vote, []);
      }
      voteConfidences.get(vote)!.push(confidence);
    }

    // Find winner
    let maxVotes = 0;
    let winner = '';
    for (const [option, count] of voteCounts.entries()) {
      if (count > maxVotes) {
        maxVotes = count;
        winner = option;
      }
    }

    // Calculate confidence
    const totalVotes = Array.from(voteCounts.values()).reduce((a, b) => a + b, 0);
    const voteShare = maxVotes / totalVotes;
    const avgConfidence =
      (voteConfidences.get(winner) ?? []).reduce((a, b) => a + b, 0) /
      (voteConfidences.get(winner)?.length ?? 1);

    const confidenceScore = voteShare * 0.5 + avgConfidence * 0.5;

    // Check unanimity
    const unanimous = voteCounts.size === 1;

    return { decision: winner, confidenceScore, unanimous };
  }

  override async decide(context: ExecutionContext): Promise<DecisionResult> {
    const inputs = context.input['inputs'] as
      | { source: string; vote: string; confidence: number }[]
      | undefined;

    if (!inputs || inputs.length === 0) {
      const decision = this.createDecision(
        'no_decision',
        'No inputs provided for aggregation',
        [],
        undefined,
        0
      );
      return { decision };
    }

    // Aggregate
    const aggregated = this.aggregate(inputs);

    // Build options from unique votes
    const uniqueVotes = [...new Set(inputs.map((i) => i.vote))];
    const options = uniqueVotes.map((vote) => {
      const voteInputs = inputs.filter((i) => i.vote === vote);
      const avgConf =
        voteInputs.reduce((sum, i) => sum + i.confidence, 0) / voteInputs.length;
      return this.createOption(vote, vote, avgConf, {
        rationale: `${voteInputs.length} votes from: ${voteInputs.map((i) => i.source).join(', ')}`,
      });
    });

    const selectedOption = options.find((o) => o.id === aggregated.decision);

    const decision = this.createDecision(
      aggregated.decision,
      `Aggregated ${inputs.length} inputs using ${this.strategy} strategy. ` +
        (aggregated.unanimous ? 'Decision was unanimous.' : `Vote share: ${(aggregated.confidenceScore * 100).toFixed(1)}%`),
      options,
      selectedOption,
      aggregated.confidenceScore
    );

    decision.factors = [
      `Strategy: ${this.strategy}`,
      `Total inputs: ${inputs.length}`,
      `Unanimous: ${aggregated.unanimous}`,
    ];

    return { decision };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Router Role
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Role for routing to appropriate paths/handlers.
 */
export class RouterRole extends DecisionRole {
  /** Available routes */
  protected routes: { id: string; label: string; condition?: string }[] = [];

  /** Default route if no match */
  protected defaultRoute?: string;

  constructor(
    agentId: string,
    config?: RoleConfig & {
      routes?: RouterRole['routes'];
      defaultRoute?: string;
      minConfidence?: number;
      requireConfirmationBelowConfidence?: number;
    },
    existingState?: AgentPersistentState
  ) {
    super(agentId, config, existingState);
    if (config?.routes) {
      this.routes = config.routes;
    }
    if (config?.defaultRoute) {
      this.defaultRoute = config.defaultRoute;
    }
  }

  override getMetadata(): RoleMetadata {
    return {
      roleType: 'router',
      displayName: 'Router',
      description: 'Routes to appropriate paths based on input',
      category: 'decision',
      parentRole: 'decision',
      version: '1.0.0',
      tags: ['routing', 'dispatch', 'branching'],
    };
  }

  override getSystemPrompt(): string {
    const routeList =
      this.routes.length > 0
        ? `\nAvailable routes:\n${this.routes.map((r) => `- ${r.id}: ${r.label}${r.condition ? ` (${r.condition})` : ''}`).join('\n')}`
        : '';

    return `You are a router agent that directs inputs to appropriate handlers.
${routeList}

Your responsibilities:
- Analyze the input thoroughly
- Match against route conditions
- Select the most appropriate route
- Explain your routing decision

Be decisive and route clearly.`;
  }

  override async decide(context: ExecutionContext): Promise<DecisionResult> {
    const input = context.input['input'] as string | Record<string, unknown> | undefined;

    if (!input) {
      const decision = this.createDecision(
        this.defaultRoute ?? 'unknown',
        'No input provided, using default route',
        [],
        undefined,
        this.defaultRoute ? 0.5 : 0
      );
      return { decision };
    }

    // Build options from routes
    const options = this.routes.map((route) => {
      // Placeholder scoring - actual implementation would evaluate conditions
      const score = route.condition ? 0.5 : 0.3;
      return this.createOption(route.id, route.label, score, {
        rationale: route.condition ?? 'Default route option',
      });
    });

    // Select best route
    const selected = this.selectBestOption(options);
    const routeId = selected?.id ?? this.defaultRoute ?? 'unknown';

    const decision = this.createDecision(
      routeId,
      `Routed to ${routeId} based on input analysis`,
      options,
      selected,
      selected?.score ?? 0.3
    );

    return { decision };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gatekeeper Role
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Role for approve/reject decisions.
 */
export class GatekeeperRole extends DecisionRole {
  /** Criteria for approval */
  protected approvalCriteria: string[] = [];

  /** Minimum score required for approval */
  protected approvalThreshold: number = 0.7;

  constructor(
    agentId: string,
    config?: RoleConfig & {
      approvalCriteria?: string[];
      approvalThreshold?: number;
    },
    existingState?: AgentPersistentState
  ) {
    super(agentId, config, existingState);
    if (config?.approvalCriteria) {
      this.approvalCriteria = config.approvalCriteria;
    }
    if (config?.approvalThreshold !== undefined) {
      this.approvalThreshold = config.approvalThreshold;
    }
  }

  override getMetadata(): RoleMetadata {
    return {
      roleType: 'gatekeeper',
      displayName: 'Gatekeeper',
      description: 'Makes approve/reject decisions',
      category: 'decision',
      parentRole: 'decision',
      version: '1.0.0',
      tags: ['approval', 'gate', 'access-control'],
    };
  }

  override getSystemPrompt(): string {
    const criteriaList =
      this.approvalCriteria.length > 0
        ? `\nApproval criteria:\n${this.approvalCriteria.map((c) => `- ${c}`).join('\n')}`
        : '';

    return `You are a gatekeeper agent responsible for approve/reject decisions.
${criteriaList}

Approval threshold: ${(this.approvalThreshold * 100).toFixed(0)}%

Your responsibilities:
- Evaluate submissions against criteria
- Make clear approve/reject decisions
- Provide detailed feedback
- Suggest improvements for rejections

Be fair and consistent. Document reasoning clearly.`;
  }

  override async decide(context: ExecutionContext): Promise<DecisionResult> {
    const submission = context.input['submission'] as
      | Record<string, unknown>
      | undefined;

    if (!submission) {
      const decision = this.createDecision(
        'reject',
        'No submission provided',
        [
          this.createOption('approve', 'Approve', 0),
          this.createOption('reject', 'Reject', 1),
        ],
        this.createOption('reject', 'Reject', 1),
        1
      );
      return { decision };
    }

    // Placeholder evaluation - actual implementation would evaluate against criteria
    const criteriaScores = this.approvalCriteria.map((criterion) => ({
      criterion,
      score: Math.random(), // Placeholder
      passed: Math.random() > 0.3,
    }));

    const avgScore =
      criteriaScores.length > 0
        ? criteriaScores.reduce((sum, c) => sum + c.score, 0) /
          criteriaScores.length
        : 0.5;

    const shouldApprove = avgScore >= this.approvalThreshold;

    const approveOption = this.createOption('approve', 'Approve', avgScore, {
      pros: criteriaScores.filter((c) => c.passed).map((c) => c.criterion),
    });

    const rejectOption = this.createOption('reject', 'Reject', 1 - avgScore, {
      cons: criteriaScores.filter((c) => !c.passed).map((c) => c.criterion),
    });

    const options = [approveOption, rejectOption];
    const selected = shouldApprove ? approveOption : rejectOption;

    const decision = this.createDecision(
      shouldApprove ? 'approve' : 'reject',
      `${shouldApprove ? 'Approved' : 'Rejected'} with score ${(avgScore * 100).toFixed(1)}% (threshold: ${(this.approvalThreshold * 100).toFixed(0)}%)`,
      options,
      selected,
      Math.abs(avgScore - 0.5) + 0.5 // Higher confidence when further from threshold
    );

    decision.factors = criteriaScores.map(
      (c) => `${c.criterion}: ${c.passed ? 'PASS' : 'FAIL'} (${(c.score * 100).toFixed(0)}%)`
    );

    return {
      decision,
      recommendedActions: shouldApprove
        ? ['Proceed with approved submission']
        : criteriaScores
            .filter((c) => !c.passed)
            .map((c) => `Address: ${c.criterion}`),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Register Role Types
// ─────────────────────────────────────────────────────────────────────────────

const registerDecisionRoles = () => {
  roleRegistry.register(
    new AggregatorRole('_template_').getMetadata(),
    (id, config, state) => new AggregatorRole(id, config, state)
  );

  roleRegistry.register(
    new RouterRole('_template_').getMetadata(),
    (id, config, state) => new RouterRole(id, config, state)
  );

  roleRegistry.register(
    new GatekeeperRole('_template_').getMetadata(),
    (id, config, state) => new GatekeeperRole(id, config, state)
  );
};

// Auto-register on module load
registerDecisionRoles();

export { registerDecisionRoles };
