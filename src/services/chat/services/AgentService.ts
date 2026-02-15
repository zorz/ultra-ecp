/**
 * AgentService - CRUD Operations for Agents
 *
 * Central agent registry for managing AI agent definitions.
 * Agents have system prompts, model configurations, and tool permissions.
 */

import { Database } from 'bun:sqlite';
import { debugLog } from '../../../debug.ts';
import type {
  Agent,
  StoredAgent,
  AgentRole,
  AgentPersona,
  AgentAgency,
  CreateAgentOptions,
  UpdateAgentOptions,
} from '../types/workflow-schema.ts';

/**
 * Options for listing agents.
 */
export interface ListAgentsOptions {
  /** Filter by role */
  role?: AgentRole;
  /** Include system agents */
  includeSystem?: boolean;
  /** Only active agents */
  activeOnly?: boolean;
  /** Limit number of results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

/**
 * AgentService handles CRUD operations for agent definitions.
 */
export class AgentService {
  constructor(private db: Database) {}

  /**
   * Create a new agent.
   */
  createAgent(options: CreateAgentOptions): Agent {
    const now = Date.now();
    const id = options.id ?? `agent-${crypto.randomUUID()}`;

    const stored: StoredAgent = {
      id,
      name: options.name,
      description: options.description ?? null,
      role: options.role ?? 'primary',
      provider: options.provider ?? 'claude',
      model: options.model ?? 'claude-sonnet-4-20250514',
      system_prompt: options.systemPrompt ?? null,
      tools: options.tools ? JSON.stringify(options.tools) : null,
      persona: options.persona ? JSON.stringify(options.persona) : null,
      persona_id: options.personaId ?? null,
      agency: options.agency ? JSON.stringify(options.agency) : null,
      is_system: options.isSystem ? 1 : 0,
      is_active: options.isActive !== false ? 1 : 0,
      created_at: now,
      updated_at: null,
    };

    this.db.run(
      `INSERT INTO agents (
        id, name, description, role, provider, model,
        system_prompt, tools, persona, persona_id, agency,
        is_system, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stored.id,
        stored.name,
        stored.description,
        stored.role,
        stored.provider,
        stored.model,
        stored.system_prompt,
        stored.tools,
        stored.persona,
        stored.persona_id,
        stored.agency,
        stored.is_system,
        stored.is_active,
        stored.created_at,
        stored.updated_at,
      ]
    );

    return this.mapStoredToAgent(stored);
  }

  /**
   * Get an agent by ID.
   */
  getAgent(id: string): Agent | null {
    const row = this.db.query(
      `SELECT id, name, description, role, provider, model,
              system_prompt, tools, persona, persona_id, agency,
              is_system, is_active, created_at, updated_at
       FROM agents WHERE id = ?`
    ).get(id) as StoredAgent | null;

    if (!row) return null;
    return this.mapStoredToAgent(row);
  }

  /**
   * Get an agent by name.
   */
  getAgentByName(name: string): Agent | null {
    const row = this.db.query(
      `SELECT id, name, description, role, provider, model,
              system_prompt, tools, persona, persona_id, agency,
              is_system, is_active, created_at, updated_at
       FROM agents WHERE name = ?`
    ).get(name) as StoredAgent | null;

    if (!row) return null;
    return this.mapStoredToAgent(row);
  }

  /**
   * List agents with optional filtering.
   */
  listAgents(options: ListAgentsOptions = {}): Agent[] {
    const { role, includeSystem = true, activeOnly = true, limit = 100, offset = 0 } = options;

    let query = `
      SELECT id, name, description, role, provider, model,
             system_prompt, tools, persona, persona_id, agency,
             is_system, is_active, created_at, updated_at
      FROM agents
      WHERE 1=1
    `;
    const params: unknown[] = [];

    if (!includeSystem) {
      query += ' AND is_system = 0';
    }

    if (activeOnly) {
      query += ' AND is_active = 1';
    }

    if (role) {
      query += ' AND role = ?';
      params.push(role);
    }

    query += ' ORDER BY is_system DESC, name ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.db.query(query).all(...(params as (string | number | null)[])) as StoredAgent[];
    return rows.map((row) => this.mapStoredToAgent(row));
  }

  /**
   * Update an agent.
   */
  updateAgent(id: string, updates: UpdateAgentOptions): Agent | null {
    const existing = this.getAgent(id);
    if (!existing) return null;

    // Don't allow modifying system agents
    if (existing.isSystem) {
      debugLog(`[AgentService] Cannot modify system agent: ${id}`);
      return existing;
    }

    const now = Date.now();
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    if (updates.name !== undefined) {
      sets.push('name = ?');
      params.push(updates.name);
    }

    if (updates.description !== undefined) {
      sets.push('description = ?');
      params.push(updates.description);
    }

    if (updates.role !== undefined) {
      sets.push('role = ?');
      params.push(updates.role);
    }

    if (updates.provider !== undefined) {
      sets.push('provider = ?');
      params.push(updates.provider);
    }

    if (updates.model !== undefined) {
      sets.push('model = ?');
      params.push(updates.model);
    }

    if (updates.systemPrompt !== undefined) {
      sets.push('system_prompt = ?');
      params.push(updates.systemPrompt);
    }

    if (updates.tools !== undefined) {
      sets.push('tools = ?');
      params.push(updates.tools ? JSON.stringify(updates.tools) : null);
    }

    if (updates.persona !== undefined) {
      sets.push('persona = ?');
      params.push(updates.persona ? JSON.stringify(updates.persona) : null);
    }

    if (updates.personaId !== undefined) {
      sets.push('persona_id = ?');
      params.push(updates.personaId);
    }

    if (updates.agency !== undefined) {
      sets.push('agency = ?');
      params.push(updates.agency ? JSON.stringify(updates.agency) : null);
    }

    if (updates.isActive !== undefined) {
      sets.push('is_active = ?');
      params.push(updates.isActive ? 1 : 0);
    }

    params.push(id);

    this.db.run(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`, params as (string | number | null)[]);

    return this.getAgent(id);
  }

