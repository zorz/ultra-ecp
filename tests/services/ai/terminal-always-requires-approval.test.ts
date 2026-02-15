/**
 * Terminal always requires approval.
 *
 * This test is intentionally scoped to the behavior we control:
 * LocalAIService forces terminal tools to require explicit approval,
 * even if the PermissionService would otherwise allow them.
 */

import { describe, test, expect } from 'bun:test';
import { LocalAIService } from '../../../src/services/ai/local.ts';
import type { ChatSession } from '../../../src/services/ai/types.ts';

function createSessionStub(): ChatSession {
  return {
    id: 'session-test',
    provider: { type: 'claude', name: 'Claude' },
    messages: [],
    state: 'tool_use',
    tools: ['Bash'] as any,
    systemPrompt: undefined,
    metadata: undefined,
    cliSessionId: undefined,
    cwd: '/repo',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as ChatSession;
}

describe('LocalAIService terminal approval hardening', () => {
  test('requests permission for Bash even if globally approved', async () => {
    const ai = new LocalAIService();

    // Stub minimal session map without going through provider creation.
    // @ts-expect-error - reaching into private for targeted unit test
    ai.sessions.set('session-test', createSessionStub());

    // Globally approve Bash.
    ai.getPermissionService().addGlobalApproval('Bash', 'test');

    const toolUseId = 'tool-1';

    // Create a minimal AIResponse with a tool_use stopReason.
    const response = {
      stopReason: 'tool_use',
      message: {
        id: 'msg-1',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: toolUseId,
            name: 'Bash',
            input: { command: 'echo hi' },
          },
        ],
        timestamp: Date.now(),
      },
      usage: { inputTokens: 0, outputTokens: 0 },
    };

    const observed: any[] = [];

    // Kick tool-use handling; it should emit a tool_use_request and then wait.
    // We race with a timeout to avoid hanging the test.
    const p = (ai as any).handleToolUse(
      // @ts-expect-error session stub
      createSessionStub(),
      response,
      (evt: any) => observed.push(evt),
    );

    // Wait until we see the permission request event.
    await Promise.race([
      (async () => {
        const start = Date.now();
        while (Date.now() - start < 250) {
          if (observed.some((e) => e.type === 'tool_use_request' && e.name === 'Bash' && e.id === toolUseId)) return;
          await new Promise((r) => setTimeout(r, 5));
        }
        throw new Error('Timed out waiting for tool_use_request');
      })(),
      p,
    ]);

    expect(observed.some((e) => e.type === 'tool_use_request' && e.name === 'Bash' && e.id === toolUseId)).toBe(true);

    // Cleanup: deny so the internal promise resolves if still pending.
    ai.denyToolPermission(toolUseId);

    // Ensure handleToolUse finishes.
    await Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error('handleToolUse did not finish')), 250)),
    ]);
  });
});
