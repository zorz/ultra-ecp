/**
 * Session State Validation Schema
 *
 * Zod schemas for validating session state on load and save.
 * Prevents schema drift and ensures data integrity.
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Nested Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SerializedUndoState schema for undo history persistence.
 */
const SerializedUndoStateSchema = z.object({
  undoStack: z.array(z.any()).optional(),
  redoStack: z.array(z.any()).optional(),
  savedVersion: z.number().optional(),
  currentVersion: z.number().optional(),
}).optional();

/**
 * Document state within a session.
 */
export const SessionDocumentStateSchema = z.object({
  filePath: z.string(),
  scrollTop: z.number(),
  scrollLeft: z.number(),
  cursorLine: z.number(),
  cursorColumn: z.number(),
  selectionAnchorLine: z.number().optional(),
  selectionAnchorColumn: z.number().optional(),
  foldedRegions: z.array(z.number()),
  paneId: z.string(),
  tabOrder: z.number(),
  isActiveInPane: z.boolean(),
  unsavedContent: z.string().optional(),
  undoHistory: SerializedUndoStateSchema,
});

/**
 * Terminal state within a session.
 */
export const SessionTerminalStateSchema = z.object({
  elementId: z.string(),
  paneId: z.string(),
  tabOrder: z.number(),
  isActiveInPane: z.boolean(),
  cwd: z.string(),
  title: z.string(),
});

/**
 * AI provider types for PTY-based AI chats.
 */
const AIProviderSchema = z.enum(['claude-code', 'codex', 'gemini', 'custom']);

/**
 * AI chat state (PTY-based) within a session.
 */
export const SessionAIChatStateSchema = z.object({
  elementId: z.string(),
  paneId: z.string(),
  tabOrder: z.number(),
  isActiveInPane: z.boolean(),
  provider: AIProviderSchema,
  sessionId: z.string().nullable(),
  cwd: z.string(),
  title: z.string(),
  inputHistory: z.array(z.string()).optional(),
});

/**
 * Service AI provider types.
 */
const ServiceAIProviderSchema = z.enum(['claude', 'openai', 'gemini', 'ollama']);

/**
 * Chat message for service AI chats.
 */
const SessionChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  timestamp: z.number(),
});

/**
 * Service AI chat state within a session.
 */
export const SessionServiceAIChatStateSchema = z.object({
  elementId: z.string(),
  paneId: z.string(),
  tabOrder: z.number(),
  isActiveInPane: z.boolean(),
  provider: ServiceAIProviderSchema,
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  title: z.string(),
  messages: z.array(SessionChatMessageSchema),
  cliSessionId: z.string().optional(),
  inputHistory: z.array(z.string()).optional(),
});

/**
 * SQL editor state within a session.
 */
export const SessionSQLEditorStateSchema = z.object({
  elementId: z.string(),
  paneId: z.string(),
  tabOrder: z.number(),
  isActiveInPane: z.boolean(),
  filePath: z.string().nullable(),
  content: z.string(),
  connectionId: z.string().nullable(),
  cursorLine: z.number(),
  cursorColumn: z.number(),
  scrollTop: z.number(),
  title: z.string(),
});

/**
 * UI state for session persistence.
 */
export const SessionUIStateSchema = z.object({
  sidebarVisible: z.boolean(),
  sidebarWidth: z.number(),
  terminalVisible: z.boolean(),
  terminalHeight: z.number(),
  gitPanelVisible: z.boolean(),
  gitPanelWidth: z.number(),
  activeSidebarPanel: z.enum(['files', 'git', 'search', 'outline']),
  minimapEnabled: z.boolean(),
  aiPanelVisible: z.boolean().optional(),
  aiPanelWidth: z.number().optional(),
  sidebarAccordionExpanded: z.array(z.string()).optional(),
});

/**
 * Layout tree node for pane arrangement.
 * Recursive schema for tree structure.
 */
export const SessionLayoutNodeSchema: z.ZodType<{
  type: 'leaf' | 'horizontal' | 'vertical';
  paneId?: string;
  children?: unknown[];
  ratios?: number[];
}> = z.lazy(() =>
  z.object({
    type: z.enum(['leaf', 'horizontal', 'vertical']),
    paneId: z.string().optional(),
    children: z.array(SessionLayoutNodeSchema).optional(),
    ratios: z.array(z.number()).optional(),
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// Flex-GUI State Schema (separate layout system from TUI)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Flex-GUI panel config (inside a pane node).
 */
const FlexGuiPanelConfigSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string().optional(),
  state: z.unknown().optional(),
});

/**
 * Flex-GUI layout node — recursive split-tree schema.
 * Matches the LayoutNode type from panes/types.ts.
 */
const FlexGuiLayoutNodeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('split'),
      id: z.string(),
      direction: z.enum(['horizontal', 'vertical']),
      children: z.array(FlexGuiLayoutNodeSchema),
      ratios: z.array(z.number()),
    }),
    z.object({
      type: z.literal('pane'),
      id: z.string(),
      mode: z.enum(['tabs', 'accordion']),
      panels: z.array(FlexGuiPanelConfigSchema),
      activePanelId: z.string().optional(),
      expandedPanelIds: z.array(z.string()).optional(),
    }),
  ])
);