  /**
   * Delete an agent.
   */
  deleteAgent(id: string): boolean {
    const existing = this.getAgent(id);
    if (!existing) return false;

    // Don't allow deleting system agents
    if (existing.isSystem) {
      debugLog(`[AgentService] Cannot delete system agent: ${id}`);
      return false;
    }

    const result = this.db.run('DELETE FROM agents WHERE id = ?', [id]);
    return result.changes > 0;
  }

  /**
   * Duplicate an agent (creates a copy with new ID).
   */
  duplicateAgent(id: string, newName?: string): Agent | null {
    const existing = this.getAgent(id);
    if (!existing) return null;

    return this.createAgent({
      name: newName ?? `${existing.name} (copy)`,
      description: existing.description ?? undefined,
      role: existing.role,
      provider: existing.provider,
      model: existing.model,
      systemPrompt: existing.systemPrompt ?? undefined,
      tools: existing.tools ?? undefined,
      persona: existing.persona ?? undefined,
      personaId: existing.personaId ?? undefined,
      agency: existing.agency ?? undefined,
      isSystem: false, // Duplicates are never system agents
      isActive: true,
    });
  }

  /**
   * Get system agents only.
   */
  getSystemAgents(): Agent[] {
    const rows = this.db.query(
      `SELECT id, name, description, role, provider, model,
              system_prompt, tools, persona, persona_id, agency,
              is_system, is_active, created_at, updated_at
       FROM agents WHERE is_system = 1 ORDER BY name ASC`
    ).all() as StoredAgent[];

    return rows.map((row) => this.mapStoredToAgent(row));
  }

  /**
   * Check if an agent exists.
   */
  exists(id: string): boolean {
    const row = this.db.query('SELECT 1 FROM agents WHERE id = ?').get(id);
    return row !== null;
  }

  /**
   * Count agents.
   */
  count(options: { includeSystem?: boolean; activeOnly?: boolean } = {}): number {
    const { includeSystem = true, activeOnly = false } = options;

    let query = 'SELECT COUNT(*) as count FROM agents WHERE 1=1';
    if (!includeSystem) {
      query += ' AND is_system = 0';
    }
    if (activeOnly) {
      query += ' AND is_active = 1';
    }

    const result = this.db.query(query).get() as { count: number };
    return result.count;
  }

  /**
   * Map a stored agent row to the domain Agent type.
   */
  private mapStoredToAgent(stored: StoredAgent): Agent {
    return {
      id: stored.id,
      name: stored.name,
      description: stored.description,
      role: stored.role,
      provider: stored.provider,
      model: stored.model,
      systemPrompt: stored.system_prompt,
      tools: stored.tools ? JSON.parse(stored.tools) : null,
      persona: stored.persona ? JSON.parse(stored.persona) : null,
      personaId: stored.persona_id,
      agency: stored.agency ? JSON.parse(stored.agency) : null,
      isSystem: stored.is_system === 1,
      isActive: stored.is_active === 1,
      createdAt: stored.created_at,
      updatedAt: stored.updated_at,
    };
  }
}

/**
 * Create a new AgentService instance.
 */
export function createAgentService(db: Database): AgentService {
  return new AgentService(db);
}
