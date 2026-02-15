/**
 * Framework Loader
 *
 * Loads ensemble framework definitions from YAML files.
 */

import type {
  FrameworkDefinition,
  AgentDefinition,
  FrameworkValidatorDefinition,
  WorkflowStep,
  FrameworkSettings,
  HumanRoleConfig,
  AgentRole,
} from './types.ts';
import {
  DEFAULT_FRAMEWORK_SETTINGS,
  DEFAULT_HUMAN_ROLE,
} from './types.ts';
import type { AIProviderType } from '../ai/types.ts';
import type { ValidationTrigger } from '../validation/types.ts';
import { debugLog, isDebugEnabled } from '../../debug.ts';

/**
 * Result of loading a framework.
 */
export interface LoadFrameworkResult {
  /** The loaded framework (or null if failed) */
  framework: FrameworkDefinition | null;
  /** Validation errors */
  errors: string[];
  /** Warnings */
  warnings: string[];
}

/**
 * Options for the framework loader.
 */
export interface FrameworkLoaderOptions {
  /** Base directory for framework files */
  baseDir: string;
  /** Whether to watch for changes */
  watch: boolean;
}

/**
 * Default loader options.
 */
const DEFAULT_OPTIONS: FrameworkLoaderOptions = {
  baseDir: '.ultra/frameworks',
  watch: false,
};

/**
 * Valid agent roles.
 */
const VALID_ROLES: AgentRole[] = ['coder', 'critic', 'arbiter', 'specialist', 'coordinator'];

/**
 * Valid providers.
 */
const VALID_PROVIDERS: AIProviderType[] = ['claude', 'openai', 'gemini', 'ollama'];

/**
 * Valid triggers.
 */
const VALID_TRIGGERS: ValidationTrigger[] = [
  'pre-tool', 'on-change', 'pre-write', 'post-tool', 'pre-commit', 'periodic', 'on-demand'
];

/**
 * Simple YAML parser for framework files.
 */
function parseSimpleYAML(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split('\n');
  const stack: Array<{ obj: Record<string, unknown>; indent: number }> = [{ obj: result, indent: -1 }];
  let currentArray: unknown[] | null = null;
  let currentArrayKey: string | null = null;
  let inMultilineString = false;
  let multilineKey: string | null = null;
  let multilineIndent = 0;
  let multilineValue = '';

  for (const line of lines) {
    // Handle multiline strings
    if (inMultilineString) {
      const lineIndent = line.search(/\S/);
      if (lineIndent >= multilineIndent && line.trim() !== '') {
        multilineValue += line.slice(multilineIndent) + '\n';
        continue;
      } else {
        // End of multiline string
        const current = stack[stack.length - 1]!;
        current.obj[multilineKey!] = multilineValue.trimEnd();
        inMultilineString = false;
        multilineKey = null;
        multilineValue = '';
      }
    }

    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) {
      continue;
    }

    const indent = line.search(/\S/);
    const trimmed = line.trim();

    // Pop stack for lower indentation
    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
      stack.pop();
      currentArray = null;
      currentArrayKey = null;
    }

    const current = stack[stack.length - 1]!;

    // Array item
    if (trimmed.startsWith('- ')) {
      const value = trimmed.slice(2).trim();

      // Check if this is an object in an array
      if (value.includes(':')) {
        const [key, val] = value.split(':').map((s) => s.trim());
        if (!currentArray) {
          currentArray = [];
          if (currentArrayKey) {
            current.obj[currentArrayKey] = currentArray;
          }
        }
        const newObj: Record<string, unknown> = {};
        newObj[key!] = parseValue(val ?? '');
        currentArray.push(newObj);
        stack.push({ obj: newObj, indent });
      } else {
        // Simple array value
        if (!currentArray) {
          currentArray = [];
          if (currentArrayKey) {
            current.obj[currentArrayKey] = currentArray;
          }
        }
        currentArray.push(parseValue(value));
      }
      continue;
    }

    // Key-value pair
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;

    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();

    // Multiline string indicator
    if (value === '|' || value === '>') {
      inMultilineString = true;
      multilineKey = key;
      multilineIndent = indent + 2;
      continue;
    }

    // Empty value indicates nested object or array
    if (value === '') {
      const newObj: Record<string, unknown> = {};
      current.obj[key] = newObj;
      stack.push({ obj: newObj, indent });
      currentArrayKey = key;
      currentArray = null;
    } else {
      current.obj[key] = parseValue(value);
      currentArray = null;
      currentArrayKey = null;
    }
  }

  return result;
}

/**
 * Parse a YAML value.
 */
function parseValue(value: string): unknown {
  // Handle arrays written inline: [a, b, c]
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',').map((s) => parseValue(s.trim()));
  }

  // Handle quoted strings
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  // Handle booleans
  if (value === 'true') return true;
  if (value === 'false') return false;

  // Handle null
  if (value === 'null' || value === '~') return null;

  // Handle numbers
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);

  // Default to string
  return value;
}

