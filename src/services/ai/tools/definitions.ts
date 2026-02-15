/**
 * ECP Tool Definitions
 *
 * Defines tools that map to ECP methods.
 * These tools allow the AI to interact with the editor through ECP.
 */

import type { ToolDefinition, JSONSchema } from '../types.ts';

/**
 * File service tools.
 */
export const fileTools: ToolDefinition[] = [
  {
    name: 'file_read',
    description: 'Read the contents of a file',
    ecpMethod: 'file/read',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to read',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_write',
    description: 'Write content to a file (creates or overwrites)',
    ecpMethod: 'file/write',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to write',
        },
        content: {
          type: 'string',
          description: 'Content to write to the file',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'file_list',
    description: 'List files and directories in a path',
    ecpMethod: 'file/list',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to list',
        },
        recursive: {
          type: 'boolean',
          description: 'Whether to list recursively',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_exists',
    description: 'Check if a file or directory exists',
    ecpMethod: 'file/exists',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to check',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_delete',
    description: 'Delete a file or directory',
    ecpMethod: 'file/delete',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to delete',
        },
        recursive: {
          type: 'boolean',
          description: 'Whether to delete directories recursively',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_move',
    description: 'Move or rename a file or directory',
    ecpMethod: 'file/rename',
    inputSchema: {
      type: 'object',
      properties: {
        oldUri: {
          type: 'string',
          description: 'Source path (file:// URI or absolute path)',
        },
        newUri: {
          type: 'string',
          description: 'Destination path (file:// URI or absolute path)',
        },
      },
      required: ['oldUri', 'newUri'],
    },
  },
  {
    name: 'file_search',
    description: 'Search for files matching a pattern',
    ecpMethod: 'file/glob',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to match (e.g., "**/*.ts")',
        },
        cwd: {
          type: 'string',
          description: 'Directory to search from',
        },
      },
      required: ['pattern'],
    },
  },
];

/**
 * Document service tools.
 */
export const documentTools: ToolDefinition[] = [
  {
    name: 'document_open',
    description: 'Open a document in the editor',
    ecpMethod: 'document/open',
    inputSchema: {
      type: 'object',
      properties: {
        uri: {
          type: 'string',
          description: 'URI of the document to open (file:// or memory://)',
        },
        content: {
          type: 'string',
          description: 'Initial content (for memory:// documents)',
        },
      },
      required: ['uri'],
    },
  },
  {
    name: 'document_content',
    description: 'Get the content of an open document',
    ecpMethod: 'document/content',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: {
          type: 'string',
          description: 'Document ID',
        },
      },
      required: ['documentId'],
    },
  },
  {
    name: 'document_insert',
    description: 'Insert text at a position in a document',
    ecpMethod: 'document/insert',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: {
          type: 'string',
          description: 'Document ID',
        },
        position: {
          type: 'object',
          description: 'Position to insert at',
          properties: {
            line: { type: 'number', description: 'Line number (0-indexed)' },
            column: { type: 'number', description: 'Column number (0-indexed)' },
          },
          required: ['line', 'column'],
        },
        text: {
          type: 'string',
          description: 'Text to insert',
        },
      },
      required: ['documentId', 'position', 'text'],
    },
  },
  {
    name: 'document_replace',
    description: 'Replace text in a range',
    ecpMethod: 'document/replace',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: {
          type: 'string',
          description: 'Document ID',
        },
        range: {
          type: 'object',
          description: 'Range to replace',
          properties: {
            start: {
              type: 'object',
              properties: {
                line: { type: 'number' },
                column: { type: 'number' },
              },
            },
            end: {
              type: 'object',
              properties: {
                line: { type: 'number' },
                column: { type: 'number' },
              },
            },
          },
        },
        text: {
          type: 'string',
          description: 'Replacement text',
        },
      },
      required: ['documentId', 'range', 'text'],
    },
  },
];

/**
 * Git service tools.
 */
