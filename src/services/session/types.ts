/**
 * Session Service Types
 *
 * Type definitions for settings, sessions, keybindings, and themes.
 */

/**
 * Re-export EditorSettings from config for convenience.
 */
export type { EditorSettings } from '../../config/settings.ts';

/**
 * Session state for a terminal in a pane.
 */
export interface SessionTerminalState {
  /** Element ID */
  elementId: string;
  /** Pane ID where terminal is open */
  paneId: string;
  /** Tab order within pane (0-indexed) */
  tabOrder: number;
  /** Whether this tab is active in its pane */
  isActiveInPane: boolean;
  /** Working directory for the terminal */
  cwd: string;
  /** Terminal title */
  title: string;
}

/**
 * AI provider type for AI chat sessions.
 */
export type AIProvider = 'claude-code' | 'codex' | 'gemini' | 'custom';

/**
 * Session state for an AI chat in a pane.
 */
export interface SessionAIChatState {
  /** Element ID */
  elementId: string;
  /** Pane ID where AI chat is open */
  paneId: string;
  /** Tab order within pane (0-indexed) */
  tabOrder: number;
  /** Whether this tab is active in its pane */
  isActiveInPane: boolean;
  /** AI provider (claude-code, codex, etc.) */
  provider: AIProvider;
  /** Session ID for resume (Claude --resume support) */
  sessionId: string | null;
  /** Working directory for the AI chat */
  cwd: string;
  /** Chat title */
  title: string;
  /** Input history for up/down navigation */
  inputHistory?: string[];
}

/**
 * Service AI provider type (claude, openai, gemini, ollama).
 */
export type ServiceAIProvider = 'claude' | 'openai' | 'gemini' | 'ollama';

/**
 * Persisted chat message for service AI chats.
 */
export interface SessionChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

/**
 * Session state for a service-based AI chat in a pane.
 */
export interface SessionServiceAIChatState {
  /** Element ID */
  elementId: string;
  /** Pane ID where AI chat is open */
  paneId: string;
  /** Tab order within pane (0-indexed) */
  tabOrder: number;
  /** Whether this tab is active in its pane */
  isActiveInPane: boolean;
  /** AI provider (claude, openai, gemini, ollama) */
  provider: ServiceAIProvider;
  /** Model name if specified */
  model?: string;
  /** System prompt */
  systemPrompt?: string;
  /** Chat title */
  title: string;
  /** Chat message history */
  messages: SessionChatMessage[];
  /** CLI session ID for resume (claude --resume, gemini --session, etc.) */
  cliSessionId?: string;
  /** Input history for up/down navigation */
  inputHistory?: string[];
}

/**
 * Session state for a SQL editor tab.
 */
export interface SessionSQLEditorState {
  /** Element ID */
  elementId: string;
  /** Pane ID where SQL editor is open */
  paneId: string;
  /** Tab order within pane (0-indexed) */
  tabOrder: number;
  /** Whether this tab is active in its pane */
  isActiveInPane: boolean;
  /** File path (if saved) */
  filePath: string | null;
  /** SQL content */
  content: string;
  /** Database connection ID */
  connectionId: string | null;
  /** Cursor line */
  cursorLine: number;
  /** Cursor column */
  cursorColumn: number;
  /** Scroll position */
  scrollTop: number;
  /** Tab title */
  title: string;
}

/**
 * Session state for an Ensemble panel tab.
 */
export interface SessionEnsemblePanelState {
  /** Element ID */
  elementId: string;
  /** Pane ID where Ensemble panel is open */
  paneId: string;
  /** Tab order within pane (0-indexed) */
  tabOrder: number;
  /** Whether this tab is active in its pane */
  isActiveInPane: boolean;
  /** Tab title */
  title: string;
}

/**
 * Re-export SerializedUndoState from core undo module for session persistence.
 */
import type { SerializedUndoState } from '../../core/undo.ts';
export type { SerializedUndoState } from '../../core/undo.ts';

