/**
 * ECP Parameter Validation Schemas
 *
 * Zod schemas for validating ECP request parameters.
 * Provides runtime type safety at the API boundary.
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Common Schemas
// ─────────────────────────────────────────────────────────────────────────────

/** URI schema - validates file:// URIs or paths */
export const UriSchema = z.string().min(1, 'uri is required');

/** Path schema - validates file paths */
export const PathSchema = z.string().min(1, 'path is required');

/** Position schema - line and column */
export const PositionSchema = z.object({
  line: z.number().int().min(0),
  column: z.number().int().min(0),
});

/** Range schema - start and end positions */
export const RangeSchema = z.object({
  start: PositionSchema,
  end: PositionSchema,
});

// ─────────────────────────────────────────────────────────────────────────────
// File Service Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const FileReadParamsSchema = z.object({
  uri: UriSchema,
  encoding: z.string().optional(),
});

export const FileWriteParamsSchema = z.object({
  uri: UriSchema,
  content: z.string(),
  encoding: z.string().optional(),
  createParents: z.boolean().optional(),
  overwrite: z.boolean().optional(),
});

export const FileStatParamsSchema = z.object({
  uri: UriSchema,
});

export const FileExistsParamsSchema = z.object({
  uri: UriSchema,
});

export const FileDeleteParamsSchema = z.object({
  uri: UriSchema,
});

export const FileRenameParamsSchema = z.object({
  oldUri: UriSchema,
  newUri: UriSchema,
  overwrite: z.boolean().optional(),
});

export const FileCopyParamsSchema = z.object({
  sourceUri: UriSchema,
  targetUri: UriSchema,
  overwrite: z.boolean().optional(),
});

export const FileReadDirParamsSchema = z.object({
  uri: UriSchema,
});

export const FileCreateDirParamsSchema = z.object({
  uri: UriSchema,
  recursive: z.boolean().optional(),
});

export const FileDeleteDirParamsSchema = z.object({
  uri: UriSchema,
  recursive: z.boolean().optional(),
});

export const FileSearchParamsSchema = z.object({
  pattern: z.string().min(1, 'pattern is required'),
  maxResults: z.number().int().positive().optional(),
  caseSensitive: z.boolean().optional(),
  searchContent: z.boolean().optional(),
  includePatterns: z.array(z.string()).optional(),
  excludePatterns: z.array(z.string()).optional(),
});

export const FileGlobParamsSchema = z.object({
  pattern: z.string().min(1, 'pattern is required'),
  baseUri: UriSchema.optional(),
  maxResults: z.number().int().positive().optional(),
  excludePatterns: z.array(z.string()).optional(),
  followSymlinks: z.boolean().optional(),
  includeDirectories: z.boolean().optional(),
});

export const FileWatchParamsSchema = z.object({
  uri: UriSchema,
  recursive: z.boolean().optional(),
  excludes: z.array(z.string()).optional(),
});

export const FileUnwatchParamsSchema = z.object({
  watchId: z.string().min(1, 'watchId is required'),
});

export const FileEditParamsSchema = z.object({
  uri: UriSchema,
  oldString: z.string(),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
});

export const FileGrepParamsSchema = z.object({
  pattern: z.string().min(1, 'pattern is required'),
  path: PathSchema.optional(),
  glob: z.string().optional(),
  caseSensitive: z.boolean().optional(),
  maxResults: z.number().int().positive().optional(),
});

export const FileListParamsSchema = z.object({
  path: PathSchema,
  recursive: z.boolean().optional(),
});

export const FileBrowseDirParamsSchema = z.object({
  path: PathSchema,
  showHidden: z.boolean().optional(),
  directoriesOnly: z.boolean().optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const WorkspaceSetRootParamsSchema = z.object({
  path: PathSchema,
});

// ─────────────────────────────────────────────────────────────────────────────
// Document Service Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const DocumentOpenParamsSchema = z.object({
  uri: UriSchema,
  content: z.string().optional(),
  languageId: z.string().optional(),
});

export const DocumentCloseParamsSchema = z.object({
  documentId: z.string().min(1, 'documentId is required'),
});

export const DocumentContentParamsSchema = z.object({
  documentId: z.string().min(1, 'documentId is required'),
});

export const DocumentInsertParamsSchema = z.object({
  documentId: z.string().min(1, 'documentId is required'),
  position: PositionSchema,
  text: z.string(),
});

export const DocumentReplaceParamsSchema = z.object({
  documentId: z.string().min(1, 'documentId is required'),
  range: RangeSchema,
  text: z.string(),
});

export const DocumentSaveParamsSchema = z.object({
  documentId: z.string().min(1, 'documentId is required'),
});

// ─────────────────────────────────────────────────────────────────────────────
// Terminal Service Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const TerminalCreateParamsSchema = z.object({
  cwd: PathSchema.optional(),
  shell: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
});

