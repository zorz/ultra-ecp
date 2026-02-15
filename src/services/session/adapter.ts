/**
 * Session Service ECP Adapter
 *
 * Maps ECP JSON-RPC calls to SessionService methods.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { SessionService } from './interface.ts';
import { SessionError } from './errors.ts';
import type { EditorSettings } from '../../config/settings.ts';
import type { KeyBinding, CommandInfo, ParsedKey, KeybindingContext } from './types.ts';
import { validateSessionState } from './session-schema.ts';
import {
  validateECPParams,
  ConfigGetParamsSchema,
  ConfigSetParamsSchema,
  ConfigResetParamsSchema,
  SessionSaveParamsSchema,
  SessionLoadParamsSchema,
  SessionDeleteParamsSchema,
  SessionSetCurrentParamsSchema,
  KeybindingsSetParamsSchema,
  KeybindingsAddParamsSchema,
  KeybindingsRemoveParamsSchema,
  KeybindingsResolveParamsSchema,
  ThemeIdParamsSchema,
  WorkspaceSetRootParamsSchema,
} from '../../protocol/schemas.ts';

/**
 * ECP error codes (JSON-RPC 2.0 compatible).
 */
export const SessionECPErrorCodes = {
  // Standard JSON-RPC errors
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,

  // Session service errors (-32300 to -32399)
  SettingNotFound: -32300,
  InvalidValue: -32301,
  SessionNotFound: -32302,
  ThemeNotFound: -32303,
  InvalidKeybinding: -32304,
  NotInitialized: -32305,
  ValidationFailed: -32306,
} as const;

/**
 * JSON-RPC error response.
 */
interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * Handler result type.
 */
type HandlerResult<T> = { result: T } | { error: JsonRpcError };

/**
 * ECP notification structure.
 */
interface ECPNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/**
 * Session Service Adapter for ECP protocol.
 *
 * Handles JSON-RPC method routing and error conversion.
 */
export class SessionServiceAdapter {
  private notificationHandler?: (notification: ECPNotification) => void;
  private workspaceChangeHandler?: (path: string) => void;

  constructor(private readonly service: SessionService) {}

  /**
   * Set handler for outgoing notifications.
   */
  setNotificationHandler(handler: (notification: ECPNotification) => void): void {
    this.notificationHandler = handler;
  }

  /**
   * Set handler for workspace changes (used by ECPServer to reinitialize services).
   */
  setWorkspaceChangeHandler(handler: (path: string) => void): void {
    this.workspaceChangeHandler = handler;
  }

  /**
   * Send a notification to all listeners.
   */
  private sendNotification(method: string, params: unknown): void {
    if (this.notificationHandler) {
      this.notificationHandler({
        jsonrpc: '2.0',
        method,
        params,
      });
    }
  }

