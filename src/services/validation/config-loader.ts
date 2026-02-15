/**
 * Configuration Loader
 *
 * Loads validation pipeline configuration from YAML or JSON files.
 * Supports hot-reload and configuration validation.
 */

import { watch } from 'node:fs';
import { join } from 'node:path';
import type {
  ValidationPipelineConfig,
  ValidatorDefinition,
  ValidatorBehavior,
  ValidatorContextConfig,
  ConsensusConfig,
  ConsensusStrategy,
  ValidationTrigger,
  ValidatorType,
  Unsubscribe,
} from './types.ts';
import type { AIProviderType } from '../ai/types.ts';
import { debugLog, isDebugEnabled } from '../../debug.ts';

/**
 * Raw YAML configuration structure.
 */
export interface ValidationConfigYAML {
  /** Global settings */
  settings?: {
    executionModel?: 'turn-based' | 'parallel';
    defaultTimeout?: number;
    cacheEnabled?: boolean;
    cacheMaxAge?: number;
    contextDir?: string;
  };

  /** Validator definitions */
  validators?: Array<{
    id: string;
    name: string;
    type: string;
    enabled?: boolean;
    priority?: number;
    provider?: string;
    model?: string;
    systemPrompt?: string;
    apiKey?: string;
    baseUrl?: string;
    maxTokens?: number;
    temperature?: number;
    command?: string;
    triggers?: string[];
    filePatterns?: string[];
    contextConfig?: Partial<ValidatorContextConfig>;
    behavior?: Partial<ValidatorBehavior>;
  }>;

  /** Consensus configuration */
  consensus?: {
    strategy?: string;
    minimumResponses?: number;
    timeoutMs?: number;
    escalateToHuman?: boolean;
  };
}

/**
 * Configuration change event.
 */
export interface ConfigChangeEvent {
  /** Path to the changed config file */
  path: string;
  /** Type of change */
  type: 'add' | 'change' | 'delete';
  /** Parsed configuration (if successful) */
  config?: ValidationPipelineConfig;
  /** Validation errors (if any) */
  errors?: string[];
}

/**
 * Configuration change callback.
 */
export type ConfigChangeCallback = (event: ConfigChangeEvent) => void;

/**
 * Configuration loader options.
 */
export interface ConfigLoaderOptions {
  /** Path to the configuration file */
  configPath: string;
  /** Whether to watch for changes */
  watchEnabled: boolean;
  /** Debounce delay for file watcher (ms) */
  watchDebounceMs: number;
}

/**
 * Default configuration loader options.
 */
const DEFAULT_OPTIONS: ConfigLoaderOptions = {
  configPath: '.ultra/validators.yaml',
  watchEnabled: false,
  watchDebounceMs: 500,
};

/**
 * Loads and manages validation configuration.
 */
export class ConfigLoader {
  private options: ConfigLoaderOptions;
  private watcher: ReturnType<typeof watch> | null = null;
  private changeCallbacks: Set<ConfigChangeCallback> = new Set();
  private debounceTimer: Timer | null = null;
  private lastConfig: ValidationPipelineConfig | null = null;