/**
 * Flex-GUI editor file state for persistence.
 */
const FlexGuiEditorFileStateSchema = z.object({
  path: z.string(),
  language: z.string().optional(),
  hostPaneId: z.string().optional(),
});

/**
 * Flex-GUI custom preset definition.
 */
const FlexGuiCustomPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string(),
  color: z.string(),
  layout: FlexGuiLayoutNodeSchema,
});

/**
 * Flex-GUI UI state for granular persistence.
 */
const FlexGuiUIStateSchema = z.object({
  focusedTileId: z.string(),
  activeTabs: z.record(z.string(), z.string()),
  themeId: z.string().optional(),
  // Ultra GUI workspace layout
  leftSidebarVisible: z.boolean().optional(),
  leftSidebarWidth: z.number().optional(),
  leftSidebarPinned: z.boolean().optional(),
  rightSidebarVisible: z.boolean().optional(),
  rightSidebarWidth: z.number().optional(),
  rightSidebarPinned: z.boolean().optional(),
  rightSidebarTab: z.string().optional(),
  contentPanelVisible: z.boolean().optional(),
  contentPanelRatio: z.number().optional(),
  followMode: z.boolean().optional(),
});

/**
 * Flex-GUI workflow session info for persistence.
 */
const FlexGuiWorkflowSessionInfoSchema = z.object({
  sessionId: z.string(),
  workflowId: z.string(),
  workflowName: z.string(),
});

/**
 * Flex-GUI workflow state for persistence.
 */
const FlexGuiWorkflowStateSchema = z.object({
  sessions: z.array(FlexGuiWorkflowSessionInfoSchema),
  activeSessionId: z.string().nullable(),
});

/**
 * Flex-GUI chat state for persistence.
 */
const FlexGuiChatStateSchema = z.object({
  storageSessionId: z.string().nullable(),
});

/**
 * Flex-GUI session state for per-workspace persistence.
 */
export const FlexGuiSessionStateSchema = z.object({
  version: z.number(),
  layout: z.object({
    activePresetId: z.string(),
    favorites: z.array(z.string()),
    customPresets: z.array(FlexGuiCustomPresetSchema),
  }),
  fileTree: z.object({
    selectedId: z.string().nullable(),
    expandedIds: z.array(z.string()),
  }),
  ui: FlexGuiUIStateSchema.optional(),
  workflow: FlexGuiWorkflowStateSchema.optional(),
  chat: FlexGuiChatStateSchema.optional(),
  paneTree: FlexGuiLayoutNodeSchema.optional(),
  editorFiles: z.array(FlexGuiEditorFileStateSchema).optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Main Session State Schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Complete session state schema.
 */
export const SessionStateSchema = z.object({
  version: z.number().min(1),
  timestamp: z.string(),
  instanceId: z.string(),
  workspaceRoot: z.string(),
  sessionName: z.string().optional(),
  documents: z.array(SessionDocumentStateSchema),
  terminals: z.array(SessionTerminalStateSchema).optional(),
  aiChats: z.array(SessionAIChatStateSchema).optional(),
  serviceAIChats: z.array(SessionServiceAIChatStateSchema).optional(),
  sqlEditors: z.array(SessionSQLEditorStateSchema).optional(),
  activeDocumentPath: z.string().nullable(),
  activePaneId: z.string(),
  layout: SessionLayoutNodeSchema,
  ui: SessionUIStateSchema,
  // Flex-GUI specific state (separate layout system from TUI)
  flexGuiState: FlexGuiSessionStateSchema.optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Type exports
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inferred type from schema (for type checking).
 */
export type ValidatedSessionState = z.infer<typeof SessionStateSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Validation Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validation result type.
 */
export interface SessionValidationResult {
  success: boolean;
  data?: ValidatedSessionState;
  error?: string;
  issues?: z.ZodIssue[];
}

/**
 * Validate a session state object.
 *
 * @param data Unknown data to validate
 * @returns Validation result with parsed data or error details
 */
export function validateSessionState(data: unknown): SessionValidationResult {
  const result = SessionStateSchema.safeParse(data);

  if (result.success) {
    return {
      success: true,
      data: result.data,
    };
  }

  // Format error message
  const issues = result.error.issues;
  const errorMessages = issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });

  return {
    success: false,
    error: `Session validation failed: ${errorMessages.join('; ')}`,
    issues,
  };
}

/**
 * Validate and parse session state, throwing on error.
 *
 * @param data Unknown data to validate
 * @returns Validated session state
 * @throws Error if validation fails
 */
export function parseSessionState(data: unknown): ValidatedSessionState {
  return SessionStateSchema.parse(data);
}
