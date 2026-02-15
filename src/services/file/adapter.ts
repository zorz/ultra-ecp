/**
 * File Service ECP Adapter
 *
 * Maps JSON-RPC 2.0 methods to FileService operations.
 * This adapter handles the protocol layer, allowing the service
 * to be accessed via ECP.
 */

import { resolve, relative } from 'path';
import { debugLog } from '../../debug.ts';
import type { FileService } from './interface.ts';
import type {
  WriteOptions,
  CreateDirOptions,
  DeleteDirOptions,
  SearchOptions,
  GlobOptions,
  WatchOptions,
  FileChangeEvent,
  WatchHandle,
} from './types.ts';
import { FileError, FileErrorCode } from './errors.ts';
import {
  validateECPParams,
  FileReadParamsSchema,
  FileWriteParamsSchema,
  FileStatParamsSchema,
  FileExistsParamsSchema,
  FileDeleteParamsSchema,
  FileRenameParamsSchema,
  FileCopyParamsSchema,
  FileReadDirParamsSchema,
  FileCreateDirParamsSchema,
  FileDeleteDirParamsSchema,
  FileSearchParamsSchema,
  FileGlobParamsSchema,
  FileWatchParamsSchema,
  FileUnwatchParamsSchema,
  FileEditParamsSchema,
  FileGrepParamsSchema,
  FileListParamsSchema,
  FileBrowseDirParamsSchema,
} from '../../protocol/schemas.ts';
import { homedir } from 'os';

/**
 * ECP error codes (JSON-RPC 2.0 compatible).
 */
export const ECPErrorCodes = {
  // Standard JSON-RPC errors
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,

  // File service errors (-32100 to -32199)
  FileNotFound: -32100,
  AccessDenied: -32101,
  IsDirectory: -32102,
  NotDirectory: -32103,
  AlreadyExists: -32104,
  NotEmpty: -32105,
  InvalidUri: -32106,
  NoProvider: -32107,
  NotSupported: -32108,
  IOError: -32109,
} as const;

/**
 * ECP error response.
 */
export interface ECPError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * ECP request.
 */
export interface ECPRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

/**
 * ECP response.
 */
export interface ECPResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: ECPError;
}

/**
 * ECP notification (no id, no response expected).
 */
export interface ECPNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/**
 * Handler result - either success with result or error.
 */
type HandlerResult<T> = { result: T } | { error: ECPError };

/**
 * Map FileError codes to ECP error codes.
 */
function fileErrorToECPError(error: FileError): ECPError {
  const codeMap: Record<FileErrorCode, number> = {
    [FileErrorCode.NOT_FOUND]: ECPErrorCodes.FileNotFound,
    [FileErrorCode.ACCESS_DENIED]: ECPErrorCodes.AccessDenied,
    [FileErrorCode.IS_DIRECTORY]: ECPErrorCodes.IsDirectory,
    [FileErrorCode.NOT_DIRECTORY]: ECPErrorCodes.NotDirectory,
    [FileErrorCode.ALREADY_EXISTS]: ECPErrorCodes.AlreadyExists,
    [FileErrorCode.NOT_EMPTY]: ECPErrorCodes.NotEmpty,
    [FileErrorCode.INVALID_URI]: ECPErrorCodes.InvalidUri,
    [FileErrorCode.NO_PROVIDER]: ECPErrorCodes.NoProvider,
    [FileErrorCode.NOT_SUPPORTED]: ECPErrorCodes.NotSupported,
    [FileErrorCode.IO_ERROR]: ECPErrorCodes.IOError,
    [FileErrorCode.UNKNOWN]: ECPErrorCodes.InternalError,
  };

  return {
    code: codeMap[error.code] ?? ECPErrorCodes.InternalError,
    message: error.message,
    data: { uri: error.uri, code: error.code },
  };
}

/**
 * Convert a file path to a file:// URI if needed.
 */
