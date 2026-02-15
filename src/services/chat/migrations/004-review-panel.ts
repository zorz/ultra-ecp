/**
 * Migration 004: Review Panel Tables
 *
 * Creates tables for multi-reviewer panels with vote collection and aggregation.
 * The review_panel node type enables N reviewers to vote on workflow artifacts.
 */

import { Database } from 'bun:sqlite';
import type { Migration } from './runner.ts';
import { debugLog } from '../../../debug.ts';

export const migration004ReviewPanel: Migration = {
  version: 4,
  name: 'review-panel',
  up(db: Database): void {
    // ─────────────────────────────────────────────────────────────────────────
    // Review Panel Executions
    // ─────────────────────────────────────────────────────────────────────────

    db.run(`
      CREATE TABLE IF NOT EXISTS review_panel_executions (
        id TEXT PRIMARY KEY,
        node_execution_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        config TEXT NOT NULL,            -- JSON: ReviewPanelConfig
        status TEXT NOT NULL DEFAULT 'pending',
        outcome TEXT,                     -- PanelOutcome when completed
        summary TEXT,                     -- JSON: AggregationSummary
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        error TEXT,

        FOREIGN KEY (execution_id) REFERENCES workflow_executions(id)
          ON DELETE CASCADE
      )
    `);

    // Index for querying panels by execution
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_review_panels_execution
      ON review_panel_executions(execution_id)
    `);

    // Index for querying panels by node execution
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_review_panels_node_execution
      ON review_panel_executions(node_execution_id)
    `);

    // Index for querying panels by status
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_review_panels_status
      ON review_panel_executions(status)
    `);

    // ─────────────────────────────────────────────────────────────────────────
    // Review Panel Votes
    // ─────────────────────────────────────────────────────────────────────────

    db.run(`
      CREATE TABLE IF NOT EXISTS review_panel_votes (
        id TEXT PRIMARY KEY,
        panel_execution_id TEXT NOT NULL,
        reviewer_id TEXT NOT NULL,        -- Agent ID of reviewer
        vote TEXT NOT NULL,               -- critical|request_changes|approve|abstain
        feedback TEXT NOT NULL,
        issues TEXT,                       -- JSON: ReviewIssue[]
        weight REAL NOT NULL DEFAULT 1.0,
        created_at INTEGER NOT NULL,

        FOREIGN KEY (panel_execution_id) REFERENCES review_panel_executions(id)
          ON DELETE CASCADE
      )
    `);

    // Index for querying votes by panel
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_review_votes_panel
      ON review_panel_votes(panel_execution_id)
    `);

    // Index for querying votes by reviewer
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_review_votes_reviewer
      ON review_panel_votes(reviewer_id)
    `);

    // Unique constraint: one vote per reviewer per panel
    db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_review_votes_unique
      ON review_panel_votes(panel_execution_id, reviewer_id)
    `);

    debugLog('[Migration 004] Created review panel tables');
  },

  down(db: Database): void {
    db.run('DROP TABLE IF EXISTS review_panel_votes');
    db.run('DROP TABLE IF EXISTS review_panel_executions');
    debugLog('[Migration 004] Dropped review panel tables');
  },
};
