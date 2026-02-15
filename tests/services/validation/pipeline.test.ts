/**
 * Validation Pipeline Unit Tests
 *
 * Tests for ValidationPipeline functionality.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { ValidationPipeline, createValidationPipeline } from '../../../src/services/validation/pipeline.ts';
import { createHumanInteractionHandler } from '../../../src/services/validation/human-interaction.ts';
import type {
  ValidatorDefinition,
  ValidationContext,
} from '../../../src/services/validation/types.ts';

describe('ValidationPipeline', () => {
  let pipeline: ValidationPipeline;

  beforeEach(() => {
    pipeline = createValidationPipeline({
      executionModel: 'turn-based',
      cacheEnabled: false,
      defaultTimeout: 5000,
    });
  });

  /**
   * Create a test validation context.
   */
  function createContext(
    trigger: ValidationContext['trigger'] = 'pre-write',
    files: Array<{ path: string; content: string }> = [{ path: 'test.ts', content: 'const x = 1;' }]
  ): ValidationContext {
    return {
      trigger,
      timestamp: Date.now(),
      files,
      sessionId: 'test-session',
    };
  }

  /**
   * Create a simple passing custom validator.
   */
  function createPassingValidator(id: string, priority: number = 10): ValidatorDefinition {
    return {
      id,
      name: `Passing ${id}`,
      type: 'custom',
      enabled: true,
      priority,
      triggers: ['pre-write'],
      behavior: {
        onFailure: 'warning',
        blockOnFailure: false,
        required: false,
        timeoutMs: 5000,
        onTimeout: 'warning',
        cacheable: false,
      },
      validate: async () => ({
        status: 'approved',
        validator: id,
        severity: 'info',
        message: 'Passed',
        durationMs: 10,
        cached: false,
      }),
    };
  }

  /**
   * Create a failing custom validator.
   */
  function createFailingValidator(id: string, priority: number = 10): ValidatorDefinition {
    return {
      id,
      name: `Failing ${id}`,
      type: 'custom',
      enabled: true,
      priority,
      triggers: ['pre-write'],
      behavior: {
        onFailure: 'error',
        blockOnFailure: false,
        required: false,
        timeoutMs: 5000,
        onTimeout: 'warning',
        cacheable: false,
      },
      validate: async () => ({
        status: 'rejected',
        validator: id,
        severity: 'error',
        message: 'Failed',
        durationMs: 10,
        cached: false,
      }),
    };
  }

  /**
   * Create a blocking custom validator (fails and blocks).
   */
  function createBlockingValidator(id: string, priority: number = 10): ValidatorDefinition {
    return {
      id,
      name: `Blocking ${id}`,
      type: 'custom',
      enabled: true,
      priority,
      triggers: ['pre-write'],
      behavior: {
        onFailure: 'error',
        blockOnFailure: true,
        required: true,
        timeoutMs: 5000,
        onTimeout: 'warning',
        cacheable: false,
      },
      validate: async () => ({
        status: 'rejected',
        validator: id,
        severity: 'error',
        message: 'Blocked',
        durationMs: 10,
        cached: false,
      }),
    };
  }

  describe('registerValidator', () => {
    it('should register a validator', () => {
      const validator = createPassingValidator('test');
      pipeline.registerValidator(validator);

      expect(pipeline.getValidator('test')).toBeDefined();
      expect(pipeline.getValidators()).toHaveLength(1);
    });

    it('should register multiple validators', () => {
      pipeline.registerValidator(createPassingValidator('v1'));
      pipeline.registerValidator(createPassingValidator('v2'));
      pipeline.registerValidator(createPassingValidator('v3'));

      expect(pipeline.getValidators()).toHaveLength(3);
    });
  });

  describe('unregisterValidator', () => {
    it('should unregister a validator', () => {
      pipeline.registerValidator(createPassingValidator('test'));
      const removed = pipeline.unregisterValidator('test');

      expect(removed).toBe(true);
      expect(pipeline.getValidator('test')).toBeUndefined();
    });

    it('should return false for non-existent validator', () => {
      const removed = pipeline.unregisterValidator('nonexistent');

      expect(removed).toBe(false);
    });
  });

  describe('setValidatorEnabled', () => {
    it('should enable/disable a validator', () => {
      pipeline.registerValidator(createPassingValidator('test'));

      pipeline.setValidatorEnabled('test', false);
      expect(pipeline.getValidator('test')?.enabled).toBe(false);

      pipeline.setValidatorEnabled('test', true);
      expect(pipeline.getValidator('test')?.enabled).toBe(true);
    });

    it('should return false for non-existent validator', () => {
      const result = pipeline.setValidatorEnabled('nonexistent', false);
      expect(result).toBe(false);
    });
  });

  describe('validate', () => {
    it('should return approved when no validators registered', async () => {
      const context = createContext();
      const summary = await pipeline.validate('pre-write', context);

      expect(summary.overallStatus).toBe('approved');
      expect(summary.results).toHaveLength(0);
    });

    it('should run applicable validators', async () => {
      pipeline.registerValidator(createPassingValidator('v1'));
      pipeline.registerValidator(createPassingValidator('v2'));

      const context = createContext();
      const summary = await pipeline.validate('pre-write', context);

      expect(summary.results).toHaveLength(2);
      expect(summary.overallStatus).toBe('approved');
    });

    it('should skip disabled validators', async () => {
      const v = createPassingValidator('disabled');
      v.enabled = false;
      pipeline.registerValidator(v);
      pipeline.registerValidator(createPassingValidator('enabled'));

      const context = createContext();
      const summary = await pipeline.validate('pre-write', context);

      expect(summary.results).toHaveLength(1);
      expect(summary.results[0]?.validator).toBe('enabled');
    });

    it('should skip validators that do not match trigger', async () => {
      const v = createPassingValidator('pre-commit-only');
      v.triggers = ['pre-commit'];
      pipeline.registerValidator(v);
      pipeline.registerValidator(createPassingValidator('pre-write'));

      const context = createContext('pre-write');
      const summary = await pipeline.validate('pre-write', context);

      expect(summary.results).toHaveLength(1);
      expect(summary.results[0]?.validator).toBe('pre-write');
    });

    it('should respect priority order', async () => {
      pipeline.registerValidator(createPassingValidator('low', 30));
      pipeline.registerValidator(createPassingValidator('high', 10));
      pipeline.registerValidator(createPassingValidator('mid', 20));

      const context = createContext();
      const summary = await pipeline.validate('pre-write', context);

      expect(summary.results[0]?.validator).toBe('high');
      expect(summary.results[1]?.validator).toBe('mid');
      expect(summary.results[2]?.validator).toBe('low');
    });

    it('should handle rejected validators', async () => {
      pipeline.registerValidator(createFailingValidator('failing'));

      const context = createContext();
      const summary = await pipeline.validate('pre-write', context);

      expect(summary.overallStatus).toBe('rejected');
      expect(summary.errors).toHaveLength(1);
    });

    it('should continue after non-blocking failure', async () => {
      pipeline.registerValidator(createFailingValidator('failing'));
      pipeline.registerValidator(createPassingValidator('passing'));

      const context = createContext();
      const summary = await pipeline.validate('pre-write', context);

      expect(summary.results).toHaveLength(2);
    });

    it('should stop on blocking failure', async () => {
      const blocking = createFailingValidator('blocking');
      blocking.behavior.blockOnFailure = true;
      pipeline.registerValidator(blocking);
      pipeline.registerValidator(createPassingValidator('after'));

      const context = createContext();
      const summary = await pipeline.validate('pre-write', context);

      expect(summary.results).toHaveLength(1);
      expect(summary.blockedBy).toContain('blocking');
    });

    it('should stop on required validator failure', async () => {
      const required = createFailingValidator('required');
      required.behavior.required = true;
      pipeline.registerValidator(required);
      pipeline.registerValidator(createPassingValidator('after'));

      const context = createContext();
      const summary = await pipeline.validate('pre-write', context);

      expect(summary.results).toHaveLength(1);
      expect(summary.overallStatus).toBe('blocked');
    });
  });

  describe('file patterns', () => {
    it('should filter by file patterns', async () => {
      const tsOnly = createPassingValidator('ts-only');
      tsOnly.filePatterns = ['**/*.ts'];
      pipeline.registerValidator(tsOnly);

      const jsOnly = createPassingValidator('js-only');
      jsOnly.filePatterns = ['**/*.js'];
      pipeline.registerValidator(jsOnly);

      const tsContext = createContext('pre-write', [{ path: 'test.ts', content: '' }]);
      const tsSummary = await pipeline.validate('pre-write', tsContext);

      expect(tsSummary.results).toHaveLength(1);
      expect(tsSummary.results[0]?.validator).toBe('ts-only');
    });
  });

  describe('consensus', () => {
    it('should evaluate majority consensus', async () => {
      pipeline.registerValidator(createPassingValidator('v1'));
      pipeline.registerValidator(createPassingValidator('v2'));
      pipeline.registerValidator(createFailingValidator('v3'));

      const context = createContext();
      const summary = await pipeline.validate('pre-write', context);

      // 2 approved, 1 rejected = majority approved
      expect(summary.consensusReached).toBe(true);
    });

    it('should require human decision when blocked', async () => {
      const blocking = createFailingValidator('blocking');
      blocking.behavior.blockOnFailure = true;
      pipeline.registerValidator(blocking);

      const context = createContext();
      const summary = await pipeline.validate('pre-write', context);

      expect(summary.requiresHumanDecision).toBe(true);
    });
  });

  describe('timeout handling', () => {
    it('should handle validator timeout', async () => {
      const slow: ValidatorDefinition = {
        id: 'slow',
        name: 'Slow Validator',
        type: 'custom',
        enabled: true,
        priority: 10,
        triggers: ['pre-write'],
        behavior: {
          onFailure: 'warning',
          blockOnFailure: false,
          required: false,
          timeoutMs: 50, // Very short timeout
          onTimeout: 'warning',
          cacheable: false,
        },
        validate: async () => {
          // Delay longer than timeout
          await new Promise((resolve) => setTimeout(resolve, 200));
          return {
            status: 'approved',
            validator: 'slow',
            severity: 'info',
            message: 'Passed',
            durationMs: 200,
            cached: false,
          };
        },
      };

      pipeline.registerValidator(slow);

      const context = createContext();
      const summary = await pipeline.validate('pre-write', context);

      expect(summary.results[0]?.status).toBe('timeout');
    });

    it('should skip on timeout when configured', async () => {
      const slow: ValidatorDefinition = {
        id: 'slow-skip',
        name: 'Slow Skip Validator',
        type: 'custom',
        enabled: true,
        priority: 10,
        triggers: ['pre-write'],
        behavior: {
          onFailure: 'warning',
          blockOnFailure: false,
          required: false,
          timeoutMs: 50,
          onTimeout: 'skip',
          cacheable: false,
        },
        validate: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return {
            status: 'approved',
            validator: 'slow-skip',
            severity: 'info',
            message: 'Passed',
            durationMs: 200,
            cached: false,
          };
        },
      };

      pipeline.registerValidator(slow);

      const context = createContext();
      const summary = await pipeline.validate('pre-write', context);

      expect(summary.results[0]?.status).toBe('skipped');
    });
  });

  describe('parallel execution', () => {
    it('should run validators in parallel when configured', async () => {
      const parallelPipeline = createValidationPipeline({
        executionModel: 'parallel',
        cacheEnabled: false,
      });

      let executionOrder: string[] = [];

      const slow: ValidatorDefinition = {
        id: 'slow',
        name: 'Slow',
        type: 'custom',
        enabled: true,
        priority: 10,
        triggers: ['pre-write'],
        behavior: {
          onFailure: 'warning',
          blockOnFailure: false,
          required: false,
          timeoutMs: 5000,
          onTimeout: 'warning',
          cacheable: false,
        },
        validate: async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          executionOrder.push('slow');
          return {
            status: 'approved',
            validator: 'slow',
            severity: 'info',
            message: 'Passed',
            durationMs: 100,
            cached: false,
          };
        },
      };

      const fast: ValidatorDefinition = {
        id: 'fast',
        name: 'Fast',
        type: 'custom',
        enabled: true,
        priority: 20, // Lower priority but should finish first
        triggers: ['pre-write'],
        behavior: {
          onFailure: 'warning',
          blockOnFailure: false,
          required: false,
          timeoutMs: 5000,
          onTimeout: 'warning',
          cacheable: false,
        },
        validate: async () => {
          executionOrder.push('fast');
          return {
            status: 'approved',
            validator: 'fast',
            severity: 'info',
            message: 'Passed',
            durationMs: 0,
            cached: false,
          };
        },
      };

      parallelPipeline.registerValidator(slow);
      parallelPipeline.registerValidator(fast);

      const context = createContext();
      const summary = await parallelPipeline.validate('pre-write', context);

      expect(summary.results).toHaveLength(2);
      // In parallel mode, fast should finish before slow
      expect(executionOrder[0]).toBe('fast');
    });
  });

  describe('validatePreWrite', () => {
    it('should validate files before writing', async () => {
      pipeline.registerValidator(createPassingValidator('pre-write'));

      const summary = await pipeline.validatePreWrite(
        [{ path: 'test.ts', content: 'const x = 1;' }],
        'session-123'
      );

      expect(summary.overallStatus).toBe('approved');
    });
  });

  describe('caching', () => {
    it('should use cached results when enabled', async () => {
      const cachingPipeline = createValidationPipeline({
        cacheEnabled: true,
        cacheMaxAge: 60000,
      });

      let callCount = 0;
      const counting: ValidatorDefinition = {
        id: 'counting',
        name: 'Counting',
        type: 'custom',
        enabled: true,
        priority: 10,
        triggers: ['pre-write'],
        behavior: {
          onFailure: 'warning',
          blockOnFailure: false,
          required: false,
          timeoutMs: 5000,
          onTimeout: 'warning',
          cacheable: true,
        },
        validate: async () => {
          callCount++;
          return {
            status: 'approved',
            validator: 'counting',
            severity: 'info',
            message: 'Passed',
            durationMs: 10,
            cached: false,
          };
        },
      };

      cachingPipeline.registerValidator(counting);

      const context = createContext();
      await cachingPipeline.validate('pre-write', context);
      await cachingPipeline.validate('pre-write', context);

      // Should only be called once due to caching
      expect(callCount).toBe(1);
    });

    it('should invalidate cache when content changes', async () => {
      const cachingPipeline = createValidationPipeline({
        cacheEnabled: true,
        cacheMaxAge: 60000,
      });

      let callCount = 0;
      const counting: ValidatorDefinition = {
        id: 'counting',
        name: 'Counting',
        type: 'custom',
        enabled: true,
        priority: 10,
        triggers: ['pre-write'],
        behavior: {
          onFailure: 'warning',
          blockOnFailure: false,
          required: false,
          timeoutMs: 5000,
          onTimeout: 'warning',
          cacheable: true,
        },
        validate: async () => {
          callCount++;
          return {
            status: 'approved',
            validator: 'counting',
            severity: 'info',
            message: 'Passed',
            durationMs: 10,
            cached: false,
          };
        },
      };

      cachingPipeline.registerValidator(counting);

      const context1 = createContext('pre-write', [{ path: 'test.ts', content: 'v1' }]);
      const context2 = createContext('pre-write', [{ path: 'test.ts', content: 'v2' }]);

      await cachingPipeline.validate('pre-write', context1);
      await cachingPipeline.validate('pre-write', context2);

      // Should be called twice due to content change
      expect(callCount).toBe(2);
    });
  });

  describe('configuration', () => {
    it('should update configuration', () => {
      pipeline.setConfig({ defaultTimeout: 10000 });

      expect(pipeline.getConfig().defaultTimeout).toBe(10000);
    });

    it('should get configuration', () => {
      const config = pipeline.getConfig();

      expect(config.executionModel).toBe('turn-based');
      expect(config.cacheEnabled).toBe(false);
    });
  });

  describe('human interaction', () => {
    it('should set and get human handler', () => {
      const handler = createHumanInteractionHandler();

      expect(pipeline.getHumanHandler()).toBeNull();

      pipeline.setHumanHandler(handler);

      expect(pipeline.getHumanHandler()).toBe(handler);
    });

    it('should track pending human decisions', async () => {
      const handler = createHumanInteractionHandler();
      pipeline.setHumanHandler(handler);

      // Create a blocking validator that will trigger human decision
      const validator = createBlockingValidator('blocker', 10);
      pipeline.registerValidator(validator);

      const context = createContext();

      // Validate - this triggers human decision requirement
      const summary = await pipeline.validate('pre-write', context);

      expect(summary.requiresHumanDecision).toBe(true);
    });

    it('should validate with human approval - approve', async () => {
      const handler = createHumanInteractionHandler();
      pipeline.setHumanHandler(handler);

      // Create a blocking validator
      const validator = createBlockingValidator('blocker', 10);
      pipeline.registerValidator(validator);

      // Listen for decision requests and auto-approve
      handler.onDecisionRequest((request) => {
        handler.approve(request.id);
      });

      const context = createContext();

      const { summary, decision } = await pipeline.validateWithHumanApproval('pre-write', context);

      expect(decision).toBeDefined();
      expect(decision!.decision).toBe('approve');
      expect(summary.overallStatus).toBe('approved');
    });

    it('should validate with human approval - reject', async () => {
      const handler = createHumanInteractionHandler();
      pipeline.setHumanHandler(handler);

      // Create a blocking validator
      const validator = createBlockingValidator('blocker', 10);
      pipeline.registerValidator(validator);

      // Listen for decision requests and reject
      handler.onDecisionRequest((request) => {
        handler.reject(request.id, 'Not approved');
      });

      const context = createContext();

      const { summary, decision } = await pipeline.validateWithHumanApproval('pre-write', context);

      expect(decision).toBeDefined();
      expect(decision!.decision).toBe('reject');
      expect(summary.overallStatus).toBe('rejected');
    });

    it('should skip human approval when not needed', async () => {
      const handler = createHumanInteractionHandler();
      pipeline.setHumanHandler(handler);

      // Create a passing validator - no human approval needed
      const validator = createPassingValidator('passer', 10);
      pipeline.registerValidator(validator);

      const context = createContext();

      const { summary, decision } = await pipeline.validateWithHumanApproval('pre-write', context);

      expect(decision).toBeUndefined();
      expect(summary.requiresHumanDecision).toBe(false);
      expect(summary.overallStatus).toBe('approved');
    });

    it('should skip human approval when no handler set', async () => {
      // No handler set - should return summary without waiting
      const validator = createBlockingValidator('blocker', 10);
      pipeline.registerValidator(validator);

      const context = createContext();

      const { summary, decision } = await pipeline.validateWithHumanApproval('pre-write', context);

      expect(decision).toBeUndefined();
      expect(summary.requiresHumanDecision).toBe(true);
      expect(summary.overallStatus).toBe('blocked');
    });

    it('should report pending decisions', async () => {
      const handler = createHumanInteractionHandler();
      pipeline.setHumanHandler(handler);

      expect(pipeline.hasPendingHumanDecision()).toBe(false);

      // Create a decision request manually
      const summary = {
        overallStatus: 'blocked' as const,
        results: [],
        requiresHumanDecision: true,
        consensusReached: false,
        warnings: [],
        errors: [],
      };

      // Don't await - let it be pending
      handler.requestDecision('approve-reject', 'Test', 'Test decision', summary);

      expect(pipeline.hasPendingHumanDecision()).toBe(true);

      // Cleanup
      handler.cleanup();
    });
  });
});
