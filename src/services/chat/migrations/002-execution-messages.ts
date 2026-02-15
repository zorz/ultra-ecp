/**
 * Migration 002: Execution Messages
 *
 * Adds the execution_messages table for unified chat model.
 * All user inputs and agent outputs are stored as messages in this table.
 * This enables the "all chats are workflows" architecture.
 */

import type { Migration } from './runner.ts';
import { debugLog } from '../../../debug.ts';

const SCHEMA = `
-- ============================================================================
-- Execution Messages (Unified Chat Model)
-- ============================================================================

CREATE TABLE IF NOT EXISTS execution_messages (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,

    -- Message role
    role TEXT NOT NULL CHECK(role IN ('user', 'agent', 'system')),

    -- Agent attribution (for agent messages)
    agent_id TEXT,
    agent_name TEXT,

    -- Message content
    content TEXT NOT NULL,

    -- Link to node execution that produced this message
    node_execution_id TEXT,

    -- Streaming support
    is_complete INTEGER DEFAULT 1,  -- 0 = still streaming

    -- Timestamps
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),

    FOREIGN KEY (execution_id) REFERENCES workflow_executions(id) ON DELETE CASCADE,
    FOREIGN KEY (node_execution_id) REFERENCES node_executions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_execution_messages_execution ON execution_messages(execution_id);
CREATE INDEX IF NOT EXISTS idx_execution_messages_role ON execution_messages(execution_id, role);
CREATE INDEX IF NOT EXISTS idx_execution_messages_agent ON execution_messages(agent_id);
CREATE INDEX IF NOT EXISTS idx_execution_messages_created ON execution_messages(execution_id, created_at);
CREATE INDEX IF NOT EXISTS idx_execution_messages_streaming ON execution_messages(execution_id, is_complete)
    WHERE is_complete = 0;
`;

const DROP_SCHEMA = `
DROP TABLE IF EXISTS execution_messages;
`;

export const migration002ExecutionMessages: Migration = {
  version: 2,
  name: 'execution-messages',

  up(db) {
    db.exec(SCHEMA);
    debugLog('[Migration 002] Created execution_messages table');
  },

  down(db) {
    db.exec(DROP_SCHEMA);
    debugLog('[Migration 002] Dropped execution_messages table');
  },
};

export default migration002ExecutionMessages;
