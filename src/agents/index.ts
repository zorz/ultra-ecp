/**
 * Agent System - Main Entry Point
 *
 * Role-oriented agent architecture where agents are first-class citizens.
 * Workflows exist to facilitate agent collaboration, not the other way around.
 *
 * Role Categories:
 * - Creative: Generate content (code, documentation, designs)
 * - Evaluative: Review and critique work
 * - Observational: Monitor and report (with configurable persistence)
 * - Decision: Make choices and aggregate inputs
 * - Orchestrator: Coordinate agents and optimize workflows
 */

// ─────────────────────────────────────────────────────────────────────────────
// Roles
// ─────────────────────────────────────────────────────────────────────────────

export {
  // Base
  BaseRole,
  RoleRegistry,
  roleRegistry,
  // Creative
  CreativeRole,
  WriterRole,
  CoderRole,
  DesignerRole,
  registerCreativeRoles,
  // Evaluative
  EvaluativeRole,
  ReviewerRole,
  CodeReviewerRole,
  SecurityReviewerRole,
  QualityReviewerRole,
  registerEvaluativeRoles,
  // Observational
  ObservationalRole,
  WatcherRole,
  MonitorRole,
  AuditorRole,
  registerObservationalRoles,
  // Decision
  DecisionRole,
  AggregatorRole,
  RouterRole,
  GatekeeperRole,
  registerDecisionRoles,
  // Orchestrator
  OrchestratorRole,
  CoordinatorRole,
  WorkflowOptimizerRole,
  SupervisorRole,
  registerOrchestratorRoles,
} from './roles/index.ts';

export type {
  // Base types
  RoleCategory,
  RoleMetadata,
  RoleConfig,
  ExecutionContext,
  AgentMessage,
  AgentEvent,
  ExecutionResult,
  RoleFactory,
  // Creative types
  ArtifactType,
  CreativeArtifact,
  CreativeResult,
  // Evaluative types
  IssueSeverity,
  EvaluationIssue,
  EvaluationResult,
  // Observational types
  ObservationSeverity,
  Observation,
  ObservationPersistenceConfig,
  ObserverState,
  ObservationResult,
  // Decision types
  ConfidenceLevel,
  DecisionOption,
  Decision,
  DecisionResult,
  // Orchestrator types
  OrchestrationStatus,
  OrchestratedAgent,
  ManagedWorkflow,
  SpawnAgentRequest,
  OrchestrationResult,
} from './roles/index.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Capabilities
// ─────────────────────────────────────────────────────────────────────────────

export {
  createCapabilities,
  mergeCapabilities,
  DEFAULT_COMMUNICATION,
  DEFAULT_RESOURCES,
} from './capabilities/index.ts';

export type {
  ToolCapability,
  ToolConstraints,
  CommunicationCapability,
  ResourceLimits,
  AgentCapabilities,
} from './capabilities/index.ts';

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

export {
  createInitialState,
  createWorkingMemory,
  createRuntimeState,
} from './state/index.ts';

export type {
  AgentRuntimeStatus,
  MemoryEntry,
  WorkingMemory,
  LongTermMemory,
  AgentPersistentState,
  AgentMetrics,
  AgentRuntimeState,
  AgentStateStore,
} from './state/index.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Communication
// ─────────────────────────────────────────────────────────────────────────────

export {
  InMemoryMessageBus,
  InMemorySharedMemory,
  createCommunicationContext,
} from './communication/index.ts';

export type {
  DeliveryStatus,
  MessageEnvelope,
  MessageHandler,
  MessageBus,
  SharedMemoryEntry,
  MemoryChangeEvent,
  MemoryChangeHandler,
  SharedMemory,
  CommunicationContext,
} from './communication/index.ts';

// ─────────────────────────────────────────────────────────────────────────────
// LLM Integration
// ─────────────────────────────────────────────────────────────────────────────

export { NullLLMExecutor, AIServiceLLMExecutor, createAIServiceExecutor } from './llm/index.ts';

export type {
  LLMStreamEvent,
  LLMStreamCallback,
  LLMInvokeOptions,
  LLMResult,
  LLMExecutor,
  LLMExecutorConfig,
  LLMExecutorFactory,
  AIServiceForExecutor,
} from './llm/index.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Auto-register built-in roles
// ─────────────────────────────────────────────────────────────────────────────

import {
  registerCreativeRoles,
  registerEvaluativeRoles,
  registerObservationalRoles,
  registerDecisionRoles,
  registerOrchestratorRoles,
} from './roles/index.ts';

/**
 * Register all built-in roles with the global registry.
 * Called automatically when this module is imported.
 */
export function registerAllBuiltInRoles(): void {
  registerCreativeRoles();
  registerEvaluativeRoles();
  registerObservationalRoles();
  registerDecisionRoles();
  registerOrchestratorRoles();
}

// Auto-register on module load
registerAllBuiltInRoles();
