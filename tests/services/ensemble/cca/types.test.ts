/**
 * CCA Types Unit Tests
 */

import { describe, it, expect } from 'bun:test';
import { DEFAULT_CCA_OPTIONS } from '../../../../src/services/ensemble/cca/index.ts';
import type {
  CCAWorkflowState,
  ProposedChange,
  CriticReview,
  CriticIssue,
  ArbiterDecision,
  CCAIteration,
  CCASessionState,
  CCAWorkflowOptions,
} from '../../../../src/services/ensemble/cca/index.ts';

describe('CCA Types', () => {
  describe('DEFAULT_CCA_OPTIONS', () => {
    it('should have maxIterations', () => {
      expect(DEFAULT_CCA_OPTIONS.maxIterations).toBe(5);
    });

    it('should default autoApplyOnConsensus to false', () => {
      expect(DEFAULT_CCA_OPTIONS.autoApplyOnConsensus).toBe(false);
    });

    it('should require 100% approval by default', () => {
      expect(DEFAULT_CCA_OPTIONS.autoApplyThreshold).toBe(1.0);
    });

    it('should validate after coding by default', () => {
      expect(DEFAULT_CCA_OPTIONS.validateAfterCoding).toBe(true);
    });

    it('should have no arbiter timeout by default', () => {
      expect(DEFAULT_CCA_OPTIONS.arbiterTimeout).toBe(0);
    });

    it('should include file diffs by default', () => {
      expect(DEFAULT_CCA_OPTIONS.includeFileDiffs).toBe(true);
    });
  });

  describe('Type safety', () => {
    it('should accept valid CCAWorkflowState values', () => {
      const states: CCAWorkflowState[] = [
        'idle',
        'coding',
        'reviewing',
        'awaiting-arbiter',
        'applying',
        'iterating',
        'completed',
        'error',
      ];
      expect(states).toHaveLength(8);
    });

    it('should accept valid ProposedChange', () => {
      const change: ProposedChange = {
        id: 'change-1',
        path: '/test/file.ts',
        type: 'edit',
        originalContent: 'old',
        newContent: 'new',
        proposedAt: Date.now(),
        status: 'proposed',
      };
      expect(change.id).toBe('change-1');
      expect(change.type).toBe('edit');
    });

    it('should accept valid CriticIssue', () => {
      const issue: CriticIssue = {
        severity: 'error',
        message: 'Test error',
        path: '/test/file.ts',
        line: 10,
        column: 5,
        rule: 'no-unused-vars',
        blocking: true,
      };
      expect(issue.severity).toBe('error');
      expect(issue.blocking).toBe(true);
    });

    it('should accept valid CriticReview', () => {
      const review: CriticReview = {
        criticId: 'typescript',
        type: 'static',
        approved: true,
        verdict: 'approve',
        confidence: 0.95,
        comments: ['Looks good'],
        issues: [],
        reviewedAt: Date.now(),
      };
      expect(review.verdict).toBe('approve');
      expect(review.approved).toBe(true);
      expect(review.type).toBe('static');
    });

    it('should accept valid ArbiterDecision', () => {
      const decision: ArbiterDecision = {
        id: 'decision-1',
        type: 'approve',
        feedback: 'Good work',
        addressIssues: ['Fix the typo'],
        focusFiles: ['/test/file.ts'],
        decidedAt: Date.now(),
      };
      expect(decision.type).toBe('approve');
    });

    it('should accept valid CCAIteration', () => {
      const iteration: CCAIteration = {
        number: 1,
        changes: [],
        reviews: [],
        startedAt: Date.now(),
        completedAt: Date.now() + 1000,
      };
      expect(iteration.number).toBe(1);
    });

    it('should accept valid CCASessionState', () => {
      const state: CCASessionState = {
        workflowState: 'idle',
        task: 'Build a test',
        iterations: [],
        currentIteration: 0,
        maxIterations: 5,
        consensusReached: false,
      };
      expect(state.workflowState).toBe('idle');
    });

    it('should accept valid CCAWorkflowOptions', () => {
      const options: CCAWorkflowOptions = {
        maxIterations: 10,
        maxToolLoops: 50,
        autoApplyOnConsensus: true,
        autoApplyThreshold: 0.8,
        validateAfterCoding: true,
        coderTimeout: 60000,
        validationTimeout: 30000,
        arbiterTimeout: 0,
        includeFileDiffs: true,
      };
      expect(options.maxIterations).toBe(10);
    });
  });
});
