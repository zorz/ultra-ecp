/**
 * Model Registry Service
 *
 * Manages dynamic model configuration with support for:
 * - Loading models from config file
 * - Fetching updated models from provider APIs
 * - Model selection by ID, capability, or preset
 * - Fallback handling for unavailable models
 */

import { EventEmitter } from 'events';
import { debugLog } from '../../debug.ts';
import type {
  ModelCapability,
  ModelDefinition,
  ModelPreset,
  ModelRegistryEvents,
  ModelRegistryState,
  ModelSelector,
  ModelsConfig,
  PricingTier,
  ProviderId,
  QualityTier,
} from './types.ts';

// ============================================
// Constants
// ============================================

/** Default config file path */
const DEFAULT_CONFIG_PATH = 'config/models.json';

/** User config path (overrides default) */
const USER_CONFIG_PATH = '~/.ultra/models.json';

/** Minimum refresh interval (1 hour) */
const MIN_REFRESH_INTERVAL = 60 * 60 * 1000;

/** Quality tier ordering for comparison */
const QUALITY_ORDER: Record<QualityTier, number> = {
  basic: 1,
  good: 2,
  excellent: 3,
  best: 4,
};

/** Pricing tier ordering for comparison */
const PRICING_ORDER: Record<PricingTier, number> = {
  free: 1,
  low: 2,
  medium: 3,
  high: 4,
  premium: 5,
};

// ============================================
// Model Registry Class
// ============================================

export class ModelRegistry extends EventEmitter {
  private state: ModelRegistryState;
  private configPath: string;