function ensureFileUri(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  // Already a URI with scheme
  if (value.includes('://')) return value;
  // Convert path to file:// URI
  const absolutePath = value.startsWith('/') ? value : resolve(process.cwd(), value);
  return `file://${absolutePath}`;
}

/**
 * Normalize params to use 'uri' instead of 'path'.
 * AI tools often use 'path' but our schemas expect 'uri'.
 * Also handles 'file_path' from Claude Code tools.
 * Converts path values to file:// URIs.
 */
function normalizePathToUri(params: unknown): unknown {
  if (!params || typeof params !== 'object') return params;
  const p = { ...(params as Record<string, unknown>) };

  // If already has uri, ensure it has a scheme
  if ('uri' in p) {
    p.uri = ensureFileUri(p.uri);
    return p;
  }

  // Convert path or file_path to uri with file:// scheme
  if ('path' in p) {
    p.uri = ensureFileUri(p.path);
    delete p.path;
  } else if ('file_path' in p) {
    p.uri = ensureFileUri(p.file_path);
    delete p.file_path;
  }

  // Handle oldUri/newUri for rename - check for old_path/new_path
  if ('old_path' in p) {
    p.oldUri = ensureFileUri(p.old_path);
    delete p.old_path;
  }
  if ('new_path' in p) {
    p.newUri = ensureFileUri(p.new_path);
    delete p.new_path;
  }

  // Handle sourceUri/targetUri for copy - check for source_path/target_path
  if ('source_path' in p) {
    p.sourceUri = ensureFileUri(p.source_path);
    delete p.source_path;
  }
  if ('target_path' in p) {
    p.targetUri = ensureFileUri(p.target_path);
    delete p.target_path;
  }

  // Handle baseUri for glob - check for base_path or basePath
  if ('base_path' in p) {
    p.baseUri = ensureFileUri(p.base_path);
    delete p.base_path;
  } else if ('basePath' in p) {
    p.baseUri = ensureFileUri(p.basePath);
    delete p.basePath;
  }

  return p;
}

/**
 * File Service ECP Adapter.
 *
 * Maps JSON-RPC methods to FileService operations:
 *
 * Content operations:
 * - file/read -> read()
 * - file/write -> write()
 *
 * Metadata operations:
 * - file/stat -> stat()
 * - file/exists -> exists()
 *
 * File operations:
 * - file/delete -> delete()
 * - file/rename -> rename()
 * - file/copy -> copy()
 *
 * Directory operations:
 * - file/readDir -> readDir()
 * - file/createDir -> createDir()
 * - file/deleteDir -> deleteDir()
 *
 * Search operations:
 * - file/search -> search()
 * - file/glob -> glob()
 *
 * Watch operations:
 * - file/watch -> watch()
 * - file/unwatch -> dispose watch
 *
 * Utility:
 * - file/pathToUri -> pathToUri()
 * - file/uriToPath -> uriToPath()
 * - file/getParent -> getParentUri()
 * - file/getBasename -> getBasename()
 * - file/join -> joinUri()
 */
export class FileServiceAdapter {
  private service: FileService;
  private notificationHandler?: (notification: ECPNotification) => void;
  private activeWatches = new Map<string, WatchHandle>();
  private workspaceRoot: string | undefined;
  private browseRootPath: string;

  constructor(service: FileService, workspaceRoot?: string) {
    this.service = service;
    this.workspaceRoot = workspaceRoot;
    this.browseRootPath = homedir();

    // Subscribe to file change events
    this.setupEventHandlers();
  }

