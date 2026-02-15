/**
 * Agent Storage Implementation
 *
 * Persists agent configurations to:
 * - ~/.ultra/agents/ for global agents
 * - .ultra/agents/ for project-scoped agents
 *
 * Each agent is stored as a JSON file named by its ID.
 */

import { readFile, writeFile, mkdir, readdir, unlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { debugLog } from '../../debug.ts';
import type { AgentScope } from './types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persisted agent data structure.
 */
export interface PersistedAgent {
  /** Unique agent ID */
  id: string;
  /** Role type from the registry */
  roleType: string;
  /** Display name */
  name: string;
  /** Optional description */
  description?: string;
  /** Persistence scope */
  scope: AgentScope;
  /** Creation timestamp (ISO string) */
  createdAt: string;
  /** Last activity timestamp (ISO string) */
  lastActiveAt: string;
  /** Number of runs */
  runCount: number;
  /** Configuration overrides */
  config: {
    provider?: string;
    model?: string;
    systemPrompt?: string;
    additionalCapabilities?: Record<string, unknown>;
    roleConfig?: Record<string, unknown>;
  };
  /** Agent metrics */
  metrics: {
    tasksCompleted: number;
    tasksFailed: number;
    avgResponseTime: number;
    totalTokens: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ULTRA_DIR = join(homedir(), '.ultra');
const GLOBAL_AGENTS_DIR = join(ULTRA_DIR, 'agents');

function log(msg: string): void {
  debugLog(`[AgentStorage] ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a path exists.
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the agents directory for a scope.
 */
function getAgentsDir(scope: AgentScope, projectPath?: string): string {
  if (scope === 'global') {
    return GLOBAL_AGENTS_DIR;
  }
  if (!projectPath) {
    throw new Error('Project path required for project-scoped agents');
  }
  return join(projectPath, '.ultra', 'agents');
}

/**
 * Get the file path for an agent.
 */
function getAgentPath(id: string, scope: AgentScope, projectPath?: string): string {
  const dir = getAgentsDir(scope, projectPath);
  return join(dir, `${id}.json`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Storage Class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handles persistence of agent configurations.
 */
export class AgentStorage {
  private projectPath?: string;

  constructor(projectPath?: string) {
    this.projectPath = projectPath;
  }

  /**
   * Set the project path (called when workspace changes).
   */
  setProjectPath(path: string): void {
    this.projectPath = path;
  }

  /**
   * Ensure the agents directory exists.
   */
  private async ensureDir(scope: AgentScope): Promise<string> {
    const dir = getAgentsDir(scope, this.projectPath);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * Save an agent to disk.
   */
  async save(agent: PersistedAgent): Promise<void> {
    await this.ensureDir(agent.scope);
    const path = getAgentPath(agent.id, agent.scope, this.projectPath);
    const content = JSON.stringify(agent, null, 2);
    await writeFile(path, content, 'utf-8');
    log(`Saved agent ${agent.id} to ${path}`);
  }

  /**
   * Load an agent by ID and scope.
   */
  async load(id: string, scope: AgentScope): Promise<PersistedAgent | null> {
    const path = getAgentPath(id, scope, this.projectPath);

    if (!await pathExists(path)) {
      return null;
    }

    try {
      const content = await readFile(path, 'utf-8');
      const agent = JSON.parse(content) as PersistedAgent;
      log(`Loaded agent ${id} from ${path}`);
      return agent;
    } catch (error) {
      log(`Failed to load agent ${id}: ${error}`);
      return null;
    }
  }

  /**
   * Load an agent by ID (searches both scopes).
   */
  async loadById(id: string): Promise<PersistedAgent | null> {
    // Try project first (higher priority)
    if (this.projectPath) {
      const projectAgent = await this.load(id, 'project');
      if (projectAgent) return projectAgent;
    }

    // Then try global
    return this.load(id, 'global');
  }

  /**
   * Delete an agent.
   */
  async delete(id: string, scope: AgentScope): Promise<boolean> {
    const path = getAgentPath(id, scope, this.projectPath);

    if (!await pathExists(path)) {
      return false;
    }

    try {
      await unlink(path);
      log(`Deleted agent ${id} from ${path}`);
      return true;
    } catch (error) {
      log(`Failed to delete agent ${id}: ${error}`);
      return false;
    }
  }

  /**
   * Delete an agent by ID (searches both scopes).
   */
  async deleteById(id: string): Promise<boolean> {
    // Try project first
    if (this.projectPath) {
      const deleted = await this.delete(id, 'project');
      if (deleted) return true;
    }

    // Then try global
    return this.delete(id, 'global');
  }

  /**
   * List all agents in a scope.
   */
  async listByScope(scope: AgentScope): Promise<PersistedAgent[]> {
    const dir = getAgentsDir(scope, this.projectPath);

    if (!await pathExists(dir)) {
      return [];
    }

    try {
      const files = await readdir(dir);
      const agents: PersistedAgent[] = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const path = join(dir, file);
        try {
          const content = await readFile(path, 'utf-8');
          const agent = JSON.parse(content) as PersistedAgent;
          agents.push(agent);
        } catch (error) {
          log(`Failed to load agent from ${path}: ${error}`);
        }
      }

      log(`Listed ${agents.length} agents from ${dir}`);
      return agents;
    } catch (error) {
      log(`Failed to list agents in ${dir}: ${error}`);
      return [];
    }
  }

  /**
   * List all agents (both scopes).
   */
  async listAll(): Promise<PersistedAgent[]> {
    const [global, project] = await Promise.all([
      this.listByScope('global'),
      this.projectPath ? this.listByScope('project') : Promise.resolve([]),
    ]);

    return [...global, ...project];
  }

  /**
   * List agents filtered by role type.
   */
  async listByRole(roleType: string): Promise<PersistedAgent[]> {
    const all = await this.listAll();
    return all.filter((a) => a.roleType === roleType);
  }

  /**
   * Update agent's last active timestamp and run count.
   */
  async updateActivity(id: string, scope: AgentScope): Promise<void> {
    const agent = await this.load(id, scope);
    if (!agent) return;

    agent.lastActiveAt = new Date().toISOString();
    agent.runCount += 1;
    await this.save(agent);
  }

  /**
   * Update agent metrics.
   */
  async updateMetrics(
    id: string,
    scope: AgentScope,
    metrics: Partial<PersistedAgent['metrics']>
  ): Promise<void> {
    const agent = await this.load(id, scope);
    if (!agent) return;

    agent.metrics = { ...agent.metrics, ...metrics };
    await this.save(agent);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton Instance
// ─────────────────────────────────────────────────────────────────────────────

let storageInstance: AgentStorage | null = null;

/**
 * Get the agent storage instance.
 */
export function getAgentStorage(projectPath?: string): AgentStorage {
  if (!storageInstance) {
    storageInstance = new AgentStorage(projectPath);
  } else if (projectPath && projectPath !== storageInstance['projectPath']) {
    storageInstance.setProjectPath(projectPath);
  }
  return storageInstance;
}

/**
 * Initialize agent storage with project path.
 */
export function initAgentStorage(projectPath?: string): AgentStorage {
  storageInstance = new AgentStorage(projectPath);
  return storageInstance;
}
