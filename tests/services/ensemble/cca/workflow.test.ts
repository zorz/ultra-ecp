/**
 * CCA Workflow Unit Tests
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import {
  CCAWorkflow,
  createCCAWorkflow,
  DEFAULT_CCA_OPTIONS,
} from '../../../../src/services/ensemble/cca/index.ts';
import type {
  CCAWorkflowDependencies,
  CCAEvent,
  ArbiterDecision,
} from '../../../../src/services/ensemble/cca/index.ts';
import { createSharedFeed } from '../../../../src/services/ensemble/shared-feed.ts';
import type { AgentInstance } from '../../../../src/services/ensemble/agent-instance.ts';
import type { APIProvider } from '../../../../src/services/ensemble/providers/api-base.ts';
import type { ValidationPipeline } from '../../../../src/services/validation/pipeline.ts';
import type { ValidationSummary } from '../../../../src/services/validation/types.ts';
import type { ToolExecutor } from '../../../../src/services/ensemble/tools/executor.ts';
import type { ToolDefinition } from '../../../../src/services/ai/types.ts';

// Mock tool executor
function createMockToolExecutor(): ToolExecutor {
  return {
    execute: mock(async (request) => ({
      requestId: request.id,
      success: true,
      result: 'Tool executed successfully',
      duration: 100,
    })),
    registerTool: () => {},
    unregisterTool: () => false,
    getTool: () => undefined,
    getTools: () => [],
    abort: () => false,
    abortAll: () => {},
    getEvaluator: () => ({} as any),
    setPermissionPromptHandler: () => {},
  } as unknown as ToolExecutor;
}

// Mock tool definitions
function createMockToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'Read',
      description: 'Read a file',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
        },
        required: ['file_path'],
      },
    },
    {
      name: 'Write',
      description: 'Write a file',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['file_path', 'content'],
      },
    },
  ];
}

// Mock agent instance
function createMockAgent(): AgentInstance {
  return {
    id: 'mock-coder',
    definition: {
      id: 'coder',
      role: 'coder',
      provider: 'claude',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'You are a helpful coder.',
      tools: ['Read', 'Write', 'Edit'],
    },
    getContext: () => ({
      messages: [],
      systemPrompt: 'You are a helpful coder.',
      tools: [],
    }),
    setContext: () => {},
    getState: () => 'idle',
    onStateChange: () => () => {},
  } as unknown as AgentInstance;
}

// Mock API provider
function createMockProvider(responseText = 'Here is my code change'): APIProvider {
  let callCount = 0;
  return {
    type: 'claude',
    name: 'Mock Claude',
    config: { type: 'claude', name: 'Mock Claude', model: 'claude-sonnet-4-20250514' },
    chat: mock(async () => {
      callCount++;
      // Odd calls return tool_use, even calls return end_turn
      // This allows multiple iterations to each get a tool call
      if (callCount % 2 === 1) {
        return {
          message: {
            id: `msg-${callCount}`,
            role: 'assistant',
            content: [
              { type: 'text', text: responseText },
              {
                type: 'tool_use',
                id: `tool-${callCount}`,
                name: 'Write',
                input: {
                  file_path: `/test/file-${callCount}.ts`,
                  content: 'export function test() { return true; }',
                },
              },
            ],
            timestamp: Date.now(),
          },
          usage: { inputTokens: 100, outputTokens: 50 },
          stopReason: 'tool_use' as const,
        };
      }
      // After tool result, return final response
      return {
        message: {
          id: `msg-${callCount}`,
          role: 'assistant',
          content: [{ type: 'text', text: 'File created successfully.' }],
          timestamp: Date.now(),
        },
        usage: { inputTokens: 150, outputTokens: 30 },
        stopReason: 'end_turn' as const,
      };
    }),
    isAvailable: async () => true,
    getAvailableModels: async () => ['claude-sonnet-4-20250514'],
    getCapabilities: () => ({
      toolUse: true,
      streaming: true,
      vision: true,
      systemMessages: true,
      maxContextTokens: 200000,
      maxOutputTokens: 8192,
    }),
    cancel: () => {},
  } as unknown as APIProvider;
}

// Mock validation pipeline
function createMockValidationPipeline(
  overallStatus: 'approved' | 'rejected' | 'needs-revision' = 'approved'
): ValidationPipeline {
  return {
    validate: mock(async (): Promise<ValidationSummary> => ({
      overallStatus,
      results: [
        {
          validator: 'mock-validator',
          status: overallStatus,
          severity: overallStatus === 'rejected' ? 'error' : 'info',
          message: overallStatus === 'approved' ? 'All checks passed' : 'Issues found',
          durationMs: 100,
          cached: false,
        },
      ],
      requiresHumanDecision: overallStatus !== 'approved',
      consensusReached: overallStatus === 'approved',
      warnings: [],
      errors: overallStatus === 'rejected' ? [{
        validator: 'mock-validator',
        status: 'rejected' as const,
        severity: 'error' as const,
        message: 'Validation failed',
        durationMs: 100,
        cached: false,
      }] : [],
    })),
    getValidators: () => [],
    addValidator: () => {},
    removeValidator: () => false,
  } as unknown as ValidationPipeline;
}

describe('CCA Workflow', () => {
  let deps: CCAWorkflowDependencies;
  let workflow: CCAWorkflow;

  beforeEach(() => {
    deps = {
      coder: createMockAgent(),
      coderProvider: createMockProvider(),
      validationPipeline: createMockValidationPipeline(),
      feed: createSharedFeed(),
      toolExecutor: createMockToolExecutor(),
      toolDefinitions: createMockToolDefinitions(),
    };
    workflow = createCCAWorkflow(deps);
  });

  describe('createCCAWorkflow', () => {
    it('should create a workflow with default options', () => {
      const wf = createCCAWorkflow(deps);
      expect(wf).toBeInstanceOf(CCAWorkflow);
      expect(wf.getWorkflowState()).toBe('idle');
    });

    it('should create a workflow with custom options', () => {
      const wf = createCCAWorkflow(deps, {
        maxIterations: 10,
        autoApplyOnConsensus: true,
      });
      expect(wf).toBeInstanceOf(CCAWorkflow);
    });
  });

  describe('getState', () => {
    it('should return initial state', () => {
      const state = workflow.getState();
      expect(state.workflowState).toBe('idle');
      expect(state.iterations).toEqual([]);
      expect(state.currentIteration).toBe(0);
      expect(state.consensusReached).toBe(false);
    });
  });

  describe('getWorkflowState', () => {
    it('should return current workflow state', () => {
      expect(workflow.getWorkflowState()).toBe('idle');
    });
  });

  describe('onEvent', () => {
    it('should subscribe to events', () => {
      const events: CCAEvent[] = [];
      const unsubscribe = workflow.onEvent((event) => events.push(event));

      expect(typeof unsubscribe).toBe('function');
    });

    it('should unsubscribe from events', () => {
      const events: CCAEvent[] = [];
      const unsubscribe = workflow.onEvent((event) => events.push(event));
      unsubscribe();

      // Event list should remain empty after unsubscribe
      expect(events).toHaveLength(0);
    });
  });

  describe('abort', () => {
    it('should abort the workflow', () => {
      workflow.abort();
      // Workflow should handle abort gracefully
      expect(workflow.getWorkflowState()).toBe('idle');
    });
  });

  describe('submitArbiterDecision', () => {
    it('should accept arbiter decision', () => {
      const decision: ArbiterDecision = {
        id: 'test-decision',
        type: 'approve',
        feedback: 'Looks good',
        decidedAt: Date.now(),
      };

      // Should not throw
      workflow.submitArbiterDecision(decision, 'test-session');
    });
  });

  describe('run with auto-apply on consensus', () => {
    beforeEach(() => {
      deps.validationPipeline = createMockValidationPipeline('approved');
      workflow = createCCAWorkflow(deps, {
        autoApplyOnConsensus: true,
        autoApplyThreshold: 1.0,
      });
    });

    it('should complete when consensus reached', async () => {
      const events: CCAEvent[] = [];
      workflow.onEvent((event) => events.push(event));

      const result = await workflow.run('Create a test file', 'session-1');

      expect(result.consensusReached).toBe(true);
      expect(result.workflowState).toBe('completed');
      expect(events.some((e) => e.type === 'cca:consensus_reached')).toBe(true);
    });

    it('should emit iteration events', async () => {
      const events: CCAEvent[] = [];
      workflow.onEvent((event) => events.push(event));

      await workflow.run('Create a test file', 'session-1');

      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain('cca:iteration_started');
      expect(eventTypes).toContain('cca:coding_started');
      expect(eventTypes).toContain('cca:coding_completed');
      expect(eventTypes).toContain('cca:review_started');
      expect(eventTypes).toContain('cca:review_completed');
      expect(eventTypes).toContain('cca:iteration_completed');
    });

    it('should post to shared feed', async () => {
      await workflow.run('Create a test file', 'session-1');

      const entries = deps.feed.getEntries();
      expect(entries.length).toBeGreaterThan(0);
    });

    it('should call coder provider', async () => {
      await workflow.run('Create a test file', 'session-1');

      expect(deps.coderProvider.chat).toHaveBeenCalled();
    });

    it('should run validation pipeline', async () => {
      await workflow.run('Create a test file', 'session-1');

      expect(deps.validationPipeline.validate).toHaveBeenCalled();
    });
  });

  describe('run without auto-apply', () => {
    beforeEach(() => {
      deps.validationPipeline = createMockValidationPipeline('approved');
      workflow = createCCAWorkflow(deps, {
        autoApplyOnConsensus: false,
        arbiterTimeout: 100, // Short timeout for tests
      });
    });

    it('should request arbiter decision', async () => {
      const events: CCAEvent[] = [];
      workflow.onEvent((event) => events.push(event));

      const result = await workflow.run('Create a test file', 'session-1');

      expect(events.some((e) => e.type === 'cca:awaiting_arbiter')).toBe(true);
      // Should auto-iterate on timeout
      expect(result.currentIteration).toBeGreaterThanOrEqual(1);
    });

    it('should handle approve decision', async () => {
      workflow = createCCAWorkflow(deps, {
        autoApplyOnConsensus: false,
        arbiterTimeout: 0, // No timeout
      });

      // Start workflow in background and submit decision
      const runPromise = workflow.run('Create a test file', 'session-1');

      // Wait for arbiter request
      await new Promise((resolve) => setTimeout(resolve, 50));

      workflow.submitArbiterDecision(
        {
          id: 'test-decision',
          type: 'approve',
          decidedAt: Date.now(),
        },
        'session-1'
      );

      const result = await runPromise;

      expect(result.consensusReached).toBe(true);
    });

    it('should handle reject decision', async () => {
      workflow = createCCAWorkflow(deps, {
        autoApplyOnConsensus: false,
        arbiterTimeout: 0,
      });

      const runPromise = workflow.run('Create a test file', 'session-1');

      await new Promise((resolve) => setTimeout(resolve, 50));

      workflow.submitArbiterDecision(
        {
          id: 'test-decision',
          type: 'reject',
          feedback: 'Not acceptable',
          decidedAt: Date.now(),
        },
        'session-1'
      );

      const result = await runPromise;

      expect(result.consensusReached).toBe(true); // Consensus to reject
    });

    it('should handle abort decision', async () => {
      workflow = createCCAWorkflow(deps, {
        autoApplyOnConsensus: false,
        arbiterTimeout: 0,
      });

      const runPromise = workflow.run('Create a test file', 'session-1');

      await new Promise((resolve) => setTimeout(resolve, 50));

      workflow.submitArbiterDecision(
        {
          id: 'test-decision',
          type: 'abort',
          decidedAt: Date.now(),
        },
        'session-1'
      );

      const result = await runPromise;

      expect(result.workflowState).toBe('completed');
    });
  });

  describe('run with validation failures', () => {
    beforeEach(() => {
      deps.validationPipeline = createMockValidationPipeline('rejected');
      workflow = createCCAWorkflow(deps, {
        autoApplyOnConsensus: true,
        arbiterTimeout: 100,
      });
    });

    it('should not auto-apply when validation fails', async () => {
      const events: CCAEvent[] = [];
      workflow.onEvent((event) => events.push(event));

      await workflow.run('Create a test file', 'session-1');

      // Should request arbiter decision when validation fails
      expect(events.some((e) => e.type === 'cca:awaiting_arbiter')).toBe(true);
    });
  });

  describe('max iterations', () => {
    beforeEach(() => {
      deps.validationPipeline = createMockValidationPipeline('needs-revision');
      workflow = createCCAWorkflow(deps, {
        maxIterations: 2,
        autoApplyOnConsensus: false,
        arbiterTimeout: 50, // Short timeout to allow iterations
      });
    });

    it('should stop at max iterations', async () => {
      const events: CCAEvent[] = [];
      workflow.onEvent((event) => events.push(event));

      const result = await workflow.run('Create a test file', 'session-1');

      expect(events.some((e) => e.type === 'cca:max_iterations_reached')).toBe(true);
      expect(result.currentIteration).toBe(2);
    });
  });

  describe('DEFAULT_CCA_OPTIONS', () => {
    it('should have expected default values', () => {
      expect(DEFAULT_CCA_OPTIONS.maxIterations).toBe(5);
      expect(DEFAULT_CCA_OPTIONS.autoApplyOnConsensus).toBe(false);
      expect(DEFAULT_CCA_OPTIONS.autoApplyThreshold).toBe(1.0);
      expect(DEFAULT_CCA_OPTIONS.validateAfterCoding).toBe(true);
      expect(DEFAULT_CCA_OPTIONS.coderTimeout).toBe(120000);
      expect(DEFAULT_CCA_OPTIONS.validationTimeout).toBe(60000);
      expect(DEFAULT_CCA_OPTIONS.arbiterTimeout).toBe(0);
      expect(DEFAULT_CCA_OPTIONS.includeFileDiffs).toBe(true);
    });
  });
});
