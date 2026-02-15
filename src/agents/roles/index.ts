/**
 * Agent Roles - Barrel Export
 *
 * Role-oriented agent architecture:
 *   BaseRole
 *   ├── CreativeRole (generates content)
 *   │   ├── WriterRole
 *   │   ├── CoderRole
 *   │   └── DesignerRole
 *   ├── EvaluativeRole (reviews/critiques)
 *   │   └── ReviewerRole
 *   │       ├── CodeReviewerRole
 *   │       ├── SecurityReviewerRole
 *   │       └── QualityReviewerRole
 *   ├── ObservationalRole (monitors/reports)
 *   │   ├── WatcherRole
 *   │   ├── MonitorRole
 *   │   └── AuditorRole
 *   ├── DecisionRole (makes choices)
 *   │   ├── AggregatorRole
 *   │   ├── RouterRole
 *   │   └── GatekeeperRole
 *   └── OrchestratorRole (coordinates agents)
 *       ├── CoordinatorRole
 *       ├── WorkflowOptimizerRole
 *       └── SupervisorRole
 */

// Base role system
export {
  BaseRole,
  RoleRegistry,
  roleRegistry,
} from './base.ts';

export type {
  RoleCategory,
  RoleMetadata,
  RoleConfig,
  ExecutionContext,
  AgentMessage,
  AgentEvent,
  ExecutionResult,
  RoleFactory,
} from './base.ts';

// Creative roles
export {
  CreativeRole,
  WriterRole,
  CoderRole,
  DesignerRole,
  registerCreativeRoles,
} from './creative.ts';

export type {
  ArtifactType,
  CreativeArtifact,
  CreativeResult,
} from './creative.ts';

// Evaluative roles
export {
  EvaluativeRole,
  ReviewerRole,
  CodeReviewerRole,
  SecurityReviewerRole,
  QualityReviewerRole,
  registerEvaluativeRoles,
} from './evaluative.ts';

export type {
  IssueSeverity,
  EvaluationIssue,
  EvaluationResult,
} from './evaluative.ts';

// Observational roles
export {
  ObservationalRole,
  WatcherRole,
  MonitorRole,
  AuditorRole,
  registerObservationalRoles,
} from './observational.ts';

export type {
  ObservationSeverity,
  Observation,
  ObservationPersistenceConfig,
  ObserverState,
  ObservationResult,
} from './observational.ts';

// Decision roles
export {
  DecisionRole,
  AggregatorRole,
  RouterRole,
  GatekeeperRole,
  registerDecisionRoles,
} from './decision.ts';

export type {
  ConfidenceLevel,
  DecisionOption,
  Decision,
  DecisionResult,
} from './decision.ts';

// Orchestrator roles
export {
  OrchestratorRole,
  CoordinatorRole,
  WorkflowOptimizerRole,
  SupervisorRole,
  registerOrchestratorRoles,
} from './orchestrator.ts';

export type {
  OrchestrationStatus,
  OrchestratedAgent,
  ManagedWorkflow,
  SpawnAgentRequest,
  OrchestrationResult,
} from './orchestrator.ts';