  constructor(options: Partial<ConfigLoaderOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[ConfigLoader] ${msg}`);
    }
  }

  /**
   * Load configuration from file.
   * Supports JSON and simple YAML formats.
   */
  async load(): Promise<{ config: ValidationPipelineConfig; errors: string[] }> {
    const errors: string[] = [];

    try {
      const fullPath = join(process.cwd(), this.options.configPath);
      this.log(`Loading configuration from: ${fullPath}`);

      const content = await Bun.file(fullPath).text();
      const rawConfig = parseConfigContent(content, this.options.configPath) as ValidationConfigYAML;

      // Validate and transform configuration
      const config = this.transformConfig(rawConfig, errors);
      this.lastConfig = config;

      this.log(`Loaded ${config.validators?.length ?? 0} validators`);
      return { config, errors };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.log('Configuration file not found, using defaults');
        const config = this.getDefaultConfig();
        return { config, errors: [] };
      }

      const errorMsg = `Failed to load configuration: ${error instanceof Error ? error.message : String(error)}`;
      this.log(errorMsg);
      errors.push(errorMsg);

      return { config: this.getDefaultConfig(), errors };
    }
  }

  /**
   * Start watching for configuration changes.
   */
  startWatching(): void {
    if (this.watcher) {
      return;
    }

    try {
      const fullPath = join(process.cwd(), this.options.configPath);
      this.watcher = watch(fullPath, (eventType) => {
        this.handleFileChange(eventType);
      });

      this.log('Started watching configuration file');
    } catch (error) {
      this.log(`Failed to start watcher: ${error}`);
    }
  }

  /**
   * Stop watching for configuration changes.
   */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      this.log('Stopped watching configuration file');
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * Subscribe to configuration changes.
   */
  onChange(callback: ConfigChangeCallback): Unsubscribe {
    this.changeCallbacks.add(callback);
    return () => {
      this.changeCallbacks.delete(callback);
    };
  }

  /**
   * Check if watching is enabled.
   */
  isWatching(): boolean {
    return this.watcher !== null;
  }

  /**
   * Get the last loaded configuration.
   */
  getLastConfig(): ValidationPipelineConfig | null {
    return this.lastConfig;
  }

  /**
   * Handle file change events.
   */
  private handleFileChange(eventType: string): void {
    // Debounce rapid changes
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(async () => {
      this.log(`Configuration file changed: ${eventType}`);

      const { config, errors } = await this.load();

      const event: ConfigChangeEvent = {
        path: this.options.configPath,
        type: eventType === 'rename' ? 'delete' : 'change',
        config: errors.length === 0 ? config : undefined,
        errors: errors.length > 0 ? errors : undefined,
      };

      for (const callback of this.changeCallbacks) {
        try {
          callback(event);
        } catch (error) {
          this.log(`Config change callback error: ${error}`);
        }
      }
    }, this.options.watchDebounceMs);
  }

  /**
   * Transform raw YAML config to typed configuration.
   */
  private transformConfig(
    raw: ValidationConfigYAML,
    errors: string[]
  ): ValidationPipelineConfig {
    const config: ValidationPipelineConfig = this.getDefaultConfig();

    // Apply settings
    if (raw.settings) {
      if (raw.settings.executionModel) {
        if (['turn-based', 'parallel'].includes(raw.settings.executionModel)) {
          config.executionModel = raw.settings.executionModel;
        } else {
          errors.push(`Invalid executionModel: ${raw.settings.executionModel}`);
        }
      }

      if (raw.settings.defaultTimeout !== undefined) {
        config.defaultTimeout = raw.settings.defaultTimeout;
      }

      if (raw.settings.cacheEnabled !== undefined) {
        config.cacheEnabled = raw.settings.cacheEnabled;
      }

      if (raw.settings.cacheMaxAge !== undefined) {
        config.cacheMaxAge = raw.settings.cacheMaxAge;
      }

      if (raw.settings.contextDir !== undefined) {
        config.contextDir = raw.settings.contextDir;
      }
    }

    // Apply consensus config
    if (raw.consensus) {
      config.consensus = this.transformConsensus(raw.consensus, errors);
    }

    // Transform validators
    if (raw.validators) {
      config.validators = [];
      for (const v of raw.validators) {
        const validator = this.transformValidator(v, errors);
        if (validator) {
          config.validators.push(validator);
        }
      }
    }

    return config;
  }

  /**
   * Transform consensus configuration.
   */
  private transformConsensus(
    raw: ValidationConfigYAML['consensus'],
    errors: string[]
  ): ConsensusConfig {
    const config: ConsensusConfig = {
      strategy: 'majority',
      minimumResponses: 1,
      timeoutMs: 60000,
      escalateToHuman: true,
    };

    if (!raw) return config;

    if (raw.strategy) {
      const validStrategies: ConsensusStrategy[] = [
        'unanimous',
        'majority',
        'any-approve',
        'no-rejections',
        'weighted',
      ];
      if (validStrategies.includes(raw.strategy as ConsensusStrategy)) {
        config.strategy = raw.strategy as ConsensusStrategy;
      } else {
        errors.push(`Invalid consensus strategy: ${raw.strategy}`);
      }
    }

    if (raw.minimumResponses !== undefined) {
      config.minimumResponses = raw.minimumResponses;
    }

    if (raw.timeoutMs !== undefined) {
      config.timeoutMs = raw.timeoutMs;
    }

    if (raw.escalateToHuman !== undefined) {
      config.escalateToHuman = raw.escalateToHuman;
    }

    return config;
  }

  /**
   * Transform a validator definition.
   */
  private transformValidator(
    raw: NonNullable<ValidationConfigYAML['validators']>[0],
    errors: string[]
  ): ValidatorDefinition | null {
    // Validate required fields
    if (!raw.id) {
      errors.push('Validator missing required field: id');
      return null;
    }

    if (!raw.name) {
      errors.push(`Validator ${raw.id} missing required field: name`);
      return null;
    }

    if (!raw.type) {
      errors.push(`Validator ${raw.id} missing required field: type`);
      return null;
    }

    // Validate type
    const validTypes: ValidatorType[] = ['static', 'ai-critic', 'custom', 'composite'];
    if (!validTypes.includes(raw.type as ValidatorType)) {
      errors.push(`Validator ${raw.id} has invalid type: ${raw.type}`);
      return null;
    }

    // Validate triggers
    const validTriggers: ValidationTrigger[] = [
      'pre-tool',
      'on-change',
      'pre-write',
      'post-tool',
      'pre-commit',
      'periodic',
      'on-demand',
    ];
    const triggers: ValidationTrigger[] = [];
    if (raw.triggers) {
      for (const t of raw.triggers) {
        if (validTriggers.includes(t as ValidationTrigger)) {
          triggers.push(t as ValidationTrigger);
        } else {
          errors.push(`Validator ${raw.id} has invalid trigger: ${t}`);
        }
      }
    }

    // Build validator definition
    const validator: ValidatorDefinition = {
      id: raw.id,
      name: raw.name,
      type: raw.type as ValidatorType,
      enabled: raw.enabled ?? true,
      priority: raw.priority ?? 50,
      triggers: triggers.length > 0 ? triggers : ['pre-write'],
      behavior: this.transformBehavior(raw.behavior),
    };

    // Add optional fields
    if (raw.provider) {
      const validProviders: AIProviderType[] = ['claude', 'openai', 'gemini', 'ollama'];
      if (validProviders.includes(raw.provider as AIProviderType)) {
        validator.provider = raw.provider as AIProviderType;
      } else {
        errors.push(`Validator ${raw.id} has invalid provider: ${raw.provider}`);
      }
    }

    if (raw.model) {
      validator.model = raw.model;
    }

    if (raw.systemPrompt) {
      validator.systemPrompt = raw.systemPrompt;
    }

    if (raw.apiKey) {
      validator.apiKey = raw.apiKey;
    }

    if (raw.baseUrl) {
      validator.baseUrl = raw.baseUrl;
    }

    if (raw.maxTokens) {
      validator.maxTokens = raw.maxTokens;
    }

    if (raw.temperature !== undefined) {
      validator.temperature = raw.temperature;
    }

    if (raw.command) {
      validator.command = raw.command;
    }

    if (raw.filePatterns) {
      validator.filePatterns = raw.filePatterns;
    }

    if (raw.contextConfig) {
      validator.contextConfig = {
        includeFullFile: raw.contextConfig.includeFullFile ?? true,
        includeDiff: raw.contextConfig.includeDiff ?? true,
        includeGitDiff: raw.contextConfig.includeGitDiff ?? true,
        includeRelatedFiles: raw.contextConfig.includeRelatedFiles ?? false,
        relatedFileDepth: raw.contextConfig.relatedFileDepth ?? 1,
        maxContextSize: raw.contextConfig.maxContextSize,
      };
    }

    return validator;
  }

  /**
   * Transform validator behavior.
   */
  private transformBehavior(raw?: Partial<ValidatorBehavior>): ValidatorBehavior {
    return {
      onFailure: raw?.onFailure ?? 'warning',
      blockOnFailure: raw?.blockOnFailure ?? false,
      required: raw?.required ?? false,
      timeoutMs: raw?.timeoutMs ?? 30000,
      onTimeout: raw?.onTimeout ?? 'warning',
      cacheable: raw?.cacheable ?? true,
      cacheKeyFields: raw?.cacheKeyFields,
      requireConsensus: raw?.requireConsensus,
      weight: raw?.weight,
    };
  }

  /**
   * Get default configuration.
   */
  private getDefaultConfig(): ValidationPipelineConfig {
    return {
      executionModel: 'turn-based',
      defaultTimeout: 30000,
      cacheEnabled: true,
      cacheMaxAge: 5 * 60 * 1000,
      contextDir: 'validation',
      consensus: {
        strategy: 'majority',
        minimumResponses: 1,
        timeoutMs: 60000,
        escalateToHuman: true,
      },
    };
  }

  /**
   * Validate a configuration object.
   */
  static validate(config: ValidationPipelineConfig): string[] {
    const errors: string[] = [];

    if (config.executionModel && !['turn-based', 'parallel'].includes(config.executionModel)) {
      errors.push(`Invalid executionModel: ${config.executionModel}`);
    }

    if (config.defaultTimeout !== undefined && config.defaultTimeout <= 0) {
      errors.push('defaultTimeout must be positive');
    }

    if (config.cacheMaxAge !== undefined && config.cacheMaxAge <= 0) {
      errors.push('cacheMaxAge must be positive');
    }

    if (config.validators) {
      for (const v of config.validators) {
        if (!v.id) {
          errors.push('Validator missing id');
        }

        if (!v.name) {
          errors.push(`Validator ${v.id} missing name`);
        }

        if (v.type === 'ai-critic' && !v.provider) {
          errors.push(`AI critic validator ${v.id} missing provider`);
        }

        if (v.type === 'static' && !v.command) {
          errors.push(`Static validator ${v.id} missing command`);
        }
      }
    }

    return errors;
  }
}

/**
 * Create a configuration loader instance.
 */
export function createConfigLoader(options?: Partial<ConfigLoaderOptions>): ConfigLoader {
  return new ConfigLoader(options);
}

/**
 * Parse configuration content (JSON or simple YAML).
 */
function parseConfigContent(content: string, path: string): ValidationConfigYAML {
  // Try JSON first
  if (path.endsWith('.json') || content.trim().startsWith('{')) {
    return JSON.parse(content);
  }

  // Simple YAML-like parsing for basic config structure
  // This handles indentation-based YAML without complex features
  return parseSimpleYAML(content);
}

/**
 * Simple YAML parser for basic configuration.
 * Supports basic key-value pairs, arrays, and nested objects.
 */
function parseSimpleYAML(content: string): ValidationConfigYAML {
  const lines = content.split('\n');
  const result: Record<string, unknown> = {};
  const stack: Array<{ obj: Record<string, unknown>; indent: number }> = [{ obj: result, indent: -1 }];
  let currentKey: string | null = null;
  let inMultilineString = false;
  let multilineIndent = 0;
  let multilineContent: string[] = [];

  for (const line of lines) {
    // Handle multiline strings (|)
    if (inMultilineString) {
      const lineIndent = line.search(/\S/);
      if (lineIndent === -1 || lineIndent > multilineIndent) {
        multilineContent.push(line.slice(multilineIndent + 2));
        continue;
      } else {
        // End multiline
        const current = stack[stack.length - 1]!;
        if (currentKey) {
          current.obj[currentKey] = multilineContent.join('\n').trimEnd();
        }
        inMultilineString = false;
        multilineContent = [];
      }
    }

    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const indent = line.search(/\S/);

    // Array item
    if (trimmed.startsWith('- ')) {
      const value = trimmed.slice(2);

      // Pop stack to appropriate level
      while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) {
        stack.pop();
      }

      const current = stack[stack.length - 1]!;
      if (currentKey) {
        if (!Array.isArray(current.obj[currentKey])) {
          current.obj[currentKey] = [];
        }
        const arr = current.obj[currentKey] as unknown[];

        // Check if it's an inline object: - id: value
        if (value.includes(':')) {
          const objItem: Record<string, unknown> = {};
          const colonIdx = value.indexOf(':');
          const key = value.slice(0, colonIdx).trim();
          const val = value.slice(colonIdx + 1).trim();
          objItem[key] = parseValue(val);
          arr.push(objItem);
          stack.push({ obj: objItem, indent: indent + 2 });
        } else {
          arr.push(parseValue(value));
        }
      }
      continue;
    }

    // Key-value pair
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      // Pop stack to appropriate level
      while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) {
        stack.pop();
      }

      const key = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();

      const current = stack[stack.length - 1]!;

      if (value === '' || value === '|') {
        // Nested object or multiline string
        if (value === '|') {
          inMultilineString = true;
          multilineIndent = indent;
          multilineContent = [];
          currentKey = key;
        } else {
          current.obj[key] = {};
          stack.push({ obj: current.obj[key] as Record<string, unknown>, indent });
        }
        currentKey = key;
      } else {
        current.obj[key] = parseValue(value);
        currentKey = key;
      }
    }
  }

  // Handle any remaining multiline string
  if (inMultilineString && currentKey) {
    const current = stack[stack.length - 1]!;
    current.obj[currentKey] = multilineContent.join('\n').trimEnd();
  }

  return result as ValidationConfigYAML;
}

/**
 * Parse a YAML value.
 */
function parseValue(value: string): unknown {
  // Remove quotes
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  // Boolean
  if (value === 'true') return true;
  if (value === 'false') return false;

  // Null
  if (value === 'null' || value === '~') return null;

  // Number
  const num = Number(value);
  if (!isNaN(num) && value !== '') return num;

  // Array inline [a, b, c]
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((v) => parseValue(v.trim()));
  }

  // String
  return value;
}

/**
 * Parse configuration from content string.
 */
export function parseConfigString(content: string): {
  config: ValidationPipelineConfig;
  errors: string[];
} {
  const errors: string[] = [];
  const loader = new ConfigLoader();

  try {
    const raw = parseConfigContent(content, 'config.yaml') as ValidationConfigYAML;
    const config = (loader as unknown as { transformConfig(raw: ValidationConfigYAML, errors: string[]): ValidationPipelineConfig }).transformConfig(raw, errors);
    return { config, errors };
  } catch (error) {
    errors.push(`Parse error: ${error instanceof Error ? error.message : String(error)}`);
    return { config: (loader as unknown as { getDefaultConfig(): ValidationPipelineConfig }).getDefaultConfig(), errors };
  }
}