export const gitTools: ToolDefinition[] = [
  {
    name: 'git_status',
    description: 'Get git repository status',
    ecpMethod: 'git/status',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Repository path (defaults to workspace)',
        },
      },
    },
  },
  {
    name: 'git_diff',
    description: 'Get git diff for changes',
    ecpMethod: 'git/diff',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File or directory to diff',
        },
        staged: {
          type: 'boolean',
          description: 'Whether to show staged changes',
        },
      },
    },
  },
  {
    name: 'git_log',
    description: 'Get git commit history',
    ecpMethod: 'git/log',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of commits to return',
        },
        path: {
          type: 'string',
          description: 'Filter by file path',
        },
      },
    },
  },
  {
    name: 'git_stage',
    description: 'Stage files for commit',
    ecpMethod: 'git/stage',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          description: 'Paths to stage',
          items: { type: 'string' },
        },
      },
      required: ['paths'],
    },
  },
  {
    name: 'git_commit',
    description: 'Create a git commit',
    ecpMethod: 'git/commit',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Commit message',
        },
      },
      required: ['message'],
    },
  },
];

/**
 * Terminal service tools.
 */
export const terminalTools: ToolDefinition[] = [
  {
    name: 'terminal_execute',
    description: 'Execute a command in the terminal',
    ecpMethod: 'terminal/execute',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Command to execute',
        },
        cwd: {
          type: 'string',
          description: 'Working directory',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'terminal_spawn',
    description: 'Spawn a long-running process in its own terminal tab. Use this for dev servers, watchers, and other interactive processes.',
    ecpMethod: 'terminal/spawn',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Command to spawn',
        },
        cwd: {
          type: 'string',
          description: 'Working directory',
        },
        title: {
          type: 'string',
          description: 'Tab title for the terminal',
        },
      },
      required: ['command'],
    },
  },
];

/**
 * LSP service tools.
 */
export const lspTools: ToolDefinition[] = [
  {
    name: 'lsp_diagnostics',
    description: 'Get diagnostics (errors, warnings) for a document',
    ecpMethod: 'lsp/diagnostics',
    inputSchema: {
      type: 'object',
      properties: {
        uri: {
          type: 'string',
          description: 'Document URI',
        },
      },
      required: ['uri'],
    },
  },
  {
    name: 'lsp_definition',
    description: 'Go to definition of a symbol',
    ecpMethod: 'lsp/definition',
    inputSchema: {
      type: 'object',
      properties: {
        uri: {
          type: 'string',
          description: 'Document URI',
        },
        position: {
          type: 'object',
          properties: {
            line: { type: 'number' },
            column: { type: 'number' },
          },
        },
      },
      required: ['uri', 'position'],
    },
  },
  {
    name: 'lsp_references',
    description: 'Find all references to a symbol',
    ecpMethod: 'lsp/references',
    inputSchema: {
      type: 'object',
      properties: {
        uri: {
          type: 'string',
          description: 'Document URI',
        },
        position: {
          type: 'object',
          properties: {
            line: { type: 'number' },
            column: { type: 'number' },
          },
        },
      },
      required: ['uri', 'position'],
    },
  },
];

/**
 * Claude Code compatible tools.
 * These use the same names and input schemas as Claude Code tools.
 */
