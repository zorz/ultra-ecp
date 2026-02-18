/**
 * Migration 007: Message Blocks
 *
 * Adds blocks_json column to messages table for persisting structured
 * stream blocks (thinking, tool executions) across sessions.
 */

import type { Migration } from './runner.ts';
import { debugLog } from '../../../debug.ts';

export const migration007MessageBlocks: Migration = {
  version: 7,
  name: 'message-blocks',

  up(db) {
    try {
      db.exec(`ALTER TABLE messages ADD COLUMN blocks_json TEXT`);
    } catch {
      // Column already exists
    }
    debugLog('[Migration 007] Added blocks_json column to messages');
  },

  down(db) {
    // SQLite can't easily drop columns; harmless if left
    debugLog('[Migration 007] Down (no-op for blocks_json column)');
  },
};

export default migration007MessageBlocks;
