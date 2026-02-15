/**
 * Agent Configuration Schema
 *
 * Defines the structure and validation for agent configuration files.
 */

import type { AgentRole, IAgentConfig } from '../types/agents.ts';
import type { AgentAgency } from '../types/workflow-schema.ts';

/**
 * Tool configuration for an agent.
 */
export interface AgentToolsConfig {
  /** Tools this agent can use (if specified, only these tools are available) */
  allowed?: string[];
  /** Tools this agent cannot use (applied after allowed list) */
  denied?: string[];
}

/**
 * Agent definition in YAML configuration.
 */
export interface AgentConfigEntry {
  /** Unique agent identifier */
  id: string;
  /** Display name for the agent */
  name: string;
  /** Role in the conversation */
  role: AgentRole;
  /** Description of the agent's expertise */
  description?: string;
  /** Keywords that trigger this agent (for @mention routing) */
  triggerKeywords?: string[];
  /** System prompt for this agent */
  systemPrompt?: string;
  /** Model to use for this agent (overrides session default) */
  model?: string;
  /** Provider to use for this agent (overrides session default) */
  provider?: string;
  /** Tool configuration */
  tools?: AgentToolsConfig;
  /** Maximum tokens for responses */
  maxTokens?: number;
  /** Temperature for responses */
  temperature?: number;
  /** Structured agency definition */
  agency?: AgentAgency;
  /** Reference to a persona ID */
  personaId?: string;
  /** Inline compressed persona text (alternative to personaId) */
  personaText?: string;
}

/**
 * Defaults section of agent configuration.
 */
export interface AgentConfigDefaults {
  /** Which agent handles messages without explicit @mentions */
  primary: string;
}

/**
 * Root agent configuration file structure.
 */
export interface AgentsConfig {
  /** Schema version for forward compatibility */
  version: number;
  /** Default settings */
  defaults: AgentConfigDefaults;
  /** Agent definitions */
  agents: AgentConfigEntry[];
}

/**
 * Result of loading agent configuration.
 */
export interface AgentConfigLoadResult {
  /** Merged configuration */
  config: AgentsConfig;
  /** Source files that were loaded (in priority order) */
  sources: string[];
  /** Any warnings encountered during loading */
  warnings: string[];
}

/**
 * Validate an agent configuration entry.
 * Returns an array of validation errors (empty if valid).
 */
export function validateAgentEntry(entry: unknown, index: number): string[] {
  const errors: string[] = [];
  const prefix = `agents[${index}]`;

  if (typeof entry !== 'object' || entry === null) {
    errors.push(`${prefix}: must be an object`);
    return errors;
  }

  const agent = entry as Record<string, unknown>;

  // Required fields
  if (typeof agent.id !== 'string' || agent.id.length === 0) {
    errors.push(`${prefix}.id: must be a non-empty string`);
  } else if (!/^[a-z0-9-]+$/.test(agent.id)) {
    errors.push(`${prefix}.id: must contain only lowercase letters, numbers, and hyphens`);
  }

  if (typeof agent.name !== 'string' || agent.name.length === 0) {
    errors.push(`${prefix}.name: must be a non-empty string`);
  }

  const validRoles: AgentRole[] = ['primary', 'specialist', 'reviewer', 'orchestrator'];
  if (!validRoles.includes(agent.role as AgentRole)) {
    errors.push(`${prefix}.role: must be one of: ${validRoles.join(', ')}`);
  }

  // Optional fields
  if (agent.description !== undefined && typeof agent.description !== 'string') {
    errors.push(`${prefix}.description: must be a string`);
  }

  if (agent.triggerKeywords !== undefined) {
    if (!Array.isArray(agent.triggerKeywords)) {
      errors.push(`${prefix}.triggerKeywords: must be an array`);
    } else {
      for (let i = 0; i < agent.triggerKeywords.length; i++) {
        if (typeof agent.triggerKeywords[i] !== 'string') {
          errors.push(`${prefix}.triggerKeywords[${i}]: must be a string`);
        }
      }
    }
  }

  if (agent.systemPrompt !== undefined && typeof agent.systemPrompt !== 'string') {
    errors.push(`${prefix}.systemPrompt: must be a string`);
  }

  if (agent.model !== undefined && typeof agent.model !== 'string') {
    errors.push(`${prefix}.model: must be a string`);
  }

  if (agent.provider !== undefined && typeof agent.provider !== 'string') {
    errors.push(`${prefix}.provider: must be a string`);
  }

  if (agent.tools !== undefined) {
    if (typeof agent.tools !== 'object' || agent.tools === null) {
      errors.push(`${prefix}.tools: must be an object`);
    } else {
      const tools = agent.tools as Record<string, unknown>;
      if (tools.allowed !== undefined) {
        if (!Array.isArray(tools.allowed)) {
          errors.push(`${prefix}.tools.allowed: must be an array`);
        } else {
          for (let i = 0; i < tools.allowed.length; i++) {
            if (typeof tools.allowed[i] !== 'string') {
              errors.push(`${prefix}.tools.allowed[${i}]: must be a string`);
            }
          }
        }
      }
      if (tools.denied !== undefined) {
        if (!Array.isArray(tools.denied)) {
          errors.push(`${prefix}.tools.denied: must be an array`);
        } else {
          for (let i = 0; i < tools.denied.length; i++) {
            if (typeof tools.denied[i] !== 'string') {
              errors.push(`${prefix}.tools.denied[${i}]: must be a string`);
            }
          }
        }
      }
    }
  }

  if (agent.maxTokens !== undefined && (typeof agent.maxTokens !== 'number' || agent.maxTokens <= 0)) {
    errors.push(`${prefix}.maxTokens: must be a positive number`);
  }

  if (agent.temperature !== undefined && (typeof agent.temperature !== 'number' || agent.temperature < 0 || agent.temperature > 2)) {
    errors.push(`${prefix}.temperature: must be a number between 0 and 2`);
  }

  return errors;
}