  /**
   * Set the workspace root for path validation.
   * All file operations will be restricted to this directory.
   */
  setWorkspaceRoot(workspaceRoot: string): void {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Set the root path for browsing directories.
   * file/browseDir will be restricted to this directory subtree.
   * Defaults to user's home directory.
   */
  setBrowseRootPath(path: string): void {
    this.browseRootPath = path;
  }

  /**
   * Get the current browse root path.
   */
  getBrowseRootPath(): string {
    return this.browseRootPath;
  }

  /**
   * Validate that a URI is within the workspace root.
   * Prevents path traversal attacks and unauthorized access.
   */
  private validateUri(uri: string): void {
    if (!this.workspaceRoot) {
      // No workspace root set - deny all paths for security
      throw new FileError(
        FileErrorCode.ACCESS_DENIED,
        uri,
        `Access denied: no workspace root configured`
      );
    }

    // Convert URI to path
    let filePath: string;
    if (uri.startsWith('file://')) {
      filePath = uri.slice(7);
    } else {
      // Assume it's already a path
      filePath = uri;
    }

    // Resolve to absolute path
    const resolvedWorkspace = resolve(this.workspaceRoot);
    const resolvedPath = resolve(resolvedWorkspace, filePath);
    const relativePath = relative(resolvedWorkspace, resolvedPath);

    // Check if path escapes workspace root
    if (relativePath.startsWith('..') || relativePath.startsWith('/')) {
      throw new FileError(
        FileErrorCode.ACCESS_DENIED,
        uri,
        `Access denied: path is outside workspace root`
      );
    }
  }

  /**
   * Set handler for outgoing notifications.
   */
  setNotificationHandler(handler: (notification: ECPNotification) => void): void {
    this.notificationHandler = handler;
  }

  /**
   * Handle an incoming ECP request.
   */
  async handleRequest(request: ECPRequest): Promise<ECPResponse> {
    const { id, method, params } = request;

    debugLog(`[FileServiceAdapter] Handling request: ${method}`);

    try {
      const result = await this.dispatch(method, params);

      if ('error' in result) {
        return {
          jsonrpc: '2.0',
          id,
          error: result.error,
        };
      }

      return {
        jsonrpc: '2.0',
        id,
        result: result.result,
      };
    } catch (error) {
      debugLog(`[FileServiceAdapter] Error handling ${method}: ${error}`);

      // Convert FileError to ECP error
      if (error instanceof FileError) {
        return {
          jsonrpc: '2.0',
          id,
          error: fileErrorToECPError(error),
        };
      }

      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: ECPErrorCodes.InternalError,
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  }

  /**
   * Dispatch a method to the appropriate handler.
   */
  private async dispatch(method: string, params: unknown): Promise<HandlerResult<unknown>> {
    switch (method) {
      // Content operations
      case 'file/read':
        return this.handleRead(params);
      case 'file/write':
        return this.handleWrite(params);

      // Metadata operations
      case 'file/stat':
        return this.handleStat(params);
      case 'file/exists':
        return this.handleExists(params);

      // File operations
      case 'file/delete':
        return this.handleDelete(params);
      case 'file/rename':
        return this.handleRename(params);
      case 'file/copy':
        return this.handleCopy(params);

      // Directory operations
      case 'file/readDir':
        return this.handleReadDir(params);
      case 'file/list':
        return this.handleList(params);
      case 'file/createDir':
        return this.handleCreateDir(params);
      case 'file/deleteDir':
        return this.handleDeleteDir(params);
      case 'file/browseDir':
        return this.handleBrowseDir(params);

      // Search operations
      case 'file/search':
        return this.handleSearch(params);
      case 'file/glob':
        return this.handleGlob(params);
      case 'file/grep':
        return this.handleGrep(params);

      // Edit operations
      case 'file/edit':
        return this.handleEdit(params);

      // Watch operations
      case 'file/watch':
        return this.handleWatch(params);
      case 'file/unwatch':
        return this.handleUnwatch(params);

      // Utility operations
      case 'file/pathToUri':
        return this.handlePathToUri(params);
      case 'file/uriToPath':
        return this.handleUriToPath(params);
      case 'file/getParent':
        return this.handleGetParent(params);
      case 'file/getBasename':
        return this.handleGetBasename(params);
      case 'file/join':
        return this.handleJoin(params);

      default:
        return {
          error: {
            code: ECPErrorCodes.MethodNotFound,
            message: `Unknown method: ${method}`,
          },
        };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Content Operation Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private async handleRead(params: unknown): Promise<HandlerResult<unknown>> {
    const normalizedParams = normalizePathToUri(params);
    const validation = validateECPParams(FileReadParamsSchema, normalizedParams, ECPErrorCodes.InvalidParams);
    if (!validation.success) {
      return { error: validation.error! };
    }
    const p = validation.data!;

    // Validate path is within workspace
    this.validateUri(p.uri);

    const result = await this.service.read(p.uri);
    return { result };
  }

  private async handleWrite(params: unknown): Promise<HandlerResult<unknown>> {
    const normalizedParams = normalizePathToUri(params);
    const validation = validateECPParams(FileWriteParamsSchema, normalizedParams, ECPErrorCodes.InvalidParams);
    if (!validation.success) {
      return { error: validation.error! };
    }
    const p = validation.data!;

    // Validate path is within workspace
    this.validateUri(p.uri);

    const options: WriteOptions = {
      encoding: p.encoding,
      createParents: p.createParents,
      overwrite: p.overwrite,
    };

    const result = await this.service.write(p.uri, p.content, options);
    return { result };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Metadata Operation Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private async handleStat(params: unknown): Promise<HandlerResult<unknown>> {
    const normalizedParams = normalizePathToUri(params);
    const validation = validateECPParams(FileStatParamsSchema, normalizedParams, ECPErrorCodes.InvalidParams);
    if (!validation.success) {
      return { error: validation.error! };
    }
    const p = validation.data!;

    // Validate path is within workspace
    this.validateUri(p.uri);

    const result = await this.service.stat(p.uri);
    return { result };
  }

  private async handleExists(params: unknown): Promise<HandlerResult<unknown>> {
    const normalizedParams = normalizePathToUri(params);
    const validation = validateECPParams(FileExistsParamsSchema, normalizedParams, ECPErrorCodes.InvalidParams);
    if (!validation.success) {
      return { error: validation.error! };
    }
    const p = validation.data!;

    // Validate path is within workspace
    this.validateUri(p.uri);

    const exists = await this.service.exists(p.uri);
    return { result: { exists } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // File Operation Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private async handleDelete(params: unknown): Promise<HandlerResult<unknown>> {
    const normalizedParams = normalizePathToUri(params);
    const validation = validateECPParams(FileDeleteParamsSchema, normalizedParams, ECPErrorCodes.InvalidParams);
    if (!validation.success) {
      return { error: validation.error! };
    }
    const p = validation.data!;

    // Validate path is within workspace
    this.validateUri(p.uri);

    await this.service.delete(p.uri);
    return { result: { success: true } };
  }

  private async handleRename(params: unknown): Promise<HandlerResult<unknown>> {
    const normalizedParams = normalizePathToUri(params);
    const validation = validateECPParams(FileRenameParamsSchema, normalizedParams, ECPErrorCodes.InvalidParams);
    if (!validation.success) {
      return { error: validation.error! };
    }
    const p = validation.data!;

    // Validate both paths are within workspace
    this.validateUri(p.oldUri);
    this.validateUri(p.newUri);

    await this.service.rename(p.oldUri, p.newUri);
    return { result: { success: true } };
  }

  private async handleCopy(params: unknown): Promise<HandlerResult<unknown>> {
    const normalizedParams = normalizePathToUri(params);
    const validation = validateECPParams(FileCopyParamsSchema, normalizedParams, ECPErrorCodes.InvalidParams);
    if (!validation.success) {
      return { error: validation.error! };
    }
    const p = validation.data!;

    // Validate both paths are within workspace
    this.validateUri(p.sourceUri);
    this.validateUri(p.targetUri);

    await this.service.copy(p.sourceUri, p.targetUri);
    return { result: { success: true } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Directory Operation Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private async handleReadDir(params: unknown): Promise<HandlerResult<unknown>> {
    const normalizedParams = normalizePathToUri(params);
    const validation = validateECPParams(FileReadDirParamsSchema, normalizedParams, ECPErrorCodes.InvalidParams);
    if (!validation.success) {
      return { error: validation.error! };
    }
    const p = validation.data!;

    // Validate path is within workspace
    this.validateUri(p.uri);

    const entries = await this.service.readDir(p.uri);
    return { result: { entries } };
  }

  /**
   * Handle file/list - list directory with optional recursive support.
   * Uses 'path' parameter (normalized from AI tools).
   */
  private async handleList(params: unknown): Promise<HandlerResult<unknown>> {
    const validation = validateECPParams(FileListParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) {
      return { error: validation.error! };
    }
    const p = validation.data!;

    // Resolve and validate path
    const pathStr = p.path as string;  // Schema guarantees path is required
    const wsRoot = this.workspaceRoot || process.cwd();
    const resolvedPath = resolve(wsRoot, pathStr);
    if (!resolvedPath.startsWith(wsRoot)) {
      return {
        error: {
          code: ECPErrorCodes.AccessDenied,
          message: `Path must be within workspace: ${pathStr}`,
        },
      };
    }

    try {
      // Convert path to file:// URI for service calls
      const uri = this.service.pathToUri(resolvedPath);

      if (p.recursive) {
        // Use glob for recursive listing
        const entries = await this.service.glob('**/*', { baseUri: uri });
        // Convert URIs to relative paths
        const files = entries.map((entryUri: string) => {
          const entryPath = this.service.uriToPath(entryUri);
          return {
            name: entryPath ? relative(resolvedPath, entryPath) : entryUri,
            uri: entryUri,
            type: 'file' as const, // Glob returns files
          };
        });
        return { result: { entries: files } };
      } else {
        // Non-recursive - use readDir
        const entries = await this.service.readDir(uri);
        return { result: { entries } };
      }
    } catch (error) {
      if (error instanceof FileError) {
        return { error: fileErrorToECPError(error) };
      }
      throw error;
    }
  }

  private async handleCreateDir(params: unknown): Promise<HandlerResult<unknown>> {
    const normalizedParams = normalizePathToUri(params);
    const validation = validateECPParams(FileCreateDirParamsSchema, normalizedParams, ECPErrorCodes.InvalidParams);
    if (!validation.success) {
      return { error: validation.error! };
    }
    const p = validation.data!;

    // Validate path is within workspace
    this.validateUri(p.uri);

    const options: CreateDirOptions = {
      recursive: p.recursive,
    };

    await this.service.createDir(p.uri, options);
    return { result: { success: true } };
  }

  private async handleDeleteDir(params: unknown): Promise<HandlerResult<unknown>> {
    const normalizedParams = normalizePathToUri(params);
    const validation = validateECPParams(FileDeleteDirParamsSchema, normalizedParams, ECPErrorCodes.InvalidParams);
    if (!validation.success) {
      return { error: validation.error! };
    }
    const p = validation.data!;

    // Validate path is within workspace
    this.validateUri(p.uri);

    const options: DeleteDirOptions = {
      recursive: p.recursive,
    };

    await this.service.deleteDir(p.uri, options);
    return { result: { success: true } };
  }

  /**
   * Handle file/browseDir - browse directories without workspace restriction.
   * Restricted to browseRootPath subtree for security.
   */
  private async handleBrowseDir(params: unknown): Promise<HandlerResult<unknown>> {
    // Note: Don't use normalizePathToUri here - this schema expects 'path', not 'uri'
    const validation = validateECPParams(FileBrowseDirParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) {
      return { error: validation.error! };
    }
    const p = validation.data!;

    // Handle ~ as home directory
    let inputPath = p.path;
    if (inputPath === '~' || inputPath.startsWith('~/')) {
      inputPath = inputPath.replace(/^~/, homedir());
    }

    // Validate path is within browse root
    const resolvedBrowseRoot = resolve(this.browseRootPath);
    const resolvedPath = resolve(resolvedBrowseRoot, inputPath);
    const relativePath = relative(resolvedBrowseRoot, resolvedPath);

    if (relativePath.startsWith('..') || relativePath.startsWith('/')) {
      throw new FileError(
        FileErrorCode.ACCESS_DENIED,
        p.path,
        `Access denied: path is outside browse root (${this.browseRootPath})`
      );
    }

    // Convert path to file:// URI for the service
    const uri = this.service.pathToUri(resolvedPath);

    // Use the URI for reading
    const entries = await this.service.readDir(uri);

    // Filter entries based on options
    let filteredEntries = entries;

    // Filter hidden files if showHidden is false
    if (!p.showHidden) {
      filteredEntries = filteredEntries.filter(entry => !entry.name.startsWith('.'));
    }

    // Filter to directories only if requested
    if (p.directoriesOnly) {
      filteredEntries = filteredEntries.filter(entry => entry.type === 'directory');
    }

    // Sort: directories first, then alphabetically
    filteredEntries.sort((a, b) => {
      const aIsDir = a.type === 'directory';
      const bIsDir = b.type === 'directory';
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.name.localeCompare(b.name);
    });

    // Convert URIs back to paths for client consumption
    const mappedEntries = filteredEntries.map(entry => ({
      ...entry,
      // Convert file:// URI to plain path
      path: this.service.uriToPath(entry.uri),
    }));

    return {
      result: {
        path: resolvedPath,
        entries: mappedEntries,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Search Operation Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private async handleSearch(params: unknown): Promise<HandlerResult<unknown>> {
    const validation = validateECPParams(FileSearchParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) {
      return { error: validation.error! };
    }
    const p = validation.data!;

    // Require workspace root for security
    if (!this.workspaceRoot) {
      return {
        error: {
          code: ECPErrorCodes.AccessDenied,
          message: 'Cannot search: no workspace root configured',
        },
      };
    }

    // Validate includePatterns if provided, and add workspace root as default
    let includePatterns = p.includePatterns;
    if (includePatterns && includePatterns.length > 0) {
      // Validate each pattern is within workspace
      for (const pattern of includePatterns) {
        this.validateUri(pattern);
      }
    } else {
      // Default to workspace root
      includePatterns = [this.service.pathToUri(this.workspaceRoot)];
    }

    const options: SearchOptions = {
      maxResults: p.maxResults,
      caseSensitive: p.caseSensitive,
      searchContent: p.searchContent,
      includePatterns,
      excludePatterns: p.excludePatterns,
    };

    const results = await this.service.search(p.pattern, options);
    return { result: { results } };
  }

  private async handleGlob(params: unknown): Promise<HandlerResult<unknown>> {
    const normalizedParams = normalizePathToUri(params);
    const validation = validateECPParams(FileGlobParamsSchema, normalizedParams, ECPErrorCodes.InvalidParams);
    if (!validation.success) {
      return { error: validation.error! };
    }
    const p = validation.data!;

    // Default to workspace root if baseUri not provided
    let baseUri = p.baseUri;
    if (!baseUri) {
      if (!this.workspaceRoot) {
        return {
          error: {
            code: ECPErrorCodes.AccessDenied,
            message: 'Cannot glob without baseUri: no workspace root configured',
          },
        };
      }
      baseUri = this.service.pathToUri(this.workspaceRoot);
    }

    // Always validate baseUri (whether provided or defaulted)
    this.validateUri(baseUri);

    const options: GlobOptions = {
      baseUri,
      maxResults: p.maxResults,
      excludePatterns: p.excludePatterns,
      followSymlinks: p.followSymlinks,
      includeDirectories: p.includeDirectories,
    };

    const uris = await this.service.glob(p.pattern, options);
    return { result: { uris } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Watch Operation Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private handleWatch(params: unknown): HandlerResult<unknown> {
    const normalizedParams = normalizePathToUri(params);
    const validation = validateECPParams(FileWatchParamsSchema, normalizedParams, ECPErrorCodes.InvalidParams);
    if (!validation.success) {
      return { error: validation.error! };
    }
    const p = validation.data!;

    // Validate path is within workspace
    this.validateUri(p.uri);

    const options: WatchOptions = {
      recursive: p.recursive,
    };

    // Create watch with callback that sends notifications
    const handle = this.service.watch(
      p.uri,
      (event: FileChangeEvent) => {
        this.sendNotification('file/didChange', event);
      },
      options
    );

    // Store handle for later disposal
    this.activeWatches.set(handle.id, handle);

    return { result: { watchId: handle.id } };
  }

  private handleUnwatch(params: unknown): HandlerResult<unknown> {
    const normalizedParams = normalizePathToUri(params);
    const validation = validateECPParams(FileUnwatchParamsSchema, normalizedParams, ECPErrorCodes.InvalidParams);
    if (!validation.success) {
      return { error: validation.error! };
    }
    const p = validation.data!;

    const handle = this.activeWatches.get(p.watchId);
    if (!handle) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'Unknown watchId' } };
    }

    handle.dispose();
    this.activeWatches.delete(p.watchId);

    return { result: { success: true } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Utility Operation Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private handlePathToUri(params: unknown): HandlerResult<unknown> {
    const p = params as { path: string };
    if (!p?.path) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'path is required' } };
    }

    const uri = this.service.pathToUri(p.path);
    return { result: { uri } };
  }

  private handleUriToPath(params: unknown): HandlerResult<unknown> {
    const p = params as { uri: string };
    if (!p?.uri) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'uri is required' } };
    }

    const path = this.service.uriToPath(p.uri);
    return { result: { path } };
  }

  private handleGetParent(params: unknown): HandlerResult<unknown> {
    const p = params as { uri: string };
    if (!p?.uri) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'uri is required' } };
    }

    const parent = this.service.getParentUri(p.uri);
    return { result: { parent } };
  }

  private handleGetBasename(params: unknown): HandlerResult<unknown> {
    const p = params as { uri: string };
    if (!p?.uri) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'uri is required' } };
    }

    const basename = this.service.getBasename(p.uri);
    return { result: { basename } };
  }

