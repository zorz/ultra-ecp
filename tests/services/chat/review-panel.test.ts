/**
 * Review Panel Tests
 *
 * Tests the multi-reviewer panel system including:
 * - Vote collection and aggregation
 * - Different voting strategies
 * - Outcome routing
 * - Integration with WorkflowExecutor
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { WorkflowExecutor, type WorkflowAIExecutor } from '../../../src/services/chat/services/WorkflowExecutor.ts';
import { ReviewPanelService } from '../../../src/services/chat/services/ReviewPanelService.ts';
import { migrations, migrateUp } from '../../../src/services/chat/migrations/index.ts';
import type { WorkflowDefinition } from '../../../src/services/chat/types/workflow-schema.ts';
import type { ReviewPanelConfig, VotingStrategy } from '../../../src/services/chat/types/review-panel.ts';

describe('ReviewPanelService', () => {
  let db: Database;
  let service: ReviewPanelService;

  beforeEach(() => {
    db = new Database(':memory:');
    migrateUp(db, migrations);
    service = new ReviewPanelService(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('Panel Execution CRUD', () => {
    it('should create a panel execution', () => {
      const config: ReviewPanelConfig = {
        reviewers: [
          { agent: 'security-reviewer', weight: 2 },
          { agent: 'style-reviewer', weight: 1 },
        ],
        voting: { strategy: 'weighted_threshold' },
        outcomes: {
          approved: { action: 'continue' },
        },
      };

      const panel = service.createPanelExecution({
        nodeExecutionId: 'node-exec-1',
        executionId: 'exec-1',
        config,
      });

      expect(panel.id).toBeTruthy();
      expect(panel.status).toBe('pending');
      expect(panel.config.reviewers.length).toBe(2);
    });

    it('should retrieve panel by ID', () => {
      const config: ReviewPanelConfig = {
        reviewers: [{ agent: 'reviewer-1' }],
        voting: { strategy: 'majority' },
        outcomes: {},
      };

      const created = service.createPanelExecution({
        nodeExecutionId: 'node-1',
        executionId: 'exec-1',
        config,
      });

      const retrieved = service.getPanelExecution(created.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(created.id);
    });

    it('should list panels for an execution', () => {
      const config: ReviewPanelConfig = {
        reviewers: [{ agent: 'reviewer' }],
        voting: { strategy: 'majority' },
        outcomes: {},
      };

      service.createPanelExecution({
        nodeExecutionId: 'node-1',
        executionId: 'exec-1',
        config,
      });

      service.createPanelExecution({
        nodeExecutionId: 'node-2',
        executionId: 'exec-1',
        config,
      });

      const panels = service.listPanelExecutions('exec-1');
      expect(panels.length).toBe(2);
    });
  });

  describe('Vote Collection', () => {
    it('should add votes to a panel', () => {
      const config: ReviewPanelConfig = {
        reviewers: [
          { agent: 'reviewer-1', weight: 1 },
          { agent: 'reviewer-2', weight: 1 },
        ],
        voting: { strategy: 'majority' },
        outcomes: {},
      };

      const panel = service.createPanelExecution({
        nodeExecutionId: 'node-1',
        executionId: 'exec-1',
        config,
      });

      service.addVote({
        panelExecutionId: panel.id,
        reviewerId: 'reviewer-1',
        vote: 'approve',
        feedback: 'Looks good!',
        weight: 1,
      });

      const votes = service.getVotesForPanel(panel.id);
      expect(votes.length).toBe(1);
      expect(votes[0].vote).toBe('approve');
    });

    it('should detect when all votes are collected', () => {
      const config: ReviewPanelConfig = {
        reviewers: [
          { agent: 'reviewer-1', weight: 1 },
          { agent: 'reviewer-2', weight: 1 },
        ],
        voting: { strategy: 'majority' },
        outcomes: {},
      };

      const panel = service.createPanelExecution({
        nodeExecutionId: 'node-1',
        executionId: 'exec-1',
        config,
      });

      expect(service.hasAllVotes(panel.id)).toBe(false);

      service.addVote({
        panelExecutionId: panel.id,
        reviewerId: 'reviewer-1',
        vote: 'approve',
        feedback: 'OK',
        weight: 1,
      });

      expect(service.hasAllVotes(panel.id)).toBe(false);

      service.addVote({
        panelExecutionId: panel.id,
        reviewerId: 'reviewer-2',
        vote: 'approve',
        feedback: 'OK',
        weight: 1,
      });

      expect(service.hasAllVotes(panel.id)).toBe(true);
    });
  });

  describe('Vote Aggregation - Weighted Threshold', () => {
    it('should approve when threshold met', () => {
      const config: ReviewPanelConfig = {
        reviewers: [
          { agent: 'r1', weight: 2 },
          { agent: 'r2', weight: 1 },
          { agent: 'r3', weight: 1 },
        ],
        voting: {
          strategy: 'weighted_threshold',
          thresholds: { approveThreshold: 0.7 },
        },
        outcomes: {},
      };

      const panel = service.createPanelExecution({
        nodeExecutionId: 'node-1',
        executionId: 'exec-1',
        config,
      });

      // 3/4 = 75% weighted approve
      service.addVote({ panelExecutionId: panel.id, reviewerId: 'r1', vote: 'approve', feedback: '', weight: 2 });
      service.addVote({ panelExecutionId: panel.id, reviewerId: 'r2', vote: 'approve', feedback: '', weight: 1 });
      service.addVote({ panelExecutionId: panel.id, reviewerId: 'r3', vote: 'request_changes', feedback: '', weight: 1 });

      const { outcome, summary } = service.aggregateVotes(panel.id);

      expect(outcome).toBe('approved');
      expect(summary.approvalPercentage).toBe(0.75);
    });

    it('should queue changes when changes threshold met', () => {
      const config: ReviewPanelConfig = {
        reviewers: [
          { agent: 'r1', weight: 1 },
          { agent: 'r2', weight: 1 },
        ],
        voting: {
          strategy: 'weighted_threshold',
          thresholds: { approveThreshold: 0.7, changesThreshold: 0.4 },
        },
        outcomes: {},
      };

      const panel = service.createPanelExecution({
        nodeExecutionId: 'node-1',
        executionId: 'exec-1',
        config,
      });

      // 50% changes - above 40% threshold
      service.addVote({ panelExecutionId: panel.id, reviewerId: 'r1', vote: 'approve', feedback: '', weight: 1 });
      service.addVote({ panelExecutionId: panel.id, reviewerId: 'r2', vote: 'request_changes', feedback: '', weight: 1 });

      const { outcome } = service.aggregateVotes(panel.id);

      expect(outcome).toBe('queue_changes');
    });

    it('should address critical when any critical vote present', () => {
      const config: ReviewPanelConfig = {
        reviewers: [
          { agent: 'r1', weight: 10 },
          { agent: 'r2', weight: 1 },
        ],
        voting: {
          strategy: 'weighted_threshold',
          thresholds: { criticalBlocks: true, approveThreshold: 0.7 },
        },
        outcomes: {},
      };

      const panel = service.createPanelExecution({
        nodeExecutionId: 'node-1',
        executionId: 'exec-1',
        config,
      });

      // Even though approve has much higher weight, critical blocks
      service.addVote({ panelExecutionId: panel.id, reviewerId: 'r1', vote: 'approve', feedback: '', weight: 10 });
      service.addVote({ panelExecutionId: panel.id, reviewerId: 'r2', vote: 'critical', feedback: 'Security issue!', weight: 1 });

      const { outcome } = service.aggregateVotes(panel.id);

      expect(outcome).toBe('address_critical');
    });
  });

  describe('Vote Aggregation - Unanimous', () => {
    it('should approve only when all approve', () => {
      const config: ReviewPanelConfig = {
        reviewers: [
          { agent: 'r1', weight: 1 },
          { agent: 'r2', weight: 1 },
          { agent: 'r3', weight: 1 },
        ],
        voting: { strategy: 'unanimous' },
        outcomes: {},
      };

      const panel = service.createPanelExecution({
        nodeExecutionId: 'node-1',
        executionId: 'exec-1',
        config,
      });

      service.addVote({ panelExecutionId: panel.id, reviewerId: 'r1', vote: 'approve', feedback: '', weight: 1 });
      service.addVote({ panelExecutionId: panel.id, reviewerId: 'r2', vote: 'approve', feedback: '', weight: 1 });
      service.addVote({ panelExecutionId: panel.id, reviewerId: 'r3', vote: 'approve', feedback: '', weight: 1 });

      const { outcome } = service.aggregateVotes(panel.id);
      expect(outcome).toBe('approved');
    });

    it('should not approve if any vote is not approve', () => {
      const config: ReviewPanelConfig = {
        reviewers: [
          { agent: 'r1', weight: 1 },
          { agent: 'r2', weight: 1 },
        ],
        voting: { strategy: 'unanimous' },
        outcomes: {},
      };

      const panel = service.createPanelExecution({
        nodeExecutionId: 'node-1',
        executionId: 'exec-1',
        config,
      });

      service.addVote({ panelExecutionId: panel.id, reviewerId: 'r1', vote: 'approve', feedback: '', weight: 1 });
      service.addVote({ panelExecutionId: panel.id, reviewerId: 'r2', vote: 'request_changes', feedback: '', weight: 1 });

      const { outcome } = service.aggregateVotes(panel.id);
      expect(outcome).toBe('queue_changes');
    });
  });

  describe('Vote Aggregation - Majority', () => {
    it('should approve with simple majority', () => {
      const config: ReviewPanelConfig = {
        reviewers: [
          { agent: 'r1', weight: 1 },
          { agent: 'r2', weight: 1 },
          { agent: 'r3', weight: 1 },
        ],
        voting: { strategy: 'majority' },
        outcomes: {},
      };

      const panel = service.createPanelExecution({
        nodeExecutionId: 'node-1',
        executionId: 'exec-1',
        config,
      });

      service.addVote({ panelExecutionId: panel.id, reviewerId: 'r1', vote: 'approve', feedback: '', weight: 1 });
      service.addVote({ panelExecutionId: panel.id, reviewerId: 'r2', vote: 'approve', feedback: '', weight: 1 });
      service.addVote({ panelExecutionId: panel.id, reviewerId: 'r3', vote: 'request_changes', feedback: '', weight: 1 });

      const { outcome } = service.aggregateVotes(panel.id);
      expect(outcome).toBe('approved');
    });

    it('should escalate when no clear majority', () => {
      const config: ReviewPanelConfig = {
        reviewers: [
          { agent: 'r1', weight: 1 },
          { agent: 'r2', weight: 1 },
          { agent: 'r3', weight: 1 },
          { agent: 'r4', weight: 1 },
        ],
        voting: { strategy: 'majority' },
        outcomes: {},
      };

      const panel = service.createPanelExecution({
        nodeExecutionId: 'node-1',
        executionId: 'exec-1',
        config,
      });

      // 50/50 split
      service.addVote({ panelExecutionId: panel.id, reviewerId: 'r1', vote: 'approve', feedback: '', weight: 1 });
      service.addVote({ panelExecutionId: panel.id, reviewerId: 'r2', vote: 'approve', feedback: '', weight: 1 });
      service.addVote({ panelExecutionId: panel.id, reviewerId: 'r3', vote: 'request_changes', feedback: '', weight: 1 });
      service.addVote({ panelExecutionId: panel.id, reviewerId: 'r4', vote: 'request_changes', feedback: '', weight: 1 });

      const { outcome } = service.aggregateVotes(panel.id);
      expect(outcome).toBe('escalate');
    });
  });

  describe('Response Parsing', () => {
    it('should parse standard vote format', () => {
      const response = `VOTE: approve
FEEDBACK: The code looks good, well-structured and follows best practices.`;

      const parsed = service.parseReviewerResponse(response);

      expect(parsed.vote).toBe('approve');
      expect(parsed.feedback).toContain('well-structured');
    });

    it('should parse critical vote with issues', () => {
      const response = `VOTE: critical
FEEDBACK: Found a security vulnerability in the authentication code.
ISSUES: [{"severity": "critical", "category": "security", "description": "SQL injection vulnerability"}]`;

      const parsed = service.parseReviewerResponse(response);

      expect(parsed.vote).toBe('critical');
      expect(parsed.issues).toHaveLength(1);
      expect(parsed.issues?.[0].severity).toBe('critical');
    });

    it('should handle missing vote gracefully', () => {
      const response = 'The code looks okay but I have some concerns...';

      const parsed = service.parseReviewerResponse(response);

      expect(parsed.vote).toBeUndefined();
      expect(parsed.feedback).toBe(response);
    });
  });

  describe('Abstain Handling', () => {
    it('should exclude abstains from total weight', () => {
      const config: ReviewPanelConfig = {
        reviewers: [
          { agent: 'r1', weight: 1 },
          { agent: 'r2', weight: 1 },
          { agent: 'r3', weight: 1 },
        ],
        voting: {
          strategy: 'weighted_threshold',
          thresholds: { approveThreshold: 0.7 },
        },
        outcomes: {},
      };

      const panel = service.createPanelExecution({
        nodeExecutionId: 'node-1',
        executionId: 'exec-1',
        config,
      });

      // 2 approve out of 2 non-abstain = 100%
      service.addVote({ panelExecutionId: panel.id, reviewerId: 'r1', vote: 'approve', feedback: '', weight: 1 });
      service.addVote({ panelExecutionId: panel.id, reviewerId: 'r2', vote: 'approve', feedback: '', weight: 1 });
      service.addVote({ panelExecutionId: panel.id, reviewerId: 'r3', vote: 'abstain', feedback: 'Not my area', weight: 1 });

      const { outcome, summary } = service.aggregateVotes(panel.id);

      expect(outcome).toBe('approved');
      expect(summary.totalWeight).toBe(2); // Excludes abstain
      expect(summary.abstainCount).toBe(1);
    });
  });

  describe('Quorum Handling', () => {
    it('should escalate when quorum not met', () => {
      const config: ReviewPanelConfig = {
        reviewers: [
          { agent: 'r1', weight: 1 },
          { agent: 'r2', weight: 1 },
          { agent: 'r3', weight: 1 },
        ],
        voting: {
          strategy: 'weighted_threshold',
          thresholds: { quorum: 2, approveThreshold: 0.5 },
        },
        outcomes: {},
      };

      const panel = service.createPanelExecution({
        nodeExecutionId: 'node-1',
        executionId: 'exec-1',
        config,
      });

      // Only 1 non-abstain vote, quorum is 2
      service.addVote({ panelExecutionId: panel.id, reviewerId: 'r1', vote: 'approve', feedback: '', weight: 1 });
      service.addVote({ panelExecutionId: panel.id, reviewerId: 'r2', vote: 'abstain', feedback: '', weight: 1 });
      service.addVote({ panelExecutionId: panel.id, reviewerId: 'r3', vote: 'abstain', feedback: '', weight: 1 });

      const { outcome, summary } = service.aggregateVotes(panel.id);

      expect(outcome).toBe('escalate');
      expect(summary.quorumMet).toBe(false);
    });
  });

  describe('Statistics', () => {
    it('should calculate panel statistics', () => {
      const config: ReviewPanelConfig = {
        reviewers: [{ agent: 'r1', weight: 1 }],
        voting: { strategy: 'majority' },
        outcomes: {},
      };

      // Create 3 panels with different outcomes
      const panel1 = service.createPanelExecution({ nodeExecutionId: 'n1', executionId: 'exec-1', config });
      service.addVote({ panelExecutionId: panel1.id, reviewerId: 'r1', vote: 'approve', feedback: '', weight: 1 });
      service.aggregateVotes(panel1.id);

      const panel2 = service.createPanelExecution({ nodeExecutionId: 'n2', executionId: 'exec-1', config });
      service.addVote({ panelExecutionId: panel2.id, reviewerId: 'r1', vote: 'critical', feedback: '', weight: 1 });
      service.aggregateVotes(panel2.id);

      const panel3 = service.createPanelExecution({ nodeExecutionId: 'n3', executionId: 'exec-1', config });
      service.addVote({ panelExecutionId: panel3.id, reviewerId: 'r1', vote: 'approve', feedback: '', weight: 1 });
      service.aggregateVotes(panel3.id);

      const stats = service.getPanelStats('exec-1');

      expect(stats.totalPanels).toBe(3);
      expect(stats.completed).toBe(3);
      expect(stats.approved).toBe(2);
      expect(stats.addressCritical).toBe(1);
    });
  });
});

describe('WorkflowExecutor - Review Panel Integration', () => {
  let db: Database;
  let executor: WorkflowExecutor;
  let mockAIExecutor: MockAIExecutor;

  beforeEach(() => {
    db = new Database(':memory:');
    migrateUp(db, migrations);
    executor = new WorkflowExecutor(db);
    mockAIExecutor = createMockAIExecutor();
    executor.setAIExecutor(mockAIExecutor.executor);
  });

  afterEach(() => {
    db.close();
  });

  describe('Review Panel Node Execution', () => {
    it('should execute review panel with multiple reviewers', async () => {
      const workflowId = createReviewPanelWorkflow(executor);

      const execution = await executor.startExecution({
        workflowId,
        input: { code: 'function add(a, b) { return a + b; }' },
      });

      // Set up mock responses: coder first, then 3 reviewers
      mockAIExecutor.setResponseQueue([
        'Here is the code...',  // Coder
        'VOTE: approve\nFEEDBACK: Code is simple and correct.',  // Reviewer 1 (security, weight 2)
        'VOTE: approve\nFEEDBACK: Good function naming.',  // Reviewer 2 (style, weight 1)
        'VOTE: request_changes\nFEEDBACK: Should add input validation.',  // Reviewer 3 (correctness, weight 1)
      ]);

      // Execute coder first
      await executor.executeStep(execution.id);

      // Execute review panel
      const result = await executor.executeStep(execution.id);

      // Verify panel executed
      expect(result.nodeExecution?.nodeId).toBe('reviews');
      const output = result.nodeExecution?.output as any;
      expect(output.outcome).toBe('approved'); // 2/3 approve = 66%, above 50% threshold
      expect(output.voteCount).toBe(3);
    });

    it('should route to coder on critical vote', async () => {
      const workflowId = createReviewPanelWorkflow(executor, {
        outcomes: {
          address_critical: { action: 'loop', target: 'coder' },
          approved: { action: 'continue' },
        },
      });

      const execution = await executor.startExecution({
        workflowId,
        input: { code: 'eval(userInput)' },
      });

      // Coder output
      mockAIExecutor.setNextResponse('Here is the code...');
      await executor.executeStep(execution.id);

      // Set up reviewers - one critical
      mockAIExecutor.setResponseQueue([
        'VOTE: critical\nFEEDBACK: Security vulnerability - eval with user input!',
        'VOTE: request_changes\nFEEDBACK: Needs refactoring.',
      ]);

      const result = await executor.executeStep(execution.id);

      // Should loop back to coder
      const output = result.nodeExecution?.output as any;
      expect(output.outcome).toBe('address_critical');
    });

    it('should collect issues from reviewers', async () => {
      const workflowId = createReviewPanelWorkflow(executor);

      const execution = await executor.startExecution({
        workflowId,
        input: { code: 'some code' },
      });

      // Coder
      mockAIExecutor.setNextResponse('Code...');
      await executor.executeStep(execution.id);

      // Reviewer with structured issues
      mockAIExecutor.setResponseQueue([
        `VOTE: request_changes
FEEDBACK: Found some issues
ISSUES: [{"severity": "major", "category": "security", "description": "Missing input validation"}]`,
        'VOTE: approve\nFEEDBACK: Looks OK',
      ]);

      await executor.executeStep(execution.id);

      // Check panel has issues
      const panels = executor.reviewPanels.listPanelExecutions(execution.id);
      expect(panels.length).toBe(1);
      expect(panels[0].summary?.otherIssues.length).toBeGreaterThan(0);
    });
  });

  describe('CCA Workflow with Review Panel', () => {
    it('should complete full CCA cycle with panel approval', async () => {
      const workflowId = createCCAWithReviewPanel(executor);

      const execution = await executor.startExecution({
        workflowId,
        input: { task: 'Implement a sorting function' },
      });

      // Coder implements
      mockAIExecutor.setNextResponse('```javascript\nfunction sort(arr) { return arr.sort(); }\n```');
      await executor.executeStep(execution.id);

      // Review panel - all approve
      mockAIExecutor.setResponseQueue([
        'VOTE: approve\nFEEDBACK: Simple and effective.',
        'VOTE: approve\nFEEDBACK: Correct implementation.',
        'VOTE: approve\nFEEDBACK: Style looks good.',
      ]);

      const panelResult = await executor.executeStep(execution.id);
      expect((panelResult.nodeExecution?.output as any).outcome).toBe('approved');

      // Checkpoint should be next (or workflow completes)
      const finalState = executor.getExecution(execution.id);
      // Either completes or pauses at checkpoint
      expect(['completed', 'paused', 'running']).toContain(finalState?.status);
    });

    it('should iterate when panel finds critical issues', async () => {
      const workflowId = createCCAWithReviewPanel(executor);

      const execution = await executor.startExecution({
        workflowId,
        input: { task: 'Handle user authentication' },
      });

      // First iteration - coder
      mockAIExecutor.setNextResponse('function login(user, pass) { db.query(`SELECT * FROM users WHERE pass="${pass}"`); }');
      await executor.executeStep(execution.id);

      // Review panel - critical security issue
      mockAIExecutor.setResponseQueue([
        'VOTE: critical\nFEEDBACK: SQL injection vulnerability!',
        'VOTE: critical\nFEEDBACK: Never interpolate user input in SQL!',
        'VOTE: approve\nFEEDBACK: Logic looks fine.',
      ]);

      const panelResult = await executor.executeStep(execution.id);
      expect((panelResult.nodeExecution?.output as any).outcome).toBe('address_critical');

      // Should loop back - check iteration incremented
      const afterPanel = executor.getExecution(execution.id);
      expect(afterPanel?.iterationCount).toBeGreaterThanOrEqual(1);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface MockAIExecutor {
  executor: WorkflowAIExecutor;
  calls: Array<{ agentId: string; prompt: string }>;
  setNextResponse: (response: string) => void;
  setResponseQueue: (responses: string[]) => void;
}

function createMockAIExecutor(): MockAIExecutor {
  let responses: string[] = [];
  let currentIndex = 0;
  const calls: Array<{ agentId: string; prompt: string }> = [];

  const executor: WorkflowAIExecutor = async (request, onStream) => {
    calls.push({ agentId: request.agentId, prompt: request.prompt });

    const response = responses[currentIndex] || 'Mock response';
    if (currentIndex < responses.length - 1) {
      currentIndex++;
    }

    if (onStream) {
      onStream({ type: 'start' });
      onStream({ type: 'delta', delta: response });
      onStream({ type: 'end' });
    }

    return { content: response, tokensIn: 100, tokensOut: 50 };
  };

  return {
    executor,
    calls,
    setNextResponse: (response: string) => {
      responses = [response];
      currentIndex = 0;
    },
    setResponseQueue: (queue: string[]) => {
      responses = queue;
      currentIndex = 0;
    },
  };
}

function createReviewPanelWorkflow(
  executor: WorkflowExecutor,
  overrides?: { outcomes?: any }
): string {
  const definition: WorkflowDefinition = {
    name: 'Review Panel Test',
    trigger: { type: 'manual' },
    steps: [
      {
        id: 'coder',
        type: 'agent',
        agent: 'coder',
        prompt: 'Write code for the task.',
      },
      {
        id: 'reviews',
        type: 'review_panel',
        depends: ['coder'],
        reviewers: [
          { agent: 'security-reviewer', weight: 2 },
          { agent: 'style-reviewer', weight: 1 },
          { agent: 'correctness-reviewer', weight: 1 },
        ],
        voting: {
          strategy: 'weighted_threshold',
          thresholds: {
            criticalBlocks: true,
            approveThreshold: 0.5,
            changesThreshold: 0.3,
          },
        },
        outcomes: overrides?.outcomes || {
          address_critical: { action: 'loop', target: 'coder' },
          queue_changes: { action: 'continue' },
          approved: { action: 'continue' },
          escalate: { action: 'pause' },
        },
      } as any, // Type assertion for review_panel-specific fields
    ],
    max_iterations: 5,
  };

  const workflow = executor.workflows.createWorkflow({
    id: `review-panel-test-${Date.now()}-${Math.random()}`,
    name: 'Review Panel Test',
    definition,
    triggerType: 'manual',
  });

  return workflow.id;
}

function createCCAWithReviewPanel(executor: WorkflowExecutor): string {
  const definition: WorkflowDefinition = {
    name: 'CCA with Review Panel',
    trigger: { type: 'manual' },
    steps: [
      {
        id: 'coder',
        type: 'agent',
        agent: 'coder',
        prompt: 'Implement the requested feature.',
      },
      {
        id: 'review_panel',
        type: 'review_panel',
        depends: ['coder'],
        reviewers: [
          { agent: 'security-reviewer', weight: 3 },
          { agent: 'correctness-reviewer', weight: 2 },
          { agent: 'style-reviewer', weight: 1 },
        ],
        voting: {
          strategy: 'weighted_threshold',
          thresholds: {
            criticalBlocks: true,
            approveThreshold: 0.6,
            changesThreshold: 0.3,
          },
        },
        outcomes: {
          address_critical: { action: 'loop', target: 'coder' },
          queue_changes: { action: 'continue', target: 'checkpoint' },
          approved: { action: 'continue', target: 'checkpoint' },
          escalate: { action: 'pause' },
        },
      } as any,
      {
        id: 'checkpoint',
        type: 'checkpoint',
        depends: ['review_panel'],
        checkpointMessage: 'Review complete. Please confirm.',
      },
    ],
    max_iterations: 5,
  };

  const workflow = executor.workflows.createWorkflow({
    id: `cca-review-panel-${Date.now()}-${Math.random()}`,
    name: 'CCA with Review Panel',
    definition,
    triggerType: 'manual',
  });

  return workflow.id;
}
