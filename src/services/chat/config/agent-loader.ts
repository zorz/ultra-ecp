/**
 * Agent Configuration Loader
 *
 * Loads agent configurations from YAML files with the following priority:
 * 1. Bundled defaults (config/agents.yaml)
 * 2. User global (~/.ultra/agents.yaml)
 * 3. Project local (.ultra/agents.yaml)
 *
 * Later files override earlier ones (agents are merged by ID).
 */

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { IAgentConfig } from '../types/agents.ts';
import {
  type AgentsConfig,
  type AgentConfigEntry,
  type AgentConfigLoadResult,
  validateAgentsConfig,
  toAgentConfig,
} from './agent-schema.ts';
import { debugLog, isDebugEnabled } from '../../../debug.ts';

// ============================================
// Constants
// ============================================

const ULTRA_DIR = join(homedir(), '.ultra');
const GLOBAL_AGENTS_FILE = join(ULTRA_DIR, 'agents.yaml');

/**
 * Get the path to the bundled agents config.
 */
function getBundledConfigPath(): string {
  // In production, this would be relative to the package
  // In development, it's in the config directory
  return join(process.cwd(), 'config', 'agents.yaml');
}

/**
 * Get the path to the project-local agents config.
 */
function getProjectConfigPath(projectPath: string): string {
  return join(projectPath, '.ultra', 'agents.yaml');
}

// ============================================
// Helpers
// ============================================

function log(msg: string): void {
  if (isDebugEnabled()) {
    debugLog(`[AgentLoader] ${msg}`);
  }
}

/**
 * Read and parse a YAML file.
 * Returns null if the file doesn't exist or is invalid.
 */
async function readYamlFile(path: string): Promise<{ data: unknown; error?: string } | null> {
  try {
    const content = await readFile(path, 'utf-8');
    const data = parseYaml(content);
    return { data };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null; // File doesn't exist
    }
    return { data: null, error: `Failed to parse ${path}: ${error}` };
  }
}

/**
 * Check if a file exists.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the default agents.yaml exists in ~/.ultra.
 * Creates it with default agents if it doesn't exist.
 * Also migrates legacy 'claude' → 'assistant' naming if needed.
 */
async function ensureDefaultAgentsConfig(): Promise<void> {
  try {
    if (await fileExists(GLOBAL_AGENTS_FILE)) {
      // Migrate legacy 'claude' primary agent → 'assistant'
      await migrateLegacyPrimaryAgent();
      return;
    }

    // Ensure ~/.ultra directory exists
    await mkdir(ULTRA_DIR, { recursive: true });

    // Get default config and convert to YAML
    const defaultConfig = getDefaultConfig();
    const yamlContent = `# Ultra Agent Configuration
#
# This file defines your AI agents.
# Customize these settings to modify agent behavior.
#
# Load priority: built-in defaults → this file → project local (.ultra/agents.yaml)
# Later files override earlier ones (agents are merged by ID).
#
# Documentation: https://ultra.dev/docs/agents

${stringifyYaml(defaultConfig, { indent: 2, lineWidth: 100 })}`;

    await writeFile(GLOBAL_AGENTS_FILE, yamlContent, 'utf-8');
    log(`Created default agents config at ${GLOBAL_AGENTS_FILE}`);
  } catch (error) {
    // Don't fail if we can't create the file - defaults will still work
    log(`Failed to create default agents config: ${error}`);
  }
}

/**
 * Migrate legacy configs that use id:'claude' as the primary agent.
 * Renames to id:'assistant', name:'Assistant' and keeps 'claude' as a trigger keyword.
 */
async function migrateLegacyPrimaryAgent(): Promise<void> {
  try {
    const content = await readFile(GLOBAL_AGENTS_FILE, 'utf-8');
    const config = parseYaml(content) as AgentsConfig | null;
    if (!config?.agents) return;

    const claudeAgent = config.agents.find(
      (a) => a.id === 'claude' && a.role === 'primary',
    );
    if (!claudeAgent) return; // No migration needed

    // Rename id and name
    claudeAgent.id = 'assistant';
    claudeAgent.name = 'Assistant';

    // Ensure 'claude' is kept as a trigger keyword so @Claude still works
    const keywords = new Set(claudeAgent.triggerKeywords || []);
    keywords.add('claude');
    keywords.add('assistant');
    claudeAgent.triggerKeywords = Array.from(keywords);

    // Update defaults.primary if it pointed to 'claude'
    if (config.defaults?.primary === 'claude') {
      config.defaults.primary = 'assistant';
    }

    const yamlContent = `# Ultra Agent Configuration
#
# This file defines your AI agents.
# Customize these settings to modify agent behavior.
#
# Load priority: built-in defaults → this file → project local (.ultra/agents.yaml)
# Later files override earlier ones (agents are merged by ID).
#
# Documentation: https://ultra.dev/docs/agents

${stringifyYaml(config, { indent: 2, lineWidth: 100 })}`;

    await writeFile(GLOBAL_AGENTS_FILE, yamlContent, 'utf-8');
    log(`Migrated legacy 'claude' primary agent to 'assistant' in ${GLOBAL_AGENTS_FILE}`);
  } catch (error) {
    log(`Failed to migrate legacy primary agent: ${error}`);
  }
}