  constructor(configPath?: string) {
    super();
    this.configPath = configPath ?? DEFAULT_CONFIG_PATH;
    this.state = {
      config: this.getDefaultConfig(),
      initialized: false,
      lastRefresh: 0,
      modelsById: new Map(),
      modelsByProvider: new Map(),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Initialize the registry by loading config.
   */
  async initialize(): Promise<void> {
    if (this.state.initialized) {
      return;
    }

    debugLog('[ModelRegistry] Initializing model registry...');

    // Try to load user config first, then default
    let config: ModelsConfig | null = null;

    const userPath = USER_CONFIG_PATH.replace('~', process.env.HOME ?? '');
    try {
      const userFile = Bun.file(userPath);
      if (await userFile.exists()) {
        const content = await userFile.text();
        config = JSON.parse(content) as ModelsConfig;
        debugLog(`[ModelRegistry] Loaded user config from ${userPath}`);
      }
    } catch (err) {
      debugLog(`[ModelRegistry] Failed to load user config: ${err}`);
    }

    if (!config) {
      try {
        const defaultFile = Bun.file(this.configPath);
        if (await defaultFile.exists()) {
          const content = await defaultFile.text();
          config = JSON.parse(content) as ModelsConfig;
          debugLog(`[ModelRegistry] Loaded default config from ${this.configPath}`);
        }
      } catch (err) {
        debugLog(`[ModelRegistry] Failed to load default config: ${err}`);
      }
    }

    if (!config) {
      debugLog('[ModelRegistry] Using built-in default config');
      config = this.getDefaultConfig();
    }

    this.loadConfig(config);
    this.state.initialized = true;
    this.state.lastRefresh = Date.now();

    debugLog(`[ModelRegistry] Initialized with ${this.state.modelsById.size} models`);
  }

  /**
   * Load configuration and build indexes.
   */
  private loadConfig(config: ModelsConfig): void {
    this.state.config = config;
    this.state.modelsById.clear();
    this.state.modelsByProvider.clear();

    for (const model of config.models) {
      this.state.modelsById.set(model.id, model);

      const providerModels = this.state.modelsByProvider.get(model.provider) ?? [];
      providerModels.push(model);
      this.state.modelsByProvider.set(model.provider, providerModels);
    }
  }

  /**
   * Get default config with essential models.
   */
  private getDefaultConfig(): ModelsConfig {
    return {
      version: 1,
      lastUpdated: new Date().toISOString(),
      defaults: {
        fast: 'claude-haiku-4-5-20251001',
        smart: 'claude-opus-4-5-20251101',
        code: 'claude-sonnet-4-5-20250929',
        balanced: 'claude-sonnet-4-5-20250929',
        cheap: 'gemini-2.0-flash-lite',
        vision: 'gpt-4o',
      },
      providerDefaults: {
        anthropic: 'claude-opus-4-5-20251101',
        openai: 'gpt-4o',
        google: 'gemini-2.0-flash',
        ollama: 'llama3.2',
        custom: '',
      },
      models: [
        {
          id: 'claude-sonnet-4-20250514',
          name: 'Claude Sonnet 4',
          provider: 'anthropic',
          capabilities: ['chat', 'code', 'reasoning', 'vision', 'tools', 'streaming', 'json-mode', 'long-context'],
          contextWindow: 200000,
          maxOutputTokens: 16000,
          pricing: 'medium',
          speed: 'medium',
          quality: 'excellent',
          available: true,
        },
        {
          id: 'gpt-4o',
          name: 'GPT-4o',
          provider: 'openai',
          capabilities: ['chat', 'code', 'reasoning', 'vision', 'tools', 'streaming', 'json-mode', 'long-context'],
          contextWindow: 128000,
          maxOutputTokens: 16384,
          pricing: 'medium',
          speed: 'medium',
          quality: 'excellent',
          available: true,
        },
        {
          id: 'gemini-2.0-flash',
          name: 'Gemini 2.0 Flash',
          provider: 'google',
          capabilities: ['chat', 'code', 'reasoning', 'vision', 'tools', 'streaming', 'json-mode', 'long-context'],
          contextWindow: 1000000,
          maxOutputTokens: 8192,
          pricing: 'low',
          speed: 'fast',
          quality: 'good',
          available: true,
        },
      ],
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Model Lookup
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get a model by ID.
   */
  getModel(id: string): ModelDefinition | undefined {
    return this.state.modelsById.get(id);
  }

  /**
   * Get all models.
   */
  getAllModels(): ModelDefinition[] {
    return Array.from(this.state.modelsById.values());
  }

  /**
   * Get models for a specific provider.
   */
  getModelsByProvider(provider: ProviderId): ModelDefinition[] {
    return this.state.modelsByProvider.get(provider) ?? [];
  }

  /**
   * Get available models only.
   */
  getAvailableModels(): ModelDefinition[] {
    return this.getAllModels().filter((m) => m.available);
  }

  /**
   * Get models with a specific capability.
   */
  getModelsWithCapability(capability: ModelCapability): ModelDefinition[] {
    return this.getAllModels().filter((m) => m.available && m.capabilities.includes(capability));
  }

  /**
   * Get the default model for a preset.
   */
  getPresetModel(preset: ModelPreset): ModelDefinition | undefined {
    const id = this.state.config.defaults[preset];
    return this.getModel(id);
  }

  /**
   * Get the default model for a provider.
   */
  getProviderDefault(provider: ProviderId): ModelDefinition | undefined {
    const id = this.state.config.providerDefaults[provider];
    return this.getModel(id);
  }

  /**
   * Get the default model ID for a provider.
   */
  getProviderDefaultId(provider: ProviderId): string {
    return this.state.config.providerDefaults[provider] ?? '';
  }

  /**
   * Get available model IDs for a provider (for fallback lists).
   */
  getProviderModelIds(provider: ProviderId): string[] {
    return this.getModelsByProvider(provider)
      .filter((m) => m.available)
      .map((m) => m.id);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Model Selection
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Select a model based on criteria.
   * Returns the best matching available model, or undefined if none match.
   */
  selectModel(selector: ModelSelector): ModelDefinition | undefined {
    // If specific ID requested, return it directly (with availability check)
    if (selector.id) {
      const model = this.getModel(selector.id);
      if (model?.available) {
        return model;
      }
      // Try replacement if deprecated
      if (model?.replacedBy) {
        return this.getModel(model.replacedBy);
      }
      return undefined;
    }

    // Filter candidates
    let candidates = this.getAvailableModels();

    if (selector.provider) {
      candidates = candidates.filter((m) => m.provider === selector.provider);
    }

    if (selector.capabilities) {
      candidates = candidates.filter((m) =>
        selector.capabilities!.every((cap) => m.capabilities.includes(cap))
      );
    }

    if (selector.minQuality) {
      const minOrder = QUALITY_ORDER[selector.minQuality];
      candidates = candidates.filter((m) => QUALITY_ORDER[m.quality] >= minOrder);
    }

    if (selector.maxPricing) {
      const maxOrder = PRICING_ORDER[selector.maxPricing];
      candidates = candidates.filter((m) => PRICING_ORDER[m.pricing] <= maxOrder);
    }

    if (selector.minContextWindow) {
      candidates = candidates.filter((m) => m.contextWindow >= selector.minContextWindow!);
    }

    if (candidates.length === 0) {
      return undefined;
    }

    // Sort by preference (quality desc, then speed if preferred, then price)
    candidates.sort((a, b) => {
      // Quality (higher is better)
      const qualityDiff = QUALITY_ORDER[b.quality] - QUALITY_ORDER[a.quality];
      if (qualityDiff !== 0) return qualityDiff;

      // Speed if preferred
      if (selector.preferSpeed) {
        const speedOrder = { fast: 3, medium: 2, slow: 1 };
        const speedDiff = speedOrder[b.speed] - speedOrder[a.speed];
        if (speedDiff !== 0) return speedDiff;
      }

      // Price (lower is better)
      return PRICING_ORDER[a.pricing] - PRICING_ORDER[b.pricing];
    });

    return candidates[0];
  }

  /**
   * Resolve a model ID or preset to an actual model.
   * Supports:
   * - Specific model ID: "claude-sonnet-4-20250514"
   * - Preset: "@fast", "@smart", "@code", etc.
   * - Provider default: "anthropic:", "openai:", etc.
   */
  resolveModel(reference: string): ModelDefinition | undefined {
    // Preset reference
    if (reference.startsWith('@')) {
      const preset = reference.slice(1) as ModelPreset;
      return this.getPresetModel(preset);
    }

    // Provider default reference
    if (reference.endsWith(':')) {
      const provider = reference.slice(0, -1) as ProviderId;
      return this.getProviderDefault(provider);
    }

    // Direct ID lookup
    const model = this.getModel(reference);
    if (model?.available) {
      return model;
    }

    // Try replacement if deprecated
    if (model?.replacedBy) {
      return this.getModel(model.replacedBy);
    }

    return undefined;
  }

  /**
   * Get fallback model when requested model is unavailable.
   */
  getFallback(modelId: string): ModelDefinition | undefined {
    const original = this.getModel(modelId);

    // If model has replacement, use it
    if (original?.replacedBy) {
      const replacement = this.getModel(original.replacedBy);
      if (replacement?.available) {
        return replacement;
      }
    }

    // Otherwise, find similar model from same provider
    if (original) {
      const providerModels = this.getModelsByProvider(original.provider);
      const similar = providerModels.find(
        (m) =>
          m.available &&
          m.id !== modelId &&
          QUALITY_ORDER[m.quality] >= QUALITY_ORDER[original.quality] - 1
      );
      if (similar) {
        return similar;
      }
    }

    // Last resort: return balanced default
    return this.getPresetModel('balanced');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Refresh
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Refresh models from config file.
   */
  async refreshFromFile(): Promise<void> {
    debugLog('[ModelRegistry] Refreshing from config file...');

    try {
      const file = Bun.file(this.configPath);
      if (await file.exists()) {
        const content = await file.text();
        const config = JSON.parse(content) as ModelsConfig;
        this.loadConfig(config);
        this.state.lastRefresh = Date.now();
        this.emit('models:refreshed', { count: config.models.length, source: 'file' });
        debugLog(`[ModelRegistry] Refreshed ${config.models.length} models from file`);
      }
    } catch (err) {
      debugLog(`[ModelRegistry] Failed to refresh from file: ${err}`);
    }
  }

  /**
   * Save current config to user file.
   */
  async saveUserConfig(): Promise<void> {
    const userPath = USER_CONFIG_PATH.replace('~', process.env.HOME ?? '');

    try {
      // Ensure directory exists
      const dir = userPath.substring(0, userPath.lastIndexOf('/'));
      await Bun.spawn(['mkdir', '-p', dir]).exited;

      await Bun.write(userPath, JSON.stringify(this.state.config, null, 2));
      debugLog(`[ModelRegistry] Saved config to ${userPath}`);
    } catch (err) {
      debugLog(`[ModelRegistry] Failed to save user config: ${err}`);
    }
  }

  /**
   * Add or update a model in the registry.
   */
  addModel(model: ModelDefinition): void {
    this.state.modelsById.set(model.id, model);

    const providerModels = this.state.modelsByProvider.get(model.provider) ?? [];
    const existingIndex = providerModels.findIndex((m) => m.id === model.id);
    if (existingIndex >= 0) {
      providerModels[existingIndex] = model;
    } else {
      providerModels.push(model);
    }
    this.state.modelsByProvider.set(model.provider, providerModels);

    // Update config
    const configIndex = this.state.config.models.findIndex((m) => m.id === model.id);
    if (configIndex >= 0) {
      this.state.config.models[configIndex] = model;
    } else {
      this.state.config.models.push(model);
    }
  }

  /**
   * Mark a model as unavailable.
   */
  markUnavailable(modelId: string, reason: string): void {
    const model = this.getModel(modelId);
    if (model) {
      model.available = false;
      this.emit('model:unavailable', { modelId, reason });
      debugLog(`[ModelRegistry] Marked ${modelId} as unavailable: ${reason}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Typed Event Emitter
  // ─────────────────────────────────────────────────────────────────────────

  override emit<K extends keyof ModelRegistryEvents>(
    event: K,
    data: ModelRegistryEvents[K]
  ): boolean {
    return super.emit(event, data);
  }

  override on<K extends keyof ModelRegistryEvents>(
    event: K,
    listener: (data: ModelRegistryEvents[K]) => void
  ): this {
    return super.on(event, listener);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get registry state for debugging.
   */
  getState(): Readonly<ModelRegistryState> {
    return this.state;
  }

  /**
   * Check if registry is initialized.
   */
  isInitialized(): boolean {
    return this.state.initialized;
  }

  /**
   * Get time since last refresh.
   */
  getTimeSinceRefresh(): number {
    return Date.now() - this.state.lastRefresh;
  }
}

// ============================================
// Singleton Instance
// ============================================

let instance: ModelRegistry | null = null;

/**
 * Get the global model registry instance.
 */
export function getModelRegistry(): ModelRegistry {
  if (!instance) {
    instance = new ModelRegistry();
  }
  return instance;
}

/**
 * Initialize the global model registry.
 */
export async function initializeModelRegistry(): Promise<ModelRegistry> {
  const registry = getModelRegistry();
  await registry.initialize();
  return registry;
}

/**
 * Create a new model registry instance (for testing).
 */
export function createModelRegistry(configPath?: string): ModelRegistry {
  return new ModelRegistry(configPath);
}