  /**
   * Handle an ECP request.
   *
   * @param method The method name (e.g., "config/get")
   * @param params The request parameters
   * @returns The method result
   */
  async handleRequest(method: string, params: unknown): Promise<HandlerResult<unknown>> {
    try {
      switch (method) {
        // Settings
        case 'config/get':
          return this.configGet(params);
        case 'config/set':
          return this.configSet(params);
        case 'config/getAll':
          return this.configGetAll();
        case 'config/reset':
          return this.configReset(params);
        case 'config/schema':
          return this.configSchema();

        // Sessions (async methods must be awaited for try/catch to work)
        case 'session/save':
          return await this.sessionSave(params);
        case 'session/load':
          return await this.sessionLoad(params);
        case 'session/list':
          return await this.sessionList();
        case 'session/delete':
          return await this.sessionDelete(params);
        case 'session/current':
          return this.sessionCurrent();
        case 'session/setCurrent':
          return this.sessionSetCurrent(params);
        case 'session/markDirty':
          return this.sessionMarkDirty();
        case 'session/loadLast':
          return await this.sessionLoadLast();

        // Keybindings
        case 'keybindings/get':
          return this.keybindingsGet();
        case 'keybindings/set':
          return this.keybindingsSet(params);
        case 'keybindings/add':
          return this.keybindingsAdd(params);
        case 'keybindings/remove':
          return this.keybindingsRemove(params);
        case 'keybindings/resolve':
          return this.keybindingsResolve(params);

        // Commands
        case 'commands/list':
          return this.commandsList();

        // Themes
        case 'theme/list':
          return this.themeList();
        case 'theme/get':
          return this.themeGet(params);
        case 'theme/set':
          return this.themeSet(params);
        case 'theme/current':
          return this.themeCurrent();

        // Workspace
        case 'workspace/getRoot':
          return this.workspaceGetRoot();
        case 'workspace/setRoot':
          return this.workspaceSetRoot(params);

        // System Prompt
        case 'systemPrompt/get':
          return await this.systemPromptGet();
        case 'systemPrompt/set':
          return await this.systemPromptSet(params);

        default:
          return {
            error: {
              code: SessionECPErrorCodes.MethodNotFound,
              message: `Method not found: ${method}`,
            },
          };
      }
    } catch (error) {
      return { error: this.toJsonRpcError(error) };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Settings handlers
  // ─────────────────────────────────────────────────────────────────────────

  private configGet(params: unknown): HandlerResult<{ value: unknown }> {
    const validation = validateECPParams(ConfigGetParamsSchema, params, SessionECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const value = this.service.getSetting(p.key as keyof EditorSettings);
    return { result: { value } };
  }

  private configSet(params: unknown): HandlerResult<{ success: boolean }> {
    const validation = validateECPParams(ConfigSetParamsSchema, params, SessionECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    // Governance settings are human-editable only.
    // Caller identity is asserted by ECPServer and injected into params.
    const caller = ((params ?? {}) as { caller?: { type?: string } }).caller;
    const isGovernanceKey = typeof p.key === 'string'
      && (p.key.startsWith('governance.') || p.key.startsWith('ultra.governance.workingSet.'));

    if (isGovernanceKey && caller?.type !== 'human') {
      return {
        error: {
          code: SessionECPErrorCodes.InvalidParams,
          message: `Access denied: ${String(p.key)} is human-editable only`,
          data: { code: 'GOVERNANCE_SETTING_HUMAN_ONLY', key: p.key },
        },
      };
    }

    this.service.setSetting(p.key as keyof EditorSettings, p.value as EditorSettings[keyof EditorSettings]);
    return { result: { success: true } };
  }

  private configGetAll(): HandlerResult<{ settings: EditorSettings }> {
    const settings = this.service.getAllSettings();
    return { result: { settings } };
  }

  private configReset(params: unknown): HandlerResult<{ success: boolean }> {
    const validation = validateECPParams(ConfigResetParamsSchema, params ?? {}, SessionECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    this.service.resetSettings(p?.key as keyof EditorSettings | undefined);
    return { result: { success: true } };
  }

  private configSchema(): HandlerResult<unknown> {
    const schema = this.service.getSettingsSchema();
    return { result: { schema } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Session handlers
  // ─────────────────────────────────────────────────────────────────────────

  private async sessionSave(params: unknown): Promise<HandlerResult<{ sessionId: string }>> {
    const validation = validateECPParams(SessionSaveParamsSchema, params ?? {}, SessionECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const sessionId = await this.service.saveSession(p?.name);
    return { result: { sessionId } };
  }

  private async sessionLoad(params: unknown): Promise<HandlerResult<unknown>> {
    const validation = validateECPParams(SessionLoadParamsSchema, params, SessionECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const state = await this.service.loadSession(p.sessionId);
    return { result: state };
  }

  private async sessionList(): Promise<HandlerResult<unknown>> {
    const sessions = await this.service.listSessions();
    return { result: { sessions } };
  }

  private async sessionDelete(params: unknown): Promise<HandlerResult<{ success: boolean }>> {
    const validation = validateECPParams(SessionDeleteParamsSchema, params, SessionECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    await this.service.deleteSession(p.sessionId);
    return { result: { success: true } };
  }

  private sessionCurrent(): HandlerResult<unknown> {
    const state = this.service.getCurrentSession();
    return { result: state };
  }

  private sessionSetCurrent(params: unknown): HandlerResult<{ success: boolean }> {
    const validation = validateECPParams(SessionSetCurrentParamsSchema, params, SessionECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    // Validate session state with detailed Zod schema
    const stateValidation = validateSessionState(p.state);
    if (!stateValidation.success) {
      return {
        error: {
          code: SessionECPErrorCodes.ValidationFailed,
          message: stateValidation.error || 'Session validation failed',
          data: { issues: stateValidation.issues },
        },
      };
    }

    // Cast to SessionState - Zod has validated the structure matches
    this.service.setCurrentSession(stateValidation.data as unknown as import('./types.ts').SessionState);
    return { result: { success: true } };
  }

  private sessionMarkDirty(): HandlerResult<{ success: boolean }> {
    this.service.markSessionDirty();
    return { result: { success: true } };
  }

  private async sessionLoadLast(): Promise<HandlerResult<unknown>> {
    const state = await this.service.tryLoadLastSession();
    if (state) {
      this.service.setCurrentSession(state);
    }
    return { result: state };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Keybindings handlers
  // ─────────────────────────────────────────────────────────────────────────

  private keybindingsGet(): HandlerResult<{ bindings: KeyBinding[] }> {
    const bindings = this.service.getKeybindings();
    return { result: { bindings } };
  }

  private keybindingsSet(params: unknown): HandlerResult<{ success: boolean }> {
    const validation = validateECPParams(KeybindingsSetParamsSchema, params, SessionECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    this.service.setKeybindings(p.bindings as KeyBinding[]);
    return { result: { success: true } };
  }

  private keybindingsAdd(params: unknown): HandlerResult<{ success: boolean }> {
    const validation = validateECPParams(KeybindingsAddParamsSchema, params, SessionECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    this.service.addKeybinding(p.binding as KeyBinding);
    return { result: { success: true } };
  }

  private keybindingsRemove(params: unknown): HandlerResult<{ success: boolean }> {
    const validation = validateECPParams(KeybindingsRemoveParamsSchema, params, SessionECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    this.service.removeKeybinding(p.key);
    return { result: { success: true } };
  }

  private keybindingsResolve(params: unknown): HandlerResult<{ command: string | null }> {
    const validation = validateECPParams(KeybindingsResolveParamsSchema, params, SessionECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const command = this.service.resolveKeybinding(p.key as ParsedKey, p.context as KeybindingContext | undefined);
    return { result: { command } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Command handlers
  // ─────────────────────────────────────────────────────────────────────────

  private commandsList(): HandlerResult<{ commands: Record<string, CommandInfo> }> {
    const commands = this.service.getCommands();
    return { result: { commands } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Theme handlers
  // ─────────────────────────────────────────────────────────────────────────

  private themeList(): HandlerResult<unknown> {
    const themes = this.service.listThemes();
    return { result: { themes } };
  }

  private themeGet(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(ThemeIdParamsSchema, params, SessionECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const theme = this.service.getTheme(p.themeId);
    if (!theme) {
      return { error: { code: SessionECPErrorCodes.ThemeNotFound, message: `Theme not found: ${p.themeId}` } };
    }

    return { result: { theme } };
  }

  private themeSet(params: unknown): HandlerResult<{ success: boolean; theme?: unknown }> {
    const validation = validateECPParams(ThemeIdParamsSchema, params, SessionECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    this.service.setTheme(p.themeId);

    // Send theme/changed notification so all connected clients apply the new theme
    const theme = this.service.getCurrentTheme();
    this.sendNotification('theme/changed', { theme });

    return { result: { success: true, theme } };
  }

  private themeCurrent(): HandlerResult<unknown> {
    const theme = this.service.getCurrentTheme();
    return { result: { theme } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Workspace handlers
  // ─────────────────────────────────────────────────────────────────────────

  private workspaceGetRoot(): HandlerResult<{ path: string | null }> {
    const path = this.service.getWorkspaceRoot();
    return { result: { path } };
  }

  private workspaceSetRoot(params: unknown): HandlerResult<{ success: boolean }> {
    const validation = validateECPParams(WorkspaceSetRootParamsSchema, params, SessionECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    console.log('[SessionAdapter] workspaceSetRoot called with:', p.path);

    this.service.setWorkspaceRoot(p.path);

    // Notify ECPServer to reinitialize services (chat storage, etc.)
    if (this.workspaceChangeHandler) {
      console.log('[SessionAdapter] Calling workspace change handler');
      this.workspaceChangeHandler(p.path);
    }

    // Send notification to all clients
    this.sendNotification('workspace/didChangeRoot', { path: p.path });

    return { result: { success: true } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // System Prompt handlers
  // ─────────────────────────────────────────────────────────────────────────

  private getSystemPromptPath(): string {
    return join(homedir(), '.ultra', 'system-prompt.md');
  }

  private getDefaultSystemPromptPath(): string {
    // Get the path relative to this file's location
    const currentDir = dirname(fileURLToPath(import.meta.url));
    return join(currentDir, '..', '..', 'config', 'default-system-prompt.md');
  }

  private async systemPromptGet(): Promise<HandlerResult<{ content: string; isDefault: boolean }>> {
    const userPromptPath = this.getSystemPromptPath();

    // Try to read user's custom system prompt first
    if (existsSync(userPromptPath)) {
      try {
        const content = await readFile(userPromptPath, 'utf-8');
        return { result: { content, isDefault: false } };
      } catch (error) {
        console.error('[SessionAdapter] Failed to read user system prompt:', error);
        // Fall through to default
      }
    }

    // Read default system prompt
    try {
      const defaultPath = this.getDefaultSystemPromptPath();
      const content = await readFile(defaultPath, 'utf-8');
      return { result: { content, isDefault: true } };
    } catch (error) {
      console.error('[SessionAdapter] Failed to read default system prompt:', error);
      // Return a minimal default if file not found
      return {
        result: {
          content: '# System Prompt\n\nYou are a helpful AI assistant.',
          isDefault: true,
        },
      };
    }
  }

  private async systemPromptSet(params: unknown): Promise<HandlerResult<{ success: boolean }>> {
    if (!params || typeof params !== 'object' || !('content' in params)) {
      return {
        error: {
          code: SessionECPErrorCodes.InvalidParams,
          message: 'Missing required parameter: content',
        },
      };
    }

    const { content } = params as { content: string };

    if (typeof content !== 'string') {
      return {
        error: {
          code: SessionECPErrorCodes.InvalidParams,
          message: 'Parameter content must be a string',
        },
      };
    }

    const userPromptPath = this.getSystemPromptPath();
    const ultraDir = join(homedir(), '.ultra');

    try {
      // Ensure ~/.ultra directory exists
      if (!existsSync(ultraDir)) {
        await mkdir(ultraDir, { recursive: true });
      }

      // Write the system prompt
      await writeFile(userPromptPath, content, 'utf-8');

      // Notify clients about the change
      this.sendNotification('systemPrompt/didChange', { content });

      return { result: { success: true } };
    } catch (error) {
      console.error('[SessionAdapter] Failed to save system prompt:', error);
      return {
        error: {
          code: SessionECPErrorCodes.InternalError,
          message: `Failed to save system prompt: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private toJsonRpcError(error: unknown): JsonRpcError {
    if (error instanceof SessionError) {
      // Map SessionError codes to ECP error codes
      let code: number = SessionECPErrorCodes.InternalError;
      switch (error.code) {
        case 'SETTING_NOT_FOUND':
          code = SessionECPErrorCodes.SettingNotFound;
          break;
        case 'INVALID_VALUE':
          code = SessionECPErrorCodes.InvalidValue;
          break;
        case 'SESSION_NOT_FOUND':
          code = SessionECPErrorCodes.SessionNotFound;
          break;
        case 'THEME_NOT_FOUND':
          code = SessionECPErrorCodes.ThemeNotFound;
          break;
        case 'INVALID_KEYBINDING':
          code = SessionECPErrorCodes.InvalidKeybinding;
          break;
        case 'NOT_INITIALIZED':
          code = SessionECPErrorCodes.NotInitialized;
          break;
        case 'VALIDATION_FAILED':
          code = SessionECPErrorCodes.ValidationFailed;
          break;
      }

      return {
        code,
        message: error.message,
        data: error.data,
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    return {
      code: SessionECPErrorCodes.InternalError,
      message,
    };
  }
}
