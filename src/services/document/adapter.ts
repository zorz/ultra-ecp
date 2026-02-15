/**
 * Document Service ECP Adapter
 *
 * Maps JSON-RPC 2.0 methods to DocumentService operations.
 * This adapter handles the protocol layer, allowing the service
 * to be accessed via ECP.
 */

import { debugLog } from '../../debug.ts';
import type { DocumentService } from './interface.ts';
import type {
  Cursor,
  DocumentOpenOptions,
  InsertOptions,
  DeleteOptions,
  ReplaceOptions,
  MoveCursorsOptions,
  MoveDirection,
  MoveUnit,
} from './types.ts';
import {
  validateECPParams,
  DocumentOpenParamsSchema,
  DocumentCloseParamsSchema,
  DocumentContentParamsSchema,
  DocumentInsertParamsSchema,
  DocumentReplaceParamsSchema,
  DocumentIdParamsSchema,
  DocumentLineParamsSchema,
  DocumentLinesParamsSchema,
  DocumentTextInRangeParamsSchema,
  DocumentDeleteParamsSchema,
  DocumentSetContentParamsSchema,
  DocumentSetCursorsParamsSchema,
  DocumentSetCursorParamsSchema,
  DocumentAddCursorParamsSchema,
  DocumentMoveCursorsParamsSchema,
  DocumentOffsetParamsSchema,
  DocumentPositionParamsSchema,
} from '../../protocol/schemas.ts';

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

  // Document service errors (-32000 to -32099)
  DocumentNotFound: -32001,
  DocumentReadOnly: -32002,
  InvalidPosition: -32003,
  InvalidRange: -32004,
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
 * Document Service ECP Adapter.
 *
 * Maps JSON-RPC methods to DocumentService operations:
 *
 * - document/open -> open()
 * - document/close -> close()
 * - document/content -> getContent()
 * - document/line -> getLine()
 * - document/lines -> getLines()
 * - document/insert -> insert()
 * - document/delete -> delete()
 * - document/replace -> replace()
 * - document/setContent -> setContent()
 * - document/cursors -> getCursors()
 * - document/setCursors -> setCursors()
 * - document/moveCursors -> moveCursors()
 * - document/selectAll -> selectAll()
 * - document/undo -> undo()
 * - document/redo -> redo()
 * - document/info -> getInfo()
 * - document/list -> listOpen()
 */
export class DocumentServiceAdapter {
  private service: DocumentService;
  private notificationHandler?: (notification: ECPNotification) => void;

