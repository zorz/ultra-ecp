/**
 * Migration 002: Agent Registry
 *
 * Adds the agents table for the central agent registry.
 * Agents can be system-provided defaults or user-created.
 *
 * New tables:
 * - agents: Agent definitions with system prompts, model configs, etc.
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

    -- Role for visual identification
    role TEXT CHECK(role IN ('primary', 'specialist', 'reviewer', 'orchestrator')) DEFAULT 'primary',

    -- Model configuration
    provider TEXT NOT NULL DEFAULT 'claude',
    model TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',

    -- System prompt for this agent
    system_prompt TEXT,

    -- Tool permissions (JSON array of tool names)
    tools TEXT,

    -- Visual persona (JSON)
    persona TEXT,

    -- Flags
    is_system INTEGER DEFAULT 0,   -- Built-in agent
    is_active INTEGER DEFAULT 1,   -- Whether agent is available

    -- Timestamps
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);
CREATE INDEX IF NOT EXISTS idx_agents_role ON agents(role);
CREATE INDEX IF NOT EXISTS idx_agents_active ON agents(is_active);
CREATE INDEX IF NOT EXISTS idx_agents_system ON agents(is_system);

-- ============================================================================
-- Default Agents (inserted via migration)
-- ============================================================================

-- Primary assistant agent (default for simple chats)
INSERT OR IGNORE INTO agents (id, name, description, role, provider, model, system_prompt, tools, is_system, created_at)
VALUES (
    'assistant',
    'Assistant',
    'General-purpose AI assistant for coding, analysis, and conversation',
    'primary',
    'claude',
    'claude-sonnet-4-20250514',
    'You are a helpful AI assistant. You have access to tools to read, write, and edit files, search code, and run commands. Use these tools to help the user with their tasks.',
    '["Read", "Write", "Edit", "Glob", "Grep", "Bash"]',
    1,
    unixepoch() * 1000
);

-- Coder agent (specialized for code generation)
INSERT OR IGNORE INTO agents (id, name, description, role, provider, model, system_prompt, tools, is_system, created_at)
VALUES (
    'coder',
    'Coder',
    'Specialized agent for writing and modifying code',
    'specialist',
    'claude',
    'claude-sonnet-4-20250514',
    'You are a skilled software engineer. Your role is to write clean, well-structured, and correct code. Focus on:
- Following best practices and design patterns
- Writing readable and maintainable code
- Handling edge cases and errors gracefully
- Using appropriate data structures and algorithms

You have access to file tools to read existing code and write new code. Always read relevant files before making changes to understand the context.',
    '["Read", "Write", "Edit", "Glob", "Grep", "Bash"]',
    1,
    unixepoch() * 1000
);

-- Code Reviewer agent
INSERT OR IGNORE INTO agents (id, name, description, role, provider, model, system_prompt, tools, is_system, created_at)
VALUES (
    'code-reviewer',
    'Code Reviewer',
    'Reviews code for correctness, style, and best practices',
    'reviewer',
    'claude',
    'claude-sonnet-4-20250514',
    'You are a thorough code reviewer. Your role is to evaluate code changes and provide constructive feedback. Focus on:
- Correctness: Does the code work as intended?
- Security: Are there any vulnerabilities?
- Performance: Are there any inefficiencies?
- Maintainability: Is the code readable and well-organized?
- Best practices: Does it follow language/framework conventions?

When reviewing, provide your assessment as:
VOTE: [approve|queue|critical]
FEEDBACK: [your detailed feedback]

Use APPROVE for good code, QUEUE for minor improvements that can wait, CRITICAL for blocking issues.',
    '["Read", "Glob", "Grep"]',
    1,
    unixepoch() * 1000
);

-- Architect agent
INSERT OR IGNORE INTO agents (id, name, description, role, provider, model, system_prompt, tools, is_system, created_at)
VALUES (
    'architect',
    'Architect',
    'Reviews code from an architectural perspective',
    'reviewer',
    'claude',
    'claude-sonnet-4-20250514',
    'You are a software architect. Your role is to review code from a high-level design perspective. Focus on:
- System design: Does it fit the overall architecture?
- Modularity: Are concerns properly separated?
- Scalability: Will it handle growth?
- Dependencies: Are they appropriate and minimal?
- Patterns: Are design patterns used correctly?

When reviewing, provide your assessment as:
VOTE: [approve|queue|critical]
FEEDBACK: [your detailed feedback]

Use APPROVE for architecturally sound code, QUEUE for improvements that can wait, CRITICAL for design issues that must be addressed.',
    '["Read", "Glob", "Grep"]',
    1,
    unixepoch() * 1000
);

-- Planner agent
INSERT OR IGNORE INTO agents (id, name, description, role, provider, model, system_prompt, tools, is_system, created_at)
VALUES (
    'planner',
    'Planner',
    'Helps break down tasks and create implementation plans',
    'orchestrator',
    'claude',
    'claude-sonnet-4-20250514',
    'You are a technical planner. Your role is to help users break down complex tasks into manageable steps. Focus on:
- Understanding the full scope of the request
- Identifying dependencies and prerequisites
- Ordering tasks logically
- Estimating complexity and effort
- Identifying potential risks or blockers

Create clear, actionable plans that can be executed step by step.',
    '["Read", "Glob", "Grep"]',
    1,
    unixepoch() * 1000
);

-- Debugger agent
INSERT OR IGNORE INTO agents (id, name, description, role, provider, model, system_prompt, tools, is_system, created_at)
VALUES (
    'debugger',
    'Debugger',
    'Specialized in finding and fixing bugs',
    'specialist',
    'claude',
    'claude-sonnet-4-20250514',
    'You are an expert debugger. Your role is to help find and fix bugs in code. Focus on:
- Understanding the expected vs actual behavior
- Identifying the root cause, not just symptoms
- Tracing data flow and state changes
- Checking edge cases and error handling
- Verifying fixes don''t introduce new issues

Use systematic debugging: reproduce, isolate, identify, fix, verify.',
    '["Read", "Write", "Edit", "Glob", "Grep", "Bash"]',
    1,
    unixepoch() * 1000
);
`;

const DROP_SCHEMA = `
DROP TABLE IF EXISTS agents;
`;

export const migration003AgentRegistry: Migration = {
  version: 3,
  name: 'agent-registry',

  up(db) {
    db.exec(SCHEMA);
    debugLog('[Migration 003] Created agent registry with default agents');
  },

  down(db) {
    db.exec(DROP_SCHEMA);
    debugLog('[Migration 003] Dropped agent registry');
  },
};

export default migration003AgentRegistry;
