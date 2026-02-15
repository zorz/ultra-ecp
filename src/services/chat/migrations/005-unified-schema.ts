/**
 * Migration 005: Unified Schema
 *
 * CLEAN BREAK migration that replaces the entire dual-schema system
 * (legacy chat_* tables + workflow_* tables) with a single unified schema.
 *
 * Key changes:
 * - Sessions unify chat_sessions + workflow_executions
 * - Messages unify chat_messages + context_items + execution_messages
 * - Tool calls unified with mandatory agent attribution
 * - New documents table for PRDs, assessments, vulnerabilities, specs, plans
 * - Todos evolved with agent attribution and document linkage
 * - Permissions unified across chat and workflow scopes
 * - Activity reconstructed from data tables (no separate activity log)
 *
 * This migration creates everything from scratch. Old databases should
 * be backed up before applying this migration.
 */

import type { Migration } from './runner.ts';
import { debugLog } from '../../../debug.ts';

const SCHEMA = `
-- ============================================================================
-- Agent Registry
-- ============================================================================

CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    role TEXT CHECK(role IN ('primary', 'specialist', 'reviewer', 'orchestrator')) DEFAULT 'primary',
    provider TEXT NOT NULL DEFAULT 'claude',
    model TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
    system_prompt TEXT,
    tools TEXT,             -- JSON array of allowed tool names
    persona TEXT,           -- JSON: {avatar?, color?}
    is_system INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);
CREATE INDEX IF NOT EXISTS idx_agents_role ON agents(role);
CREATE INDEX IF NOT EXISTS idx_agents_active ON agents(is_active);

-- Default agents
INSERT OR IGNORE INTO agents (id, name, description, role, provider, model, system_prompt, tools, is_system, created_at)
VALUES
    ('assistant', 'Assistant', 'General-purpose AI assistant for coding, analysis, and conversation', 'primary', 'claude', 'claude-sonnet-4-20250514',
     'You are a helpful AI assistant. You have access to tools to read, write, and edit files, search code, and run commands. Use these tools to help the user with their tasks.',
     '["Read", "Write", "Edit", "Glob", "Grep", "Bash"]', 1, unixepoch() * 1000),

    ('coder', 'Coder', 'Specialized agent for writing and modifying code', 'specialist', 'claude', 'claude-sonnet-4-20250514',
     'You are a skilled software engineer. Focus on writing clean, well-structured, correct code. Read relevant files before making changes to understand context.',
     '["Read", "Write", "Edit", "Glob", "Grep", "Bash"]', 1, unixepoch() * 1000),

    ('code-reviewer', 'Code Reviewer', 'Reviews code for correctness, style, and best practices', 'reviewer', 'claude', 'claude-sonnet-4-20250514',
     'You are a thorough code reviewer. Evaluate code changes for correctness, security, performance, and maintainability. Provide assessment as: VOTE: [approve|queue|critical] FEEDBACK: [details]',
     '["Read", "Glob", "Grep"]', 1, unixepoch() * 1000),

    ('architect', 'Architect', 'Reviews code from an architectural perspective', 'reviewer', 'claude', 'claude-sonnet-4-20250514',
     'You are a software architect. Review code from a high-level design perspective: system design, modularity, scalability, dependencies, patterns. Provide assessment as: VOTE: [approve|queue|critical] FEEDBACK: [details]',
     '["Read", "Glob", "Grep"]', 1, unixepoch() * 1000),

    ('planner', 'Planner', 'Helps break down tasks and create implementation plans', 'orchestrator', 'claude', 'claude-sonnet-4-20250514',
     'You are a technical planner. Break down complex tasks into manageable steps. Identify dependencies, prerequisites, and risks. Create clear, actionable plans.',
     '["Read", "Glob", "Grep"]', 1, unixepoch() * 1000),

    ('debugger', 'Debugger', 'Specialized in finding and fixing bugs', 'specialist', 'claude', 'claude-sonnet-4-20250514',
     'You are an expert debugger. Find and fix bugs using systematic debugging: reproduce, isolate, identify, fix, verify. Focus on root causes, not symptoms.',
     '["Read", "Write", "Edit", "Glob", "Grep", "Bash"]', 1, unixepoch() * 1000),

    ('security-auditor', 'Security Auditor', 'Identifies security vulnerabilities and recommends fixes', 'reviewer', 'claude', 'claude-sonnet-4-20250514',
     'You are a security auditor. Analyze code for vulnerabilities (OWASP Top 10, injection, auth issues, data exposure, etc.). Create vulnerability documents with severity ratings and remediation guidance.',
     '["Read", "Glob", "Grep"]', 1, unixepoch() * 1000);

-- ============================================================================
-- Workflows
-- ============================================================================

CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    source_type TEXT CHECK(source_type IN ('file', 'inline')) DEFAULT 'inline',
    source_path TEXT,
    definition TEXT,        -- JSON/YAML workflow definition
    trigger_type TEXT CHECK(trigger_type IN ('manual', 'on_message', 'on_file_change', 'scheduled')),
    trigger_config TEXT,    -- JSON trigger configuration
    is_system INTEGER DEFAULT 0,
    is_default INTEGER DEFAULT 0,
    agent_pool TEXT,        -- JSON array of agent IDs
    default_agent_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_workflows_name ON workflows(name);
CREATE INDEX IF NOT EXISTS idx_workflows_default ON workflows(is_default);

-- ============================================================================
-- Sessions (unified: every chat is a session, every workflow execution is a session)
-- ============================================================================

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT,

    -- Workflow linkage (NULL for simple chats)
    workflow_id TEXT,

    -- AI configuration
    provider TEXT NOT NULL DEFAULT 'claude',
    model TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
    system_prompt TEXT,

    -- Execution state
    status TEXT NOT NULL CHECK(status IN (
        'pending', 'active', 'running', 'paused', 'awaiting_input',
        'completed', 'failed', 'cancelled', 'archived'
    )) DEFAULT 'active',

    -- Workflow execution state
    current_node_id TEXT,
    iteration_count INTEGER DEFAULT 0,
    max_iterations INTEGER DEFAULT 10,

    -- Input/Output (for workflow executions)
    initial_input TEXT,
    final_output TEXT,
    error_message TEXT,

    -- Timestamps
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER,
    completed_at INTEGER,

    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_workflow ON sessions(workflow_id);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

-- ============================================================================
-- Session Agents (which agents participate in each session)
-- ============================================================================

CREATE TABLE IF NOT EXISTS session_agents (
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    role TEXT DEFAULT 'primary',
    joined_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    left_at INTEGER,

    PRIMARY KEY (session_id, agent_id),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_agents_agent ON session_agents(agent_id);

-- ============================================================================
-- Node Executions (workflow step instances)
-- ============================================================================

CREATE TABLE IF NOT EXISTS node_executions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    node_type TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN (
        'pending', 'running', 'completed', 'failed', 'skipped'
    )) DEFAULT 'pending',
    iteration_number INTEGER DEFAULT 0,
    input TEXT,
    output TEXT,
    agent_id TEXT,
    agent_name TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    duration_ms INTEGER,
    tokens_in INTEGER,
    tokens_out INTEGER,

    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_node_exec_session ON node_executions(session_id);
CREATE INDEX IF NOT EXISTS idx_node_exec_status ON node_executions(status);
CREATE INDEX IF NOT EXISTS idx_node_exec_agent ON node_executions(agent_id);

-- ============================================================================
-- Messages (unified: all communication in a session)
-- ============================================================================

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    node_execution_id TEXT,

    -- Role: who/what generated this message
    role TEXT NOT NULL CHECK(role IN (
        'user', 'assistant', 'system',
        'tool_call', 'tool_result', 'feedback'
    )),

    -- Content
    content TEXT NOT NULL,

    -- Agent attribution (populated for assistant/feedback messages)
    agent_id TEXT,
    agent_name TEXT,
    agent_role TEXT,

    -- Model info
    model TEXT,

    -- Token tracking
    input_tokens INTEGER,
    output_tokens INTEGER,
    tokens INTEGER,
    duration_ms INTEGER,

    -- Feedback-specific fields (when role = 'feedback')
    feedback_source_agent_id TEXT,
    feedback_target_agent_id TEXT,
    feedback_vote TEXT CHECK(feedback_vote IN ('critical', 'queue', 'approve')),
    feedback_status TEXT CHECK(feedback_status IN ('pending', 'addressed', 'queued', 'dismissed')),

    -- Context management
    is_active INTEGER DEFAULT 1,         -- 0 = compacted away
    compacted_into_id TEXT,              -- Reference to compaction summary message
    is_complete INTEGER DEFAULT 1,       -- 0 = still streaming

    -- Iteration tracking (for workflow loops)
    iteration_number INTEGER DEFAULT 0,

    -- Timestamps
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),

    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (node_execution_id) REFERENCES node_executions(id) ON DELETE SET NULL,
    FOREIGN KEY (compacted_into_id) REFERENCES messages(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(session_id, role);
CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id);
CREATE INDEX IF NOT EXISTS idx_messages_active ON messages(session_id, is_active);
CREATE INDEX IF NOT EXISTS idx_messages_node ON messages(node_execution_id);
CREATE INDEX IF NOT EXISTS idx_messages_streaming ON messages(session_id, is_complete) WHERE is_complete = 0;
CREATE INDEX IF NOT EXISTS idx_messages_feedback ON messages(session_id, role, feedback_status) WHERE role = 'feedback';

-- Full-text search on messages
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    content='messages',
    content_rowid='rowid'
);

-- Auto-sync triggers for FTS
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF content ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- ============================================================================
-- Tool Calls (unified with mandatory agent attribution)
-- ============================================================================

CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    message_id TEXT,
    node_execution_id TEXT,

    -- Agent that invoked the tool (always tracked)
    agent_id TEXT,
    agent_name TEXT,

    -- Tool info
    tool_name TEXT NOT NULL,
    input TEXT,             -- JSON
    output TEXT,            -- JSON

    -- Status lifecycle
    status TEXT NOT NULL CHECK(status IN (
        'pending', 'awaiting_permission', 'approved', 'denied',
        'running', 'success', 'error'
    )) DEFAULT 'pending',

    error_message TEXT,

    -- Timestamps
    started_at INTEGER DEFAULT (unixepoch() * 1000),
    completed_at INTEGER,

    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL,
    FOREIGN KEY (node_execution_id) REFERENCES node_executions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_status ON tool_calls(status);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_calls_agent ON tool_calls(agent_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_node ON tool_calls(node_execution_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_message ON tool_calls(message_id);

-- ============================================================================
-- Documents (PRDs, Assessments, Vulnerabilities, Specs, Plans, etc.)
-- ============================================================================

CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    agent_id TEXT,

    -- Type discriminator
    doc_type TEXT NOT NULL CHECK(doc_type IN (
        'prd',              -- Product Requirements Document
        'assessment',       -- Code review assessment
        'vulnerability',    -- Security vulnerability finding
        'spec',             -- Technical specification
        'plan',             -- Implementation plan
        'report',           -- General analysis report
        'decision',         -- Architecture decision record (ADR)
        'runbook',          -- Operational runbook
        'review',           -- Code review summary
        'note'              -- General note or annotation
    )),

    -- Content
    title TEXT NOT NULL,
    content TEXT NOT NULL,  -- Markdown body
    summary TEXT,           -- One-line summary for lists/cards

    -- Structured metadata (JSON, schema varies by doc_type)
    -- PRD: {features: [], acceptance_criteria: [], stakeholders: []}
    -- Vulnerability: {cwe: string, affected_files: [], attack_vector: string}
    -- Assessment: {score: number, areas: [], recommendations: []}
    -- Plan: {phases: [], dependencies: [], estimates: {}}
    metadata TEXT,

    -- Hierarchy (spec -> plan, prd -> spec, etc.)
    parent_id TEXT,

    -- Status tracking
    status TEXT DEFAULT 'draft' CHECK(status IN (
        'draft', 'active', 'in_review', 'approved',
        'rejected', 'completed', 'archived'
    )),

    -- Severity/priority (for vulns, assessments, PRDs)
    severity TEXT CHECK(severity IN ('info', 'low', 'medium', 'high', 'critical')),
    priority INTEGER DEFAULT 0,

    -- Review tracking
    reviewed_by_agent_id TEXT,
    review_status TEXT CHECK(review_status IN (
        'pending', 'approved', 'changes_requested', 'critical'
    )),

    -- File reference (for specs/plans stored as files)
    file_path TEXT,

    -- Validation criteria (from specs - how to verify completion)
    validation_criteria TEXT,

    -- Timestamps
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER,

    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL,
    FOREIGN KEY (parent_id) REFERENCES documents(id) ON DELETE SET NULL,
    FOREIGN KEY (reviewed_by_agent_id) REFERENCES agents(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(doc_type);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_agent ON documents(agent_id);
CREATE INDEX IF NOT EXISTS idx_documents_session ON documents(session_id);
CREATE INDEX IF NOT EXISTS idx_documents_parent ON documents(parent_id);
CREATE INDEX IF NOT EXISTS idx_documents_severity ON documents(severity) WHERE severity IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_review ON documents(review_status) WHERE review_status IS NOT NULL;

-- ============================================================================
-- Todos (with agent attribution and document linkage)
-- ============================================================================

CREATE TABLE IF NOT EXISTS todos (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    document_id TEXT,       -- Link to parent plan/spec document

    -- Agent attribution
    agent_id TEXT,          -- Who created this todo
    assigned_agent_id TEXT, -- Who should do this todo

    -- Content
    content TEXT NOT NULL,
    active_form TEXT,       -- Present continuous form for spinner display

    -- Status
    status TEXT NOT NULL CHECK(status IN (
        'pending', 'in_progress', 'completed', 'blocked'
    )) DEFAULT 'pending',

    -- Ordering
    order_index INTEGER DEFAULT 0,

    -- Timestamps
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER,
    completed_at INTEGER,

    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE SET NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL,
    FOREIGN KEY (assigned_agent_id) REFERENCES agents(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_todos_session ON todos(session_id);
CREATE INDEX IF NOT EXISTS idx_todos_document ON todos(document_id);
CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
CREATE INDEX IF NOT EXISTS idx_todos_agent ON todos(agent_id);
CREATE INDEX IF NOT EXISTS idx_todos_assigned ON todos(assigned_agent_id);

-- ============================================================================
-- Permissions (unified)
-- ============================================================================

CREATE TABLE IF NOT EXISTS permissions (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    workflow_id TEXT,

    tool_name TEXT NOT NULL,
    pattern TEXT,

    scope TEXT NOT NULL CHECK(scope IN (
        'once', 'session', 'workflow', 'project', 'global'
    )),

    decision TEXT NOT NULL CHECK(decision IN ('approved', 'denied')),

    granted_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    expires_at INTEGER,

    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_permissions_session ON permissions(session_id);
CREATE INDEX IF NOT EXISTS idx_permissions_tool ON permissions(tool_name);
CREATE INDEX IF NOT EXISTS idx_permissions_scope ON permissions(scope);
CREATE UNIQUE INDEX IF NOT EXISTS idx_permissions_unique ON permissions(
    tool_name, scope,
    COALESCE(session_id, ''),
    COALESCE(workflow_id, ''),
    COALESCE(pattern, '')
);

-- ============================================================================
-- Checkpoints (user approval/input points)
-- ============================================================================

CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    node_execution_id TEXT,

    checkpoint_type TEXT NOT NULL CHECK(checkpoint_type IN (
        'approval', 'arbiter', 'input_required', 'confirmation'
    )),

    prompt_message TEXT,
    options TEXT,           -- JSON array
    decision TEXT,
    feedback TEXT,

    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    decided_at INTEGER,

    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (node_execution_id) REFERENCES node_executions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_pending ON checkpoints(session_id, decided_at) WHERE decided_at IS NULL;

-- ============================================================================
-- Feedback Queue (CCA-style feedback management)
-- ============================================================================

CREATE TABLE IF NOT EXISTS feedback_queue (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,

    status TEXT NOT NULL CHECK(status IN (
        'queued', 'pending_review', 'addressed', 'dismissed'
    )) DEFAULT 'queued',

    priority INTEGER DEFAULT 0,

    surface_trigger TEXT CHECK(surface_trigger IN (
        'task_complete', 'iteration_end', 'manual', 'immediate'
    )) DEFAULT 'iteration_end',

    queued_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    surfaced_at INTEGER,
    resolved_at INTEGER,

    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_feedback_session ON feedback_queue(session_id);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback_queue(status);
CREATE INDEX IF NOT EXISTS idx_feedback_pending ON feedback_queue(session_id, status)
    WHERE status IN ('queued', 'pending_review');

-- ============================================================================
-- Review Panels (multi-reviewer voting)
-- ============================================================================

CREATE TABLE IF NOT EXISTS review_panels (
    id TEXT PRIMARY KEY,
    node_execution_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    config TEXT NOT NULL,        -- JSON: ReviewPanelConfig
    status TEXT NOT NULL DEFAULT 'pending',
    outcome TEXT,                -- PanelOutcome when completed
    summary TEXT,                -- JSON: AggregationSummary
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    error TEXT,

    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_review_panels_session ON review_panels(session_id);
CREATE INDEX IF NOT EXISTS idx_review_panels_status ON review_panels(status);

CREATE TABLE IF NOT EXISTS review_votes (
    id TEXT PRIMARY KEY,
    panel_id TEXT NOT NULL,
    reviewer_id TEXT NOT NULL,
    vote TEXT NOT NULL,          -- critical|request_changes|approve|abstain
    feedback TEXT NOT NULL,
    issues TEXT,                 -- JSON: ReviewIssue[]
    weight REAL NOT NULL DEFAULT 1.0,
    created_at INTEGER NOT NULL,

    FOREIGN KEY (panel_id) REFERENCES review_panels(id) ON DELETE CASCADE,
    FOREIGN KEY (reviewer_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_review_votes_panel ON review_votes(panel_id);
CREATE INDEX IF NOT EXISTS idx_review_votes_reviewer ON review_votes(reviewer_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_votes_unique ON review_votes(panel_id, reviewer_id);

-- ============================================================================
-- Compactions (context window management)
-- ============================================================================

CREATE TABLE IF NOT EXISTS compactions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    start_message_id TEXT,
    end_message_id TEXT,
    original_token_count INTEGER,
    compressed_token_count INTEGER,
    messages_compacted INTEGER,

    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),

    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_compactions_session ON compactions(session_id);
`;

const DROP_SCHEMA = `
DROP TABLE IF EXISTS review_votes;
DROP TABLE IF EXISTS review_panels;
DROP TABLE IF EXISTS feedback_queue;
DROP TABLE IF EXISTS checkpoints;
DROP TABLE IF EXISTS compactions;
DROP TABLE IF EXISTS todos;
DROP TABLE IF EXISTS documents;
DROP TABLE IF EXISTS tool_calls;
DROP TRIGGER IF EXISTS messages_fts_insert;
DROP TRIGGER IF EXISTS messages_fts_delete;
DROP TRIGGER IF EXISTS messages_fts_update;
DROP TABLE IF EXISTS messages_fts;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS node_executions;
DROP TABLE IF EXISTS session_agents;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS permissions;
DROP TABLE IF EXISTS workflows;
DROP TABLE IF EXISTS agents;
`;

export const migration005UnifiedSchema: Migration = {
  version: 5,
  name: 'unified-schema',

  up(db) {
    db.exec(SCHEMA);
    debugLog('[Migration 005] Created unified schema');
  },

  down(db) {
    db.exec(DROP_SCHEMA);
    debugLog('[Migration 005] Dropped unified schema');
  },
};

export default migration005UnifiedSchema;