/**
 * Session state for a single document.
 */
export interface SessionDocumentState {
  /** Absolute file path */
  filePath: string;
  /** Scroll position (line number) */
  scrollTop: number;
  /** Horizontal scroll position */
  scrollLeft: number;
  /** Primary cursor line */
  cursorLine: number;
  /** Primary cursor column */
  cursorColumn: number;
  /** Selection anchor (if any) */
  selectionAnchorLine?: number;
  selectionAnchorColumn?: number;
  /** Folded line numbers */
  foldedRegions: number[];
  /** Pane ID where document is open */
  paneId: string;
  /** Tab order within pane (0-indexed) */
  tabOrder: number;
  /** Whether this tab is active in its pane */
  isActiveInPane: boolean;
  /** Unsaved content (if file was modified) */
  unsavedContent?: string;
  /** Undo/redo history for session persistence */
  undoHistory?: SerializedUndoState;
}

/**
 * UI state for session persistence.
 */
export interface SessionUIState {
  /** Whether sidebar is visible */
  sidebarVisible: boolean;
  /** Sidebar width in characters */
  sidebarWidth: number;
  /** Whether terminal is visible */
  terminalVisible: boolean;
  /** Terminal height in lines */
  terminalHeight: number;
  /** Whether git panel is visible */
  gitPanelVisible: boolean;
  /** Git panel width */
  gitPanelWidth: number;
  /** Active sidebar panel */
  activeSidebarPanel: 'files' | 'git' | 'search' | 'outline';
  /** Whether minimap is enabled */
  minimapEnabled: boolean;
  /** Whether AI panel is visible */
  aiPanelVisible?: boolean;
  /** AI panel width */
  aiPanelWidth?: number;
  /** Sidebar accordion expanded element IDs */
  sidebarAccordionExpanded?: string[];
}

/**
 * Layout tree node for pane arrangement.
 */
export interface SessionLayoutNode {
  /** Node type */
  type: 'leaf' | 'horizontal' | 'vertical';
  /** Pane ID (for leaf nodes) */
  paneId?: string;
  /** Child nodes (for split nodes) */
  children?: SessionLayoutNode[];
  /** Split ratios for children */
  ratios?: number[];
}

/**
 * Flex-GUI tile position (percentage 0-1 of grid).
 */
export interface FlexGuiTilePosition {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Flex-GUI custom preset definition.
 */
export interface FlexGuiCustomPreset {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  tiles: Record<string, FlexGuiTilePosition>;
}

/**
 * Flex-GUI session state for per-workspace persistence.
 * Used by flex-gui client (separate layout system from TUI).
 */
/**
 * Workflow session info for persistence.
 */
export interface FlexGuiWorkflowSessionInfo {
  sessionId: string;
  workflowId: string;
  workflowName: string;
}

/**
 * Workflow state for session persistence.
 */
export interface FlexGuiWorkflowState {
  /** Active workflow sessions */
  sessions: FlexGuiWorkflowSessionInfo[];
  /** Currently active workflow session ID */
  activeSessionId: string | null;
}

/**
 * Chat state for session persistence.
 */
export interface FlexGuiChatState {
  /** Storage session ID for the AI chat */
  storageSessionId: string | null;
}

/**
 * Granular UI state for persistence.
 */
export interface FlexGuiUIState {
  /** Currently focused tile ID */
  focusedTileId: string;
  /** Active tab for each tabbed tile (tile ID -> tab ID) */
  activeTabs: Record<string, string>;
  /** Theme ID */
  themeId?: string;

