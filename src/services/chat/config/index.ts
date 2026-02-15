/**
 * Agent Configuration Module
 *
 * Provides YAML-based agent configuration loading and validation.
 */

export {
  loadAgentConfig,
  loadAgents,
  getGlobalAgentConfigPath,
  getProjectAgentConfigPath,
  getSampleAgentConfig,
} from './agent-loader.ts';

export {
  type AgentConfigEntry,
  type AgentConfigDefaults,
  type AgentsConfig,
  type AgentConfigLoadResult,
  type AgentToolsConfig,
  validateAgentEntry,
  validateAgentsConfig,
  toAgentConfig,
} from './agent-schema.ts';