export const TerminalWriteParamsSchema = z.object({
  terminalId: z.string().min(1, 'terminalId is required'),
  data: z.string(),
});

export const TerminalResizeParamsSchema = z.object({
  terminalId: z.string().min(1, 'terminalId is required'),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

export const TerminalCloseParamsSchema = z.object({
  terminalId: z.string().min(1, 'terminalId is required'),
});

export const TerminalExecuteParamsSchema = z.object({
  command: z.string().min(1, 'command is required'),
  cwd: PathSchema.optional(),
  timeout: z.number().int().positive().optional(),
});

export const TerminalSpawnParamsSchema = z.object({
  command: z.string().min(1, 'command is required'),
  cwd: PathSchema.optional(),
  title: z.string().optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Session Service Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const SessionListParamsSchema = z.object({}).optional();

export const SessionLoadParamsSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required'),
});

export const SessionSaveParamsSchema = z.object({
  name: z.string().optional(),
});

export const SessionDeleteParamsSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required'),
});

// ─────────────────────────────────────────────────────────────────────────────
// AI Service Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const AIProviderTypeSchema = z.enum(['claude', 'openai', 'gemini', 'ollama']);

/** Message schema for session context restoration */
export const AISessionMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  timestamp: z.number().optional(),
});

export const AISessionCreateParamsSchema = z.object({
  provider: AIProviderTypeSchema,
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  tools: z.array(z.string()).optional(),
  /** Messages to restore session context (e.g., after page reload) */
  messages: z.array(AISessionMessageSchema).optional(),
});

export const AISessionIdParamsSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required'),
});

export const AIMessageSendParamsSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required'),
  content: z.string(),
  images: z.array(z.object({
    data: z.string(),
    mediaType: z.string(),
  })).optional(),
  /** Client-provided stream ID for correlating stream events */
  streamId: z.string().optional(),
  /** Target agent ID for routing (parsed from @mentions or sticky target) */
  targetAgentId: z.string().optional(),
  /** Storage session ID for transcript context (from client's persistent session) */
  storageSessionId: z.string().optional(),
});

export const AITodoItemSchema = z.object({
  content: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'completed']),
  activeForm: z.string().optional(),
});

export const AITodoWriteParamsSchema = z.object({
  sessionId: z.string().optional(),
  todos: z.array(AITodoItemSchema),
});