  // Ultra GUI workspace layout
  /** Whether the left sidebar (sessions) is visible */
  leftSidebarVisible?: boolean;
  /** Left sidebar width in points */
  leftSidebarWidth?: number;
  /** Whether the left sidebar stays visible when not hovered */
  leftSidebarPinned?: boolean;
  /** Whether the right sidebar (inspector) is visible */
  rightSidebarVisible?: boolean;
  /** Right sidebar width in points */
  rightSidebarWidth?: number;
  /** Whether the right sidebar stays visible when not hovered */
  rightSidebarPinned?: boolean;
  /** Active tab in the right sidebar */
  rightSidebarTab?: string;
  /** Whether the content panel is visible */
  contentPanelVisible?: boolean;
  /** Ratio of center area given to chat (0.0–1.0) */
  contentPanelRatio?: number;
  /** Whether follow mode is enabled */
  followMode?: boolean;
}

export interface FlexGuiSessionState {
  /** Session state version for migrations */
  version: number;
  /** Layout preset configuration */
  layout: {
    activePresetId: string;
    favorites: string[];
    customPresets: FlexGuiCustomPreset[];
  };
  /** File tree UI state */
  fileTree: {
    selectedId: string | null;
    expandedIds: string[];
  };
  /** Selected theme ID */
  themeId?: string;
  /** Granular UI state */
  ui?: FlexGuiUIState;
  /** Workflow state */
  workflow?: FlexGuiWorkflowState;
  /** Chat state */
  chat?: FlexGuiChatState;
}

/**
 * Complete session state.
 */
export interface SessionState {
  /** Session file format version */
  version: number;
  /** When this session was last saved */
  timestamp: string;
  /** Instance ID that owns this session */
  instanceId: string;
  /** Workspace root path */
  workspaceRoot: string;
  /** Session name (for named sessions) */
  sessionName?: string;
  /** All open documents */
  documents: SessionDocumentState[];
  /** All open terminals in panes */
  terminals?: SessionTerminalState[];
  /** All open AI chats in panes (PTY-based) */
  aiChats?: SessionAIChatState[];
  /** All open service AI chats in panes */
  serviceAIChats?: SessionServiceAIChatState[];
  /** All open SQL editors in panes */
  sqlEditors?: SessionSQLEditorState[];
  /** All open Ensemble panels in panes */
  ensemblePanels?: SessionEnsemblePanelState[];
  /** Active document path */
  activeDocumentPath: string | null;
  /** Active pane ID */
  activePaneId: string;
  /** Pane layout tree */
  layout: SessionLayoutNode;
  /** UI visibility states */
  ui: SessionUIState;
  /** Flex-GUI specific state (separate layout system) */
  flexGuiState?: FlexGuiSessionState;
}

/**
 * Session info for listing.
 */
export interface SessionInfo {
  /** Session identifier */
  id: string;
  /** Display name */
  name: string;
  /** Type of session */
  type: 'workspace' | 'named';
  /** Workspace root path */
  workspaceRoot: string;
  /** When the session was last modified */
  lastModified: string;
  /** Number of open documents */
  documentCount: number;
}

/**
 * Keybinding definition.
 */
export interface KeyBinding {
  /** Key combination (e.g., "ctrl+s", "cmd+k cmd+j") */
  key: string;
  /** Command ID to execute */
  command: string;
  /** Context condition (when clause) */
  when?: string;
  /** Command arguments */
  args?: unknown;
}

/**
 * Command metadata for the command palette.
 */
export interface CommandInfo {
  /** Display label */
  label: string;
  /** Category for grouping */
  category: string;
  /** Optional description */
  description?: string;
}

/**
 * Context for evaluating keybinding when clauses.
 */
export interface KeybindingContext {
  /** Whether editor has multiple cursors */
  editorHasMultipleCursors: boolean;
  /** Whether editor is focused */
  editorHasFocus: boolean;
  /** Whether terminal is focused */
  terminalHasFocus: boolean;
  /** Whether file tree is focused */
  fileTreeHasFocus: boolean;
  /** Whether search is active */
  searchIsActive: boolean;
  /** Whether in find dialog */
  findWidgetVisible: boolean;
  /** Whether text is selected */
  editorHasSelection: boolean;
}

/**
 * Parsed key event.
 */
export interface ParsedKey {
  /** Key name (e.g., "s", "Enter", "ArrowUp") */
  key: string;
  /** Ctrl/Cmd modifier */
  ctrl: boolean;
  /** Shift modifier */
  shift: boolean;
  /** Alt/Option modifier */
  alt: boolean;
  /** Meta modifier (Cmd on Mac, Win on Windows) */
  meta: boolean;
}

/**
 * Theme info for listing.
 */
export interface ThemeInfo {
  /** Theme identifier */
  id: string;
  /** Display name */
  name: string;
  /** Theme type */
  type: 'dark' | 'light' | 'high-contrast';
  /** Whether this is a built-in theme */
  builtin: boolean;
}

/**
 * Theme color palette.
 */
export interface ThemeColors {
  /** Editor background */
  'editor.background': string;
  /** Editor foreground */
  'editor.foreground': string;
  /** Line highlight background */
  'editor.lineHighlightBackground': string;
  /** Selection background */
  'editor.selectionBackground': string;
  /** Find match background */
  'editor.findMatchBackground': string;
  /** Find match highlight background */
  'editor.findMatchHighlightBackground': string;
  /** Cursor color */
  'editorCursor.foreground': string;
  /** Line number color */
  'editorLineNumber.foreground': string;
  /** Active line number color */
  'editorLineNumber.activeForeground': string;
  /** Sidebar background */
  'sideBar.background': string;
  /** Sidebar foreground */
  'sideBar.foreground': string;
  /** Status bar background */
  'statusBar.background': string;
  /** Status bar foreground */
  'statusBar.foreground': string;
  /** Terminal background */
  'terminal.background': string;
  /** Terminal foreground */
  'terminal.foreground': string;
  /** Plus other theme colors... */
  [key: string]: string;
}

/**
 * Complete theme definition.
 */
export interface Theme {
  /** Theme identifier (optional, defaults to name) */
  id?: string;
  /** Display name */
  name: string;
  /** Theme type */
  type: 'dark' | 'light' | 'high-contrast';
  /** Color palette */
  colors: ThemeColors;
  /** Token colors for syntax highlighting */
  tokenColors?: TokenColor[];
}

/**
 * Token color for syntax highlighting.
 */
export interface TokenColor {
  /** Optional name for the token color rule */
  name?: string;
  /** Token scope */
  scope: string | string[];
  /** Color settings */
  settings: {
    foreground?: string;
    background?: string;
    fontStyle?: string;
  };
}

/**
 * Settings schema property definition.
 */
export interface SettingsSchemaProperty {
  /** Property type */
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  /** Default value */
  default: unknown;
  /** Allowed values (for enums) */
  enum?: unknown[];
  /** Human-readable description */
  description?: string;
  /** Minimum value (for numbers) */
  minimum?: number;
  /** Maximum value (for numbers) */
  maximum?: number;
  /** Item type (for arrays) */
  items?: SettingsSchemaProperty;
}

/**
 * Settings schema for validation and discovery.
 */
export interface SettingsSchema {
  /** Schema properties */
  properties: Record<string, SettingsSchemaProperty>;
}

/**
 * Settings validation result.
 */
export interface ValidationResult {
  /** Whether the value is valid */
  valid: boolean;
  /** Error message if invalid */
  error?: string;
}

/**
 * Setting change event.
 */
export interface SettingChangeEvent {
  /** Setting key */
  key: string;
  /** New value */
  value: unknown;
  /** Old value */
  oldValue: unknown;
}

/**
 * Session change event.
 */
export interface SessionChangeEvent {
  /** Session ID */
  sessionId: string;
  /** Change type */
  type: 'saved' | 'loaded' | 'deleted';
}

/**
 * Callback for setting changes.
 */
export type SettingChangeCallback = (event: SettingChangeEvent) => void;

/**
 * Callback for session changes.
 */
export type SessionChangeCallback = (event: SessionChangeEvent) => void;

/**
 * Unsubscribe function.
 */
export type Unsubscribe = () => void;
