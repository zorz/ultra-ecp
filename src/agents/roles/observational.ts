/**
 * Observational Role Hierarchy
 *
 * Roles that monitor, watch, and report on activities.
 * Key feature: Configurable state persistence across workflow runs.
 *
 * Inheritance:
 *   ObservationalRole (abstract)
 *   ├── WatcherRole (monitors for specific events)
 *   ├── MonitorRole (continuous system monitoring)
 *   └── AuditorRole (tracks changes and compliance)
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
// Observation Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Severity of an observation/alert.
 */
export type ObservationSeverity = 'info' | 'warning' | 'alert' | 'critical';

/**
 * An observation made by the agent.
 */
export interface Observation {
  /** Unique observation ID */
  id: string;
  /** When observed */
  timestamp: Date;
  /** Observation type/category */
  category: string;
  /** Severity level */
  severity: ObservationSeverity;
  /** What was observed */
  description: string;
  /** Source of observation (file, system, etc.) */
  source?: string;
  /** Related data */
  data?: Record<string, unknown>;
  /** Whether this requires action */
  actionRequired: boolean;
  /** Suggested actions */
  suggestedActions?: string[];
}

/**
 * Configuration for observation persistence.
 */
export interface ObservationPersistenceConfig {
  /** Enable state persistence across workflow runs */
  enabled: boolean;
  /** Maximum observations to retain */
  maxObservations: number;
  /** How long to retain observations (ms, 0 = forever) */
  retentionPeriod: number;
  /** Persist only observations at or above this severity */
  minSeverityToPersist: ObservationSeverity;
  /** Group observations by category for deduplication */
  deduplicateByCategory: boolean;
  /** Deduplication window in ms */
  deduplicationWindow: number;
}

/**
 * Persistent state specific to observational roles.
 */
export interface ObserverState {
  /** Historical observations */
  observations: Observation[];
  /** Tracked metrics over time */
  metrics: Record<string, { timestamp: Date; value: number }[]>;
  /** Alert thresholds */
  thresholds: Record<string, number>;
  /** Suppressed alerts (to prevent spam) */
  suppressedAlerts: Map<string, Date>;
}

/**
 * Result of an observation cycle.
 */
export interface ObservationResult {
  /** New observations made */
  observations: Observation[];
  /** Summary of what was observed */
  summary: string;
  /** Whether any alerts were raised */
  alertsRaised: boolean;
  /** Agents/humans to notify */
  notifyTargets?: string[];
  /** Metrics collected */
  metrics?: Record<string, number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Persistence Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_PERSISTENCE_CONFIG: ObservationPersistenceConfig = {
  enabled: true,
  maxObservations: 1000,
  retentionPeriod: 7 * 24 * 60 * 60 * 1000, // 7 days
  minSeverityToPersist: 'info',
  deduplicateByCategory: true,
  deduplicationWindow: 5 * 60 * 1000, // 5 minutes
};

const SEVERITY_LEVELS: Record<ObservationSeverity, number> = {
  info: 0,
  warning: 1,
  alert: 2,
  critical: 3,
};

// ─────────────────────────────────────────────────────────────────────────────
// Observational Role (Abstract)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Abstract base for all observational roles.
 * Provides configurable state persistence across workflow runs.
 */
export abstract class ObservationalRole extends BaseRole {
  /** Persistence configuration */
  protected persistenceConfig: ObservationPersistenceConfig;

  /** Observer-specific state */
  protected observerState: ObserverState;

  /** Counter for observation IDs */
  private observationCounter = 0;

  constructor(
    agentId: string,
    config?: RoleConfig & { persistence?: Partial<ObservationPersistenceConfig> },
    existingState?: AgentPersistentState
  ) {
    super(agentId, config, existingState);

    // Merge persistence config
    this.persistenceConfig = {
      ...DEFAULT_PERSISTENCE_CONFIG,
      ...config?.persistence,
    };

    // Initialize or restore observer state
    const storedState = existingState?.preferences?.['observerState'] as
      | ObserverState
      | undefined;

    this.observerState = storedState ?? {
      observations: [],
      metrics: {},
      thresholds: {},
      suppressedAlerts: new Map(),
    };

    // Clean up old observations on load
    if (this.persistenceConfig.enabled) {
      this.pruneOldObservations();
    }
  }