/**
 * Validate a full agent configuration.
 * Returns an array of validation errors (empty if valid).
 */
export function validateAgentsConfig(config: unknown): string[] {
  const errors: string[] = [];

  if (typeof config !== 'object' || config === null) {
    errors.push('Configuration must be an object');
    return errors;
  }

  const cfg = config as Record<string, unknown>;

  // Version
  if (typeof cfg.version !== 'number' || cfg.version < 1) {
    errors.push('version: must be a positive number');
  }

  // Defaults
  if (typeof cfg.defaults !== 'object' || cfg.defaults === null) {
    errors.push('defaults: must be an object');
  } else {
    const defaults = cfg.defaults as Record<string, unknown>;
    if (typeof defaults.primary !== 'string' || defaults.primary.length === 0) {
      errors.push('defaults.primary: must be a non-empty string');
    }
  }

  // Agents
  if (!Array.isArray(cfg.agents)) {
    errors.push('agents: must be an array');
  } else {
    // Check for duplicate IDs
    const ids = new Set<string>();
    for (let i = 0; i < cfg.agents.length; i++) {
      const agent = cfg.agents[i] as Record<string, unknown>;
      if (typeof agent?.id === 'string') {
        if (ids.has(agent.id)) {
          errors.push(`agents[${i}].id: duplicate ID "${agent.id}"`);
        }
        ids.add(agent.id);
      }

      // Validate individual agent
      errors.push(...validateAgentEntry(cfg.agents[i], i));
    }

    // Verify primary agent exists
    const defaults = cfg.defaults as Record<string, unknown>;
    if (typeof defaults?.primary === 'string' && !ids.has(defaults.primary)) {
      errors.push(`defaults.primary: agent "${defaults.primary}" not found in agents list`);
    }
  }

  return errors;
}

/**
 * Convert an agent config entry to IAgentConfig.
 */
export function toAgentConfig(entry: AgentConfigEntry): IAgentConfig {
  return {
    id: entry.id,
    name: entry.name,
    role: entry.role,
    description: entry.description,
    triggerKeywords: entry.triggerKeywords,
    systemPrompt: entry.systemPrompt,
    provider: entry.provider,
    model: entry.model,
    allowedTools: entry.tools?.allowed,
    deniedTools: entry.tools?.denied,
    maxTokens: entry.maxTokens,
    temperature: entry.temperature,
    agency: entry.agency,
    personaCompressed: entry.personaText,
  };
}
