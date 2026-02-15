/**
 * Tool Translator
 *
 * Provides translation between canonical ECP tool definitions and
 * provider-specific tool formats. This allows us to define tools once
 * and automatically adapt them for different AI providers.
 */

import type { ToolDefinition, ToolUseContent } from '../types.ts';
import { debugLog, isDebugEnabled } from '../../../debug.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical ECP tool definition.
 * These are our internal standard tools with consistent naming.
 */
/** Schema property type for nested definitions */
interface SchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: SchemaProperty;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}

export interface ECPToolDefinition {
  /** Internal ECP tool name (e.g., 'file.read', 'file.edit') */
  name: string;
  /** Human-readable description */
  description: string;
  /** ECP method to call (e.g., 'file/read') */
  ecpMethod: string;
  /** JSON Schema for input parameters */
  inputSchema: {
    type: 'object';
    properties: Record<string, SchemaProperty>;
    required?: string[];
  };
  /** Tool category for grouping */
  category: 'file' | 'terminal' | 'git' | 'lsp' | 'ai' | 'document';
}

/**
 * Provider tool mapping configuration.
 */
export interface ProviderToolMapping {
  /** Provider's tool name */
  providerName: string;
  /** Canonical ECP tool name */
  ecpName: string;
  /** Optional input parameter name mappings (provider -> ecp) */
  inputMappings?: Record<string, string>;
  /** Optional output transformation */
  outputTransform?: (result: unknown) => unknown;
}

/**
 * Tool translator interface.
 */
export interface ToolTranslator {
  /** Provider identifier */
  readonly providerId: string;

  /**
   * Convert canonical ECP tools to provider-specific format.
   */
  toProviderTools(ecpTools: ECPToolDefinition[]): ToolDefinition[];

  /**
   * Map an incoming tool call from the provider to ECP format.
   * Returns the ECP method and transformed parameters.
   */
  mapToolCall(toolCall: ToolUseContent): {
    ecpMethod: string;
    params: Record<string, unknown>;
  } | null;

  /**
   * Check if a provider tool name is supported.
   */
  isSupported(providerToolName: string): boolean;