  constructor(service: DocumentService) {
    this.service = service;

    // Subscribe to service events and emit as notifications
    this.setupEventHandlers();
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

    debugLog(`[DocumentServiceAdapter] Handling request: ${method}`);

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
      debugLog(`[DocumentServiceAdapter] Error handling ${method}: ${error}`);
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
      // Document lifecycle
      case 'document/open':
        return this.handleOpen(params);
      case 'document/close':
        return this.handleClose(params);
      case 'document/info':
        return this.handleInfo(params);
      case 'document/list':
        return this.handleList();

      // Content access
      case 'document/content':
        return this.handleContent(params);
      case 'document/line':
        return this.handleLine(params);
      case 'document/lines':
        return this.handleLines(params);
      case 'document/textInRange':
        return this.handleTextInRange(params);
      case 'document/version':
        return this.handleVersion(params);

      // Text editing
      case 'document/insert':
        return this.handleInsert(params);
      case 'document/delete':
        return this.handleDelete(params);
      case 'document/replace':
        return this.handleReplace(params);
      case 'document/setContent':
        return this.handleSetContent(params);

      // Cursor management
      case 'document/cursors':
        return this.handleCursors(params);
      case 'document/setCursors':
        return this.handleSetCursors(params);
      case 'document/setCursor':
        return this.handleSetCursor(params);
      case 'document/addCursor':
        return this.handleAddCursor(params);
      case 'document/moveCursors':
        return this.handleMoveCursors(params);
      case 'document/selectAll':
        return this.handleSelectAll(params);
      case 'document/clearSelections':
        return this.handleClearSelections(params);
      case 'document/selections':
        return this.handleSelections(params);

      // Undo/Redo
      case 'document/undo':
        return this.handleUndo(params);
      case 'document/redo':
        return this.handleRedo(params);
      case 'document/canUndo':
        return this.handleCanUndo(params);
      case 'document/canRedo':
        return this.handleCanRedo(params);

      // Dirty state
      case 'document/isDirty':
        return this.handleIsDirty(params);
      case 'document/markClean':
        return this.handleMarkClean(params);

      // Utility
      case 'document/positionToOffset':
        return this.handlePositionToOffset(params);
      case 'document/offsetToPosition':
        return this.handleOffsetToPosition(params);
      case 'document/wordAtPosition':
        return this.handleWordAtPosition(params);

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
  // Document Lifecycle Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private async handleOpen(params: unknown): Promise<HandlerResult<unknown>> {
    const validation = validateECPParams(DocumentOpenParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const options: DocumentOpenOptions = {
      uri: p.uri,
      content: p.content,
      languageId: p.languageId,
    };

    try {
      const result = await this.service.open(options);
      return { result };
    } catch (error) {
      return {
        error: {
          code: ECPErrorCodes.InternalError,
          message: error instanceof Error ? error.message : 'Failed to open document',
        },
      };
    }
  }

  private async handleClose(params: unknown): Promise<HandlerResult<unknown>> {
    const validation = validateECPParams(DocumentCloseParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const success = await this.service.close(p.documentId);
    return { result: { success } };
  }

  private handleInfo(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(DocumentIdParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const info = this.service.getInfo(p.documentId);
    if (!info) {
      return { error: { code: ECPErrorCodes.DocumentNotFound, message: 'Document not found' } };
    }

    return { result: info };
  }

  private handleList(): HandlerResult<unknown> {
    const documents = this.service.listOpen();
    return { result: { documents } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Content Access Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private handleContent(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(DocumentContentParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const content = this.service.getContent(p.documentId);
    if (!content) {
      return { error: { code: ECPErrorCodes.DocumentNotFound, message: 'Document not found' } };
    }

    return { result: content };
  }

  private handleLine(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(DocumentLineParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const line = this.service.getLine(p.documentId, p.lineNumber);
    if (line === null) {
      return { error: { code: ECPErrorCodes.InvalidPosition, message: 'Invalid line number' } };
    }

    return { result: line };
  }

  private handleLines(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(DocumentLinesParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const lines = this.service.getLines(p.documentId, p.startLine, p.endLine);
    return { result: { lines } };
  }

  private handleTextInRange(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(DocumentTextInRangeParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const text = this.service.getTextInRange(p.documentId, p.range);
    if (text === null) {
      return { error: { code: ECPErrorCodes.DocumentNotFound, message: 'Document not found' } };
    }

    return { result: { text } };
  }

  private handleVersion(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(DocumentIdParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const version = this.service.getVersion(p.documentId);
    if (version === null) {
      return { error: { code: ECPErrorCodes.DocumentNotFound, message: 'Document not found' } };
    }

    return { result: { version } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Text Editing Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private handleInsert(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(DocumentInsertParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const options: InsertOptions = {
      documentId: p.documentId,
      position: p.position,
      text: p.text,
    };

    const result = this.service.insert(options);
    return { result };
  }

  private handleDelete(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(DocumentDeleteParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const options: DeleteOptions = {
      documentId: p.documentId,
      range: p.range,
      groupWithPrevious: p.groupWithPrevious,
    };

    const result = this.service.delete(options);
    return { result };
  }

  private handleReplace(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(DocumentReplaceParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const options: ReplaceOptions = {
      documentId: p.documentId,
      range: p.range,
      text: p.text,
    };

    const result = this.service.replace(options);
    return { result };
  }

  private handleSetContent(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(DocumentSetContentParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const result = this.service.setContent(p.documentId, p.content);
    return { result };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cursor Management Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private handleCursors(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(DocumentIdParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const cursors = this.service.getCursors(p.documentId);
    if (cursors === null) {
      return { error: { code: ECPErrorCodes.DocumentNotFound, message: 'Document not found' } };
    }

    return { result: { cursors } };
  }

  private handleSetCursors(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(DocumentSetCursorsParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const success = this.service.setCursors({ documentId: p.documentId, cursors: p.cursors as Cursor[] });
    return { result: { success } };
  }

  private handleSetCursor(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(DocumentSetCursorParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const success = this.service.setCursor(p.documentId, p.position, p.selection);
    return { result: { success } };
  }

  private handleAddCursor(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(DocumentAddCursorParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const success = this.service.addCursor(p.documentId, p.position);
    return { result: { success } };
  }

  private handleMoveCursors(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(DocumentMoveCursorsParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const options: MoveCursorsOptions = {
      documentId: p.documentId,
      direction: p.direction as MoveDirection,
      unit: p.unit as MoveUnit,
      select: p.select,
    };

    const success = this.service.moveCursors(options);
    return { result: { success } };
  }

  private handleSelectAll(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(DocumentIdParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const success = this.service.selectAll(p.documentId);
    return { result: { success } };
  }

  private handleClearSelections(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(DocumentIdParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const success = this.service.clearSelections(p.documentId);
    return { result: { success } };
  }

  private handleSelections(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(DocumentIdParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const selections = this.service.getSelections(p.documentId);
    if (selections === null) {
      return { error: { code: ECPErrorCodes.DocumentNotFound, message: 'Document not found' } };
    }

    return { result: { selections } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Undo/Redo Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private handleUndo(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(DocumentIdParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const result = this.service.undo(p.documentId);
    return { result };
  }

  private handleRedo(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(DocumentIdParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const result = this.service.redo(p.documentId);
    return { result };
  }

  private handleCanUndo(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(DocumentIdParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const canUndo = this.service.canUndo(p.documentId);
    return { result: { canUndo } };
  }

  private handleCanRedo(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(DocumentIdParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const canRedo = this.service.canRedo(p.documentId);
    return { result: { canRedo } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Dirty State Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private handleIsDirty(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(DocumentIdParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const isDirty = this.service.isDirty(p.documentId);
    return { result: { isDirty } };
  }

  private handleMarkClean(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(DocumentIdParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    this.service.markClean(p.documentId);
    return { result: { success: true } };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Utility Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private handlePositionToOffset(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(DocumentPositionParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const offset = this.service.positionToOffset(p.documentId, p.position);
    if (offset === null) {
      return { error: { code: ECPErrorCodes.DocumentNotFound, message: 'Document not found' } };
    }

    return { result: { offset } };
  }

  private handleOffsetToPosition(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(DocumentOffsetParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const position = this.service.offsetToPosition(p.documentId, p.offset);
    if (position === null) {
      return { error: { code: ECPErrorCodes.DocumentNotFound, message: 'Document not found' } };
    }

    return { result: { position } };
  }

  private handleWordAtPosition(params: unknown): HandlerResult<unknown> {
    const validation = validateECPParams(DocumentPositionParamsSchema, params, ECPErrorCodes.InvalidParams);
    if (!validation.success) return { error: validation.error! };
    const p = validation.data!;

    const word = this.service.getWordAtPosition(p.documentId, p.position);
    return { result: word };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Event Handlers
  // ─────────────────────────────────────────────────────────────────────────

  private setupEventHandlers(): void {
    // Content changes -> document/didChange notification
    this.service.onDidChangeContent((event) => {
      this.sendNotification('document/didChange', event);
    });

    // Cursor changes -> document/didChangeCursors notification
    this.service.onDidChangeCursors((event) => {
      this.sendNotification('document/didChangeCursors', event);
    });

    // Document open -> document/didOpen notification
    this.service.onDidOpenDocument((event) => {
      this.sendNotification('document/didOpen', event);
    });

    // Document close -> document/didClose notification
    this.service.onDidCloseDocument((event) => {
      this.sendNotification('document/didClose', event);
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
}