/**
 * Merge two agent configurations.
 * The override config takes precedence for agent definitions with the same ID.
 */
function mergeConfigs(base: AgentsConfig, override: Partial<AgentsConfig>): AgentsConfig {
  const result: AgentsConfig = {
    version: override.version ?? base.version,
    defaults: {
      ...base.defaults,
      ...(override.defaults || {}),
    },
    agents: [...base.agents],
  };

  // Merge agents by ID
  if (override.agents) {
    const agentMap = new Map<string, AgentConfigEntry>();

    // Add base agents
    for (const agent of base.agents) {
      agentMap.set(agent.id, agent);
    }

    // Override with new agents
    for (const agent of override.agents) {
      const existing = agentMap.get(agent.id);
      if (existing) {
        // Merge agent properties
        agentMap.set(agent.id, {
          ...existing,
          ...agent,
          // Merge tools specially
          tools: agent.tools
            ? {
                allowed: agent.tools.allowed ?? existing.tools?.allowed,
                denied: agent.tools.denied ?? existing.tools?.denied,
              }
            : existing.tools,
          // Merge trigger keywords (combine arrays)
          triggerKeywords: agent.triggerKeywords
            ? [...new Set([...(existing.triggerKeywords || []), ...agent.triggerKeywords])]
            : existing.triggerKeywords,
        });
      } else {
        agentMap.set(agent.id, agent);
      }
    }

    result.agents = Array.from(agentMap.values());
  }

  return result;
}

/**
 * Get the default agent configuration.
 * These are the built-in agents that ship with Ultra.
 */
function getDefaultConfig(): AgentsConfig {
  return {
    version: 1,
    defaults: {
      primary: 'assistant',
    },
    agents: [
      {
        id: 'assistant',
        name: 'Assistant',
        role: 'primary',
        description: 'Primary AI assistant for general tasks',
        triggerKeywords: ['assistant', 'ai', 'help'],
      },
      {
        id: 'code-reviewer',
        name: 'Code Reviewer',
        role: 'specialist',
        description: 'Specialized in code review and best practices',
        triggerKeywords: ['reviewer', 'review', 'cr'],
        systemPrompt: `You are a code reviewer focused on quality, bugs, and best practices.

When reviewing code:
- Look for bugs, edge cases, and potential issues
- Check for security vulnerabilities
- Suggest improvements to code clarity and maintainability
- Point out violations of common coding standards
- Be constructive and specific in your feedback`,
        tools: {
          allowed: ['Read', 'Grep', 'Glob'],
          denied: ['Write', 'Edit', 'Bash'],
        },
      },
      {
        id: 'architect',
        name: 'Architect',
        role: 'specialist',
        description: 'Specialized in system design and architecture',
        triggerKeywords: ['architect', 'design', 'architecture'],
        systemPrompt: `You are a software architect focused on system design, scalability, and maintainability.

When discussing architecture:
- Consider scalability, reliability, and performance
- Suggest appropriate design patterns
- Think about separation of concerns and modularity
- Consider future maintenance and extensibility
- Evaluate trade-offs between different approaches`,
        tools: {
          allowed: ['Read', 'Grep', 'Glob'],
          denied: ['Write', 'Edit', 'Bash'],
        },
      },
      {
        id: 'planner',
        name: 'Planner',
        role: 'orchestrator',
        description: 'Breaks down tasks and coordinates work',
        triggerKeywords: ['planner', 'plan', 'breakdown'],
        systemPrompt: `You are a planning specialist who breaks down complex tasks into manageable steps.

When planning:
- Break large tasks into smaller, actionable items
- Identify dependencies between tasks
- Estimate complexity and suggest priorities
- Consider potential blockers and risks
- Create clear, measurable goals`,
      },
      {
        id: 'debugger',
        name: 'Debugger',
        role: 'specialist',
        description: 'Specialized in debugging and troubleshooting',
        triggerKeywords: ['debugger', 'debug', 'fix', 'bug'],
        systemPrompt: `You are a debugging specialist focused on finding and fixing issues.

When debugging:
- Systematically narrow down the root cause
- Look for common error patterns
- Check logs, stack traces, and error messages
- Verify assumptions about data and state
- Suggest minimal fixes that address the root cause`,
      },
      {
        id: 'agent-builder',
        name: 'Agent Builder',
        role: 'orchestrator',
        description: 'Guides you through creating agent personas and agency definitions',
        triggerKeywords: ['builder', 'agent-builder', 'create-agent', 'persona'],
        systemPrompt: `You are the Agent Builder — a guide for creating AI agent personas and agency definitions. Walk users through the persona pipeline stages one question at a time, saving progress with UpdatePersonaField after each answer. Use CompressPersona when all stages are complete.`,
        tools: {
          allowed: ['Read', 'Grep', 'Glob', 'UpdatePersonaField', 'UpdateAgencyField', 'CompressPersona'],
        },
      },
    ],
  };
}

