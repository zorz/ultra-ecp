/**
 * Config governance hardening tests.
 */

import { describe, test, expect } from 'bun:test';
import { SessionServiceAdapter } from '../../../src/services/session/adapter.ts';
import { LocalSessionService } from '../../../src/services/session/local.ts';

function createAdapter() {
  const svc = new LocalSessionService();
  // No init needed for config/set path
  return new SessionServiceAdapter(svc);
}

describe('config/set governance hardening', () => {
  test('blocks non-human callers from editing governance.* keys', async () => {
    const adapter = createAdapter();

    const res = await adapter.handleRequest('config/set', {
      key: 'governance.workingSet.enforcementEnabled',
      value: false,
      caller: { type: 'agent', agentId: 'local-ai-service' },
    });

    expect('error' in res).toBe(true);
    if ('error' in res) {
      expect(res.error.message).toContain('human-editable only');
      expect((res.error.data as any)?.code).toBe('GOVERNANCE_SETTING_HUMAN_ONLY');
    }
  });

  test('allows human callers to edit governance.* keys', async () => {
    const adapter = createAdapter();

    const res = await adapter.handleRequest('config/set', {
      key: 'governance.workingSet.enforcementEnabled',
      value: true,
      caller: { type: 'human' },
    });

    expect('result' in res).toBe(true);
    if ('result' in res) {
      expect((res.result as any)?.success).toBe(true);
    }
  });

  test('blocks non-human callers from editing ultra.governance.workingSet.* keys', async () => {
    const adapter = createAdapter();

    const res = await adapter.handleRequest('config/set', {
      key: 'ultra.governance.workingSet.project',
      value: ['src'],
      caller: { type: 'agent', agentId: 'local-ai-service' },
    });

    expect('error' in res).toBe(true);
    if ('error' in res) {
      expect((res.error.data as any)?.code).toBe('GOVERNANCE_SETTING_HUMAN_ONLY');
    }
  });
});
