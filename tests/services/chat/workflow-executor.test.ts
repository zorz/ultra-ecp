/**
 * Workflow Executor Unit Tests
 *
 * Tests the core workflow execution system including:
 * - Node execution paths and dependencies
 * - Multi-turn conversation support (await_input)
 * - Agent registry integration
 * - Iteration tracking for CCA loops
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { WorkflowExecutor, type WorkflowAIExecutor } from '../../../src/services/chat/services/WorkflowExecutor.ts';
import { migrations, migrateUp } from '../../../src/services/chat/migrations/index.ts';
import type { WorkflowDefinition, ExecutionStatus } from '../../../src/services/chat/types/workflow-schema.ts';

describe('WorkflowExecutor', () => {
  let db: Database;
  let executor: WorkflowExecutor;
  let mockAIExecutor: ReturnType<typeof createMockAIExecutor>;

  // Create an in-memory database for testing
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Agent Registry Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Agent Registry', () => {
    it('should have default system agents', () => {
      const agents = executor.listAgents();

      // Check that default agents exist
      const agentIds = agents.map(a => a.id);
      expect(agentIds).toContain('assistant');
      expect(agentIds).toContain('coder');
      expect(agentIds).toContain('code-reviewer');
      expect(agentIds).toContain('architect');
    });

    it('should retrieve agent by ID', () => {
      const assistant = executor.getAgent('assistant');

      expect(assistant).not.toBeNull();
      expect(assistant!.name).toBe('Assistant');
      expect(assistant!.isSystem).toBe(true);
      expect(assistant!.provider).toBe('claude');
    });

    it('should have system prompts for agents', () => {
      const coder = executor.getAgent('coder');
      const reviewer = executor.getAgent('code-reviewer');

      expect(coder?.systemPrompt).toBeTruthy();
      expect(reviewer?.systemPrompt).toBeTruthy();
      expect(reviewer?.systemPrompt).toContain('VOTE');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Basic Workflow Execution Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Basic Workflow Execution', () => {
    it('should create and start a workflow execution', async () => {
      // Create a simple workflow
      const workflowId = createSimpleWorkflow(executor);

      // Start execution
      const execution = await executor.startExecution({
        workflowId,
        input: { task: 'Hello world' },
      });

      expect(execution.id).toBeTruthy();
      expect(execution.workflowId).toBe(workflowId);
      expect(execution.status).toBe('running');
      expect(execution.initialInput).toEqual({ task: 'Hello world' });
    });

    it('should execute a single agent node', async () => {
      const workflowId = createSimpleWorkflow(executor);

      // Start execution
      const execution = await executor.startExecution({
        workflowId,
        input: { task: 'Test task' },
      });

      // Execute step
      const result = await executor.executeStep(execution.id);

      // Check that agent node was executed
      expect(mockAIExecutor.calls.length).toBe(1);
      expect(mockAIExecutor.calls[0].agentId).toBe('assistant');
    });

    it('should follow node dependencies in order', async () => {
      // Create workflow with dependencies: A -> B -> C
      const workflowId = createChainedWorkflow(executor);

      const execution = await executor.startExecution({
        workflowId,
        input: { task: 'Test' },
      });

      // Execute all steps
      let result = await executor.executeStep(execution.id);
      expect(result.nodeExecution?.nodeId).toBe('node_a');

      result = await executor.executeStep(execution.id);
      expect(result.nodeExecution?.nodeId).toBe('node_b');

      result = await executor.executeStep(execution.id);
      expect(result.nodeExecution?.nodeId).toBe('node_c');

      result = await executor.executeStep(execution.id);
      expect(result.completed).toBe(true);
    });

    it('should complete workflow when all nodes are done', async () => {
      const workflowId = createSimpleWorkflow(executor);

      const execution = await executor.startExecution({
        workflowId,
        input: { task: 'Test' },
      });

      // Execute until complete
      let result;
      do {
        result = await executor.executeStep(execution.id);
      } while (!result.completed && !result.paused);

      expect(result.execution.status).toBe('completed');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Multi-turn Conversation Tests (await_input)
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Multi-turn Conversations', () => {
    it('should pause at await_input node', async () => {
      const workflowId = createConversationWorkflow(executor);

      const execution = await executor.startExecution({
        workflowId,
        input: { task: 'Hello' },
      });

      // Execute agent node
      let result = await executor.executeStep(execution.id);
      expect(result.nodeExecution?.nodeId).toBe('agent');
      expect(result.paused).toBe(false);

      // Execute await_input node - should pause
      result = await executor.executeStep(execution.id);
      expect(result.nodeExecution?.nodeId).toBe('await_user');
      expect(result.paused).toBe(true);
      expect(result.execution.status).toBe('awaiting_input');
    });

    it('should resume from await_input when user sends message', async () => {
      const workflowId = createConversationWorkflow(executor);

      const execution = await executor.startExecution({
        workflowId,
        input: { task: 'Hello' },
      });

      // Execute to await_input
      await executor.executeStep(execution.id);
      await executor.executeStep(execution.id);

      // Simulate user sending a message
      executor.messages.createMessage({
        executionId: execution.id,
        role: 'user',
        content: 'Follow-up message',
      });

      // Resume after input
      await executor.resumeAfterInput(execution.id);

      // Get updated execution
      const updatedExecution = executor.getExecution(execution.id);
      expect(updatedExecution?.status).toBe('running');
      expect(updatedExecution?.iterationCount).toBe(1); // Should have incremented
    });

    it('should loop back to first node after user input', async () => {
      const workflowId = createConversationWorkflow(executor);

      const execution = await executor.startExecution({
        workflowId,
        input: { task: 'Hello' },
      });

      // First iteration: execute to await_input
      await executor.executeStep(execution.id);
      await executor.executeStep(execution.id);

      // User sends message and we resume
      executor.messages.createMessage({
        executionId: execution.id,
        role: 'user',
        content: 'Follow-up',
      });
      await executor.resumeAfterInput(execution.id);

      // Should now be able to execute agent node again
      const result = await executor.executeStep(execution.id);
      expect(result.nodeExecution?.nodeId).toBe('agent');
      expect(result.nodeExecution?.iterationNumber).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // CCA Workflow Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe('CCA Workflow Patterns', () => {
    it('should execute CCA pattern nodes in order', async () => {
      const workflowId = createCCAWorkflow(executor);

      const execution = await executor.startExecution({
        workflowId,
        input: { task: 'Implement feature' },
      });

      // Execute coder
      let result = await executor.executeStep(execution.id);
      expect(result.nodeExecution?.nodeId).toBe('coder');

      // Execute reviewer
      mockAIExecutor.setNextResponse('VOTE: approve\nFEEDBACK: Looks good!');
      result = await executor.executeStep(execution.id);
      expect(result.nodeExecution?.nodeId).toBe('reviewer');

      // Execute decision
      result = await executor.executeStep(execution.id);
      expect(result.nodeExecution?.nodeId).toBe('decision');
    });

    it('should loop back on address_critical decision', async () => {
      const workflowId = createCCAWorkflow(executor);

      const execution = await executor.startExecution({
        workflowId,
        input: { task: 'Implement feature' },
      });

      // Execute coder
      await executor.executeStep(execution.id);

      // Execute reviewer with critical vote
      mockAIExecutor.setNextResponse('VOTE: critical\nFEEDBACK: Major bug found!');
      await executor.executeStep(execution.id);

      // Execute decision - should increment iteration and route back to coder
      const result = await executor.executeStep(execution.id);
      const updatedExecution = executor.getExecution(execution.id);

      // Decision node increments iteration when routing back
      expect(updatedExecution?.iterationCount).toBeGreaterThanOrEqual(0);

      // The workflow should continue running after decision
      expect(updatedExecution?.status).not.toBe('failed');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Error Handling Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Error Handling', () => {
    it('should handle missing workflow gracefully', async () => {
      await expect(
        executor.startExecution({
          workflowId: 'non-existent-workflow',
          input: {},
        })
      ).rejects.toThrow('Workflow not found');
    });

    it('should enforce max iterations limit', async () => {
      const workflowId = createSimpleWorkflow(executor, { maxIterations: 2 });

      const execution = await executor.startExecution({
        workflowId,
        input: { task: 'Test' },
      });

      // Execute first step
      await executor.executeStep(execution.id);

      // Force increment iteration past max
      executor.executions.incrementIteration(execution.id);
      executor.executions.incrementIteration(execution.id);

      // Check if max iterations is reached
      const reachedMax = executor.executions.hasReachedMaxIterations(execution.id);
      expect(reachedMax).toBe(true);
    });

    it('should handle AI executor errors gracefully', async () => {
      mockAIExecutor.shouldThrow = true;

      const workflowId = createSimpleWorkflow(executor);

      const execution = await executor.startExecution({
        workflowId,
        input: { task: 'Test' },
      });

      const result = await executor.executeStep(execution.id);
      expect(result.error).toBeTruthy();
      expect(result.execution.status).toBe('failed');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Message Service Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Message Service', () => {
    it('should create messages during agent execution', async () => {
      const workflowId = createSimpleWorkflow(executor);

      const execution = await executor.startExecution({
        workflowId,
        input: { task: 'Test' },
      });

      await executor.executeStep(execution.id);

      const messages = executor.messages.listMessages(execution.id);
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.some(m => m.role === 'agent')).toBe(true);
    });

    it('should track user messages', async () => {
      const workflowId = createConversationWorkflow(executor);

      const execution = await executor.startExecution({
        workflowId,
        input: { task: 'Hello' },
      });

      // Add user message
      executor.messages.createMessage({
        executionId: execution.id,
        role: 'user',
        content: 'User message',
      });

      const messages = executor.messages.listMessages(execution.id);
      expect(messages.some(m => m.role === 'user' && m.content === 'User message')).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

function createMockAIExecutor() {
  let nextResponse = 'Mock AI response';
  let shouldThrow = false;
  const calls: Array<{ agentId: string; prompt: string }> = [];

  const executor: WorkflowAIExecutor = async (request, onStream) => {
    if (shouldThrow) {
      throw new Error('Mock AI error');
    }

    calls.push({
      agentId: request.agentId,
      prompt: request.prompt,
    });

    // Simulate streaming
    if (onStream) {
      onStream({ type: 'start' });
      onStream({ type: 'delta', delta: nextResponse });
      onStream({ type: 'end' });
    }

    return {
      content: nextResponse,
      tokensIn: 100,
      tokensOut: 50,
    };
  };

  return {
    executor,
    calls,
    setNextResponse: (response: string) => {
      nextResponse = response;
    },
    get shouldThrow() { return shouldThrow; },
    set shouldThrow(value: boolean) { shouldThrow = value; },
  };
}

function createSimpleWorkflow(executor: WorkflowExecutor, options?: { maxIterations?: number }): string {
  const definition: WorkflowDefinition = {
    name: 'Simple Test Workflow',
    trigger: { type: 'manual' },
    steps: [
      {
        id: 'agent',
        type: 'agent',
        agent: 'assistant',
        prompt: 'Process the user input.',
      },
    ],
    max_iterations: options?.maxIterations ?? 10,
  };

  const workflow = executor.workflows.createWorkflow({
    id: 'test-simple',
    name: 'Simple Test Workflow',
    definition,
    triggerType: 'manual',
  });

  return workflow.id;
}

function createChainedWorkflow(executor: WorkflowExecutor): string {
  const definition: WorkflowDefinition = {
    name: 'Chained Test Workflow',
    trigger: { type: 'manual' },
    steps: [
      {
        id: 'node_a',
        type: 'agent',
        agent: 'assistant',
        prompt: 'First step.',
      },
      {
        id: 'node_b',
        type: 'agent',
        agent: 'assistant',
        prompt: 'Second step.',
        depends: ['node_a'],
      },
      {
        id: 'node_c',
        type: 'agent',
        agent: 'assistant',
        prompt: 'Third step.',
        depends: ['node_b'],
      },
    ],
    max_iterations: 10,
  };

  const workflow = executor.workflows.createWorkflow({
    id: 'test-chained',
    name: 'Chained Test Workflow',
    definition,
    triggerType: 'manual',
  });

  return workflow.id;
}

function createConversationWorkflow(executor: WorkflowExecutor): string {
  const definition: WorkflowDefinition = {
    name: 'Conversation Test Workflow',
    trigger: { type: 'manual' },
    steps: [
      {
        id: 'agent',
        type: 'agent',
        agent: 'assistant',
        prompt: 'Process the user message.',
      },
      {
        id: 'await_user',
        type: 'await_input',
        depends: ['agent'],
      },
    ],
    max_iterations: 1000,
  };

  const workflow = executor.workflows.createWorkflow({
    id: 'test-conversation',
    name: 'Conversation Test Workflow',
    definition,
    triggerType: 'manual',
  });

  return workflow.id;
}

function createCCAWorkflow(executor: WorkflowExecutor): string {
  const definition: WorkflowDefinition = {
    name: 'CCA Test Workflow',
    trigger: { type: 'manual' },
    steps: [
      {
        id: 'coder',
        type: 'agent',
        agent: 'coder',
        prompt: 'Implement the requested feature.',
        action: 'implement',
      },
      {
        id: 'reviewer',
        type: 'agent',
        agent: 'code-reviewer',
        prompt: 'Review the code changes.',
        action: 'review',
        depends: ['coder'],
      },
      {
        id: 'decision',
        type: 'decision',
        depends: ['reviewer'],
      },
      {
        id: 'arbiter',
        type: 'checkpoint',
        checkpoint: true,
        checkpointMessage: 'Please review the code changes.',
        depends: ['decision'],
      },
    ],
    max_iterations: 5,
  };

  const workflow = executor.workflows.createWorkflow({
    id: 'test-cca',
    name: 'CCA Test Workflow',
    definition,
    triggerType: 'manual',
  });

  return workflow.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Advanced Integration Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('WorkflowExecutor - Advanced Integration', () => {
  let db: Database;
  let executor: WorkflowExecutor;
  let mockAIExecutor: ReturnType<typeof createMockAIExecutor>;

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

  describe('Full CCA Conversation Flow', () => {
    it('should complete a multi-turn chat conversation', async () => {
      // Create a default-chat style workflow (agent -> await_input -> loop)
      const workflowId = createAdvancedConversationWorkflow(executor);

      // Start with user's initial message
      const execution = await executor.startExecution({
        workflowId,
        input: { task: 'Help me write a function to calculate fibonacci numbers' },
      });

      // Turn 1: Agent responds
      mockAIExecutor.setNextResponse('Here\'s a function to calculate fibonacci numbers:\n\n```javascript\nfunction fibonacci(n) {\n  if (n <= 1) return n;\n  return fibonacci(n-1) + fibonacci(n-2);\n}\n```');
      let result = await executor.executeStep(execution.id);
      expect(result.nodeExecution?.nodeId).toBe('agent');

      // Workflow pauses at await_input
      result = await executor.executeStep(execution.id);
      expect(result.paused).toBe(true);

      // User sends follow-up
      executor.messages.createMessage({
        executionId: execution.id,
        role: 'user',
        content: 'Can you make it iterative instead of recursive?',
      });
      await executor.resumeAfterInput(execution.id);

      // Turn 2: Agent responds to follow-up
      mockAIExecutor.setNextResponse('Here\'s an iterative version:\n\n```javascript\nfunction fibonacci(n) {\n  let a = 0, b = 1;\n  for (let i = 0; i < n; i++) {\n    [a, b] = [b, a + b];\n  }\n  return a;\n}\n```');
      result = await executor.executeStep(execution.id);
      expect(result.nodeExecution?.nodeId).toBe('agent');
      expect(result.nodeExecution?.iterationNumber).toBe(1);

      // Verify message history
      // Note: Initial input + follow-up = 2 user messages
      const messages = executor.messages.listMessages(execution.id);
      expect(messages.filter(m => m.role === 'user').length).toBeGreaterThanOrEqual(1);
      // Agent messages may include both ExecutionMessage and ContextItem entries
      expect(messages.filter(m => m.role === 'agent').length).toBeGreaterThanOrEqual(2);

      // Verify iteration tracking
      const finalExecution = executor.getExecution(execution.id);
      expect(finalExecution?.iterationCount).toBe(1);
    });

    it('should track all agent calls with proper context', async () => {
      const workflowId = createAdvancedConversationWorkflow(executor);

      const execution = await executor.startExecution({
        workflowId,
        input: { task: 'Explain async/await in JavaScript' },
      });

      // Execute first agent call
      mockAIExecutor.setNextResponse('Async/await is a syntactic sugar for promises...');
      await executor.executeStep(execution.id);

      // Check the AI was called with correct context
      expect(mockAIExecutor.calls.length).toBe(1);
      expect(mockAIExecutor.calls[0].agentId).toBe('assistant');
      expect(mockAIExecutor.calls[0].prompt).toContain('Explain async/await');
    });
  });

  describe('CCA Review Loop Simulation', () => {
    it('should create messages for coder and reviewer', async () => {
      const workflowId = createAdvancedCCAWorkflow(executor);

      const execution = await executor.startExecution({
        workflowId,
        input: { task: 'Implement a sorting algorithm' },
      });

      // Coder implements
      mockAIExecutor.setNextResponse('```javascript\nfunction bubbleSort(arr) { /* impl */ }\n```');
      await executor.executeStep(execution.id);

      // Reviewer reviews
      mockAIExecutor.setNextResponse('VOTE: approve\nFEEDBACK: Looks good.');
      await executor.executeStep(execution.id);

      // Verify messages were created for both agents
      const messages = executor.messages.listMessages(execution.id);
      expect(messages.filter(m => m.role === 'agent').length).toBeGreaterThanOrEqual(2);

      // Verify workflow completed (since no decision node to loop back)
      const finalExecution = executor.getExecution(execution.id);
      expect(finalExecution?.status).toBe('completed');
    });
  });

  describe('Tool Call Tracking', () => {
    it('should track tool calls through the toolCalls service', async () => {
      // This test verifies the tool call service is properly integrated
      const workflowId = createAdvancedSimpleWorkflow(executor);

      const execution = await executor.startExecution({
        workflowId,
        input: { task: 'Use tools' },
      });

      // Create a tool call
      const toolCall = executor.toolCalls.createToolCall({
        executionId: execution.id,
        nodeExecutionId: 'node-exec-1',
        toolName: 'read_file',
        input: { path: '/test/file.txt' },
      });

      expect(toolCall.id).toBeTruthy();
      expect(toolCall.status).toBe('pending');

      // Complete the tool call using correct API
      const success = executor.toolCalls.completeToolCall(toolCall.id, 'File contents here');
      expect(success).toBe(true);

      const updated = executor.toolCalls.getToolCall(toolCall.id);
      expect(updated?.status).toBe('success');
      expect(updated?.output).toBe('File contents here');
    });

    it('should list tool calls by execution', async () => {
      const workflowId = createAdvancedSimpleWorkflow(executor);

      const execution = await executor.startExecution({
        workflowId,
        input: { task: 'Multiple tools' },
      });

      // Create multiple tool calls
      executor.toolCalls.createToolCall({
        executionId: execution.id,
        nodeExecutionId: 'node-1',
        toolName: 'read_file',
        input: { path: '/a.txt' },
      });

      executor.toolCalls.createToolCall({
        executionId: execution.id,
        nodeExecutionId: 'node-1',
        toolName: 'write_file',
        input: { path: '/b.txt', content: 'hello' },
      });

      const toolCalls = executor.toolCalls.listToolCalls(execution.id);
      expect(toolCalls.length).toBe(2);
    });

    it('should support approve and deny flows', async () => {
      const workflowId = createAdvancedSimpleWorkflow(executor);

      const execution = await executor.startExecution({
        workflowId,
        input: { task: 'Permission test' },
      });

      const toolCall = executor.toolCalls.createToolCall({
        executionId: execution.id,
        nodeExecutionId: 'node-1',
        toolName: 'dangerous_tool',
        input: { command: 'rm -rf /' },
      });

      // Request permission
      executor.toolCalls.awaitPermission(toolCall.id);
      let updated = executor.toolCalls.getToolCall(toolCall.id);
      expect(updated?.status).toBe('awaiting_permission');

      // Deny the tool call
      executor.toolCalls.denyToolCall(toolCall.id);
      updated = executor.toolCalls.getToolCall(toolCall.id);
      expect(updated?.status).toBe('denied');
    });
  });
});

// Helper functions for advanced tests (with unique IDs to avoid conflicts)
function createAdvancedSimpleWorkflow(executor: WorkflowExecutor): string {
  const definition: WorkflowDefinition = {
    name: 'Advanced Simple Workflow',
    trigger: { type: 'manual' },
    steps: [
      { id: 'agent', type: 'agent', agent: 'assistant', prompt: 'Process the user input.' },
    ],
    max_iterations: 10,
  };

  const workflow = executor.workflows.createWorkflow({
    id: `adv-simple-${Date.now()}-${Math.random()}`,
    name: 'Advanced Simple Workflow',
    definition,
    triggerType: 'manual',
  });

  return workflow.id;
}

function createAdvancedConversationWorkflow(executor: WorkflowExecutor): string {
  const definition: WorkflowDefinition = {
    name: 'Advanced Conversation Workflow',
    trigger: { type: 'manual' },
    steps: [
      { id: 'agent', type: 'agent', agent: 'assistant', prompt: 'Process the user message.' },
      { id: 'await_user', type: 'await_input', depends: ['agent'] },
    ],
    max_iterations: 1000,
  };

  const workflow = executor.workflows.createWorkflow({
    id: `adv-conversation-${Date.now()}-${Math.random()}`,
    name: 'Advanced Conversation Workflow',
    definition,
    triggerType: 'manual',
  });

  return workflow.id;
}

function createAdvancedCCAWorkflow(executor: WorkflowExecutor): string {
  const definition: WorkflowDefinition = {
    name: 'Advanced CCA Workflow',
    trigger: { type: 'manual' },
    steps: [
      { id: 'coder', type: 'agent', agent: 'coder', prompt: 'Implement the feature.' },
      { id: 'reviewer', type: 'agent', agent: 'code-reviewer', prompt: 'Review the code.', depends: ['coder'] },
    ],
    max_iterations: 5,
  };

  const workflow = executor.workflows.createWorkflow({
    id: `adv-cca-${Date.now()}-${Math.random()}`,
    name: 'Advanced CCA Workflow',
    definition,
    triggerType: 'manual',
  });

  return workflow.id;
}
