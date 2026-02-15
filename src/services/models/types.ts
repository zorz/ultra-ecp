/**
 * Model Registry Types
 *
 * Types for dynamic model configuration and management.
 */

// ============================================
// Model Capabilities
// ============================================

/**
 * Capabilities that a model may support.
 */
export type ModelCapability =
  | 'chat' // Basic chat/conversation
  | 'code' // Code generation/understanding
  | 'reasoning' // Complex reasoning tasks
  | 'vision' // Image understanding
  | 'tools' // Tool/function calling
  | 'streaming' // Streaming responses
  | 'json-mode' // Structured JSON output
  | 'long-context'; // Extended context window (100k+)

/**
 * Pricing tier for cost estimation.
 */
export type PricingTier = 'free' | 'low' | 'medium' | 'high' | 'premium';

/**
 * Speed tier for latency expectations.
 */
export type SpeedTier = 'fast' | 'medium' | 'slow';

/**
 * Quality tier for output quality expectations.
 */
export type QualityTier = 'basic' | 'good' | 'excellent' | 'best';

// ============================================
// Model Definition
// ============================================

/**
 * Provider identifiers.
 */
export type ProviderId = 'anthropic' | 'openai' | 'google' | 'ollama' | 'custom';

/**
 * Full model definition with metadata.
 */
export interface ModelDefinition {
  /** Unique model identifier (e.g., 'claude-sonnet-4-20250514') */
  id: string;

  /** Human-readable display name */
  name: string;

  /** Provider that offers this model */
  provider: ProviderId;

  /** Model capabilities */
  capabilities: ModelCapability[];

  /** Maximum context window in tokens */
  contextWindow: number;

  /** Maximum output tokens (if different from context) */
  maxOutputTokens?: number;

  /** Pricing tier */
  pricing: PricingTier;

  /** Speed tier */
  speed: SpeedTier;

  /** Quality tier */
  quality: QualityTier;

  /** Whether this model is currently available */
  available: boolean;

  /** Deprecation date if model is being sunset (ISO date string) */
  deprecatedAt?: string;

  /** Suggested replacement model ID if deprecated */
  replacedBy?: string;

  /** Additional provider-specific metadata */
  metadata?: Record<string, unknown>;
}

// ============================================
// Model Selection
// ============================================

/**
 * Criteria for selecting a model.
 */
export interface ModelSelector {
  /** Specific model ID (highest priority) */
  id?: string;

  /** Required provider */
  provider?: ProviderId;

  /** Required capabilities (all must be present) */
  capabilities?: ModelCapability[];

  /** Minimum quality tier */
  minQuality?: QualityTier;

  /** Maximum pricing tier */
  maxPricing?: PricingTier;

  /** Preferred speed tier */
  preferSpeed?: SpeedTier;

  /** Minimum context window */
  minContextWindow?: number;
}

/**
 * Predefined model selection presets.
 */
export type ModelPreset =
  | 'fast' // Fastest available model
  | 'smart' // Best reasoning/quality
  | 'code' // Best for code tasks
  | 'balanced' // Good balance of speed/quality/cost
  | 'cheap' // Lowest cost option
  | 'vision'; // Vision-capable model

// ============================================
// Configuration
// ============================================

/**
 * Models configuration file structure.
 */
export interface ModelsConfig {
  /** Schema version for forward compatibility */
  version: number;

  /** When this config was last updated */
  lastUpdated: string;

  /** Default model selections by preset */
  defaults: Record<ModelPreset, string>;

  /** Provider-specific default models */
  providerDefaults: Record<ProviderId, string>;

  /** All available models */
  models: ModelDefinition[];
}

/**
 * Runtime model registry state.
 */
export interface ModelRegistryState {
  /** Loaded configuration */
  config: ModelsConfig;

  /** Whether registry has been initialized */
  initialized: boolean;

  /** Last refresh timestamp */
  lastRefresh: number;

  /** Models indexed by ID for fast lookup */
  modelsById: Map<string, ModelDefinition>;

  /** Models indexed by provider */
  modelsByProvider: Map<ProviderId, ModelDefinition[]>;
}

// ============================================
// Events
// ============================================

/**
 * Events emitted by the model registry.
 */
export interface ModelRegistryEvents {
  /** Emitted when models are refreshed from source */
  'models:refreshed': { count: number; source: 'file' | 'api' };

  /** Emitted when a model becomes unavailable */
  'model:unavailable': { modelId: string; reason: string };

  /** Emitted when a model is deprecated */
  'model:deprecated': { modelId: string; replacedBy?: string };
}