  override getMetadata(): RoleMetadata {
    return {
      roleType: 'observational',
      displayName: 'Observational Agent',
      description: 'Base observational role for monitoring and reporting',
      category: 'observational',
      version: '1.0.0',
    };
  }

  override getDefaultCapabilities(): AgentCapabilities {
    return createCapabilities({
      communication: {
        canDirectMessage: true, // Need to notify agents/humans
        canBroadcast: true, // May need to alert all
        canReadSharedMemory: true,
        canWriteSharedMemory: true,
        canSpawnAgents: false,
        canModifyWorkflows: false,
      },
      resources: {
        maxTokensPerTurn: 2048, // Observers typically don't need much
        maxTotalTokens: 16000,
        maxExecutionTime: 60000, // 1 minute quick checks
        maxConcurrentTools: 3,
      },
    });
  }

  override getSystemPrompt(): string {
    return `You are an observational agent responsible for monitoring and reporting.

Your responsibilities:
- Watch for important events and changes
- Classify observations by severity
- Report findings clearly and concisely
- Suggest actions when appropriate
- Avoid alert fatigue (consolidate similar observations)

Severity levels:
- INFO: Notable but not concerning
- WARNING: Potential issue, worth attention
- ALERT: Problem that needs action
- CRITICAL: Urgent issue requiring immediate response

Be vigilant but not alarmist. Focus on actionable insights.`;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // State Persistence
  // ───────────────────────────────────────────────────────────────────────────

  /** Get persistent state including observer-specific state */
  override getPersistentState(): AgentPersistentState {
    const baseState = super.getPersistentState();

    if (this.persistenceConfig.enabled) {
      return {
        ...baseState,
        preferences: {
          ...baseState.preferences,
          observerState: this.observerState,
          persistenceConfig: this.persistenceConfig,
        },
      };
    }

    return baseState;
  }

  /** Prune observations older than retention period */
  protected pruneOldObservations(): void {
    if (this.persistenceConfig.retentionPeriod === 0) {
      return; // Infinite retention
    }

    const cutoff = Date.now() - this.persistenceConfig.retentionPeriod;
    this.observerState.observations = this.observerState.observations.filter(
      (o) => o.timestamp.getTime() > cutoff
    );

    // Enforce max observations
    if (
      this.observerState.observations.length >
      this.persistenceConfig.maxObservations
    ) {
      this.observerState.observations = this.observerState.observations.slice(
        -this.persistenceConfig.maxObservations
      );
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Observation Helpers
  // ───────────────────────────────────────────────────────────────────────────

  /** Create a new observation */
  protected createObservation(
    category: string,
    severity: ObservationSeverity,
    description: string,
    options?: Partial<
      Omit<Observation, 'id' | 'timestamp' | 'category' | 'severity' | 'description'>
    >
  ): Observation {
    return {
      id: `obs_${this.agentId}_${++this.observationCounter}`,
      timestamp: new Date(),
      category,
      severity,
      description,
      actionRequired: severity === 'alert' || severity === 'critical',
      ...options,
    };
  }

  /** Check if an observation should be persisted based on config */
  protected shouldPersist(observation: Observation): boolean {
    if (!this.persistenceConfig.enabled) {
      return false;
    }

    const minLevel = SEVERITY_LEVELS[this.persistenceConfig.minSeverityToPersist];
    const obsLevel = SEVERITY_LEVELS[observation.severity];

    return obsLevel >= minLevel;
  }

  /** Check if observation is duplicate within deduplication window */
  protected isDuplicate(observation: Observation): boolean {
    if (!this.persistenceConfig.deduplicateByCategory) {
      return false;
    }

    const windowStart =
      Date.now() - this.persistenceConfig.deduplicationWindow;
    const recent = this.observerState.observations.filter(
      (o) =>
        o.category === observation.category &&
        o.timestamp.getTime() > windowStart
    );

    return recent.length > 0;
  }

  /** Store an observation with deduplication and persistence checks */
  protected storeObservation(observation: Observation): boolean {
    if (this.isDuplicate(observation)) {
      return false; // Deduplicated
    }

    if (this.shouldPersist(observation)) {
      this.observerState.observations.push(observation);
      this.pruneOldObservations();
    }

    // Also add to long-term memory for searchability
    this.addMemory({
      type: 'observation',
      content: observation.description,
      metadata: {
        observationId: observation.id,
        category: observation.category,
        severity: observation.severity,
        actionRequired: observation.actionRequired,
      },
    });

    return true;
  }

  /** Record a metric value */
  protected recordMetric(name: string, value: number): void {
    if (!this.observerState.metrics[name]) {
      this.observerState.metrics[name] = [];
    }

    this.observerState.metrics[name]!.push({
      timestamp: new Date(),
      value,
    });

    // Keep last 1000 data points per metric
    if (this.observerState.metrics[name]!.length > 1000) {
      this.observerState.metrics[name] =
        this.observerState.metrics[name]!.slice(-1000);
    }
  }

  /** Check if a metric exceeds threshold */
  protected checkThreshold(name: string, value: number): boolean {
    const threshold = this.observerState.thresholds[name];
    return threshold !== undefined && value > threshold;
  }

  /** Set a threshold */
  protected setThreshold(name: string, value: number): void {
    this.observerState.thresholds[name] = value;
  }

  /** Get observations by category */
  protected getObservationsByCategory(category: string): Observation[] {
    return this.observerState.observations.filter(
      (o) => o.category === category
    );
  }

  /** Get observations by severity */
  protected getObservationsBySeverity(
    severity: ObservationSeverity
  ): Observation[] {
    return this.observerState.observations.filter(
      (o) => o.severity === severity
    );
  }

  /** Create notification messages for alerts */
  protected createAlertMessages(
    observations: Observation[],
    targets: string[]
  ): AgentMessage[] {
    const alerts = observations.filter((o) => o.actionRequired);
    if (alerts.length === 0) {
      return [];
    }

    const content = alerts
      .map((a) => `[${a.severity.toUpperCase()}] ${a.description}`)
      .join('\n');

    return targets.map((target) =>
      this.createMessage(target, 'notification', content, {
        alertCount: alerts.length,
        observations: alerts.map((a) => ({
          id: a.id,
          severity: a.severity,
          category: a.category,
        })),
      })
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Abstract Methods
  // ───────────────────────────────────────────────────────────────────────────

  /** Perform observation/monitoring cycle */
  abstract observe(context: ExecutionContext): Promise<ObservationResult>;

  override async execute(context: ExecutionContext): Promise<ExecutionResult> {
    try {
      this.setStatus('executing', 'Observing...');

      const result = await this.observe(context);

      // Store observations
      let storedCount = 0;
      for (const observation of result.observations) {
        if (this.storeObservation(observation)) {
          storedCount++;
        }
      }

      // Store metrics
      if (result.metrics) {
        for (const [name, value] of Object.entries(result.metrics)) {
          this.recordMetric(name, value);
        }
      }

      // Create alert messages
      const outgoingMessages = result.notifyTargets
        ? this.createAlertMessages(result.observations, result.notifyTargets)
        : [];

      return {
        success: true,
        output: result,
        outputs: {
          observations: result.observations,
          summary: result.summary,
          alertsRaised: result.alertsRaised,
          storedCount,
        },
        outgoingMessages,
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
// Watcher Role
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Role for watching specific events or conditions.
 */
export class WatcherRole extends ObservationalRole {
  /** Events/conditions to watch for */
  protected watchPatterns: string[] = [];

  constructor(
    agentId: string,
    config?: RoleConfig & {
      persistence?: Partial<ObservationPersistenceConfig>;
      watchPatterns?: string[];
    },
    existingState?: AgentPersistentState
  ) {
    super(agentId, config, existingState);
    if (config?.watchPatterns) {
      this.watchPatterns = config.watchPatterns;
    }
  }

  override getMetadata(): RoleMetadata {
    return {
      roleType: 'watcher',
      displayName: 'Watcher',
      description: 'Watches for specific events or conditions',
      category: 'observational',
      parentRole: 'observational',
      version: '1.0.0',
      tags: ['monitoring', 'events', 'watching'],
    };
  }

  override getSystemPrompt(): string {
    const patternsInfo =
      this.watchPatterns.length > 0
        ? `\nWatch patterns: ${this.watchPatterns.join(', ')}`
        : '';

    return `You are a watcher agent that monitors for specific events or conditions.
${patternsInfo}

Your responsibilities:
- Check for events matching watch patterns
- Report matches with appropriate severity
- Track frequency of events
- Detect anomalies in patterns

Be specific about what triggered an observation.`;
  }

  override async observe(context: ExecutionContext): Promise<ObservationResult> {
    // Base implementation - subclasses should override
    const target = context.input['target'] as string | undefined;
    const observations: Observation[] = [];

    if (!target) {
      return {
        observations: [],
        summary: 'No target specified for watching',
        alertsRaised: false,
      };
    }

    // Placeholder - check watch patterns against target
    for (const pattern of this.watchPatterns) {
      if (target.includes(pattern)) {
        observations.push(
          this.createObservation('pattern_match', 'info', `Pattern matched: ${pattern}`, {
            source: target,
            data: { pattern },
          })
        );
      }
    }

    return {
      observations,
      summary: `Watched target: ${target}. Found ${observations.length} matches.`,
      alertsRaised: observations.some((o) => o.actionRequired),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Monitor Role
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Role for continuous system monitoring.
 */
export class MonitorRole extends ObservationalRole {
  /** Metrics to monitor */
  protected monitoredMetrics: string[] = [];

  /** Default thresholds */
  protected defaultThresholds: Record<string, number> = {};

  constructor(
    agentId: string,
    config?: RoleConfig & {
      persistence?: Partial<ObservationPersistenceConfig>;
      monitoredMetrics?: string[];
      thresholds?: Record<string, number>;
    },
    existingState?: AgentPersistentState
  ) {
    super(agentId, config, existingState);
    if (config?.monitoredMetrics) {
      this.monitoredMetrics = config.monitoredMetrics;
    }
    if (config?.thresholds) {
      this.defaultThresholds = config.thresholds;
      // Apply thresholds
      for (const [name, value] of Object.entries(config.thresholds)) {
        this.setThreshold(name, value);
      }
    }
  }

  override getMetadata(): RoleMetadata {
    return {
      roleType: 'monitor',
      displayName: 'Monitor',
      description: 'Performs continuous system monitoring',
      category: 'observational',
      parentRole: 'observational',
      version: '1.0.0',
      tags: ['monitoring', 'metrics', 'health'],
    };
  }

  override getDefaultCapabilities(): AgentCapabilities {
    const base = super.getDefaultCapabilities();
    return {
      ...base,
      tools: [
        ...base.tools,
        {
          id: 'system_metrics',
          name: 'System Metrics',
          description: 'Collect system performance metrics',
        },
        {
          id: 'health_check',
          name: 'Health Check',
          description: 'Perform health checks on services',
        },
      ],
    };
  }

  override getSystemPrompt(): string {
    const metricsInfo =
      this.monitoredMetrics.length > 0
        ? `\nMonitored metrics: ${this.monitoredMetrics.join(', ')}`
        : '';

    return `You are a monitor agent responsible for continuous system monitoring.
${metricsInfo}

Your responsibilities:
- Collect and track metrics
- Detect threshold violations
- Identify trends and anomalies
- Report system health status
- Recommend optimizations

Prioritize stability and early warning.`;
  }

  override async observe(context: ExecutionContext): Promise<ObservationResult> {
    // Base implementation - subclasses should override
    const metrics = context.input['metrics'] as Record<string, number> | undefined;
    const observations: Observation[] = [];
    const collectedMetrics: Record<string, number> = {};

    if (metrics) {
      for (const [name, value] of Object.entries(metrics)) {
        collectedMetrics[name] = value;

        if (this.checkThreshold(name, value)) {
          observations.push(
            this.createObservation(
              'threshold_exceeded',
              'alert',
              `Metric ${name} (${value}) exceeded threshold (${this.observerState.thresholds[name]})`,
              {
                data: { metric: name, value, threshold: this.observerState.thresholds[name] },
              }
            )
          );
        }
      }
    }

    return {
      observations,
      summary: `Monitored ${Object.keys(collectedMetrics).length} metrics. ${observations.length} threshold violations.`,
      alertsRaised: observations.some((o) => o.actionRequired),
      metrics: collectedMetrics,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auditor Role
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Role for tracking changes and ensuring compliance.
 */
export class AuditorRole extends ObservationalRole {
  /** Audit rules/policies */
  protected auditRules: string[] = [];

  constructor(
    agentId: string,
    config?: RoleConfig & {
      persistence?: Partial<ObservationPersistenceConfig>;
      auditRules?: string[];
    },
    existingState?: AgentPersistentState
  ) {
    super(agentId, config, existingState);
    if (config?.auditRules) {
      this.auditRules = config.auditRules;
    }
    // Auditors typically need longer retention
    this.persistenceConfig.retentionPeriod = 30 * 24 * 60 * 60 * 1000; // 30 days
  }

  override getMetadata(): RoleMetadata {
    return {
      roleType: 'auditor',
      displayName: 'Auditor',
      description: 'Tracks changes and ensures compliance',
      category: 'observational',
      parentRole: 'observational',
      version: '1.0.0',
      tags: ['audit', 'compliance', 'tracking'],
    };
  }

  override getSystemPrompt(): string {
    const rulesInfo =
      this.auditRules.length > 0
        ? `\nAudit rules:\n${this.auditRules.map((r) => `- ${r}`).join('\n')}`
        : '';

    return `You are an auditor agent responsible for compliance and change tracking.
${rulesInfo}

Your responsibilities:
- Track all relevant changes
- Check compliance with rules and policies
- Document violations clearly
- Maintain audit trail
- Report to appropriate parties

Be thorough and objective. Document everything.`;
  }

  override async observe(context: ExecutionContext): Promise<ObservationResult> {
    // Base implementation - subclasses should override
    const changes = context.input['changes'] as Record<string, unknown>[] | undefined;
    const observations: Observation[] = [];

    if (changes) {
      for (const change of changes) {
        // Log each change
        observations.push(
          this.createObservation('change_recorded', 'info', `Change recorded: ${JSON.stringify(change)}`, {
            data: change,
          })
        );

        // Check against audit rules (placeholder)
        for (const rule of this.auditRules) {
          // Would normally evaluate rule against change
          if (Math.random() < 0.1) {
            // Placeholder: 10% chance of violation
            observations.push(
              this.createObservation('compliance_violation', 'alert', `Possible violation of rule: ${rule}`, {
                data: { rule, change },
                actionRequired: true,
              })
            );
          }
        }
      }
    }

    return {
      observations,
      summary: `Audited ${changes?.length ?? 0} changes. Found ${observations.filter((o) => o.severity === 'alert').length} potential violations.`,
      alertsRaised: observations.some((o) => o.actionRequired),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Register Role Types
// ─────────────────────────────────────────────────────────────────────────────

const registerObservationalRoles = () => {
  roleRegistry.register(
    new WatcherRole('_template_').getMetadata(),
    (id, config, state) => new WatcherRole(id, config, state)
  );

  roleRegistry.register(
    new MonitorRole('_template_').getMetadata(),
    (id, config, state) => new MonitorRole(id, config, state)
  );

  roleRegistry.register(
    new AuditorRole('_template_').getMetadata(),
    (id, config, state) => new AuditorRole(id, config, state)
  );
};

// Auto-register on module load
registerObservationalRoles();

export { registerObservationalRoles };