export const claudeCodeTools: ToolDefinition[] = [
  {
    name: 'Read',
    description: 'Read the contents of a file',
    ecpMethod: 'file/read',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The absolute path to the file to read',
        },
        offset: {
          type: 'number',
          description: 'Line number to start reading from (optional)',
        },
        limit: {
          type: 'number',
          description: 'Number of lines to read (optional)',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description: 'Write content to a file (creates or overwrites)',
    ecpMethod: 'file/write',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The absolute path to the file to write',
        },
        content: {
          type: 'string',
          description: 'The content to write to the file',
        },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'Edit',
    description: 'Perform exact string replacement in a file',
    ecpMethod: 'file/edit',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The absolute path to the file to modify',
        },
        old_string: {
          type: 'string',
          description: 'The text to replace',
        },
        new_string: {
          type: 'string',
          description: 'The text to replace it with',
        },
        replace_all: {
          type: 'boolean',
          description: 'Replace all occurrences (default false)',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Glob',
    description: 'Find files matching a glob pattern',
    ecpMethod: 'file/glob',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'The glob pattern to match files against',
        },
        path: {
          type: 'string',
          description: 'The directory to search in (optional)',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Grep',
    description: 'Search for text in files using regex',
    ecpMethod: 'file/grep',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'The regex pattern to search for',
        },
        path: {
          type: 'string',
          description: 'File or directory to search in (optional)',
        },
        glob: {
          type: 'string',
          description: 'Glob pattern to filter files (optional)',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Bash',
    description: 'Execute a shell command',
    ecpMethod: 'terminal/execute',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The command to execute',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (optional)',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'LS',
    description: 'List files and directories',
    ecpMethod: 'file/list',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to list',
        },
        recursive: {
          type: 'boolean',
          description: 'Whether to list recursively',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'TodoWrite',
    description:
      'Update the AI todo list for task tracking. Use this to create and manage a list of tasks. Each todo must have a content description and status.',
    ecpMethod: 'ai/todo/write',
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'Array of todo items to replace the current list',
          items: {
            type: 'object',
            properties: {
              content: {
                type: 'string',
                description: 'Brief description of the task (imperative form, e.g., "Fix authentication bug")',
              },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: 'Current status of the task',
              },
              activeForm: {
                type: 'string',
                description:
                  'Present continuous form shown in spinner when in_progress (e.g., "Fixing authentication bug")',
              },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
  {
    name: 'PlanCreate',
    description:
      'Create a new plan for a complex task. Plans are high-level strategies that break down into todos. Use this when starting a multi-step task that requires planning before implementation.',
    ecpMethod: 'chat/plan/create',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short title for the plan (e.g., "Implement user authentication")',
        },
        content: {
          type: 'string',
          description: 'The full plan content in markdown format. Include sections like Overview, Steps, Considerations.',
        },
        status: {
          type: 'string',
          enum: ['draft', 'active', 'completed', 'archived'],
          description: 'Plan status. Use "draft" for plans being developed, "active" for plans being executed.',
        },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'PlanUpdate',
    description:
      'Update an existing plan. Use this to modify the content, status, or title of a plan as work progresses.',
    ecpMethod: 'chat/plan/update',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The ID of the plan to update',
        },
        title: {
          type: 'string',
          description: 'New title for the plan (optional)',
        },
        content: {
          type: 'string',
          description: 'Updated plan content in markdown format (optional)',
        },
        status: {
          type: 'string',
          enum: ['draft', 'active', 'completed', 'archived'],
          description: 'New status for the plan (optional)',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'PlanRead',
    description:
      'List all plans for the current session. Use this to see existing plans and their status before creating new ones or to reference plan IDs.',
    ecpMethod: 'chat/plan/list',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['draft', 'active', 'completed', 'archived'],
          description: 'Filter by status (optional)',
        },
      },
    },
  },
  {
    name: 'SpecCreate',
    description:
      'Create a specification for a feature or project. Specifications are top-level documents that contain multiple plans. Use for large initiatives.',
    ecpMethod: 'chat/spec/create',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short title for the specification',
        },
        content: {
          type: 'string',
          description: 'The full specification content in markdown format. Include requirements, goals, constraints.',
        },
        status: {
          type: 'string',
          enum: ['draft', 'active', 'completed', 'archived'],
          description: 'Specification status',
        },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'SpecRead',
    description:
      'List all specifications for the current session, optionally with their linked plans and todos (hierarchy view).',
    ecpMethod: 'chat/spec/list',
    inputSchema: {
      type: 'object',
      properties: {
        includeHierarchy: {
          type: 'boolean',
          description: 'If true, include linked plans and todos for each specification',
        },
      },
    },
  },
  {
    name: 'TodoRead',
    description:
      'Read the current todo list for this session. Use this to see existing tasks and their status before updating them.',
    ecpMethod: 'ai/todo/get',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'PlanGet',
    description:
      'Get the full content of a specific plan by ID. Use this to read plan details before working on tasks within it.',
    ecpMethod: 'chat/plan/content',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The ID of the plan to retrieve',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'SpecUpdate',
    description:
      'Update an existing specification. Use this to modify the content, status, or title of a specification as work progresses.',
    ecpMethod: 'chat/spec/update',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The ID of the specification to update',
        },
        title: {
          type: 'string',
          description: 'New title for the specification (optional)',
        },
        content: {
          type: 'string',
          description: 'Updated specification content in markdown format (optional)',
        },
        status: {
          type: 'string',
          enum: ['draft', 'active', 'completed', 'archived'],
          description: 'New status for the specification (optional)',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'DocumentGet',
    description:
      'Get the full content of a specific document by ID. Use this to read document details, reports, assessments, or any previously created document.',
    ecpMethod: 'chat/document/get',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The ID of the document to retrieve',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'DocumentSearch',
    description:
      'Search documents by text query. Use this to find relevant documents, reports, assessments, or other stored content.',
    ecpMethod: 'chat/document/search',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to find relevant documents',
        },
        docType: {
          type: 'string',
          enum: ['prd', 'assessment', 'vulnerability', 'spec', 'plan', 'report', 'decision', 'runbook', 'review', 'note'],
          description: 'Filter by document type (optional)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'DocumentCreate',
    description:
      'Create a structured document and store it in the project document store. Use this instead of writing markdown files when producing analysis reports, assessments, reviews, decisions, runbooks, vulnerability reports, PRDs, or any other structured output. Documents are searchable, typed, and visible in the Activity panel.',
    ecpMethod: 'chat/document/create',
    inputSchema: {
      type: 'object',
      properties: {
        docType: {
          type: 'string',
          enum: ['prd', 'assessment', 'vulnerability', 'spec', 'plan', 'report', 'decision', 'runbook', 'review', 'note'],
          description: 'The type of document. Use "assessment" for audits/analysis, "vulnerability" for security findings, "report" for general reports, "review" for code reviews, "decision" for ADRs, "runbook" for operational guides, "note" for general notes.',
        },
        title: {
          type: 'string',
          description: 'Short descriptive title for the document',
        },
        content: {
          type: 'string',
          description: 'The full document content in markdown format',
        },
        summary: {
          type: 'string',
          description: 'Brief summary of the document (1-2 sentences)',
        },
        status: {
          type: 'string',
          enum: ['draft', 'active', 'in_review', 'approved', 'rejected', 'completed', 'archived'],
          description: 'Document status. Default: "active"',
        },
        severity: {
          type: 'string',
          enum: ['info', 'low', 'medium', 'high', 'critical'],
          description: 'Severity level (primarily for vulnerability and assessment documents)',
        },
        metadata: {
          type: 'object',
          description: 'Additional structured metadata (e.g., { "category": "security", "scope": "backend" })',
        },
      },
      required: ['docType', 'title', 'content'],
    },
  },
  {
    name: 'DocumentUpdate',
    description:
      'Update an existing document in the document store. Use this to modify content, status, or metadata of a previously created document.',
    ecpMethod: 'chat/document/update',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The ID of the document to update',
        },
        title: {
          type: 'string',
          description: 'New title (optional)',
        },
        content: {
          type: 'string',
          description: 'Updated content in markdown (optional)',
        },
        summary: {
          type: 'string',
          description: 'Updated summary (optional)',
        },
        status: {
          type: 'string',
          enum: ['draft', 'active', 'in_review', 'approved', 'rejected', 'completed', 'archived'],
          description: 'New status (optional)',
        },
        severity: {
          type: 'string',
          enum: ['info', 'low', 'medium', 'high', 'critical'],
          description: 'New severity (optional)',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'DocumentList',
    description:
      'List documents in the document store, optionally filtered by type. Use this to find existing documents before creating duplicates.',
    ecpMethod: 'chat/document/list',
    inputSchema: {
      type: 'object',
      properties: {
        docType: {
          type: 'string',
          enum: ['prd', 'assessment', 'vulnerability', 'spec', 'plan', 'report', 'decision', 'runbook', 'review', 'note'],
          description: 'Filter by document type (optional)',
        },
        status: {
          type: 'string',
          enum: ['draft', 'active', 'in_review', 'approved', 'rejected', 'completed', 'archived'],
          description: 'Filter by status (optional)',
        },
      },
    },
  },
];