/**
 * Framework loader.
 */
export class FrameworkLoader {
  private options: FrameworkLoaderOptions;
  private loadedFrameworks: Map<string, FrameworkDefinition> = new Map();

  constructor(options: Partial<FrameworkLoaderOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[FrameworkLoader] ${msg}`);
    }
  }

  /**
   * Load a framework from a file.
   */
  async loadFromFile(filePath: string): Promise<LoadFrameworkResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      const content = await Bun.file(filePath).text();
      return this.loadFromString(content);
    } catch (error) {
      errors.push(`Failed to read file: ${error}`);
      return { framework: null, errors, warnings };
    }
  }

  /**
   * Load a framework from a string.
   */
  loadFromString(content: string): LoadFrameworkResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // Try JSON first
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(content);
      } catch {
        // Fall back to YAML
        raw = parseSimpleYAML(content);
      }

      // Extract framework object if nested
      const frameworkRaw = (raw.framework ?? raw) as Record<string, unknown>;

      // Parse and validate
      const framework = this.parseFramework(frameworkRaw, errors, warnings);

      if (errors.length > 0) {
        return { framework: null, errors, warnings };
      }

      this.loadedFrameworks.set(framework!.id, framework!);
      this.log(`Loaded framework: ${framework!.id}`);

      return { framework, errors, warnings };
    } catch (error) {
      errors.push(`Parse error: ${error}`);
      return { framework: null, errors, warnings };
    }
  }

  /**
   * Parse a framework definition.
   */
  private parseFramework(
    raw: Record<string, unknown>,
    errors: string[],
    warnings: string[]
  ): FrameworkDefinition | null {
    // Required fields
    const id = raw.id as string | undefined;
    if (!id) {
      errors.push('Framework missing required field: id');
      return null;
    }

    const name = (raw.name as string) ?? id;
    const description = (raw.description as string) ?? '';

    // Settings
    const rawSettings = (raw.settings ?? {}) as Record<string, unknown>;
    const settings = this.parseSettings(rawSettings, warnings);

    // Agents
    const rawAgents = (raw.agents ?? []) as Array<Record<string, unknown>>;
    const agents: AgentDefinition[] = [];
    for (const rawAgent of rawAgents) {
      const agent = this.parseAgent(rawAgent, errors);
      if (agent) {
        agents.push(agent);
      }
    }

    if (agents.length === 0) {
      errors.push('Framework must have at least one agent');
      return null;
    }

    // Validators
    const rawValidators = (raw.validators ?? []) as Array<Record<string, unknown>>;
    const validators: FrameworkValidatorDefinition[] = [];
    for (const rawValidator of rawValidators) {
      const validator = this.parseValidator(rawValidator, errors);
      if (validator) {
        validators.push(validator);
      }
    }

    // Workflow
    const rawWorkflow = (raw.workflow ?? []) as Array<Record<string, unknown>>;
    const workflow: WorkflowStep[] = [];
    for (const rawStep of rawWorkflow) {
      const step = this.parseWorkflowStep(rawStep, warnings);
      if (step) {
        workflow.push(step);
      }
    }

    // Human role
    const rawHumanRole = (raw.humanRole ?? {}) as Record<string, unknown>;
    const humanRole = this.parseHumanRole(rawHumanRole);

    return {
      id,
      name,
      description,
      settings,
      agents,
      validators,
      workflow,
      humanRole,
    };
  }

  /**
   * Parse framework settings.
   */
  private parseSettings(
    raw: Record<string, unknown>,
    warnings: string[]
  ): FrameworkSettings {
    const settings = { ...DEFAULT_FRAMEWORK_SETTINGS };

    if (raw.contextSharing) {
      const value = raw.contextSharing as string;
      if (value === 'shared' || value === 'isolated') {
        settings.contextSharing = value;
      } else {
        warnings.push(`Invalid contextSharing: ${value}, using default`);
      }
    }

    if (raw.executionModel) {
      const value = raw.executionModel as string;
      if (value === 'turn-based' || value === 'parallel') {
        settings.executionModel = value;
      } else {
        warnings.push(`Invalid executionModel: ${value}, using default`);
      }
    }

    if (raw.communicationPattern) {
      const value = raw.communicationPattern as string;
      if (value === 'shared-feed' || value === 'direct' || value === 'hierarchical') {
        settings.communicationPattern = value;
      } else {
        warnings.push(`Invalid communicationPattern: ${value}, using default`);
      }
    }

    return settings;
  }

  /**
   * Parse an agent definition.
   */
  private parseAgent(
    raw: Record<string, unknown>,
    errors: string[]
  ): AgentDefinition | null {
    const id = raw.id as string | undefined;
    if (!id) {
      errors.push('Agent missing required field: id');
      return null;
    }

    const role = raw.role as string | undefined;
    if (!role || !VALID_ROLES.includes(role as AgentRole)) {
      errors.push(`Agent ${id}: invalid role '${role}'`);
      return null;
    }

    const provider = raw.provider as string | undefined;
    if (!provider || !VALID_PROVIDERS.includes(provider as AIProviderType)) {
      errors.push(`Agent ${id}: invalid provider '${provider}'`);
      return null;
    }

    const model = raw.model as string | undefined;
    if (!model) {
      errors.push(`Agent ${id}: missing required field: model`);
      return null;
    }

    const systemPrompt = (raw.systemPrompt as string) ?? '';

    // Tools can be string array or string
    let tools: string[] = [];
    if (Array.isArray(raw.tools)) {
      tools = raw.tools.map(String);
    } else if (typeof raw.tools === 'string') {
      tools = raw.tools.split(',').map((s) => s.trim());
    }

    return {
      id,
      role: role as AgentRole,
      provider: provider as AIProviderType,
      model,
      systemPrompt,
      tools,
      apiKey: raw.apiKey as string | undefined,
      baseUrl: raw.baseUrl as string | undefined,
      options: raw.options as Record<string, unknown> | undefined,
    };
  }

  /**
   * Parse a validator definition.
   */
  private parseValidator(
    raw: Record<string, unknown>,
    errors: string[]
  ): FrameworkValidatorDefinition | null {
    const id = raw.id as string | undefined;
    if (!id) {
      errors.push('Validator missing required field: id');
      return null;
    }

    const type = raw.type as string | undefined;
    if (!type || (type !== 'static' && type !== 'ai-critic')) {
      errors.push(`Validator ${id}: invalid type '${type}'`);
      return null;
    }

    // Parse triggers
    let triggers: ValidationTrigger[] = [];
    if (Array.isArray(raw.triggers)) {
      triggers = raw.triggers.filter((t) =>
        VALID_TRIGGERS.includes(t as ValidationTrigger)
      ) as ValidationTrigger[];
    }

    const validator: FrameworkValidatorDefinition = {
      id,
      type: type as 'static' | 'ai-critic',
      triggers,
      blockOnFailure: raw.blockOnFailure as boolean | undefined,
    };

    if (type === 'ai-critic') {
      validator.provider = raw.provider as AIProviderType | undefined;
      validator.model = raw.model as string | undefined;
      validator.systemPrompt = raw.systemPrompt as string | undefined;
    } else {
      validator.command = raw.command as string | undefined;
    }

    return validator;
  }

  /**
   * Parse a workflow step.
   */
  private parseWorkflowStep(
    raw: Record<string, unknown>,
    _warnings: string[]
  ): WorkflowStep | null {
    const step = raw.step as string | undefined;
    if (!step) {
      return null;
    }

    return {
      step,
      agent: raw.agent as string | undefined,
      validators: raw.validators as string[] | undefined,
      parallel: raw.parallel as boolean | undefined,
      condition: raw.condition as WorkflowStep['condition'],
      action: raw.action as WorkflowStep['action'],
      next: raw.next as string | undefined,
      else: raw.else as string | undefined,
    };
  }

  /**
   * Parse human role configuration.
   */
  private parseHumanRole(raw: Record<string, unknown>): HumanRoleConfig {
    return {
      canInterrupt: (raw.canInterrupt as boolean) ?? DEFAULT_HUMAN_ROLE.canInterrupt,
      canRedirect: (raw.canRedirect as boolean) ?? DEFAULT_HUMAN_ROLE.canRedirect,
      promptForPermission: (raw.promptForPermission as string[]) ?? DEFAULT_HUMAN_ROLE.promptForPermission,
      escalateOnDisagreement: (raw.escalateOnDisagreement as boolean) ?? DEFAULT_HUMAN_ROLE.escalateOnDisagreement,
    };
  }

  /**
   * Get a loaded framework by ID.
   */
  getFramework(id: string): FrameworkDefinition | undefined {
    return this.loadedFrameworks.get(id);
  }

  /**
   * Get all loaded frameworks.
   */
  getFrameworks(): FrameworkDefinition[] {
    return Array.from(this.loadedFrameworks.values());
  }

  /**
   * List available framework files.
   */
  async listAvailable(): Promise<string[]> {
    const { Glob } = await import('bun');
    const glob = new Glob('**/*.{yaml,yml,json}');
    const files: string[] = [];

    for await (const file of glob.scan({ cwd: this.options.baseDir })) {
      files.push(file);
    }

    return files;
  }
}

/**
 * Create a new framework loader.
 */
export function createFrameworkLoader(
  options?: Partial<FrameworkLoaderOptions>
): FrameworkLoader {
  return new FrameworkLoader(options);
}

/**
 * Load a framework from a YAML/JSON string.
 */
export function parseFrameworkString(content: string): LoadFrameworkResult {
  const loader = new FrameworkLoader();
  return loader.loadFromString(content);
}