  private handleJoin(params: unknown): HandlerResult<unknown> {
    const p = params as { baseUri: string; paths: string[] };
    if (!p?.baseUri || !Array.isArray(p.paths)) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'baseUri and paths array are required' } };
    }

    const uri = this.service.joinUri(p.baseUri, ...p.paths);
    return { result: { uri } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Edit Operation Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private async handleEdit(params: unknown): Promise<HandlerResult<unknown>> {
    // Normalize path/file_path to uri if needed
    const normalizedParams = this.normalizeEditParams(params);
    const validation = validateECPParams(FileEditParamsSchema, normalizedParams, ECPErrorCodes.InvalidParams);
    if (!validation.success) {
      return { error: validation.error! };
    }
    const p = validation.data!;

    // Validate path is within workspace
    this.validateUri(p.uri);

    try {
      // Read current content
      const fileContent = await this.service.read(p.uri);
      const content = fileContent.content;

      // Check if old_string exists in content
      if (!content.includes(p.oldString)) {
        return {
          error: {
            code: ECPErrorCodes.InvalidParams,
            message: `old_string not found in file. Make sure it matches exactly, including whitespace.`,
          },
        };
      }

      // Check for uniqueness if not replacing all
      if (!p.replaceAll) {
        const occurrences = content.split(p.oldString).length - 1;
        if (occurrences > 1) {
          return {
            error: {
              code: ECPErrorCodes.InvalidParams,
              message: `old_string is not unique in file (found ${occurrences} occurrences). Provide more context or use replaceAll.`,
            },
          };
        }
      }

      // Perform replacement
      let newContent: string;
      if (p.replaceAll) {
        newContent = content.split(p.oldString).join(p.newString);
      } else {
        newContent = content.replace(p.oldString, p.newString);
      }

      // Write back
      await this.service.write(p.uri, newContent);

      return { result: { success: true } };
    } catch (error) {
      if (error instanceof FileError) {
        return { error: fileErrorToECPError(error) };
      }
      throw error;
    }
  }

  private normalizeEditParams(params: unknown): unknown {
    const p = params as Record<string, unknown>;
    if (!p) return params;

    // Convert file_path or path to uri
    const path = p.file_path || p.path;
    if (typeof path === 'string' && !p.uri) {
      return {
        ...p,
        uri: this.service.pathToUri(path),
        oldString: p.old_string || p.oldString,
        newString: p.new_string || p.newString,
        replaceAll: p.replace_all || p.replaceAll,
      };
    }

    return params;
  }

  private async handleGrep(params: unknown): Promise<HandlerResult<unknown>> {
    const validation = validateECPParams(FileGrepParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) {
      return { error: validation.error! };
    }
    const p = validation.data!;

    // Require workspace root for security
    if (!this.workspaceRoot) {
      return {
        error: {
          code: ECPErrorCodes.AccessDenied,
          message: 'Cannot grep: no workspace root configured',
        },
      };
    }

    // Default to workspace root if no path provided
    const searchPath = p.path || this.workspaceRoot;

    // Validate path is within workspace
    const resolvedPath = resolve(searchPath);
    const resolvedWorkspace = resolve(this.workspaceRoot);
    if (!resolvedPath.startsWith(resolvedWorkspace)) {
      return {
        error: {
          code: ECPErrorCodes.AccessDenied,
          message: 'Cannot grep: path is outside workspace',
        },
      };
    }

    try {
      // Use ripgrep via shell command for better performance
      const args = ['rg', '--json', '--max-count', String(p.maxResults || 100)];

      if (!p.caseSensitive) {
        args.push('-i');
      }

      if (p.glob) {
        args.push('-g', p.glob);
      }

      args.push(p.pattern, searchPath);

      const proc = Bun.spawn(args, {
        cwd: this.workspaceRoot,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      // Exit code 1 means no matches (not an error)
      if (exitCode !== 0 && exitCode !== 1) {
        const stderr = await new Response(proc.stderr).text();
        return {
          error: {
            code: ECPErrorCodes.InternalError,
            message: `grep failed: ${stderr}`,
          },
        };
      }

      // Parse JSON lines output from ripgrep
      const matches: Array<{
        file: string;
        line: number;
        column: number;
        text: string;
      }> = [];

      for (const line of output.split('\n').filter(Boolean)) {
        try {
          const item = JSON.parse(line);
          if (item.type === 'match') {
            const data = item.data;
            matches.push({
              file: data.path.text,
              line: data.line_number,
              column: data.submatches[0]?.start || 0,
              text: data.lines.text.trimEnd(),
            });
          }
        } catch {
          // Skip invalid JSON lines
        }
      }

      return { result: { matches } };
    } catch (error) {
      // Fallback if ripgrep not available
      return {
        error: {
          code: ECPErrorCodes.InternalError,
          message: `grep failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Event Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private setupEventHandlers(): void {
    // Subscribe to file change events
    this.service.onFileChange((event: FileChangeEvent) => {
      // Determine notification type based on change type
      switch (event.type) {
        case 'created':
          this.sendNotification('file/didCreate', { uri: event.uri });
          break;
        case 'deleted':
          this.sendNotification('file/didDelete', { uri: event.uri });
          break;
        case 'changed':
          this.sendNotification('file/didChange', event);
          break;
      }
    });
  }

  private sendNotification(method: string, params: unknown): void {
    if (this.notificationHandler) {
      this.notificationHandler({
        jsonrpc: '2.0',
        method,
        params,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cleanup
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Dispose all active watches.
   */
  dispose(): void {
    for (const handle of this.activeWatches.values()) {
      handle.dispose();
    }
    this.activeWatches.clear();
  }
}