/**
 * Chat history search tool.
 * Allows agents to search the conversation history for earlier messages,
 * decisions, or context from other agents.
 */
export const chatTools: ToolDefinition[] = [
  {
    name: 'SearchChatHistory',
    description:
      'Search the chat conversation history. Use this to find earlier messages, decisions, or context from other agents in the conversation.',
    ecpMethod: 'chat/message/search',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to find relevant messages',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10)',
        },
      },
      required: ['query'],
    },
  },
];

/**
 * DelegateToAgent tool for workflow agent-to-agent handoff.
 * Not added to allECPTools since it's a custom tool without an ECP method.
 * Registered directly by the workflow AI executor bridge.
 */
export const delegateToAgentTool: ToolDefinition = {
  name: 'DelegateToAgent',
  description: 'Delegate work to another agent. Use when a task requires expertise another agent is better suited for.',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'ID of the target agent' },
      message: { type: 'string', description: 'Task description for the target agent' },
      context: { type: 'string', description: 'Optional: additional context or partial work to pass along' },
    },
    required: ['agentId', 'message'],
  },
};

/**
 * Builder agent tools.
 * These are NOT added to allECPTools — they're agent-specific tools
 * registered globally but only available to the agent-builder via allowedTools.
 */
export const updatePersonaFieldTool: ToolDefinition = {
  name: 'UpdatePersonaField',
  description: `Update a specific pipeline stage on a persona. You MUST include all three parameters: personaId, field, and value.

Example calls:
- field="problemSpace", value={"domain":"Web dev","challenges":["scaling"],"targetAudience":"developers","context":"SaaS"}
- field="highLevel", value={"identity":"A senior engineer","expertise":["React","Node"],"communicationStyle":"Direct","values":["clarity"]}
- field="archetype", value={"name":"The Mentor","description":"Patient guide","strengths":["teaching"],"blindSpots":["impatience"]}
- field="principles", value={"principles":["Be clear"],"assumptions":["User knows basics"],"philosophy":"Simplicity first","antiPatterns":["Over-engineering"]}
- field="taste", value={"tone":"Friendly","verbosity":"moderate","formatting":"Uses bullet lists","personality":"Warm","examples":[]}
- field="name", value="My Persona Name"
- field="compressed", value="You are a senior engineer who..."`,
  inputSchema: {
    type: 'object',
    properties: {
      personaId: { type: 'string', description: 'ID of the persona to update' },
      field: {
        type: 'string',
        enum: ['problemSpace', 'highLevel', 'archetype', 'principles', 'taste', 'compressed', 'name', 'description', 'pipelineStatus', 'avatar', 'color'],
        description: 'Pipeline stage or field to update',
      },
      value: {
        type: 'object',
        description: 'The value to save. REQUIRED. For pipeline stages (problemSpace, highLevel, archetype, principles, taste), provide the full structured object. For name/description/compressed/avatar/color, provide the string as {"value": "the string"} or just pass the string directly.',
      },
    },
    required: ['personaId', 'field', 'value'],
  },
};

