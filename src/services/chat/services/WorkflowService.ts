/**
 * WorkflowService - CRUD Operations for Workflows
 *
 * Manages workflow definitions stored in the database.
 * Workflows can be loaded from YAML files or stored inline.
 */

import { Database } from 'bun:sqlite';
import type {
  Workflow,
  StoredWorkflow,
  WorkflowDefinition,
  WorkflowTriggerType,
  TriggerConfig,
  CreateWorkflowOptions,
} from '../types/workflow-schema.ts';

/**
 * Options for listing workflows.
 */
export interface ListWorkflowsOptions {
  /** Filter by trigger type */
  triggerType?: WorkflowTriggerType;
  /** Include system workflows */
  includeSystem?: boolean;
  /** Limit number of results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

/**
 * Options for updating a workflow.
 */
export interface UpdateWorkflowOptions {
  name?: string;
  description?: string | null;
  definition?: WorkflowDefinition;
  triggerType?: WorkflowTriggerType;
  triggerConfig?: TriggerConfig;
  isDefault?: boolean;
  agentPool?: string[];
  defaultAgentId?: string;
}

/**
 * WorkflowService handles CRUD operations for workflow definitions.
 */
export class WorkflowService {
  constructor(private db: Database) {}

  /**
   * Create a new workflow.
   */
  createWorkflow(options: CreateWorkflowOptions): Workflow {
    const now = Date.now();
    const id = options.id ?? `workflow-${crypto.randomUUID()}`;

    const stored: StoredWorkflow = {
      id,
      name: options.name,
      description: options.description ?? null,
      source_type: options.sourceType ?? 'inline',
      source_path: options.sourcePath ?? null,
      definition: options.definition ? JSON.stringify(options.definition) : null,
      trigger_type: options.triggerType ?? null,
      trigger_config: options.triggerConfig ? JSON.stringify(options.triggerConfig) : null,
      is_system: options.isSystem ? 1 : 0,
      is_default: options.isDefault ? 1 : 0,
      agent_pool: options.agentPool ? JSON.stringify(options.agentPool) : null,
      default_agent_id: options.defaultAgentId ?? null,
      created_at: now,
      updated_at: null,
    };

    // If setting as default, clear other defaults first
    if (options.isDefault) {
      this.db.run('UPDATE workflows SET is_default = 0 WHERE is_default = 1');
    }

    this.db.run(
      `INSERT INTO workflows (
        id, name, description, source_type, source_path, definition,
        trigger_type, trigger_config, is_system, is_default,
        agent_pool, default_agent_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stored.id,
        stored.name,
        stored.description,
        stored.source_type,
        stored.source_path,
        stored.definition,
        stored.trigger_type,
        stored.trigger_config,
        stored.is_system,
        stored.is_default,
        stored.agent_pool,
        stored.default_agent_id,
        stored.created_at,
        stored.updated_at,
      ]
    );

    return this.mapStoredToWorkflow(stored);
  }

  /**
   * Get a workflow by ID.
   */
  getWorkflow(id: string): Workflow | null {
    const row = this.db.query(
      `SELECT id, name, description, source_type, source_path, definition,
              trigger_type, trigger_config, is_system, is_default,
              agent_pool, default_agent_id, created_at, updated_at
       FROM workflows WHERE id = ?`
    ).get(id) as StoredWorkflow | null;

    if (!row) return null;
    return this.mapStoredToWorkflow(row);
  }

  /**
   * Get a workflow by name.
   */
  getWorkflowByName(name: string): Workflow | null {
    const row = this.db.query(
      `SELECT id, name, description, source_type, source_path, definition,
              trigger_type, trigger_config, is_system, is_default,
              agent_pool, default_agent_id, created_at, updated_at
       FROM workflows WHERE name = ?`
    ).get(name) as StoredWorkflow | null;

    if (!row) return null;
    return this.mapStoredToWorkflow(row);
  }

  /**
   * List workflows with optional filtering.
   */
  listWorkflows(options: ListWorkflowsOptions = {}): Workflow[] {
    const { triggerType, includeSystem = true, limit = 100, offset = 0 } = options;

    let query = `
      SELECT id, name, description, source_type, source_path, definition,
             trigger_type, trigger_config, is_system, is_default,
             agent_pool, default_agent_id, created_at, updated_at
      FROM workflows
      WHERE 1=1
    `;
    const params: unknown[] = [];

    if (!includeSystem) {
      query += ' AND is_system = 0';
    }

    if (triggerType) {
      query += ' AND trigger_type = ?';
      params.push(triggerType);
    }

    query += ' ORDER BY is_default DESC, name ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.db.query(query).all(...(params as (string | number | null)[])) as StoredWorkflow[];
    return rows.map((row) => this.mapStoredToWorkflow(row));
  }

  /**
   * Update a workflow.
   */
  updateWorkflow(id: string, updates: UpdateWorkflowOptions): Workflow | null {
    const existing = this.getWorkflow(id);
    if (!existing) return null;

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

    if (updates.definition !== undefined) {
      sets.push('definition = ?');
      params.push(JSON.stringify(updates.definition));
    }

    if (updates.triggerType !== undefined) {
      sets.push('trigger_type = ?');
      params.push(updates.triggerType);
    }

    if (updates.triggerConfig !== undefined) {
      sets.push('trigger_config = ?');
      params.push(JSON.stringify(updates.triggerConfig));
    }

    if (updates.isDefault !== undefined) {
      // Clear other defaults first if setting this as default
      if (updates.isDefault) {
        this.db.run('UPDATE workflows SET is_default = 0 WHERE is_default = 1');
      }
      sets.push('is_default = ?');
      params.push(updates.isDefault ? 1 : 0);
    }

    if (updates.agentPool !== undefined) {
      sets.push('agent_pool = ?');
      params.push(JSON.stringify(updates.agentPool));
    }

    if (updates.defaultAgentId !== undefined) {
      sets.push('default_agent_id = ?');
      params.push(updates.defaultAgentId);
    }

    params.push(id);

    this.db.run(`UPDATE workflows SET ${sets.join(', ')} WHERE id = ?`, params as (string | number | null)[]);

    return this.getWorkflow(id);
  }

  /**
   * Delete a workflow.
   */
  deleteWorkflow(id: string): boolean {
    const result = this.db.run('DELETE FROM workflows WHERE id = ?', [id]);
    return result.changes > 0;
  }

  /**
   * Get the default workflow.
   */
  getDefaultWorkflow(): Workflow | null {
    const row = this.db.query(
      `SELECT id, name, description, source_type, source_path, definition,
              trigger_type, trigger_config, is_system, is_default,
              agent_pool, default_agent_id, created_at, updated_at
       FROM workflows WHERE is_default = 1 LIMIT 1`
    ).get() as StoredWorkflow | null;

    if (!row) return null;
    return this.mapStoredToWorkflow(row);
  }

  /**
   * Set a workflow as the default.
   */
  setDefaultWorkflow(id: string): boolean {
    const existing = this.getWorkflow(id);
    if (!existing) return false;

    // Clear existing default
    this.db.run('UPDATE workflows SET is_default = 0 WHERE is_default = 1');

    // Set new default
    this.db.run('UPDATE workflows SET is_default = 1, updated_at = ? WHERE id = ?', [
      Date.now(),
      id,
    ]);

    return true;
  }

  /**
   * Get system workflows.
   */
  getSystemWorkflows(): Workflow[] {
    const rows = this.db.query(
      `SELECT id, name, description, source_type, source_path, definition,
              trigger_type, trigger_config, is_system, is_default,
              agent_pool, default_agent_id, created_at, updated_at
       FROM workflows WHERE is_system = 1 ORDER BY name ASC`
    ).all() as StoredWorkflow[];

    return rows.map((row) => this.mapStoredToWorkflow(row));
  }

  /**
   * Check if a workflow exists.
   */
  exists(id: string): boolean {
    const row = this.db.query('SELECT 1 FROM workflows WHERE id = ?').get(id);
    return row !== null;
  }

  /**
   * Count workflows.
   */
  count(options: { includeSystem?: boolean } = {}): number {
    const { includeSystem = true } = options;

    let query = 'SELECT COUNT(*) as count FROM workflows';
    if (!includeSystem) {
      query += ' WHERE is_system = 0';
    }

    const result = this.db.query(query).get() as { count: number };
    return result.count;
  }

  /**
   * Map a stored workflow row to the domain Workflow type.
   */
  private mapStoredToWorkflow(stored: StoredWorkflow): Workflow {
    return {
      id: stored.id,
      name: stored.name,
      description: stored.description,
      sourceType: stored.source_type,
      sourcePath: stored.source_path,
      definition: stored.definition ? JSON.parse(stored.definition) : null,
      triggerType: stored.trigger_type,
      triggerConfig: stored.trigger_config ? JSON.parse(stored.trigger_config) : null,
      isSystem: stored.is_system === 1,
      isDefault: stored.is_default === 1,
      agentPool: stored.agent_pool ? JSON.parse(stored.agent_pool) : null,
      defaultAgentId: stored.default_agent_id,
      createdAt: stored.created_at,
      updatedAt: stored.updated_at,
    };
  }
}

/**
 * Create a new WorkflowService instance.
 */
export function createWorkflowService(db: Database): WorkflowService {
  return new WorkflowService(db);
}
