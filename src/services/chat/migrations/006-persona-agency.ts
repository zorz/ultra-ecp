/**
 * Migration 006: Persona & Agency
 *
 * Adds the personas table and extends agents with persona_id + agency fields.
 *
 * - personas: structured persona pipeline (problem space → compressed text)
 * - agents.persona_id: FK to personas table
 * - agents.agency: JSON structured agency definition
 */

import type { Migration } from './runner.ts';
import { debugLog } from '../../../debug.ts';

export const migration006PersonaAgency: Migration = {
  version: 6,
  name: 'persona-agency',

  up(db) {
    // Create the personas table
    db.exec(`
      CREATE TABLE IF NOT EXISTS personas (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          problem_space TEXT,
          high_level TEXT,
          archetype TEXT,
          principles TEXT,
          taste TEXT,
          compressed TEXT,
          pipeline_status TEXT NOT NULL DEFAULT 'draft'
            CHECK(pipeline_status IN ('draft','sketched','archetyped','principled','flavored','compressed','published')),
          avatar TEXT,
          color TEXT,
          is_system INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          updated_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_personas_name ON personas(name);
      CREATE INDEX IF NOT EXISTS idx_personas_status ON personas(pipeline_status);
    `);

    // Add persona_id and agency columns to agents table
    // Use try/catch for each ALTER TABLE since the column may already exist
    try {
      db.exec(`ALTER TABLE agents ADD COLUMN persona_id TEXT REFERENCES personas(id) ON DELETE SET NULL`);
    } catch {
      // Column already exists
    }

    try {
      db.exec(`ALTER TABLE agents ADD COLUMN agency TEXT`);
    } catch {
      // Column already exists
    }

    debugLog('[Migration 006] Created personas table and extended agents with persona_id/agency');
  },

  down(db) {
    // SQLite doesn't support DROP COLUMN before 3.35, so we recreate
    // For simplicity, just drop the personas table
    db.exec(`
      DROP TABLE IF EXISTS personas;
    `);
    // Note: persona_id and agency columns remain on agents (harmless, ignored)
    debugLog('[Migration 006] Dropped personas table');
  },
};

export default migration006PersonaAgency;