export const updateAgencyFieldTool: ToolDefinition = {
  name: 'UpdateAgencyField',
  description: 'Update a specific agency field on an agent. Use this to build structured agency definitions.',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'ID of the agent to update' },
      field: {
        type: 'string',
        description: 'Agency field to update: roleDescription, responsibilities, expectedOutputs, constraints, delegationRules',
      },
      value: { type: 'object', description: 'The value to set for the field' },
    },
    required: ['agentId', 'field', 'value'],
  },
};

export const createPersonaTool: ToolDefinition = {
  name: 'CreatePersona',
  description: 'Create a new persona. Returns the created persona with its ID, which you can then use with UpdatePersonaField to fill in pipeline stages.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name for the new persona' },
      description: { type: 'string', description: 'Brief description of what this persona is for (optional)' },
    },
    required: ['name'],
  },
};

export const compressPersonaTool: ToolDefinition = {
  name: 'CompressPersona',
  description: 'Generate compressed persona text from all pipeline stages. This synthesizes the problem space, high-level persona, archetype, principles, and taste into a concise system prompt fragment.',
  inputSchema: {
    type: 'object',
    properties: {
      personaId: { type: 'string', description: 'ID of the persona to compress' },
    },
    required: ['personaId'],
  },
};

/** All builder tools (registered globally, filtered by agent allowedTools) */
export const builderTools: ToolDefinition[] = [
  createPersonaTool,
  updatePersonaFieldTool,
  updateAgencyFieldTool,
  compressPersonaTool,
];

/**
 * All ECP tools combined.
 */
export const allECPTools: ToolDefinition[] = [
  ...fileTools,
  ...documentTools,
  ...gitTools,
  ...terminalTools,
  ...lspTools,
  ...claudeCodeTools,
  ...chatTools,
];

/**
 * Get tools by category.
 */
export function getToolsByCategory(category: string): ToolDefinition[] {
  switch (category) {
    case 'file':
      return fileTools;
    case 'document':
      return documentTools;
    case 'git':
      return gitTools;
    case 'terminal':
      return terminalTools;
    case 'lsp':
      return lspTools;
    default:
      return [];
  }
}

/**
 * Get a tool by name.
 */
export function getToolByName(name: string): ToolDefinition | undefined {
  return allECPTools.find((t) => t.name === name);
}
