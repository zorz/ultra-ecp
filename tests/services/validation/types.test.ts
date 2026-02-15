/**
 * Validation Service Types Unit Tests
 *
 * Tests for validation type definitions and structures.
 */

import { describe, it, expect } from 'bun:test';
import type {
  ValidationTrigger,
  ValidatorType,
  ValidationContext,
  ValidationResult,
  ValidationSummary,
  ValidatorDefinition,
  ValidatorBehavior,
  HierarchicalContext,
  ConsensusConfig,
} from '../../../src/services/validation/types.ts';
import {
  DEFAULT_CONTEXT_CONFIG,
  DEFAULT_VALIDATOR_BEHAVIOR,
  DEFAULT_CONSENSUS_CONFIG,
  DEFAULT_PIPELINE_CONFIG,
  generateValidationId,
} from '../../../src/services/validation/types.ts';

describe('Validation Types', () => {
  describe('ValidationTrigger', () => {
    it('should support all trigger types', () => {
      const triggers: ValidationTrigger[] = [
        'pre-tool',
        'on-change',
        'pre-write',
        'post-tool',
        'pre-commit',
        'periodic',
        'on-demand',
      ];

      expect(triggers).toHaveLength(7);
    });
  });

  describe('ValidatorType', () => {
    it('should support all validator types', () => {
      const types: ValidatorType[] = [
        'static',
        'ai-critic',
        'custom',
        'composite',
      ];

      expect(types).toHaveLength(4);
    });
  });

  describe('ValidationContext', () => {
    it('should have required fields', () => {
      const context: ValidationContext = {
        trigger: 'pre-write',
        timestamp: Date.now(),
        files: [
          { path: 'test.ts', content: 'const x = 1;' },
        ],
        sessionId: 'session-123',
      };

      expect(context.trigger).toBe('pre-write');
      expect(context.timestamp).toBeGreaterThan(0);
      expect(context.files).toHaveLength(1);
      expect(context.sessionId).toBe('session-123');
    });

    it('should allow optional fields', () => {
      const context: ValidationContext = {
        trigger: 'pre-commit',
        timestamp: Date.now(),
        files: [],
        sessionId: 'session-123',
        gitDiff: '+ added line',
        gitStatus: {
          branch: 'main',
          changedFiles: ['test.ts'],
          stagedFiles: [],
          untrackedFiles: [],
        },
        recentActions: [
          { timestamp: Date.now(), type: 'edit', details: { file: 'test.ts' } },
        ],
        toolCall: {
          id: 'tool-1',
          name: 'Edit',
          input: { file: 'test.ts' },
        },
      };

      expect(context.gitDiff).toBe('+ added line');
      expect(context.gitStatus?.branch).toBe('main');
      expect(context.recentActions).toHaveLength(1);
      expect(context.toolCall?.name).toBe('Edit');
    });
  });

  describe('ValidationResult', () => {
    it('should have required fields', () => {
      const result: ValidationResult = {
        status: 'approved',
        validator: 'typescript',
        severity: 'info',
        message: 'Type check passed',
        durationMs: 1500,
        cached: false,
      };

      expect(result.status).toBe('approved');
      expect(result.validator).toBe('typescript');
      expect(result.severity).toBe('info');
      expect(result.message).toBe('Type check passed');
      expect(result.durationMs).toBe(1500);
      expect(result.cached).toBe(false);
    });

    it('should support all status types', () => {
      const statuses: ValidationResult['status'][] = [
        'approved',
        'rejected',
        'needs-revision',
        'skipped',
        'timeout',
      ];

      expect(statuses).toHaveLength(5);
    });

    it('should allow details', () => {
      const result: ValidationResult = {
        status: 'rejected',
        validator: 'eslint',
        severity: 'error',
        message: 'Lint error',
        durationMs: 500,
        cached: false,
        details: {
          file: 'test.ts',
          line: 10,
          column: 5,
          suggestedFix: 'Add semicolon',
          reasoning: 'Missing semicolon at end of statement',
        },
      };

      expect(result.details?.file).toBe('test.ts');
      expect(result.details?.line).toBe(10);
      expect(result.details?.suggestedFix).toBe('Add semicolon');
    });
  });

  describe('ValidationSummary', () => {
    it('should have required fields', () => {
      const summary: ValidationSummary = {
        overallStatus: 'approved',
        results: [],
        requiresHumanDecision: false,
        consensusReached: true,
        warnings: [],
        errors: [],
      };

      expect(summary.overallStatus).toBe('approved');
      expect(summary.results).toHaveLength(0);
      expect(summary.requiresHumanDecision).toBe(false);
      expect(summary.consensusReached).toBe(true);
    });

    it('should track blocked validators', () => {
      const summary: ValidationSummary = {
        overallStatus: 'blocked',
        results: [
          {
            status: 'rejected',
            validator: 'security',
            severity: 'error',
            message: 'Security violation',
            durationMs: 100,
            cached: false,
          },
        ],
        requiresHumanDecision: true,
        consensusReached: false,
        blockedBy: ['security'],
        warnings: [],
        errors: [],
      };

      expect(summary.blockedBy).toContain('security');
      expect(summary.requiresHumanDecision).toBe(true);
    });
  });

  describe('ValidatorDefinition', () => {
    it('should define a static validator', () => {
      const validator: ValidatorDefinition = {
        id: 'typescript',
        name: 'TypeScript Check',
        type: 'static',
        enabled: true,
        priority: 10,
        command: 'tsc --noEmit',
        triggers: ['pre-write', 'pre-commit'],
        filePatterns: ['**/*.ts'],
        behavior: {
          onFailure: 'error',
          blockOnFailure: true,
          required: true,
          timeoutMs: 60000,
          onTimeout: 'error',
          cacheable: true,
        },
      };

      expect(validator.type).toBe('static');
      expect(validator.command).toBe('tsc --noEmit');
      expect(validator.triggers).toContain('pre-write');
    });

    it('should define an AI critic validator', () => {
      const validator: ValidatorDefinition = {
        id: 'code-review',
        name: 'Code Review AI',
        type: 'ai-critic',
        enabled: true,
        priority: 20,
        provider: 'claude',
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'Review this code for quality.',
        triggers: ['pre-write'],
        behavior: {
          onFailure: 'warning',
          blockOnFailure: false,
          required: false,
          timeoutMs: 30000,
          onTimeout: 'warning',
          cacheable: true,
        },
      };

      expect(validator.type).toBe('ai-critic');
      expect(validator.provider).toBe('claude');
      expect(validator.model).toBe('claude-sonnet-4-20250514');
    });

    it('should define a custom validator', () => {
      const validator: ValidatorDefinition = {
        id: 'custom-check',
        name: 'Custom Check',
        type: 'custom',
        enabled: true,
        priority: 30,
        triggers: ['on-demand'],
        behavior: {
          onFailure: 'warning',
          blockOnFailure: false,
          required: false,
          timeoutMs: 5000,
          onTimeout: 'skip',
          cacheable: false,
        },
        validate: async (context) => ({
          status: 'approved',
          validator: 'custom-check',
          severity: 'info',
          message: `Checked ${context.files.length} files`,
          durationMs: 0,
          cached: false,
        }),
      };

      expect(validator.type).toBe('custom');
      expect(validator.validate).toBeDefined();
    });
  });

  describe('ValidatorBehavior', () => {
    it('should have all behavior options', () => {
      const behavior: ValidatorBehavior = {
        onFailure: 'error',
        blockOnFailure: true,
        required: true,
        timeoutMs: 60000,
        onTimeout: 'error',
        cacheable: true,
        cacheKeyFields: ['content', 'diff'],
        requireConsensus: true,
        weight: 2,
      };

      expect(behavior.onFailure).toBe('error');
      expect(behavior.blockOnFailure).toBe(true);
      expect(behavior.required).toBe(true);
      expect(behavior.weight).toBe(2);
    });
  });

  describe('HierarchicalContext', () => {
    it('should contain all context types', () => {
      const context: HierarchicalContext = {
        patterns: [
          { id: 'p1', description: 'Use Result type', source: 'global' },
        ],
        antiPatterns: [
          { id: 'ap1', pattern: 'console.log', alternative: 'debugLog', source: 'global' },
        ],
        conventions: [
          { id: 'c1', description: 'Use kebab-case for files', source: 'global' },
        ],
        architectureNotes: 'This module handles...',
        overrides: [
          { type: 'disable', targetId: 'console.log', source: 'local' },
        ],
      };

      expect(context.patterns).toHaveLength(1);
      expect(context.antiPatterns).toHaveLength(1);
      expect(context.conventions).toHaveLength(1);
      expect(context.overrides).toHaveLength(1);
    });
  });

  describe('ConsensusConfig', () => {
    it('should have all consensus options', () => {
      const config: ConsensusConfig = {
        strategy: 'weighted',
        minimumResponses: 2,
        timeoutMs: 60000,
        escalateToHuman: true,
      };

      expect(config.strategy).toBe('weighted');
      expect(config.minimumResponses).toBe(2);
      expect(config.escalateToHuman).toBe(true);
    });

    it('should support all strategies', () => {
      const strategies: ConsensusConfig['strategy'][] = [
        'unanimous',
        'majority',
        'any-approve',
        'no-rejections',
        'weighted',
      ];

      expect(strategies).toHaveLength(5);
    });
  });

  describe('Default configurations', () => {
    it('should have sensible defaults for context config', () => {
      expect(DEFAULT_CONTEXT_CONFIG.includeFullFile).toBe(true);
      expect(DEFAULT_CONTEXT_CONFIG.includeDiff).toBe(true);
      expect(DEFAULT_CONTEXT_CONFIG.includeGitDiff).toBe(true);
      expect(DEFAULT_CONTEXT_CONFIG.includeRelatedFiles).toBe(false);
      expect(DEFAULT_CONTEXT_CONFIG.relatedFileDepth).toBe(1);
    });

    it('should have sensible defaults for validator behavior', () => {
      expect(DEFAULT_VALIDATOR_BEHAVIOR.onFailure).toBe('warning');
      expect(DEFAULT_VALIDATOR_BEHAVIOR.blockOnFailure).toBe(false);
      expect(DEFAULT_VALIDATOR_BEHAVIOR.required).toBe(false);
      expect(DEFAULT_VALIDATOR_BEHAVIOR.timeoutMs).toBe(30000);
      expect(DEFAULT_VALIDATOR_BEHAVIOR.onTimeout).toBe('warning');
      expect(DEFAULT_VALIDATOR_BEHAVIOR.cacheable).toBe(true);
    });

    it('should have sensible defaults for consensus', () => {
      expect(DEFAULT_CONSENSUS_CONFIG.strategy).toBe('majority');
      expect(DEFAULT_CONSENSUS_CONFIG.minimumResponses).toBe(1);
      expect(DEFAULT_CONSENSUS_CONFIG.timeoutMs).toBe(60000);
      expect(DEFAULT_CONSENSUS_CONFIG.escalateToHuman).toBe(true);
    });

    it('should have sensible defaults for pipeline', () => {
      expect(DEFAULT_PIPELINE_CONFIG.executionModel).toBe('turn-based');
      expect(DEFAULT_PIPELINE_CONFIG.defaultTimeout).toBe(30000);
      expect(DEFAULT_PIPELINE_CONFIG.cacheEnabled).toBe(true);
      expect(DEFAULT_PIPELINE_CONFIG.cacheMaxAge).toBe(5 * 60 * 1000);
      expect(DEFAULT_PIPELINE_CONFIG.contextDir).toBe('validation');
    });
  });

  describe('generateValidationId', () => {
    it('should generate unique IDs', () => {
      const id1 = generateValidationId();
      const id2 = generateValidationId();

      expect(id1).toMatch(/^val-\d+-[a-z0-9]+$/);
      expect(id2).toMatch(/^val-\d+-[a-z0-9]+$/);
      expect(id1).not.toBe(id2);
    });
  });
});
