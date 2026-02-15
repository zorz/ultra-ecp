/**
 * Migration 001: Workflow Schema
 *
 * Adds new tables for the unified workflow model.
 * DOES NOT modify any existing chat_* tables.
 *
 * New tables:
 * - workflows: Workflow definitions
 * - workflow_executions: Active/completed workflow runs
 * - node_executions: Individual node runs within a workflow
 * - context_items: Unified message/feedback storage
 * - workflow_tool_calls: Tool calls within workflow context
 * - workflow_permissions: Permission grants scoped to workflows
 * - checkpoints: User input/approval points
 * - feedback_queue: CCA-style feedback management
 */

import type { Migration } from './runner.ts';
import { debugLog } from '../../../debug.ts';

const SCHEMA = `
-- ============================================================================
-- Workflow Definitions
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,

    -- Source: 'file' for YAML files, 'inline' for stored definitions
    source_type TEXT CHECK(source_type IN ('file', 'inline')) DEFAULT 'inline',
    source_path TEXT,  -- Path to YAML file if source_type = 'file'
    definition TEXT,   -- JSON/YAML definition if source_type = 'inline'

    -- Trigger configuration
    trigger_type TEXT CHECK(trigger_type IN ('manual', 'on_message', 'on_file_change', 'scheduled')),
    trigger_config TEXT,  -- JSON config for trigger (e.g., file patterns, schedule)

    -- Flags
    is_system INTEGER DEFAULT 0,   -- Built-in workflow
    is_default INTEGER DEFAULT 0,  -- Default workflow for new chats

    -- Agent configuration
    agent_pool TEXT,         -- JSON array of agent IDs in pool
    default_agent_id TEXT,   -- Default agent for routing

    -- Timestamps
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_workflows_name ON workflows(name);
CREATE INDEX IF NOT EXISTS idx_workflows_default ON workflows(is_default);
CREATE INDEX IF NOT EXISTS idx_workflows_trigger ON workflows(trigger_type);

-- ============================================================================
-- Workflow Executions
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflow_executions (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,

    -- Link to legacy chat session (for backward compatibility)
    chat_session_id TEXT,

    -- Execution state
    status TEXT NOT NULL CHECK(status IN (
        'pending', 'running', 'paused', 'awaiting_input',
        'completed', 'failed', 'cancelled'
    )) DEFAULT 'pending',

    -- Current position in workflow
    current_node_id TEXT,

    -- Iteration tracking (for CCA loops)
    iteration_count INTEGER DEFAULT 0,
    max_iterations INTEGER DEFAULT 10,

    -- Input/Output
    initial_input TEXT,   -- JSON: initial user input
    final_output TEXT,    -- JSON: final result
    error_message TEXT,

    -- Timestamps
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER,
    completed_at INTEGER,

    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE,
    FOREIGN KEY (chat_session_id) REFERENCES chat_sessions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_executions_workflow ON workflow_executions(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_status ON workflow_executions(status);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_session ON workflow_executions(chat_session_id);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_created ON workflow_executions(created_at DESC);

-- ============================================================================
-- Node Executions
-- ============================================================================

CREATE TABLE IF NOT EXISTS node_executions (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,

    -- Node identification
    node_id TEXT NOT NULL,      -- ID from workflow definition
    node_type TEXT NOT NULL,    -- 'router', 'agent', 'permission_gate', 'checkpoint', 'decision'

    -- Execution state
    status TEXT NOT NULL CHECK(status IN (
        'pending', 'running', 'completed', 'failed', 'skipped'
    )) DEFAULT 'pending',

    -- Iteration tracking
    iteration_number INTEGER DEFAULT 0,

    -- Input/Output (JSON)
    input TEXT,
    output TEXT,

    -- Agent info (if node executed by agent)
    agent_id TEXT,
    agent_name TEXT,

    -- Metrics
    started_at INTEGER,
    completed_at INTEGER,
    duration_ms INTEGER,
    tokens_in INTEGER,
    tokens_out INTEGER,

    FOREIGN KEY (execution_id) REFERENCES workflow_executions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_node_executions_execution ON node_executions(execution_id);
CREATE INDEX IF NOT EXISTS idx_node_executions_node ON node_executions(node_id);
CREATE INDEX IF NOT EXISTS idx_node_executions_status ON node_executions(status);
CREATE INDEX IF NOT EXISTS idx_node_executions_agent ON node_executions(agent_id);

-- ============================================================================
-- Context Items (Unified Messages/Feedback)
-- ============================================================================

CREATE TABLE IF NOT EXISTS context_items (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    node_execution_id TEXT,

    -- Item type
    item_type TEXT NOT NULL CHECK(item_type IN (
        'user_input', 'agent_output', 'system',
        'tool_call', 'tool_result',
        'feedback', 'compaction'
    )),

    -- Role (for API compatibility)
    role TEXT CHECK(role IN ('user', 'assistant', 'system')),

    -- Content
    content TEXT NOT NULL,

    -- Agent attribution
    agent_id TEXT,
    agent_name TEXT,
    agent_role TEXT,

    -- Feedback-specific fields
    feedback_source_agent_id TEXT,   -- Agent that gave feedback
    feedback_target_agent_id TEXT,   -- Agent that should address feedback
    feedback_vote TEXT CHECK(feedback_vote IN ('critical', 'queue', 'approve')),
    feedback_status TEXT CHECK(feedback_status IN ('pending', 'addressed', 'queued', 'dismissed')),

    -- Iteration tracking
    iteration_number INTEGER DEFAULT 0,

    -- Visibility/compaction
    is_active INTEGER DEFAULT 1,         -- 0 = compacted away
    compacted_into_id TEXT,              -- Reference to compaction summary

    -- Token tracking
    tokens INTEGER,

    -- Streaming
    is_complete INTEGER DEFAULT 1,       -- 0 = still streaming

    -- Timestamps
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),

    FOREIGN KEY (execution_id) REFERENCES workflow_executions(id) ON DELETE CASCADE,
    FOREIGN KEY (node_execution_id) REFERENCES node_executions(id) ON DELETE SET NULL,
    FOREIGN KEY (compacted_into_id) REFERENCES context_items(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_context_items_execution ON context_items(execution_id);
CREATE INDEX IF NOT EXISTS idx_context_items_node ON context_items(node_execution_id);
CREATE INDEX IF NOT EXISTS idx_context_items_type ON context_items(item_type);
CREATE INDEX IF NOT EXISTS idx_context_items_active ON context_items(execution_id, is_active);
CREATE INDEX IF NOT EXISTS idx_context_items_feedback ON context_items(execution_id, item_type, feedback_status)
    WHERE item_type = 'feedback';
CREATE INDEX IF NOT EXISTS idx_context_items_created ON context_items(created_at);

-- ============================================================================
-- Workflow Tool Calls
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflow_tool_calls (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    node_execution_id TEXT,
    context_item_id TEXT,

    -- Tool info
    tool_name TEXT NOT NULL,
    input TEXT,      -- JSON
    output TEXT,     -- JSON

    -- Status
    status TEXT NOT NULL CHECK(status IN (
        'pending', 'awaiting_permission', 'approved', 'denied',
        'running', 'success', 'error'
    )) DEFAULT 'pending',

    error_message TEXT,

    -- Timestamps
    started_at INTEGER,
    completed_at INTEGER,

    FOREIGN KEY (execution_id) REFERENCES workflow_executions(id) ON DELETE CASCADE,
    FOREIGN KEY (node_execution_id) REFERENCES node_executions(id) ON DELETE SET NULL,
    FOREIGN KEY (context_item_id) REFERENCES context_items(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_tool_calls_execution ON workflow_tool_calls(execution_id);
CREATE INDEX IF NOT EXISTS idx_workflow_tool_calls_node ON workflow_tool_calls(node_execution_id);
CREATE INDEX IF NOT EXISTS idx_workflow_tool_calls_status ON workflow_tool_calls(status);
CREATE INDEX IF NOT EXISTS idx_workflow_tool_calls_tool ON workflow_tool_calls(tool_name);

-- ============================================================================
-- Workflow Permissions
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflow_permissions (
    id TEXT PRIMARY KEY,

    -- Scope: can be tied to execution, workflow, or global
    execution_id TEXT,
    workflow_id TEXT,

    -- Permission details
    tool_name TEXT NOT NULL,
    pattern TEXT,            -- Optional: file/path pattern

    -- Scope level
    scope TEXT NOT NULL CHECK(scope IN (
        'once', 'execution', 'workflow', 'project', 'global'
    )),

    -- Decision
    decision TEXT NOT NULL CHECK(decision IN ('approved', 'denied')),

    -- Timestamps
    granted_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    expires_at INTEGER,

    FOREIGN KEY (execution_id) REFERENCES workflow_executions(id) ON DELETE CASCADE,
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_permissions_execution ON workflow_permissions(execution_id);
CREATE INDEX IF NOT EXISTS idx_workflow_permissions_workflow ON workflow_permissions(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_permissions_tool ON workflow_permissions(tool_name);
CREATE INDEX IF NOT EXISTS idx_workflow_permissions_scope ON workflow_permissions(scope);

-- Unique constraint for permission lookup
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_permissions_unique ON workflow_permissions(
    tool_name,
    scope,
    COALESCE(execution_id, ''),
    COALESCE(workflow_id, ''),
    COALESCE(pattern, '')
);

-- ============================================================================
-- Checkpoints (User Input/Approval Points)
-- ============================================================================

CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    node_execution_id TEXT,

    -- Checkpoint type
    checkpoint_type TEXT NOT NULL CHECK(checkpoint_type IN (
        'approval',        -- Simple approve/reject
        'arbiter',         -- CCA arbiter decision
        'input_required',  -- Need user input
        'confirmation'     -- Confirm before proceeding
    )),

    -- Prompt shown to user
    prompt_message TEXT,

    -- Available options (JSON array)
    options TEXT,

    -- User's decision
    decision TEXT,
    feedback TEXT,

    -- Timestamps
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    decided_at INTEGER,

    FOREIGN KEY (execution_id) REFERENCES workflow_executions(id) ON DELETE CASCADE,
    FOREIGN KEY (node_execution_id) REFERENCES node_executions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_execution ON checkpoints(execution_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_pending ON checkpoints(execution_id, decided_at)
    WHERE decided_at IS NULL;

-- ============================================================================
-- Feedback Queue
-- ============================================================================

CREATE TABLE IF NOT EXISTS feedback_queue (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    context_item_id TEXT NOT NULL,

    -- Queue status
    status TEXT NOT NULL CHECK(status IN (
        'queued',           -- Waiting in queue
        'pending_review',   -- Surfaced to user
        'addressed',        -- Incorporated into next iteration
        'dismissed'         -- User dismissed
    )) DEFAULT 'queued',

    -- Priority (higher = more urgent)
    priority INTEGER DEFAULT 0,

    -- When to surface this feedback
    surface_trigger TEXT CHECK(surface_trigger IN (
        'task_complete',    -- Surface after current task
        'iteration_end',    -- Surface at end of iteration
        'manual',           -- Only when user asks
        'immediate'         -- Surface immediately
    )) DEFAULT 'iteration_end',

    -- Timestamps
    queued_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    surfaced_at INTEGER,
    resolved_at INTEGER,

    FOREIGN KEY (execution_id) REFERENCES workflow_executions(id) ON DELETE CASCADE,
    FOREIGN KEY (context_item_id) REFERENCES context_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_feedback_queue_execution ON feedback_queue(execution_id);
CREATE INDEX IF NOT EXISTS idx_feedback_queue_status ON feedback_queue(status);
CREATE INDEX IF NOT EXISTS idx_feedback_queue_pending ON feedback_queue(execution_id, status)
    WHERE status IN ('queued', 'pending_review');
`;

const DROP_SCHEMA = `
DROP TABLE IF EXISTS feedback_queue;
DROP TABLE IF EXISTS checkpoints;
DROP TABLE IF EXISTS workflow_permissions;
DROP TABLE IF EXISTS workflow_tool_calls;
DROP TABLE IF EXISTS context_items;
DROP TABLE IF EXISTS node_executions;
DROP TABLE IF EXISTS workflow_executions;
DROP TABLE IF EXISTS workflows;
`;

export const migration001WorkflowSchema: Migration = {
  version: 1,
  name: 'workflow-schema',

  up(db) {
    // Execute schema creation
    db.exec(SCHEMA);
    debugLog('[Migration 001] Created workflow schema tables');
  },

  down(db) {
    // Drop all new tables in reverse order
    db.exec(DROP_SCHEMA);
    debugLog('[Migration 001] Dropped workflow schema tables');
  },
};

export default migration001WorkflowSchema;
