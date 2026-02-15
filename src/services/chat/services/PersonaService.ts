/**
 * PersonaService - CRUD Operations for Personas
 *
 * Manages structured persona definitions with pipeline stages.
 * Personas define *who* an agent is (personality, principles, style).
 * They are reusable across multiple agents.
 */

import { Database } from 'bun:sqlite';
import { debugLog } from '../../../debug.ts';
import type {
  Persona,
  StoredPersona,
  PersonaPipelineStatus,
  PersonaProblemSpace,
  PersonaHighLevel,
  PersonaArchetype,
  PersonaPrinciples,
  PersonaTaste,
  CreatePersonaOptions,
  UpdatePersonaOptions,
} from '../types/workflow-schema.ts';

/**
 * Options for listing personas.
 */
export interface ListPersonasOptions {
  /** Filter by pipeline status */
  status?: PersonaPipelineStatus;
  /** Include system personas */
  includeSystem?: boolean;
  /** Limit number of results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

const SELECT_COLS = `id, name, description, problem_space, high_level, archetype,
  principles, taste, compressed, pipeline_status, avatar, color,
  is_system, created_at, updated_at`;

/**
 * PersonaService handles CRUD operations for persona definitions.
 */
export class PersonaService {
  constructor(private db: Database) {}

  /**
   * Create a new persona.
   */
  createPersona(options: CreatePersonaOptions): Persona {
    const now = Date.now();
    const id = options.id ?? `persona-${crypto.randomUUID()}`;

    const stored: StoredPersona = {
      id,
      name: options.name,
      description: options.description ?? null,
      problem_space: options.problemSpace ? JSON.stringify(options.problemSpace) : null,
      high_level: options.highLevel ? JSON.stringify(options.highLevel) : null,
      archetype: options.archetype ? JSON.stringify(options.archetype) : null,
      principles: options.principles ? JSON.stringify(options.principles) : null,
      taste: options.taste ? JSON.stringify(options.taste) : null,
      compressed: options.compressed ?? null,
      pipeline_status: options.pipelineStatus ?? 'draft',
      avatar: options.avatar ?? null,
      color: options.color ?? null,
      is_system: options.isSystem ? 1 : 0,
      created_at: now,
      updated_at: null,
    };

    this.db.run(
      `INSERT INTO personas (
        id, name, description, problem_space, high_level, archetype,
        principles, taste, compressed, pipeline_status, avatar, color,
        is_system, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stored.id,
        stored.name,
        stored.description,
        stored.problem_space,
        stored.high_level,
        stored.archetype,
        stored.principles,
        stored.taste,
        stored.compressed,
        stored.pipeline_status,
        stored.avatar,
        stored.color,
        stored.is_system,
        stored.created_at,
        stored.updated_at,
      ]
    );

    return this.mapStoredToPersona(stored);
  }

  /**
   * Get a persona by ID.
   */
  getPersona(id: string): Persona | null {
    const row = this.db.query(
      `SELECT ${SELECT_COLS} FROM personas WHERE id = ?`
    ).get(id) as StoredPersona | null;

    if (!row) return null;
    return this.mapStoredToPersona(row);
  }

  /**
   * List personas with optional filtering.
   */
  listPersonas(options: ListPersonasOptions = {}): Persona[] {
    const { status, includeSystem = true, limit = 100, offset = 0 } = options;

    let query = `SELECT ${SELECT_COLS} FROM personas WHERE 1=1`;
    const params: unknown[] = [];

    if (!includeSystem) {
      query += ' AND is_system = 0';
    }

    if (status) {
      query += ' AND pipeline_status = ?';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.db.query(query).all(...(params as (string | number | null)[])) as StoredPersona[];
    return rows.map((row) => this.mapStoredToPersona(row));
  }

  /**
   * Update a persona.
   */
  updatePersona(id: string, updates: UpdatePersonaOptions): Persona | null {
    const existing = this.getPersona(id);
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

    if (updates.problemSpace !== undefined) {
      sets.push('problem_space = ?');
      params.push(updates.problemSpace ? JSON.stringify(updates.problemSpace) : null);
    }

    if (updates.highLevel !== undefined) {
      sets.push('high_level = ?');
      params.push(updates.highLevel ? JSON.stringify(updates.highLevel) : null);
    }

    if (updates.archetype !== undefined) {
      sets.push('archetype = ?');
      params.push(updates.archetype ? JSON.stringify(updates.archetype) : null);
    }

    if (updates.principles !== undefined) {
      sets.push('principles = ?');
      params.push(updates.principles ? JSON.stringify(updates.principles) : null);
    }

    if (updates.taste !== undefined) {
      sets.push('taste = ?');
      params.push(updates.taste ? JSON.stringify(updates.taste) : null);
    }

    if (updates.compressed !== undefined) {
      sets.push('compressed = ?');
      params.push(updates.compressed);
    }

    if (updates.pipelineStatus !== undefined) {
      sets.push('pipeline_status = ?');
      params.push(updates.pipelineStatus);
    }

    if (updates.avatar !== undefined) {
      sets.push('avatar = ?');
      params.push(updates.avatar);
    }

    if (updates.color !== undefined) {
      sets.push('color = ?');
      params.push(updates.color);
    }

    params.push(id);

    this.db.run(`UPDATE personas SET ${sets.join(', ')} WHERE id = ?`, params as (string | number | null)[]);

    return this.getPersona(id);
  }

  /**
   * Delete a persona.
   */
  deletePersona(id: string): boolean {
    const existing = this.getPersona(id);
    if (!existing) return false;

    if (existing.isSystem) {
      debugLog(`[PersonaService] Cannot delete system persona: ${id}`);
      return false;
    }

    const result = this.db.run('DELETE FROM personas WHERE id = ?', [id]);
    return result.changes > 0;
  }

  /**
   * Duplicate a persona (creates a copy with new ID).
   */
  duplicatePersona(id: string, newName?: string): Persona | null {
    const existing = this.getPersona(id);
    if (!existing) return null;

    return this.createPersona({
      name: newName ?? `${existing.name} (copy)`,
      description: existing.description ?? undefined,
      problemSpace: existing.problemSpace ?? undefined,
      highLevel: existing.highLevel ?? undefined,
      archetype: existing.archetype ?? undefined,
      principles: existing.principles ?? undefined,
      taste: existing.taste ?? undefined,
      compressed: existing.compressed ?? undefined,
      pipelineStatus: 'draft',
      avatar: existing.avatar ?? undefined,
      color: existing.color ?? undefined,
      isSystem: false,
    });
  }

  /**
   * Check if a persona exists.
   */
  exists(id: string): boolean {
    const row = this.db.query('SELECT 1 FROM personas WHERE id = ?').get(id);
    return row !== null;
  }

  /**
   * Count personas.
   */
  count(options: { includeSystem?: boolean } = {}): number {
    const { includeSystem = true } = options;

    let query = 'SELECT COUNT(*) as count FROM personas WHERE 1=1';
    if (!includeSystem) {
      query += ' AND is_system = 0';
    }

    const result = this.db.query(query).get() as { count: number };
    return result.count;
  }

  /**
   * Map a stored persona row to the domain Persona type.
   */
  private mapStoredToPersona(stored: StoredPersona): Persona {
    return {
      id: stored.id,
      name: stored.name,
      description: stored.description,
      problemSpace: stored.problem_space ? JSON.parse(stored.problem_space) as PersonaProblemSpace : null,
      highLevel: stored.high_level ? JSON.parse(stored.high_level) as PersonaHighLevel : null,
      archetype: stored.archetype ? JSON.parse(stored.archetype) as PersonaArchetype : null,
      principles: stored.principles ? JSON.parse(stored.principles) as PersonaPrinciples : null,
      taste: stored.taste ? JSON.parse(stored.taste) as PersonaTaste : null,
      compressed: stored.compressed,
      pipelineStatus: stored.pipeline_status,
      avatar: stored.avatar,
      color: stored.color,
      isSystem: stored.is_system === 1,
      createdAt: stored.created_at,
      updatedAt: stored.updated_at,
    };
  }
}

/**
 * Create a new PersonaService instance.
 */
export function createPersonaService(db: Database): PersonaService {
  return new PersonaService(db);
}