  /**
   * Get the ECP tool name for a provider tool name.
   */
  getECPToolName(providerToolName: string): string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical ECP Tools
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical ECP tool definitions.
 * These are provider-agnostic and use consistent naming.
 */
export const canonicalECPTools: ECPToolDefinition[] = [
  // File operations
  {
    name: 'file.read',
    description: 'Read the contents of a file',
    ecpMethod: 'file/read',
    category: 'file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' },
        offset: { type: 'number', description: 'Line number to start reading from' },
        limit: { type: 'number', description: 'Number of lines to read' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file.write',
    description: 'Write content to a file (creates or overwrites)',
    ecpMethod: 'file/write',
    category: 'file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'file.edit',
    description: 'Perform exact string replacement in a file',
    ecpMethod: 'file/edit',
    category: 'file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' },
        old_string: { type: 'string', description: 'Text to find and replace' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'file.glob',
    description: 'Find files matching a glob pattern',
    ecpMethod: 'file/glob',
    category: 'file',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match' },
        path: { type: 'string', description: 'Directory to search in' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'file.grep',
    description: 'Search for text in files using regex',
    ecpMethod: 'file/grep',
    category: 'file',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'File or directory to search' },
        glob: { type: 'string', description: 'Glob pattern to filter files' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'file.list',
    description: 'List files and directories',
    ecpMethod: 'file/list',
    category: 'file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to list' },
        recursive: { type: 'boolean', description: 'List recursively' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file.exists',
    description: 'Check if a file or directory exists',
    ecpMethod: 'file/exists',
    category: 'file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to check' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file.delete',
    description: 'Delete a file',
    ecpMethod: 'file/delete',
    category: 'file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to delete' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file.rename',
    description: 'Rename or move a file',
    ecpMethod: 'file/rename',
    category: 'file',
    inputSchema: {
      type: 'object',
      properties: {
        oldPath: { type: 'string', description: 'Current file path' },
        newPath: { type: 'string', description: 'New file path' },
      },
      required: ['oldPath', 'newPath'],
    },
  },
  {
    name: 'file.mkdir',
    description: 'Create a directory',
    ecpMethod: 'file/mkdir',
    category: 'file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to create' },
        recursive: { type: 'boolean', description: 'Create parent directories if needed' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file.deleteDir',
    description: 'Delete a directory',
    ecpMethod: 'file/deleteDir',
    category: 'file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to delete' },
        recursive: { type: 'boolean', description: 'Delete recursively' },
      },
      required: ['path'],
    },
  },

  // Terminal operations
  {
    name: 'terminal.execute',
    description: 'Execute a shell command',
    ecpMethod: 'terminal/execute',
    category: 'terminal',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to execute' },
        cwd: { type: 'string', description: 'Working directory' },
        timeout: { type: 'number', description: 'Timeout in milliseconds' },
      },
      required: ['command'],
    },
  },
  {
    name: 'terminal.spawn',
    description: 'Spawn a long-running process in its own terminal tab',
    ecpMethod: 'terminal/spawn',
    category: 'terminal',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to spawn' },
        cwd: { type: 'string', description: 'Working directory' },
        title: { type: 'string', description: 'Tab title for the terminal' },
      },
      required: ['command'],
    },
  },

  // AI operations
  {
    name: 'ai.todo',
    description:
      'Update the AI todo list for task tracking. Use this to create and manage a list of tasks. Each todo must have a content description and status.',
    ecpMethod: 'ai/todo/write',
    category: 'ai',
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
    name: 'ai.plan.create',
    description:
      'Create a new plan for a complex task. Plans are high-level strategies that break down into todos.',
    ecpMethod: 'chat/plan/create',
    category: 'ai',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the plan' },
        content: { type: 'string', description: 'Full plan content in markdown format' },
        status: {
          type: 'string',
          enum: ['draft', 'active', 'completed', 'archived'],
          description: 'Plan status',
        },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'ai.plan.update',
    description: 'Update an existing plan.',
    ecpMethod: 'chat/plan/update',
    category: 'ai',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The ID of the plan to update' },
        title: { type: 'string', description: 'New title (optional)' },
        content: { type: 'string', description: 'Updated content (optional)' },
        status: {
          type: 'string',
          enum: ['draft', 'active', 'completed', 'archived'],
          description: 'New status (optional)',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'ai.plan.list',
    description: 'List all plans for the current session.',
    ecpMethod: 'chat/plan/list',
    category: 'ai',
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
    name: 'ai.spec.create',
    description:
      'Create a specification for a feature or project. Specifications contain multiple plans.',
    ecpMethod: 'chat/spec/create',
    category: 'ai',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the specification' },
        content: { type: 'string', description: 'Full specification content in markdown' },
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
    name: 'ai.spec.list',
    description: 'List all specifications for the current session.',
    ecpMethod: 'chat/spec/list',
    category: 'ai',
    inputSchema: {
      type: 'object',
      properties: {
        includeHierarchy: {
          type: 'boolean',
          description: 'Include linked plans and todos',
        },
      },
    },
  },
  // Todo read
  {
    name: 'ai.todo.read',
    description: 'Read the current todo list for this session.',
    ecpMethod: 'ai/todo/get',
    category: 'ai',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  // Plan get (content)
  {
    name: 'ai.plan.get',
    description: 'Get the full content of a specific plan by ID.',
    ecpMethod: 'chat/plan/content',
    category: 'ai',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The ID of the plan to retrieve' },
      },
      required: ['id'],
    },
  },
  // Spec update
  {
    name: 'ai.spec.update',
    description: 'Update an existing specification.',
    ecpMethod: 'chat/spec/update',
    category: 'ai',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Specification ID to update' },
        title: { type: 'string', description: 'New title' },
        content: { type: 'string', description: 'Updated content' },
        status: {
          type: 'string',
          enum: ['draft', 'active', 'completed', 'archived'],
          description: 'New status',
        },
      },
      required: ['id'],
    },
  },
  // Document get
  {
    name: 'ai.document.get',
    description: 'Get the full content of a specific document by ID.',
    ecpMethod: 'chat/document/get',
    category: 'ai',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document ID to retrieve' },
      },
      required: ['id'],
    },
  },
  // Document search
  {
    name: 'ai.document.search',
    description: 'Search documents by text query.',
    ecpMethod: 'chat/document/search',
    category: 'ai',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        docType: {
          type: 'string',
          enum: ['prd', 'assessment', 'vulnerability', 'spec', 'plan', 'report', 'decision', 'runbook', 'review', 'note'],
          description: 'Filter by type',
        },
        limit: { type: 'number', description: 'Maximum results (default: 10)' },
      },
      required: ['query'],
    },
  },
  // Document operations (generic)
  {
    name: 'ai.document.create',
    description:
      'Create a structured document in the project document store. Use for reports, assessments, reviews, decisions, vulnerability findings, etc.',
    ecpMethod: 'chat/document/create',
    category: 'ai',
    inputSchema: {
      type: 'object',
      properties: {
        docType: {
          type: 'string',
          enum: ['prd', 'assessment', 'vulnerability', 'spec', 'plan', 'report', 'decision', 'runbook', 'review', 'note'],
          description: 'Document type',
        },
        title: { type: 'string', description: 'Document title' },
        content: { type: 'string', description: 'Full content in markdown' },
        summary: { type: 'string', description: 'Brief summary' },
        status: {
          type: 'string',
          enum: ['draft', 'active', 'in_review', 'approved', 'rejected', 'completed', 'archived'],
          description: 'Document status',
        },
        severity: {
          type: 'string',
          enum: ['info', 'low', 'medium', 'high', 'critical'],
          description: 'Severity level',
        },
        metadata: { type: 'object', description: 'Additional structured metadata' },
      },
      required: ['docType', 'title', 'content'],
    },
  },
  {
    name: 'ai.document.update',
    description: 'Update an existing document in the document store.',
    ecpMethod: 'chat/document/update',
    category: 'ai',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document ID to update' },
        title: { type: 'string', description: 'New title' },
        content: { type: 'string', description: 'Updated content' },
        summary: { type: 'string', description: 'Updated summary' },
        status: {
          type: 'string',
          enum: ['draft', 'active', 'in_review', 'approved', 'rejected', 'completed', 'archived'],
          description: 'New status',
        },
        severity: {
          type: 'string',
          enum: ['info', 'low', 'medium', 'high', 'critical'],
          description: 'New severity',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'ai.document.list',
    description: 'List documents in the document store, optionally filtered by type or status.',
    ecpMethod: 'chat/document/list',
    category: 'ai',
    inputSchema: {
      type: 'object',
      properties: {
        docType: {
          type: 'string',
          enum: ['prd', 'assessment', 'vulnerability', 'spec', 'plan', 'report', 'decision', 'runbook', 'review', 'note'],
          description: 'Filter by type',
        },
        status: {
          type: 'string',
          enum: ['draft', 'active', 'in_review', 'approved', 'rejected', 'completed', 'archived'],
          description: 'Filter by status',
        },
      },
    },
  },
  // Chat history search
  {
    name: 'ai.chat.search',
    description: 'Search the chat conversation history for earlier messages, decisions, or context.',
    ecpMethod: 'chat/message/search',
    category: 'ai',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query to find relevant messages' },
        limit: { type: 'number', description: 'Maximum number of results (default: 10)' },
      },
      required: ['query'],
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Base Translator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Base implementation for tool translators.
 */
export abstract class BaseToolTranslator implements ToolTranslator {
  abstract readonly providerId: string;
  protected mappings: Map<string, ProviderToolMapping> = new Map();

  protected log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[ToolTranslator:${this.providerId}] ${msg}`);
    }
  }

  /**
   * Register a tool mapping.
   */
  protected registerMapping(mapping: ProviderToolMapping): void {
    this.mappings.set(mapping.providerName, mapping);
  }

  toProviderTools(ecpTools: ECPToolDefinition[]): ToolDefinition[] {
    const tools: ToolDefinition[] = [];

    for (const ecpTool of ecpTools) {
      // Find mapping for this ECP tool
      const mapping = Array.from(this.mappings.values()).find(
        (m) => m.ecpName === ecpTool.name
      );

      if (mapping) {
        // Create provider-specific tool definition
        const providerTool = this.createProviderTool(ecpTool, mapping);
        if (providerTool) {
          tools.push(providerTool);
        }
      }
    }

    return tools;
  }

  /**
   * Create a provider-specific tool definition from an ECP tool.
   * Override in subclasses for provider-specific formatting.
   */
  protected createProviderTool(
    ecpTool: ECPToolDefinition,
    mapping: ProviderToolMapping
  ): ToolDefinition | null {
    // Transform input schema property names if needed
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(ecpTool.inputSchema.properties)) {
      // Reverse lookup: find provider param name for ECP param name
      let providerKey = key;
      if (mapping.inputMappings) {
        const reverseMapping = Object.entries(mapping.inputMappings).find(
          ([, ecpKey]) => ecpKey === key
        );
        if (reverseMapping) {
          providerKey = reverseMapping[0];
        }
      }
      properties[providerKey] = value;

      if (ecpTool.inputSchema.required?.includes(key)) {
        required.push(providerKey);
      }
    }

    return {
      name: mapping.providerName,
      description: ecpTool.description,
      ecpMethod: ecpTool.ecpMethod,
      inputSchema: {
        type: 'object',
        properties: properties as ToolDefinition['inputSchema']['properties'],
        required: required.length > 0 ? required : undefined,
      },
    };
  }

  mapToolCall(toolCall: ToolUseContent): {
    ecpMethod: string;
    params: Record<string, unknown>;
  } | null {
    const mapping = this.mappings.get(toolCall.name);
    if (!mapping) {
      this.log(`No mapping found for tool: ${toolCall.name}`);
      return null;
    }

    // Find the ECP tool to get the method
    const ecpTool = canonicalECPTools.find((t) => t.name === mapping.ecpName);
    if (!ecpTool) {
      this.log(`ECP tool not found: ${mapping.ecpName}`);
      return null;
    }

    // Transform input parameters
    const params: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(toolCall.input)) {
      const ecpKey = mapping.inputMappings?.[key] || key;
      params[ecpKey] = value;
    }

    this.log(`Mapped ${toolCall.name} -> ${ecpTool.ecpMethod}`);
    return {
      ecpMethod: ecpTool.ecpMethod,
      params,
    };
  }

  isSupported(providerToolName: string): boolean {
    return this.mappings.has(providerToolName);
  }

  getECPToolName(providerToolName: string): string | null {
    return this.mappings.get(providerToolName)?.ecpName || null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude Translator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tool translator for Claude (Anthropic).
 * Maps Claude Code tool names to canonical ECP tools.
 */
export class ClaudeToolTranslator extends BaseToolTranslator {
  readonly providerId = 'claude';

  constructor() {
    super();
    this.initializeMappings();
  }

  private initializeMappings(): void {
    // File operations
    this.registerMapping({
      providerName: 'Read',
      ecpName: 'file.read',
      inputMappings: { file_path: 'path' },
    });

    this.registerMapping({
      providerName: 'Write',
      ecpName: 'file.write',
      inputMappings: { file_path: 'path' },
    });

    this.registerMapping({
      providerName: 'Edit',
      ecpName: 'file.edit',
      inputMappings: { file_path: 'path' },
    });

    this.registerMapping({
      providerName: 'Glob',
      ecpName: 'file.glob',
    });

    this.registerMapping({
      providerName: 'Grep',
      ecpName: 'file.grep',
    });

    this.registerMapping({
      providerName: 'LS',
      ecpName: 'file.list',
    });

    // Additional file operations (Claude doesn't have native tools for these,
    // but we register them so they can be called if the AI requests them)
    this.registerMapping({
      providerName: 'file_exists',
      ecpName: 'file.exists',
      inputMappings: { file_path: 'path' },
    });

    this.registerMapping({
      providerName: 'file_delete',
      ecpName: 'file.delete',
      inputMappings: { file_path: 'path' },
    });

    this.registerMapping({
      providerName: 'file_rename',
      ecpName: 'file.rename',
      inputMappings: { old_path: 'oldPath', new_path: 'newPath' },
    });

    this.registerMapping({
      providerName: 'mkdir',
      ecpName: 'file.mkdir',
      inputMappings: { dir_path: 'path' },
    });

    this.registerMapping({
      providerName: 'rmdir',
      ecpName: 'file.deleteDir',
      inputMappings: { dir_path: 'path' },
    });

    // Terminal
    this.registerMapping({
      providerName: 'Bash',
      ecpName: 'terminal.execute',
    });

    this.registerMapping({
      providerName: 'spawn_process',
      ecpName: 'terminal.spawn',
    });

    // AI - Task Management
    this.registerMapping({
      providerName: 'TodoWrite',
      ecpName: 'ai.todo',
    });

    // AI - Planning
    this.registerMapping({
      providerName: 'PlanCreate',
      ecpName: 'ai.plan.create',
    });

    this.registerMapping({
      providerName: 'PlanUpdate',
      ecpName: 'ai.plan.update',
    });

    this.registerMapping({
      providerName: 'PlanRead',
      ecpName: 'ai.plan.list',
    });

    // AI - Specifications
    this.registerMapping({
      providerName: 'SpecCreate',
      ecpName: 'ai.spec.create',
    });

    this.registerMapping({
      providerName: 'SpecRead',
      ecpName: 'ai.spec.list',
    });

    this.registerMapping({
      providerName: 'SpecUpdate',
      ecpName: 'ai.spec.update',
    });

    // AI - Documents (generic)
    this.registerMapping({
      providerName: 'DocumentCreate',
      ecpName: 'ai.document.create',
    });

    this.registerMapping({
      providerName: 'DocumentUpdate',
      ecpName: 'ai.document.update',
    });

    this.registerMapping({
      providerName: 'DocumentList',
      ecpName: 'ai.document.list',
    });

    this.registerMapping({
      providerName: 'DocumentGet',
      ecpName: 'ai.document.get',
    });

    this.registerMapping({
      providerName: 'DocumentSearch',
      ecpName: 'ai.document.search',
    });

    // AI - Todo read
    this.registerMapping({
      providerName: 'TodoRead',
      ecpName: 'ai.todo.read',
    });

    // AI - Plan get
    this.registerMapping({
      providerName: 'PlanGet',
      ecpName: 'ai.plan.get',
    });

    // AI - Chat history
    this.registerMapping({
      providerName: 'SearchChatHistory',
      ecpName: 'ai.chat.search',
    });

    this.log(`Initialized with ${this.mappings.size} tool mappings`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI Translator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tool translator for OpenAI.
 * OpenAI typically uses snake_case function names.
 */
export class OpenAIToolTranslator extends BaseToolTranslator {
  readonly providerId = 'openai';

  constructor() {
    super();
    this.initializeMappings();
  }

  private initializeMappings(): void {
    // File operations
    this.registerMapping({
      providerName: 'read_file',
      ecpName: 'file.read',
      inputMappings: { file_path: 'path' },
    });

    this.registerMapping({
      providerName: 'write_file',
      ecpName: 'file.write',
      inputMappings: { file_path: 'path' },
    });

    this.registerMapping({
      providerName: 'edit_file',
      ecpName: 'file.edit',
      inputMappings: { file_path: 'path' },
    });

    this.registerMapping({
      providerName: 'find_files',
      ecpName: 'file.glob',
    });

    this.registerMapping({
      providerName: 'search_files',
      ecpName: 'file.grep',
    });

    this.registerMapping({
      providerName: 'list_directory',
      ecpName: 'file.list',
    });

    this.registerMapping({
      providerName: 'file_exists',
      ecpName: 'file.exists',
      inputMappings: { file_path: 'path' },
    });

    this.registerMapping({
      providerName: 'delete_file',
      ecpName: 'file.delete',
      inputMappings: { file_path: 'path' },
    });

    this.registerMapping({
      providerName: 'rename_file',
      ecpName: 'file.rename',
      inputMappings: { old_path: 'oldPath', new_path: 'newPath' },
    });

    this.registerMapping({
      providerName: 'make_directory',
      ecpName: 'file.mkdir',
      inputMappings: { dir_path: 'path' },
    });

    this.registerMapping({
      providerName: 'remove_directory',
      ecpName: 'file.deleteDir',
      inputMappings: { dir_path: 'path' },
    });

    // Terminal
    this.registerMapping({
      providerName: 'execute_command',
      ecpName: 'terminal.execute',
    });

    this.registerMapping({
      providerName: 'spawn_process',
      ecpName: 'terminal.spawn',
    });

    // Task management
    this.registerMapping({
      providerName: 'write_todos',
      ecpName: 'ai.todo',
    });

    // Planning
    this.registerMapping({
      providerName: 'create_plan',
      ecpName: 'ai.plan.create',
    });

    this.registerMapping({
      providerName: 'update_plan',
      ecpName: 'ai.plan.update',
    });

    this.registerMapping({
      providerName: 'list_plans',
      ecpName: 'ai.plan.list',
    });

    // Specifications
    this.registerMapping({
      providerName: 'create_spec',
      ecpName: 'ai.spec.create',
    });

    this.registerMapping({
      providerName: 'list_specs',
      ecpName: 'ai.spec.list',
    });

    this.registerMapping({
      providerName: 'update_spec',
      ecpName: 'ai.spec.update',
    });

    // Documents (generic)
    this.registerMapping({
      providerName: 'create_document',
      ecpName: 'ai.document.create',
    });

    this.registerMapping({
      providerName: 'update_document',
      ecpName: 'ai.document.update',
    });

    this.registerMapping({
      providerName: 'list_documents',
      ecpName: 'ai.document.list',
    });

    this.registerMapping({
      providerName: 'get_document',
      ecpName: 'ai.document.get',
    });

    this.registerMapping({
      providerName: 'search_documents',
      ecpName: 'ai.document.search',
    });

    // Todo read
    this.registerMapping({
      providerName: 'read_todos',
      ecpName: 'ai.todo.read',
    });

    // Plan get
    this.registerMapping({
      providerName: 'get_plan',
      ecpName: 'ai.plan.get',
    });

    // Chat history
    this.registerMapping({
      providerName: 'search_chat_history',
      ecpName: 'ai.chat.search',
    });

    this.log(`Initialized with ${this.mappings.size} tool mappings`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini Translator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tool translator for Google Gemini.
 */
export class GeminiToolTranslator extends BaseToolTranslator {
  readonly providerId = 'gemini';

  constructor() {
    super();
    this.initializeMappings();
  }

  private initializeMappings(): void {
    // Gemini uses camelCase naming
    // File operations
    this.registerMapping({
      providerName: 'readFile',
      ecpName: 'file.read',
      inputMappings: { filePath: 'path' },
    });

    this.registerMapping({
      providerName: 'writeFile',
      ecpName: 'file.write',
      inputMappings: { filePath: 'path' },
    });

    this.registerMapping({
      providerName: 'editFile',
      ecpName: 'file.edit',
      inputMappings: { filePath: 'path' },
    });

    this.registerMapping({
      providerName: 'findFiles',
      ecpName: 'file.glob',
    });

    this.registerMapping({
      providerName: 'searchFiles',
      ecpName: 'file.grep',
    });

    this.registerMapping({
      providerName: 'listDirectory',
      ecpName: 'file.list',
    });

    this.registerMapping({
      providerName: 'fileExists',
      ecpName: 'file.exists',
      inputMappings: { filePath: 'path' },
    });

    this.registerMapping({
      providerName: 'deleteFile',
      ecpName: 'file.delete',
      inputMappings: { filePath: 'path' },
    });

    this.registerMapping({
      providerName: 'renameFile',
      ecpName: 'file.rename',
      inputMappings: { oldPath: 'oldPath', newPath: 'newPath' },
    });

    this.registerMapping({
      providerName: 'makeDirectory',
      ecpName: 'file.mkdir',
      inputMappings: { dirPath: 'path' },
    });

    this.registerMapping({
      providerName: 'removeDirectory',
      ecpName: 'file.deleteDir',
      inputMappings: { dirPath: 'path' },
    });

    // Terminal
    this.registerMapping({
      providerName: 'executeCommand',
      ecpName: 'terminal.execute',
    });

    this.registerMapping({
      providerName: 'spawnProcess',
      ecpName: 'terminal.spawn',
    });

    // Task management
    this.registerMapping({
      providerName: 'writeTodos',
      ecpName: 'ai.todo',
    });

    // Planning
    this.registerMapping({
      providerName: 'createPlan',
      ecpName: 'ai.plan.create',
    });

    this.registerMapping({
      providerName: 'updatePlan',
      ecpName: 'ai.plan.update',
    });

    this.registerMapping({
      providerName: 'listPlans',
      ecpName: 'ai.plan.list',
    });

    // Specifications
    this.registerMapping({
      providerName: 'createSpec',
      ecpName: 'ai.spec.create',
    });

    this.registerMapping({
      providerName: 'listSpecs',
      ecpName: 'ai.spec.list',
    });

    this.registerMapping({
      providerName: 'updateSpec',
      ecpName: 'ai.spec.update',
    });

    // Documents (generic)
    this.registerMapping({
      providerName: 'createDocument',
      ecpName: 'ai.document.create',
    });

    this.registerMapping({
      providerName: 'updateDocument',
      ecpName: 'ai.document.update',
    });

    this.registerMapping({
      providerName: 'listDocuments',
      ecpName: 'ai.document.list',
    });

    this.registerMapping({
      providerName: 'getDocument',
      ecpName: 'ai.document.get',
    });

    this.registerMapping({
      providerName: 'searchDocuments',
      ecpName: 'ai.document.search',
    });

    // Todo read
    this.registerMapping({
      providerName: 'readTodos',
      ecpName: 'ai.todo.read',
    });

    // Plan get
    this.registerMapping({
      providerName: 'getPlan',
      ecpName: 'ai.plan.get',
    });

    // Chat history
    this.registerMapping({
      providerName: 'searchChatHistory',
      ecpName: 'ai.chat.search',
    });

    this.log(`Initialized with ${this.mappings.size} tool mappings`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the tool translator for a provider.
 */
export function getToolTranslator(providerId: string): ToolTranslator {
  switch (providerId) {
    case 'claude':
      return new ClaudeToolTranslator();
    case 'openai':
      return new OpenAIToolTranslator();
    case 'gemini':
      return new GeminiToolTranslator();
    default:
      // Default to Claude translator
      return new ClaudeToolTranslator();
  }
}

/**
 * Get canonical ECP tools filtered by category.
 */
export function getECPToolsByCategory(category: ECPToolDefinition['category']): ECPToolDefinition[] {
  return canonicalECPTools.filter((t) => t.category === category);
}
