/**
 * Pipeline Unit Tests
 *
 * Tests for the AI middleware pipeline.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  Pipeline,
  createPipeline,
} from '../../../src/services/ai/framework/pipeline.ts';
import type {
  MiddlewareDefinition,
  MiddlewareContext,
  MiddlewareAction,
  PipelineStage,
  ChatSession,
  SendMessageOptions,
  AIResponse,
} from '../../../src/services/ai/types.ts';

describe('Pipeline', () => {
  let pipeline: Pipeline;

  // Helper to create a mock session
  const createMockSession = (): ChatSession => ({
    id: 'session-123',
    provider: { type: 'claude', name: 'Claude' },
    messages: [],
    state: 'idle',
    tools: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  // Helper to create a middleware
  const createMiddleware = (
    name: string,
    stages: PipelineStage[],
    action: MiddlewareAction,
    priority: number = 100
  ): MiddlewareDefinition => ({
    name,
    description: `Test middleware: ${name}`,
    stages,
    priority,
    enabled: true,
    execute: async () => action,
  });

  beforeEach(() => {
    // Explicitly provide empty middleware array to avoid shared state
    // due to shallow copy of DEFAULT_PIPELINE_CONFIG
    pipeline = new Pipeline({ middleware: [] });
  });

  describe('construction', () => {
    it('should create pipeline with default config', () => {
      const config = pipeline.getConfig();

      expect(config.middleware).toEqual([]);
      expect(config.haltOnBlock).toBe(true);
      expect(config.timeout).toBe(30000);
    });

    it('should create pipeline with custom config', () => {
      const customPipeline = new Pipeline({
        haltOnBlock: false,
        timeout: 5000,
      });

      const config = customPipeline.getConfig();

      expect(config.haltOnBlock).toBe(false);
      expect(config.timeout).toBe(5000);
    });
  });

  describe('registerMiddleware', () => {
    it('should register middleware', () => {
      const middleware = createMiddleware('test', ['pre_request'], { type: 'continue' });

      pipeline.registerMiddleware(middleware);

      const registered = pipeline.getMiddleware();
      expect(registered.length).toBe(1);
      expect(registered[0]!.name).toBe('test');
    });

    it('should order middleware by priority', () => {
      const high = createMiddleware('high', ['pre_request'], { type: 'continue' }, 10);
      const low = createMiddleware('low', ['pre_request'], { type: 'continue' }, 100);
      const medium = createMiddleware('medium', ['pre_request'], { type: 'continue' }, 50);

      pipeline.registerMiddleware(low);
      pipeline.registerMiddleware(high);
      pipeline.registerMiddleware(medium);

      const registered = pipeline.getMiddleware();
      expect(registered[0]!.name).toBe('high');
      expect(registered[1]!.name).toBe('medium');
      expect(registered[2]!.name).toBe('low');
    });
  });

  describe('unregisterMiddleware', () => {
    it('should unregister middleware by name', () => {
      pipeline.registerMiddleware(createMiddleware('test', ['pre_request'], { type: 'continue' }));

      const result = pipeline.unregisterMiddleware('test');

      expect(result).toBe(true);
      expect(pipeline.getMiddleware().length).toBe(0);
    });

    it('should return false for non-existent middleware', () => {
      const result = pipeline.unregisterMiddleware('nonexistent');

      expect(result).toBe(false);
    });
  });

  describe('setMiddlewareEnabled', () => {
    it('should enable/disable middleware', () => {
      pipeline.registerMiddleware(createMiddleware('test', ['pre_request'], { type: 'continue' }));

      let result = pipeline.setMiddlewareEnabled('test', false);
      expect(result).toBe(true);
      expect(pipeline.getMiddleware()[0]!.enabled).toBe(false);

      result = pipeline.setMiddlewareEnabled('test', true);
      expect(result).toBe(true);
      expect(pipeline.getMiddleware()[0]!.enabled).toBe(true);
    });

    it('should return false for non-existent middleware', () => {
      const result = pipeline.setMiddlewareEnabled('nonexistent', false);

      expect(result).toBe(false);
    });
  });

  describe('execute', () => {
    it('should execute middleware and return success', async () => {
      pipeline.registerMiddleware(createMiddleware('test', ['pre_request'], { type: 'continue' }));

      const context: MiddlewareContext = {
        session: createMockSession(),
        data: {},
      };

      const result = await pipeline.execute('pre_request', context);

      expect(result.success).toBe(true);
      expect(result.actions.length).toBe(1);
      expect(result.actions[0]!.middleware).toBe('test');
      expect(result.actions[0]!.action.type).toBe('continue');
    });

    it('should skip disabled middleware', async () => {
      const middleware = createMiddleware('test', ['pre_request'], { type: 'continue' });
      middleware.enabled = false;
      pipeline.registerMiddleware(middleware);

      const context: MiddlewareContext = {
        session: createMockSession(),
        data: {},
      };

      const result = await pipeline.execute('pre_request', context);

      expect(result.success).toBe(true);
      expect(result.actions.length).toBe(0);
    });

    it('should skip middleware for non-matching stage', async () => {
      pipeline.registerMiddleware(createMiddleware('test', ['post_response'], { type: 'continue' }));

      const context: MiddlewareContext = {
        session: createMockSession(),
        data: {},
      };

      const result = await pipeline.execute('pre_request', context);

      expect(result.actions.length).toBe(0);
    });

    it('should handle modify action', async () => {
      const middleware: MiddlewareDefinition = {
        name: 'modifier',
        description: 'Modifies context',
        stages: ['pre_request'],
        priority: 100,
        enabled: true,
        execute: async (ctx) => ({
          type: 'modify',
          context: {
            data: { ...ctx.data, modified: true },
          },
        }),
      };
      pipeline.registerMiddleware(middleware);

      const context: MiddlewareContext = {
        session: createMockSession(),
        data: { original: true },
      };

      const result = await pipeline.execute('pre_request', context);

      expect(result.success).toBe(true);
      expect(result.context.data.original).toBe(true);
      expect(result.context.data.modified).toBe(true);
    });

    it('should handle block action', async () => {
      pipeline.registerMiddleware(
        createMiddleware('blocker', ['pre_request'], { type: 'block', reason: 'Blocked!' })
      );

      const context: MiddlewareContext = {
        session: createMockSession(),
        data: {},
      };

      const result = await pipeline.execute('pre_request', context);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Blocked!');
    });

    it('should halt on block when configured', async () => {
      pipeline.registerMiddleware(
        createMiddleware('blocker', ['pre_request'], { type: 'block', reason: 'Blocked!' }, 10)
      );
      pipeline.registerMiddleware(
        createMiddleware('after', ['pre_request'], { type: 'continue' }, 100)
      );

      const context: MiddlewareContext = {
        session: createMockSession(),
        data: {},
      };

      const result = await pipeline.execute('pre_request', context);

      expect(result.success).toBe(false);
      // After middleware should be skipped
      expect(result.actions.length).toBe(1);
    });

    it('should continue after block when configured', async () => {
      pipeline.setConfig({ haltOnBlock: false });
      pipeline.registerMiddleware(
        createMiddleware('blocker', ['pre_request'], { type: 'block', reason: 'Blocked!' }, 10)
      );
      pipeline.registerMiddleware(
        createMiddleware('after', ['pre_request'], { type: 'continue' }, 100)
      );

      const context: MiddlewareContext = {
        session: createMockSession(),
        data: {},
      };

      const result = await pipeline.execute('pre_request', context);

      expect(result.success).toBe(false);
      // After middleware should still run
      expect(result.actions.length).toBe(2);
    });

    it('should handle middleware errors', async () => {
      const middleware: MiddlewareDefinition = {
        name: 'thrower',
        description: 'Throws error',
        stages: ['pre_request'],
        priority: 100,
        enabled: true,
        execute: async () => {
          throw new Error('Middleware failed!');
        },
      };
      pipeline.registerMiddleware(middleware);

      const context: MiddlewareContext = {
        session: createMockSession(),
        data: {},
      };

      const result = await pipeline.execute('pre_request', context);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Middleware thrower error');
    });

    it('should run multiple middleware in order', async () => {
      const order: string[] = [];

      pipeline.registerMiddleware({
        name: 'first',
        description: 'First',
        stages: ['pre_request'],
        priority: 10,
        enabled: true,
        execute: async () => {
          order.push('first');
          return { type: 'continue' };
        },
      });

      pipeline.registerMiddleware({
        name: 'second',
        description: 'Second',
        stages: ['pre_request'],
        priority: 20,
        enabled: true,
        execute: async () => {
          order.push('second');
          return { type: 'continue' };
        },
      });

      const context: MiddlewareContext = {
        session: createMockSession(),
        data: {},
      };

      await pipeline.execute('pre_request', context);

      expect(order).toEqual(['first', 'second']);
    });
  });

  describe('executePreRequest', () => {
    it('should create context and execute', async () => {
      let capturedContext: MiddlewareContext | null = null;

      pipeline.registerMiddleware({
        name: 'capture',
        description: 'Captures context',
        stages: ['pre_request'],
        priority: 100,
        enabled: true,
        execute: async (ctx) => {
          capturedContext = ctx;
          return { type: 'continue' };
        },
      });

      const session = createMockSession();
      const request: SendMessageOptions = {
        sessionId: 'session-123',
        content: 'Hello',
      };

      await pipeline.executePreRequest(session, request);

      expect(capturedContext).not.toBeNull();
      expect(capturedContext!.session).toBe(session);
      expect(capturedContext!.request).toBe(request);
    });
  });

  describe('executePostResponse', () => {
    it('should create context and execute', async () => {
      let capturedContext: MiddlewareContext | null = null;

      pipeline.registerMiddleware({
        name: 'capture',
        description: 'Captures context',
        stages: ['post_response'],
        priority: 100,
        enabled: true,
        execute: async (ctx) => {
          capturedContext = ctx;
          return { type: 'continue' };
        },
      });

      const session = createMockSession();
      const response: AIResponse = {
        message: {
          id: 'msg-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
          timestamp: Date.now(),
        },
        stopReason: 'end_turn',
      };

      await pipeline.executePostResponse(session, response);

      expect(capturedContext).not.toBeNull();
      expect(capturedContext!.session).toBe(session);
      expect(capturedContext!.response).toBe(response);
    });
  });

  describe('executeToolExecution', () => {
    it('should create context and execute', async () => {
      let capturedContext: MiddlewareContext | null = null;

      pipeline.registerMiddleware({
        name: 'capture',
        description: 'Captures context',
        stages: ['tool_execution'],
        priority: 100,
        enabled: true,
        execute: async (ctx) => {
          capturedContext = ctx;
          return { type: 'continue' };
        },
      });

      const session = createMockSession();
      const toolCall = {
        type: 'tool_use' as const,
        id: 'tool-1',
        name: 'Read',
        input: { file_path: '/test.txt' },
      };

      await pipeline.executeToolExecution(session, toolCall);

      expect(capturedContext).not.toBeNull();
      expect(capturedContext!.session).toBe(session);
      expect(capturedContext!.toolCall).toBe(toolCall);
    });
  });

  describe('createPipeline factory', () => {
    it('should create pipeline with default config', () => {
      const p = createPipeline();

      expect(p.getConfig().timeout).toBe(30000);
    });

    it('should create pipeline with custom config', () => {
      const p = createPipeline({ timeout: 5000 });

      expect(p.getConfig().timeout).toBe(5000);
    });
  });
});
