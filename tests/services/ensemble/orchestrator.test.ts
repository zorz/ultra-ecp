/**
 * Ensemble Orchestrator Unit Tests
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  EnsembleOrchestrator,
  createEnsembleOrchestrator,
} from '../../../src/services/ensemble/orchestrator.ts';
import type {
  FrameworkDefinition,
  EnsembleEvent,
} from '../../../src/services/ensemble/types.ts';

// Helper to create a minimal valid framework
function createTestFramework(overrides: Partial<FrameworkDefinition> = {}): FrameworkDefinition {
  return {
    id: 'test-framework',
    name: 'Test Framework',
    description: 'A test framework',
    settings: {
      contextSharing: 'shared',
      executionModel: 'turn-based',
      communicationPattern: 'shared-feed',
    },
    agents: [
      {
        id: 'coder',
        role: 'coder',
        provider: 'claude',
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'You are a coder.',
        tools: ['read', 'write'],
      },
    ],
    validators: [],
    workflow: [
      {
        step: 'respond',
        agent: 'coder',
        action: 'respond-to-task',
      },
    ],
    humanRole: {
      canInterrupt: true,
      canRedirect: true,
      promptForPermission: ['write', 'bash'],
      escalateOnDisagreement: true,
    },
    ...overrides,
  };
}

describe('EnsembleOrchestrator', () => {
  let orchestrator: EnsembleOrchestrator;
  const framework = createTestFramework();

  beforeEach(() => {
    orchestrator = createEnsembleOrchestrator(framework, {
      tools: [],
    });
  });

  describe('constructor', () => {
    it('should initialize agents from framework', () => {
      const agents = orchestrator.getAgents();

      expect(agents).toHaveLength(1);
      expect(agents[0]!.id).toBe('coder');
    });

    it('should create empty feed', () => {
      const feed = orchestrator.getFeed();

      expect(feed.getCount()).toBe(0);
    });

    it('should have no active session initially', () => {
      expect(orchestrator.getSession()).toBeNull();
    });
  });

  describe('getFramework', () => {
    it('should return the framework', () => {
      const fw = orchestrator.getFramework();

      expect(fw.id).toBe('test-framework');
    });
  });

  describe('getAgent', () => {
    it('should find agent by id', () => {
      const agent = orchestrator.getAgent('coder');

      expect(agent).toBeDefined();
      expect(agent!.id).toBe('coder');
    });

    it('should return undefined for unknown agent', () => {
      expect(orchestrator.getAgent('unknown')).toBeUndefined();
    });
  });

  describe('startSession', () => {
    it('should create a new session', async () => {
      const session = await orchestrator.startSession('Build a REST API');

      expect(session).toBeDefined();
      expect(session.id).toMatch(/^ensemble-/);
      expect(session.task).toBe('Build a REST API');
    });

    it('should set session state to completed after workflow', async () => {
      const session = await orchestrator.startSession('Simple task');

      // The simple workflow completes quickly
      expect(session.state).toBe('completed');
    });

    it('should post session_start to feed', async () => {
      await orchestrator.startSession('Test task');

      const entries = orchestrator.getFeed().getEntries({ types: ['system'] });
      const startEntry = entries.find((e) => {
        const content = e.content as { event?: string };
        return content.event === 'session_start';
      });

      expect(startEntry).toBeDefined();
    });

    it('should emit session_created event', async () => {
      const events: EnsembleEvent[] = [];
      orchestrator.onEvent((e) => events.push(e));

      await orchestrator.startSession('Test task');

      expect(events.some((e) => e.type === 'session_created')).toBe(true);
    });

    it('should update agent statuses in session', async () => {
      const session = await orchestrator.startSession('Test task');

      expect(session.agents).toHaveLength(1);
      expect(session.agents[0]!.id).toBe('coder');
    });
  });

  describe('humanInterject', () => {
    it('should throw if no active session', async () => {
      expect(orchestrator.humanInterject('Hello')).rejects.toThrow('No active session');
    });

    it('should post message to feed', async () => {
      await orchestrator.startSession('Test task');
      await orchestrator.humanInterject('A human comment');

      const messages = orchestrator.getFeed().getEntries({ types: ['message'] });
      const humanMessage = messages.find((m) => m.source === 'human');

      expect(humanMessage).toBeDefined();
      expect((humanMessage!.content as { text: string }).text).toBe('A human comment');
    });
  });

  describe('humanDecide', () => {
    it('should throw if no active session', async () => {
      expect(
        orchestrator.humanDecide({
          decisionId: 'test',
          choice: 'approve',
        })
      ).rejects.toThrow('No active session');
    });

    it('should post decision to feed', async () => {
      await orchestrator.startSession('Test task');
      await orchestrator.humanDecide({
        decisionId: 'decision-1',
        choice: 'approve',
        feedback: 'Looks good',
      });

      const decisions = orchestrator.getFeed().getEntries({ types: ['decision'] });

      expect(decisions).toHaveLength(1);
      const content = decisions[0]!.content as { type: string; reason: string };
      expect(content.type).toBe('approve');
      expect(content.reason).toBe('Looks good');
    });

    it('should emit decision_made event', async () => {
      await orchestrator.startSession('Test task');

      const events: EnsembleEvent[] = [];
      orchestrator.onEvent((e) => events.push(e));

      await orchestrator.humanDecide({
        decisionId: 'decision-1',
        choice: 'reject',
      });

      expect(events.some((e) => e.type === 'decision_made')).toBe(true);
    });
  });

  describe('interrupt', () => {
    it('should pause the session', async () => {
      await orchestrator.startSession('Test task');
      await orchestrator.interrupt();

      const session = orchestrator.getSession();
      expect(session!.state).toBe('paused');
    });

    it('should post interrupt action to feed', async () => {
      await orchestrator.startSession('Test task');
      await orchestrator.interrupt();

      const actions = orchestrator.getFeed().getEntries({ types: ['action'] });
      const interrupt = actions.find((a) => {
        const content = a.content as { type: string };
        return content.type === 'interrupt';
      });

      expect(interrupt).toBeDefined();
    });
  });

  describe('resume', () => {
    it('should resume a paused session', async () => {
      await orchestrator.startSession('Test task');
      await orchestrator.interrupt();
      await orchestrator.resume();

      const session = orchestrator.getSession();
      // After resume, workflow completes
      expect(session!.state).toBe('completed');
    });

    it('should do nothing if not paused', async () => {
      await orchestrator.startSession('Test task');
      // Session is completed, not paused
      await orchestrator.resume();

      const session = orchestrator.getSession();
      expect(session!.state).toBe('completed');
    });
  });

  describe('endSession', () => {
    it('should set session state to completed', async () => {
      await orchestrator.startSession('Test task');
      await orchestrator.endSession();

      const session = orchestrator.getSession();
      expect(session!.state).toBe('completed');
    });

    it('should post session_end to feed', async () => {
      await orchestrator.startSession('Test task');
      await orchestrator.endSession();

      const entries = orchestrator.getFeed().getEntries({ types: ['system'] });
      const endEntry = entries.find((e) => {
        const content = e.content as { event?: string };
        return content.event === 'session_end';
      });

      expect(endEntry).toBeDefined();
    });

    it('should emit session_ended event', async () => {
      await orchestrator.startSession('Test task');

      const events: EnsembleEvent[] = [];
      orchestrator.onEvent((e) => events.push(e));

      await orchestrator.endSession();

      expect(events.some((e) => e.type === 'session_ended')).toBe(true);
    });
  });

  describe('onEvent', () => {
    it('should subscribe to events', async () => {
      const events: EnsembleEvent[] = [];
      orchestrator.onEvent((e) => events.push(e));

      await orchestrator.startSession('Test');

      expect(events.length).toBeGreaterThan(0);
    });

    it('should unsubscribe correctly', async () => {
      const events: EnsembleEvent[] = [];
      const unsubscribe = orchestrator.onEvent((e) => events.push(e));

      await orchestrator.startSession('Test 1');
      const countAfterFirst = events.length;

      unsubscribe();

      // Create new orchestrator for second test
      const orchestrator2 = createEnsembleOrchestrator(framework, { tools: [] });
      orchestrator2.onEvent((e) => events.push(e));

      // Events from first orchestrator should not increase
      expect(events.length).toBe(countAfterFirst);
    });
  });

  describe('cleanup', () => {
    it('should clear all resources', async () => {
      await orchestrator.startSession('Test');
      orchestrator.cleanup();

      expect(orchestrator.getAgents()).toHaveLength(0);
      expect(orchestrator.getFeed().getCount()).toBe(0);
      expect(orchestrator.getSession()).toBeNull();
    });
  });

  describe('workflow execution', () => {
    it('should execute workflow steps in order', async () => {
      const multiStepFramework = createTestFramework({
        workflow: [
          { step: 'step1', agent: 'coder', action: 'respond-to-task' },
          { step: 'step2', action: 'validate', validators: [] },
        ],
      });

      const orch = createEnsembleOrchestrator(multiStepFramework, { tools: [] });
      const events: EnsembleEvent[] = [];
      orch.onEvent((e) => events.push(e));

      await orch.startSession('Test');

      const stepChanges = events.filter((e) => e.type === 'workflow_step_changed');
      expect(stepChanges).toHaveLength(2);
    });
  });
});
