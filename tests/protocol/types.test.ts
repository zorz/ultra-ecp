import { describe, expect, test } from 'bun:test';
import {
  ECPErrorCodes,
  createErrorResponse,
  createSuccessResponse,
  createNotification,
  isErrorResponse,
  isSuccessResponse,
} from '../../src/protocol/types.ts';

describe('ECPErrorCodes', () => {
  test('has standard JSON-RPC error codes', () => {
    expect(ECPErrorCodes.ParseError).toBe(-32700);
    expect(ECPErrorCodes.InvalidRequest).toBe(-32600);
    expect(ECPErrorCodes.MethodNotFound).toBe(-32601);
    expect(ECPErrorCodes.InvalidParams).toBe(-32602);
    expect(ECPErrorCodes.InternalError).toBe(-32603);
  });

  test('has server error codes', () => {
    expect(ECPErrorCodes.ServerError).toBe(-32000);
    expect(ECPErrorCodes.ServerNotInitialized).toBe(-32001);
    expect(ECPErrorCodes.ServerShuttingDown).toBe(-32002);
  });

  test('all codes are unique', () => {
    const values = Object.values(ECPErrorCodes);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});

describe('createErrorResponse', () => {
  test('creates a valid error response', () => {
    const response = createErrorResponse(1, -32600, 'Invalid request');
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32600, message: 'Invalid request' },
    });
  });

  test('accepts null id', () => {
    const response = createErrorResponse(null, -32700, 'Parse error');
    expect(response.id).toBeNull();
  });

  test('includes optional data', () => {
    const response = createErrorResponse(1, -32602, 'Invalid params', { field: 'name' });
    expect(response.error.data).toEqual({ field: 'name' });
  });

  test('omits data when not provided', () => {
    const response = createErrorResponse(1, -32600, 'err');
    expect(response.error.data).toBeUndefined();
  });
});

describe('createSuccessResponse', () => {
  test('creates a valid success response', () => {
    const response = createSuccessResponse(42, { files: ['a.ts'] });
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 42,
      result: { files: ['a.ts'] },
    });
  });

  test('accepts string id', () => {
    const response = createSuccessResponse('req-1', null);
    expect(response.id).toBe('req-1');
    expect(response.result).toBeNull();
  });
});

describe('createNotification', () => {
  test('creates a valid notification', () => {
    const notification = createNotification('file/didChange', { uri: 'file:///a.ts' });
    expect(notification).toEqual({
      jsonrpc: '2.0',
      method: 'file/didChange',
      params: { uri: 'file:///a.ts' },
    });
  });

  test('params are optional', () => {
    const notification = createNotification('server/connected');
    expect(notification.params).toBeUndefined();
  });
});

describe('isErrorResponse / isSuccessResponse', () => {
  test('identifies error responses', () => {
    const err = createErrorResponse(1, -32600, 'bad');
    expect(isErrorResponse(err)).toBe(true);
    expect(isSuccessResponse(err)).toBe(false);
  });

  test('identifies success responses', () => {
    const ok = createSuccessResponse(1, 'done');
    expect(isSuccessResponse(ok)).toBe(true);
    expect(isErrorResponse(ok)).toBe(false);
  });
});