// ============================================
// Main Functions
// ============================================

/**
 * Load agent configurations from all sources.
 *
 * @param projectPath - Path to the project root (for project-local config)
 * @returns Merged configuration with source information
 */
export async function loadAgentConfig(projectPath?: string): Promise<AgentConfigLoadResult> {
  const sources: string[] = [];
  const warnings: string[] = [];
  let config: AgentsConfig = getDefaultConfig();

  // Ensure default config exists in ~/.ultra (creates it if missing)
  await ensureDefaultAgentsConfig();

  // 1. Load bundled defaults
  const bundledPath = getBundledConfigPath();
  const bundled = await readYamlFile(bundledPath);

  if (bundled?.error) {
    warnings.push(bundled.error);
  } else if (bundled?.data) {
    const errors = validateAgentsConfig(bundled.data);
    if (errors.length > 0) {
      warnings.push(`Bundled config validation errors: ${errors.join('; ')}`);
    } else {
      config = bundled.data as AgentsConfig;
      sources.push(bundledPath);
      log(`Loaded bundled config from ${bundledPath}`);
    }
  }

  // 2. Load user global config
  const global = await readYamlFile(GLOBAL_AGENTS_FILE);

  if (global?.error) {
    warnings.push(global.error);
  } else if (global?.data) {
    const errors = validateAgentsConfig(global.data);
    if (errors.length > 0) {
      warnings.push(`Global config validation errors: ${errors.join('; ')}`);
    } else {
      config = mergeConfigs(config, global.data as Partial<AgentsConfig>);
      sources.push(GLOBAL_AGENTS_FILE);
      log(`Loaded global config from ${GLOBAL_AGENTS_FILE}`);
    }
  }

  // 3. Load project-local config
  if (projectPath) {
    const projectConfigPath = getProjectConfigPath(projectPath);
    const project = await readYamlFile(projectConfigPath);

    if (project?.error) {
      warnings.push(project.error);
    } else if (project?.data) {
      const errors = validateAgentsConfig(project.data);
      if (errors.length > 0) {
        warnings.push(`Project config validation errors: ${errors.join('; ')}`);
      } else {
        config = mergeConfigs(config, project.data as Partial<AgentsConfig>);
        sources.push(projectConfigPath);
        log(`Loaded project config from ${projectConfigPath}`);
      }
    }
  }

  // Validate final merged config
  const finalErrors = validateAgentsConfig(config);
  if (finalErrors.length > 0) {
    warnings.push(`Merged config validation errors: ${finalErrors.join('; ')}`);
  }

  return {
    config,
    sources,
    warnings,
  };
}

/**
 * Load agents as IAgentConfig array (ready for AgentManager).
 *
 * @param projectPath - Path to the project root (for project-local config)
 * @returns Array of agent configurations
 */
export async function loadAgents(projectPath?: string): Promise<{
  agents: IAgentConfig[];
  primaryAgentId: string;
  sources: string[];
  warnings: string[];
}> {
  const result = await loadAgentConfig(projectPath);

  return {
    agents: result.config.agents.map(toAgentConfig),
    primaryAgentId: result.config.defaults.primary,
    sources: result.sources,
    warnings: result.warnings,
  };
}

