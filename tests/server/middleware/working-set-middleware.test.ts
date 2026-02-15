/**
 * Working Set Middleware Tests
 */

import { describe, test, expect } from 'bun:test';
import { WorkingSetMiddleware } from '../../../src/server/middleware/working-set-middleware.ts';
import type { MiddlewareContext } from '../../../src/server/middleware/types.ts';

function ctx(overrides: Partial<MiddlewareContext> = {}): MiddlewareContext {
  return {
    method: 'file/write',
    params: {},
    workspaceRoot: '/repo',
    metadata: {
      settings: {
        // default: enforcement enabled for tests
        'governance.workingSet.enforcementEnabled': true,
        'ultra.governance.workingSet.project': ['src'],
      },
    },
    ...overrides,
  };
}

describe('WorkingSetMiddleware', () => {
  test('appliesTo returns true for file mutations and terminal methods', () => {
    const m = new WorkingSetMiddleware();
    expect(m.appliesTo('file/write')).toBe(true);
    expect(m.appliesTo('file/edit')).toBe(true);
    expect(m.appliesTo('file/delete')).toBe(true);
    expect(m.appliesTo('file/deleteDir')).toBe(true);
    expect(m.appliesTo('file/rename')).toBe(true);
    expect(m.appliesTo('file/createDir')).toBe(true);
    expect(m.appliesTo('file/createDirectory')).toBe(true);
    expect(m.appliesTo('terminal/execute')).toBe(true);
    expect(m.appliesTo('terminal/spawn')).toBe(true);
    expect(m.appliesTo('file/read')).toBe(false);
  });

  test('does nothing when enforcement flag is disabled', async () => {
    const m = new WorkingSetMiddleware();
    const result = await m.validate(ctx({
      params: { uri: 'file:///repo/outside.txt' },
      metadata: { settings: { 'governance.workingSet.enforcementEnabled': false }, caller: { type: 'agent', agentId: 'a1' } },
    }));
    expect(result.allowed).toBe(true);
  });

  test('never blocks human callers', async () => {
    const m = new WorkingSetMiddleware();
    const result = await m.validate(ctx({
      params: { uri: 'file:///repo/outside.txt' },
      metadata: {
        settings: {
          'governance.workingSet.enforcementEnabled': true,
          'ultra.governance.workingSet.project': ['src'],
        },
        caller: { type: 'human' },
      },
    }));
    expect(result.allowed).toBe(true);
  });

  test('does not trust params.caller (forged human) when metadata asserts agent', async () => {
    const m = new WorkingSetMiddleware();
    const result = await m.validate(ctx({
      params: { uri: 'file:///repo/other/file.ts', caller: { type: 'human' } },
      metadata: {
        settings: {
          'governance.workingSet.enforcementEnabled': true,
          'ultra.governance.workingSet.project': ['src'],
        },
        caller: { type: 'agent', agentId: 'a1' },
      },
    }));

    expect(result.allowed).toBe(false);
    expect((result.errorData as any)?.code).toBe('OUTSIDE_WORKING_SET');
  });

  test('blocks agent file mutation when working set is empty', async () => {
    const m = new WorkingSetMiddleware();
    const result = await m.validate(ctx({
      metadata: { settings: { 'governance.workingSet.enforcementEnabled': true, 'ultra.governance.workingSet.project': [] }, caller: { type: 'agent', agentId: 'a1' } },
      params: { uri: 'file:///repo/src/app.ts' },
    }));

    expect(result.allowed).toBe(false);
    expect((result.errorData as any)?.code).toBe('WORKING_SET_EMPTY');
  });

  test('blocks agent file mutation outside working set', async () => {
    const m = new WorkingSetMiddleware();
    const result = await m.validate(ctx({
      params: { uri: 'file:///repo/other/file.ts' },
      metadata: {
        settings: {
          'governance.workingSet.enforcementEnabled': true,
          'ultra.governance.workingSet.project': ['src'],
        },
        caller: { type: 'agent', agentId: 'a1' },
      },
    }));

    expect(result.allowed).toBe(false);
    expect((result.errorData as any)?.code).toBe('OUTSIDE_WORKING_SET');
    expect((result.errorData as any)?.target).toBe('/repo/other/file.ts');
    expect(Array.isArray((result.errorData as any)?.workingSet)).toBe(true);
  });

  test('allows agent file mutation inside working set', async () => {
    const m = new WorkingSetMiddleware();
    const result = await m.validate(ctx({
      params: { uri: 'file:///repo/src/app.ts' },
      metadata: {
        settings: {
          'governance.workingSet.enforcementEnabled': true,
          'ultra.governance.workingSet.project': ['src'],
        },
        caller: { type: 'agent', agentId: 'a1' },
      },
    }));

    expect(result.allowed).toBe(true);
  });

  test('bypassAgents exempts specific agent IDs (deny-list semantics)', async () => {
    const m = new WorkingSetMiddleware();
    const result = await m.validate(ctx({
      params: { uri: 'file:///repo/other/file.ts' },
      metadata: {
        settings: {
          'governance.workingSet.enforcementEnabled': true,
          'governance.workingSet.bypassAgents': ['first-class-1'],
          'ultra.governance.workingSet.project': ['src'],
        },
        caller: { type: 'agent', agentId: 'first-class-1' },
      },
    }));

    expect(result.allowed).toBe(true);
  });

  test('bypassRoles exempts specific role types (deny-list semantics)', async () => {
    const m = new WorkingSetMiddleware();
    const result = await m.validate(ctx({
      params: { uri: 'file:///repo/other/file.ts' },
      metadata: {
        settings: {
          'governance.workingSet.enforcementEnabled': true,
          'governance.workingSet.bypassRoles': ['first_class'],
          'ultra.governance.workingSet.project': ['src'],
        },
        caller: { type: 'agent', agentId: 'a1', roleType: 'first_class' },
      },
    }));

    expect(result.allowed).toBe(true);
  });

  test('blocks terminal methods when working set is empty', async () => {
    const m = new WorkingSetMiddleware();
    const result = await m.validate(ctx({
      method: 'terminal/execute',
      params: { command: 'echo hi' },
      metadata: { settings: { 'governance.workingSet.enforcementEnabled': true, 'ultra.governance.workingSet.project': [] }, caller: { type: 'agent', agentId: 'a1' } },
    }));

    expect(result.allowed).toBe(false);
    expect((result.errorData as any)?.code).toBe('WORKING_SET_EMPTY');
  });

  test('blocks file mutations when target path cannot be extracted (prevents param-shape bypass)', async () => {
    const m = new WorkingSetMiddleware();
    const result = await m.validate(ctx({
      method: 'file/write',
      // Deliberately omit uri/path/file_path to simulate a caller trying a different param shape.
      params: { notAUri: 'file:///repo/other/file.ts' },
      metadata: {
        settings: {
          'governance.workingSet.enforcementEnabled': true,
          'ultra.governance.workingSet.project': ['src'],
        },
        caller: { type: 'agent', agentId: 'a1' },
      },
    }));

    expect(result.allowed).toBe(false);
    expect((result.errorData as any)?.code).toBe('WORKING_SET_TARGET_UNKNOWN');
  });

  test('requires all rename targets to be inside working set (oldUri + newUri)', async () => {
    const m = new WorkingSetMiddleware();
    const result = await m.validate(ctx({
      method: 'file/rename',
      params: {
        oldUri: 'file:///repo/src/in.ts',
        newUri: 'file:///repo/other/out.ts',
      },
      metadata: {
        settings: {
          'governance.workingSet.enforcementEnabled': true,
          'ultra.governance.workingSet.project': ['src'],
        },
        caller: { type: 'agent', agentId: 'a1' },
      },
    }));

    expect(result.allowed).toBe(false);
    expect((result.errorData as any)?.code).toBe('OUTSIDE_WORKING_SET');
    expect((result.errorData as any)?.target).toBe('/repo/other/out.ts');
  });

  test('allows terminal methods when working set is non-empty (known limitation: no shell parsing yet)', async () => {
    const m = new WorkingSetMiddleware();
    const result = await m.validate(ctx({
      method: 'terminal/execute',
      params: { command: 'rm -rf /repo/other' },
      metadata: { settings: { 'governance.workingSet.enforcementEnabled': true, 'ultra.governance.workingSet.project': ['src'] }, caller: { type: 'agent', agentId: 'a1' } },
    }));

    // This test is intentionally documenting current behavior so we don't accidentally
    // believe terminal is scoped by working set.
    expect(result.allowed).toBe(true);
  });
});