export const AITodoGetParamsSchema = z.object({
  sessionId: z.string().optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Document Service Schemas (Additional)
// ─────────────────────────────────────────────────────────────────────────────

export const DocumentIdParamsSchema = z.object({
  documentId: z.string().min(1, 'documentId is required'),
});

export const DocumentLineParamsSchema = z.object({
  documentId: z.string().min(1, 'documentId is required'),
  lineNumber: z.number().int().min(0),
});

export const DocumentLinesParamsSchema = z.object({
  documentId: z.string().min(1, 'documentId is required'),
  startLine: z.number().int().min(0),
  endLine: z.number().int().min(0),
});

export const DocumentTextInRangeParamsSchema = z.object({
  documentId: z.string().min(1, 'documentId is required'),
  range: RangeSchema,
});

export const DocumentDeleteParamsSchema = z.object({
  documentId: z.string().min(1, 'documentId is required'),
  range: RangeSchema,
  groupWithPrevious: z.boolean().optional(),
});

export const DocumentSetContentParamsSchema = z.object({
  documentId: z.string().min(1, 'documentId is required'),
  content: z.string(),
});

export const CursorSchema = z.object({
  position: PositionSchema,
  selection: z.object({
    anchor: PositionSchema,
    active: PositionSchema,
  }).optional(),
});

export const DocumentSetCursorsParamsSchema = z.object({
  documentId: z.string().min(1, 'documentId is required'),
  cursors: z.array(CursorSchema),
});

export const DocumentSetCursorParamsSchema = z.object({
  documentId: z.string().min(1, 'documentId is required'),
  position: PositionSchema,
  selection: z.object({
    anchor: PositionSchema,
    active: PositionSchema,
  }).optional(),
});

export const DocumentAddCursorParamsSchema = z.object({
  documentId: z.string().min(1, 'documentId is required'),
  position: PositionSchema,
});

export const MoveDirectionSchema = z.enum(['up', 'down', 'left', 'right']);
export const MoveUnitSchema = z.enum(['character', 'word', 'line', 'page', 'document']);

export const DocumentMoveCursorsParamsSchema = z.object({
  documentId: z.string().min(1, 'documentId is required'),
  direction: MoveDirectionSchema,
  unit: MoveUnitSchema.optional(),
  select: z.boolean().optional(),
});

export const DocumentOffsetParamsSchema = z.object({
  documentId: z.string().min(1, 'documentId is required'),
  offset: z.number().int().min(0),
});

export const DocumentPositionParamsSchema = z.object({
  documentId: z.string().min(1, 'documentId is required'),
  position: PositionSchema,
});

// ─────────────────────────────────────────────────────────────────────────────
// Terminal Service Schemas (Additional)
// ─────────────────────────────────────────────────────────────────────────────

export const TerminalIdParamsSchema = z.object({
  terminalId: z.string().min(1, 'terminalId is required'),
});

export const TerminalAttachTmuxParamsSchema = z.object({
  session: z.string().min(1, 'session is required'),
  socket: z.string().optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
});

export const TerminalScrollParamsSchema = z.object({
  terminalId: z.string().min(1, 'terminalId is required'),
  lines: z.number().int(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Session Service Schemas (Additional)
// ─────────────────────────────────────────────────────────────────────────────

export const ConfigGetParamsSchema = z.object({
  key: z.string().min(1, 'key is required'),
});

export const ConfigSetParamsSchema = z.object({
  key: z.string().min(1, 'key is required'),
  value: z.unknown().refine((val) => val !== undefined, {
    message: 'value is required',
  }),
});

export const ConfigResetParamsSchema = z.object({
  key: z.string().optional(),
});

export const SessionIdParamsSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required'),
});

export const SessionSetCurrentParamsSchema = z.object({
  state: z.unknown().refine((val) => val !== null && val !== undefined, {
    message: 'state is required',
  }),
});

export const KeyBindingSchema = z.object({
  key: z.string().min(1),
  command: z.string().min(1),
  when: z.string().optional(),
  args: z.unknown().optional(),
});

export const KeybindingsSetParamsSchema = z.object({
  bindings: z.array(KeyBindingSchema),
});

export const KeybindingsAddParamsSchema = z.object({
  binding: KeyBindingSchema,
});

export const KeybindingsRemoveParamsSchema = z.object({
  key: z.string().min(1, 'key is required'),
});

export const ParsedKeySchema = z.object({
  key: z.string(),
  ctrl: z.boolean().optional(),
  alt: z.boolean().optional(),
  shift: z.boolean().optional(),
  meta: z.boolean().optional(),
});

export const KeybindingsResolveParamsSchema = z.object({
  key: ParsedKeySchema,
  context: z.record(z.string(), z.unknown()).optional(),
});

export const ThemeIdParamsSchema = z.object({
  themeId: z.string().min(1, 'themeId is required'),
});

// ─────────────────────────────────────────────────────────────────────────────
// AI Service Schemas (Additional)
// ─────────────────────────────────────────────────────────────────────────────

export const AIProviderParamsSchema = z.object({
  provider: AIProviderTypeSchema,
});

export const AIToolExecuteParamsSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, 'name is required'),
  input: z.record(z.string(), z.unknown()),
});

export const AIPermissionApproveParamsSchema = z.object({
  toolUseId: z.string().min(1, 'toolUseId is required'),
  scope: z.enum(['once', 'session', 'folder']).optional(),
  folderPath: z.string().optional(),
});

export const AIPermissionDenyParamsSchema = z.object({
  toolUseId: z.string().min(1, 'toolUseId is required'),
});

export const AIAutoApprovedToolsParamsSchema = z.object({
  toolNames: z.array(z.string()).optional(),
  add: z.string().optional(),
  remove: z.string().optional(),
}).refine((data) => data.toolNames || data.add || data.remove, {
  message: 'toolNames, add, or remove is required',
});

export const AIRemoveApprovalParamsSchema = z.object({
  scope: z.enum(['session', 'folder', 'global']),
  sessionId: z.string().optional(),
  folderPath: z.string().optional(),
  toolName: z.string().min(1, 'toolName is required'),
});

export const AIMiddlewareEnableParamsSchema = z.object({
  name: z.string().min(1, 'name is required'),
  enabled: z.boolean(),
});

export const AIAddMessageParamsSchema = z.object({
  sessionId: z.string().min(1, 'sessionId is required'),
  message: z.object({
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string(),
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation Helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validation result type for ECP params.
 */
export interface ECPValidationResult<T> {
  success: boolean;
  data?: T;
  error?: {
    code: number;
    message: string;
  };
}

/**
 * Validate ECP params with a Zod schema.
 * Returns a consistent result format for ECP handlers.
 *
 * @param schema - Zod schema to validate against
 * @param params - Unknown params to validate
 * @param invalidParamsCode - Error code for invalid params (default: -32602)
 * @returns Validation result with parsed data or error
 */
export function validateECPParams<T>(
  schema: z.ZodType<T>,
  params: unknown,
  invalidParamsCode = -32602
): ECPValidationResult<T> {
  const result = schema.safeParse(params);

  if (result.success) {
    return {
      success: true,
      data: result.data,
    };
  }

  // Format error message from Zod issues
  const messages = result.error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });

  return {
    success: false,
    error: {
      code: invalidParamsCode,
      message: messages.join('; '),
    },
  };
}