/**
 * Get the path where user should create their global agent config.
 */
export function getGlobalAgentConfigPath(): string {
  return GLOBAL_AGENTS_FILE;
}

/**
 * Get the path where user should create their project agent config.
 */
export function getProjectAgentConfigPath(projectPath: string): string {
  return getProjectConfigPath(projectPath);
}

/**
 * Update an agent's config in the appropriate YAML file.
 * Creates the file if it doesn't exist. Merges updates into the existing entry.
 *
 * @param agentId - The agent ID to update
 * @param updates - Partial agent config fields to merge
 * @param scope - 'global' writes to ~/.ultra/agents.yaml, 'project' writes to .ultra/agents.yaml
 * @param projectPath - Required when scope is 'project'
 * @returns The updated agent config entry
 */
export async function updateAgentInConfig(
  agentId: string,
  updates: Partial<Omit<AgentConfigEntry, 'id'>>,
  scope: 'global' | 'project' = 'global',
  projectPath?: string,
): Promise<AgentConfigEntry> {
  const filePath = scope === 'project' && projectPath
    ? getProjectConfigPath(projectPath)
    : GLOBAL_AGENTS_FILE;

  // Read existing config or create a minimal one
  let config: AgentsConfig;
  const existing = await readYamlFile(filePath);

  if (existing?.data && typeof existing.data === 'object') {
    config = existing.data as AgentsConfig;
    // Ensure agents array exists
    if (!Array.isArray(config.agents)) {
      config.agents = [];
    }
  } else {
    config = {
      version: 1,
      defaults: { primary: 'assistant' },
      agents: [],
    };
  }

  // Find or create the agent entry
  const idx = config.agents.findIndex(a => a.id === agentId);
  if (idx >= 0) {
    // Merge updates into existing entry
    const entry = config.agents[idx]!;
    if (updates.name !== undefined) entry.name = updates.name;
    if (updates.description !== undefined) entry.description = updates.description;
    if (updates.role !== undefined) entry.role = updates.role;
    if (updates.systemPrompt !== undefined) entry.systemPrompt = updates.systemPrompt;
    if (updates.model !== undefined) entry.model = updates.model;
    if (updates.provider !== undefined) entry.provider = updates.provider;
    if (updates.triggerKeywords !== undefined) entry.triggerKeywords = updates.triggerKeywords;
    if (updates.tools !== undefined) entry.tools = updates.tools;
    if (updates.maxTokens !== undefined) entry.maxTokens = updates.maxTokens;
    if (updates.temperature !== undefined) entry.temperature = updates.temperature;
    config.agents[idx] = entry;
  } else {
    // Create new entry — need at minimum id, name, role
    const newEntry: AgentConfigEntry = {
      id: agentId,
      name: updates.name || agentId,
      role: updates.role || 'specialist',
      ...updates,
    };
    config.agents.push(newEntry);
  }

  // Ensure directory exists
  const dir = filePath.substring(0, filePath.lastIndexOf('/'));
  await mkdir(dir, { recursive: true });

  // Write back
  const yamlContent = `# Ultra Agent Configuration\n# Modified by Ultra IDE\n\n${stringifyYaml(config, { indent: 2, lineWidth: 100 })}`;
  await writeFile(filePath, yamlContent, 'utf-8');
  log(`Updated agent ${agentId} in ${filePath}`);

  // Return the final entry
  const finalEntry = config.agents.find(a => a.id === agentId)!;
  return finalEntry;
}

/**
 * Create a sample agent configuration YAML string.
 */
export function getSampleAgentConfig(): string {
  return `# Ultra Agent Configuration
#
# Customize your AI agents for this project.
# See https://ultra.dev/docs/agents for documentation.

version: 1

defaults:
  # Which agent handles messages without explicit @mentions
  primary: claude

agents:
  # Override the default Claude agent
  - id: claude
    name: Claude
    role: primary
    description: Primary AI assistant customized for this project
    triggerKeywords:
      - claude
      - assistant
      - ai

  # Add a custom specialist agent
  - id: my-specialist
    name: My Specialist
    role: specialist
    description: Custom specialist for project-specific tasks
    triggerKeywords:
      - specialist
      - custom
    systemPrompt: |
      You are a specialist focused on [your domain].

      When working on tasks:
      - Focus on [specific concerns]
      - Follow [specific guidelines]
    tools:
      allowed:
        - Read
        - Grep
        - Glob
      denied:
        - Bash
`;
}
