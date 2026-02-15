/**
 * Human Interaction Handler Unit Tests
 *
 * Tests for decision request/response flow.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  HumanInteractionHandler,
  createHumanInteractionHandler,
  createApprovalRequest,
  type DecisionRequest,
} from '../../../src/services/validation/human-interaction.ts';
import type { ValidationSummary, ValidationResult } from '../../../src/services/validation/types.ts';

// Helper to create a mock validation summary
function createMockSummary(overrides: Partial<ValidationSummary> = {}): ValidationSummary {
  return {
    overallStatus: 'rejected',
    results: [],
    requiresHumanDecision: true,
    consensusReached: false,
    warnings: [],
    errors: [],
    ...overrides,
  };
}

// Helper to create a mock validation result
function createMockResult(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    status: 'rejected',
    validator: 'test-validator',
    severity: 'error',
    message: 'Test validation failed',
    durationMs: 100,
    cached: false,
    ...overrides,
  };
}

describe('HumanInteractionHandler', () => {
  let handler: HumanInteractionHandler;

  beforeEach(() => {
    handler = createHumanInteractionHandler();
  });

  describe('constructor', () => {
    it('should create handler with default options', () => {
      const h = new HumanInteractionHandler();
      expect(h).toBeDefined();
    });

    it('should create handler with custom options', () => {
      const h = new HumanInteractionHandler({
        defaultTimeoutMs: 10000,
        autoRejectOnTimeout: true,
        emitFeedEntries: false,
      });
      expect(h).toBeDefined();
    });
  });

  describe('requestDecision', () => {
    it('should create a decision request', async () => {
      const summary = createMockSummary();
      let receivedRequest: DecisionRequest | null = null;

      handler.onDecisionRequest((request) => {
        receivedRequest = request;
      });

      // Start the request but don't await it yet
      const responsePromise = handler.requestDecision(
        'approve-reject',
        'Test Decision',
        'Please approve or reject this change',
        summary
      );

      // Verify request was created
      expect(receivedRequest).not.toBeNull();
      expect(receivedRequest!.type).toBe('approve-reject');
      expect(receivedRequest!.title).toBe('Test Decision');
      expect(receivedRequest!.description).toBe('Please approve or reject this change');

      // Respond to complete the request
      handler.approve(receivedRequest!.id);

      const response = await responsePromise;
      expect(response.decision).toBe('approve');
    });

    it('should include relevant results in request', async () => {
      const results = [
        createMockResult({ status: 'rejected', validator: 'validator-1' }),
        createMockResult({ status: 'approved', validator: 'validator-2' }),
        createMockResult({ status: 'needs-revision', validator: 'validator-3' }),
      ];
      const summary = createMockSummary({ results });

      let receivedRequest: DecisionRequest | null = null;
      handler.onDecisionRequest((req) => {
        receivedRequest = req;
      });

      const responsePromise = handler.requestDecision(
        'approve-reject',
        'Test',
        'Description',
        summary
      );

      // Should only include rejected and needs-revision results by default
      expect(receivedRequest!.relevantResults).toHaveLength(2);
      expect(receivedRequest!.relevantResults.map((r) => r.validator)).toContain('validator-1');
      expect(receivedRequest!.relevantResults.map((r) => r.validator)).toContain('validator-3');

      handler.approve(receivedRequest!.id);
      await responsePromise;
    });

    it('should support custom relevant results', async () => {
      const summary = createMockSummary();
      const customResults = [createMockResult({ validator: 'custom' })];

      let receivedRequest: DecisionRequest | null = null;
      handler.onDecisionRequest((req) => {
        receivedRequest = req;
      });

      const responsePromise = handler.requestDecision(
        'approve-reject',
        'Test',
        'Description',
        summary,
        { relevantResults: customResults }
      );

      expect(receivedRequest!.relevantResults).toHaveLength(1);
      expect(receivedRequest!.relevantResults[0]!.validator).toBe('custom');

      handler.approve(receivedRequest!.id);
      await responsePromise;
    });

    it('should support select-option type with options', async () => {
      const summary = createMockSummary();

      let receivedRequest: DecisionRequest | null = null;
      handler.onDecisionRequest((req) => {
        receivedRequest = req;
      });

      const responsePromise = handler.requestDecision(
        'select-option',
        'Choose Option',
        'Select one of the following',
        summary,
        {
          selectOptions: [
            { id: 'opt-1', label: 'Option 1', description: 'First option' },
            { id: 'opt-2', label: 'Option 2', description: 'Second option' },
          ],
        }
      );

      expect(receivedRequest!.type).toBe('select-option');
      expect(receivedRequest!.options).toHaveLength(2);
      expect(receivedRequest!.options![0]!.id).toBe('opt-1');

      handler.respond({
        requestId: receivedRequest!.id,
        decision: 'approve',
        selectedOption: 'opt-1',
        respondedAt: Date.now(),
      });

      const response = await responsePromise;
      expect(response.selectedOption).toBe('opt-1');
    });

    it('should include context in request', async () => {
      const summary = createMockSummary();

      let receivedRequest: DecisionRequest | null = null;
      handler.onDecisionRequest((req) => {
        receivedRequest = req;
      });

      const responsePromise = handler.requestDecision(
        'approve-reject',
        'Test',
        'Description',
        summary,
        { context: { key: 'value', nested: { data: 123 } } }
      );

      expect(receivedRequest!.context).toEqual({ key: 'value', nested: { data: 123 } });

      handler.approve(receivedRequest!.id);
      await responsePromise;
    });
  });

  describe('respond', () => {
    it('should resolve the decision promise', async () => {
      const summary = createMockSummary();

      let requestId = '';
      handler.onDecisionRequest((req) => {
        requestId = req.id;
      });

      const responsePromise = handler.requestDecision(
        'approve-reject',
        'Test',
        'Description',
        summary
      );

      const success = handler.respond({
        requestId,
        decision: 'approve',
        feedback: 'Looks good!',
        respondedAt: Date.now(),
      });

      expect(success).toBe(true);

      const response = await responsePromise;
      expect(response.decision).toBe('approve');
      expect(response.feedback).toBe('Looks good!');
    });

    it('should return false for non-existent request', () => {
      const success = handler.respond({
        requestId: 'non-existent',
        decision: 'approve',
        respondedAt: Date.now(),
      });

      expect(success).toBe(false);
    });

    it('should clean up pending request after response', async () => {
      const summary = createMockSummary();

      let requestId = '';
      handler.onDecisionRequest((req) => {
        requestId = req.id;
      });

      const responsePromise = handler.requestDecision(
        'approve-reject',
        'Test',
        'Description',
        summary
      );

      expect(handler.getRequest(requestId)).toBeDefined();

      handler.approve(requestId);
      await responsePromise;

      expect(handler.getRequest(requestId)).toBeUndefined();
    });
  });

  describe('approve/reject/defer shortcuts', () => {
    it('should approve a request', async () => {
      const summary = createMockSummary();

      let requestId = '';
      handler.onDecisionRequest((req) => {
        requestId = req.id;
      });

      const responsePromise = handler.requestDecision(
        'approve-reject',
        'Test',
        'Description',
        summary
      );

      const success = handler.approve(requestId, 'Approved with feedback');
      expect(success).toBe(true);

      const response = await responsePromise;
      expect(response.decision).toBe('approve');
      expect(response.feedback).toBe('Approved with feedback');
    });

    it('should reject a request', async () => {
      const summary = createMockSummary();

      let requestId = '';
      handler.onDecisionRequest((req) => {
        requestId = req.id;
      });

      const responsePromise = handler.requestDecision(
        'approve-reject',
        'Test',
        'Description',
        summary
      );

      const success = handler.reject(requestId, 'Not acceptable');
      expect(success).toBe(true);

      const response = await responsePromise;
      expect(response.decision).toBe('reject');
      expect(response.feedback).toBe('Not acceptable');
    });

    it('should defer a request', async () => {
      const summary = createMockSummary();

      let requestId = '';
      handler.onDecisionRequest((req) => {
        requestId = req.id;
      });

      const responsePromise = handler.requestDecision(
        'approve-reject',
        'Test',
        'Description',
        summary
      );

      const success = handler.defer(requestId, 'Need more info');
      expect(success).toBe(true);

      const response = await responsePromise;
      expect(response.decision).toBe('defer');
      expect(response.feedback).toBe('Need more info');
    });
  });

  describe('timeout handling', () => {
    it('should defer on timeout by default', async () => {
      const h = createHumanInteractionHandler({
        defaultTimeoutMs: 50,
        autoRejectOnTimeout: false,
      });

      const summary = createMockSummary();

      const responsePromise = h.requestDecision(
        'approve-reject',
        'Test',
        'Description',
        summary,
        { timeoutMs: 50 }
      );

      const response = await responsePromise;
      expect(response.decision).toBe('defer');
      expect(response.feedback).toContain('timed out');
    });

    it('should reject on timeout if configured', async () => {
      const h = createHumanInteractionHandler({
        defaultTimeoutMs: 50,
        autoRejectOnTimeout: true,
      });

      const summary = createMockSummary();

      const responsePromise = h.requestDecision(
        'approve-reject',
        'Test',
        'Description',
        summary,
        { timeoutMs: 50 }
      );

      const response = await responsePromise;
      expect(response.decision).toBe('reject');
      expect(response.feedback).toContain('timed out');
    });
  });

  describe('getPendingRequests', () => {
    it('should return all pending requests', async () => {
      const summary = createMockSummary();

      const promise1 = handler.requestDecision('approve-reject', 'Test 1', 'Desc 1', summary);
      const promise2 = handler.requestDecision('approve-reject', 'Test 2', 'Desc 2', summary);

      const pending = handler.getPendingRequests();
      expect(pending).toHaveLength(2);
      expect(pending.map((r) => r.title)).toContain('Test 1');
      expect(pending.map((r) => r.title)).toContain('Test 2');

      // Clean up
      for (const req of pending) {
        handler.approve(req.id);
      }
      await Promise.all([promise1, promise2]);
    });
  });

  describe('cancelRequest', () => {
    it('should cancel a pending request', async () => {
      const summary = createMockSummary();

      let requestId = '';
      handler.onDecisionRequest((req) => {
        requestId = req.id;
      });

      const responsePromise = handler.requestDecision(
        'approve-reject',
        'Test',
        'Description',
        summary
      );

      const success = handler.cancelRequest(requestId);
      expect(success).toBe(true);

      const response = await responsePromise;
      expect(response.decision).toBe('reject');
      expect(response.feedback).toBe('Request cancelled');
    });

    it('should return false for non-existent request', () => {
      const success = handler.cancelRequest('non-existent');
      expect(success).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('should cancel all pending requests', async () => {
      const summary = createMockSummary();

      const promise1 = handler.requestDecision('approve-reject', 'Test 1', 'Desc 1', summary);
      const promise2 = handler.requestDecision('approve-reject', 'Test 2', 'Desc 2', summary);

      expect(handler.getPendingRequests()).toHaveLength(2);

      handler.cleanup();

      expect(handler.getPendingRequests()).toHaveLength(0);

      const [response1, response2] = await Promise.all([promise1, promise2]);
      expect(response1.decision).toBe('reject');
      expect(response2.decision).toBe('reject');
    });
  });

  describe('subscriptions', () => {
    it('should unsubscribe from decision requests', async () => {
      const summary = createMockSummary();
      let callCount = 0;

      const unsubscribe = handler.onDecisionRequest(() => {
        callCount++;
      });

      const promise1 = handler.requestDecision('approve-reject', 'Test 1', 'Desc 1', summary);
      expect(callCount).toBe(1);

      unsubscribe();

      const promise2 = handler.requestDecision('approve-reject', 'Test 2', 'Desc 2', summary);
      expect(callCount).toBe(1); // Should not increment

      // Clean up
      handler.cleanup();
      await Promise.all([promise1, promise2]);
    });

    it('should unsubscribe from feed entries', async () => {
      const h = createHumanInteractionHandler({ emitFeedEntries: true });
      const summary = createMockSummary();
      let callCount = 0;

      const unsubscribe = h.onFeedEntry(() => {
        callCount++;
      });

      const promise1 = h.requestDecision('approve-reject', 'Test 1', 'Desc 1', summary);
      expect(callCount).toBe(1);

      unsubscribe();

      const promise2 = h.requestDecision('approve-reject', 'Test 2', 'Desc 2', summary);
      expect(callCount).toBe(1); // Should not increment

      // Clean up
      h.cleanup();
      await Promise.all([promise1, promise2]);
    });

    it('should handle callback errors gracefully', async () => {
      const summary = createMockSummary();

      handler.onDecisionRequest(() => {
        throw new Error('Callback error');
      });

      // Should not throw
      const responsePromise = handler.requestDecision(
        'approve-reject',
        'Test',
        'Description',
        summary
      );

      handler.cleanup();
      await responsePromise;
    });
  });

  describe('feed entry emission', () => {
    it('should emit feed entries when enabled', async () => {
      const h = createHumanInteractionHandler({ emitFeedEntries: true });
      const summary = createMockSummary();
      const feedEntries: unknown[] = [];

      h.onFeedEntry((entry) => {
        feedEntries.push(entry);
      });

      let requestId = '';
      h.onDecisionRequest((req) => {
        requestId = req.id;
      });

      const responsePromise = h.requestDecision('approve-reject', 'Test', 'Description', summary);

      // Should emit entry for request
      expect(feedEntries).toHaveLength(1);

      h.approve(requestId);
      await responsePromise;

      // Should emit entry for response
      expect(feedEntries).toHaveLength(2);
    });

    it('should not emit feed entries when disabled', async () => {
      const h = createHumanInteractionHandler({ emitFeedEntries: false });
      const summary = createMockSummary();
      const feedEntries: unknown[] = [];

      h.onFeedEntry((entry) => {
        feedEntries.push(entry);
      });

      let requestId = '';
      h.onDecisionRequest((req) => {
        requestId = req.id;
      });

      const responsePromise = h.requestDecision('approve-reject', 'Test', 'Description', summary);

      expect(feedEntries).toHaveLength(0);

      h.approve(requestId);
      await responsePromise;

      expect(feedEntries).toHaveLength(0);
    });
  });
});

describe('createApprovalRequest', () => {
  it('should create approval request with default title', async () => {
    const handler = createHumanInteractionHandler();
    const summary = createMockSummary({
      blockedBy: ['validator-1', 'validator-2'],
    });

    let request: DecisionRequest | null = null;
    handler.onDecisionRequest((req) => {
      request = req;
    });

    const responsePromise = createApprovalRequest(handler, summary);

    expect(request).not.toBeNull();
    expect(request!.title).toContain('validator-1');
    expect(request!.title).toContain('validator-2');

    handler.approve(request!.id);
    await responsePromise;
  });

  it('should create approval request with custom title', async () => {
    const handler = createHumanInteractionHandler();
    const summary = createMockSummary();

    let request: DecisionRequest | null = null;
    handler.onDecisionRequest((req) => {
      request = req;
    });

    const responsePromise = createApprovalRequest(handler, summary, 'Custom Title');

    expect(request!.title).toBe('Custom Title');

    handler.approve(request!.id);
    await responsePromise;
  });

  it('should use default title when no blockers', async () => {
    const handler = createHumanInteractionHandler();
    const summary = createMockSummary({ blockedBy: [] });

    let request: DecisionRequest | null = null;
    handler.onDecisionRequest((req) => {
      request = req;
    });

    const responsePromise = createApprovalRequest(handler, summary);

    expect(request!.title).toBe('Validation requires approval');

    handler.approve(request!.id);
    await responsePromise;
  });

  it('should include summary description with errors and warnings', async () => {
    const handler = createHumanInteractionHandler();
    const summary = createMockSummary({
      errors: [
        createMockResult({ validator: 'error-validator', message: 'Error message' }),
      ],
      warnings: [
        createMockResult({ validator: 'warning-validator', message: 'Warning message' }),
      ],
    });

    let request: DecisionRequest | null = null;
    handler.onDecisionRequest((req) => {
      request = req;
    });

    const responsePromise = createApprovalRequest(handler, summary);

    expect(request!.description).toContain('error-validator');
    expect(request!.description).toContain('warning-validator');

    handler.approve(request!.id);
    await responsePromise;
  });
});
