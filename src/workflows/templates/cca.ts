/**
 * CCA (Coder/Critic/Arbiter) Workflow Template
 *
 * This demonstrates how CCA emerges from the generic node system.
 * Users can:
 * - Use this as-is
 * - Modify it in the visual editor
 * - Build similar patterns from scratch
 * - Learn how multi-agent workflows are constructed
 */

import type {
  WorkflowDefinition,
  WorkflowNode,
  WorkflowEdge,
  AgentConfig,
  VoteConfig,
  HumanConfig,
  ConditionConfig,
  LoopConfig,
  MergeConfig,
  TriggerConfig,
  OutputConfig,
} from '../nodes/types.ts';

// ─────────────────────────────────────────────────────────────────────────────
// CCA Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface CCATemplateOptions {
  /** Number of critic agents (default: 2) */
  criticCount?: number;
  /** Vote threshold for pass/fail (default: 0.5) */
  voteThreshold?: number;
  /** Max retry attempts before escalation (default: 2) */
  maxRetries?: number;
  /** Coder model (default: claude-sonnet-4-20250514) */
  coderModel?: string;
  /** Critic model (default: claude-sonnet-4-20250514) */
  criticModel?: string;
  /** Custom coder system prompt */
  coderPrompt?: string;
  /** Custom critic system prompt */
  criticPrompt?: string;
}

const DEFAULT_OPTIONS: Required<CCATemplateOptions> = {
  criticCount: 2,
  voteThreshold: 0.5,
  maxRetries: 2,
  coderModel: 'claude-sonnet-4-20250514',
  criticModel: 'claude-sonnet-4-20250514',
  coderPrompt: `You are a skilled software developer. Execute the given coding task with high quality.
Focus on:
- Clean, readable code
- Proper error handling
- Following best practices
- Addressing any feedback from previous iterations

After completing your work, provide a summary of what you did and any files modified.`,
  criticPrompt: `You are a code reviewer. Analyze the coder's work and provide structured feedback.

Evaluate:
1. Code quality and readability
2. Correctness and completeness
3. Error handling
4. Best practices adherence
5. Any issues or improvements

Vote:
- PASS: Work meets all requirements, no significant issues
- QUEUE: Minor issues that can be addressed later
- FAIL: Significant issues that must be fixed now

Respond in JSON format:
{
  "vote": "pass" | "queue" | "fail",
  "feedback": "Your detailed feedback",
  "issues": [
    {
      "severity": "error" | "warning" | "suggestion",
      "description": "Issue description",
      "suggestion": "How to fix"
    }
  ]
}`,
};

// ─────────────────────────────────────────────────────────────────────────────
// Create CCA Workflow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a CCA workflow definition from the template.
 */
export function createCCAWorkflow(options: CCATemplateOptions = {}): WorkflowDefinition {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];

  // Positioning helpers
  let x = 50;
  const y = 100;
  const xStep = 180;
  const yStep = 80;

  // ─────────────────────────────────────────────────────────────────────────
  // Node 1: Trigger (user message)
  // ─────────────────────────────────────────────────────────────────────────
  const triggerId = 'trigger';
  nodes.push(createNode(triggerId, 'trigger', 'User Task', x, y, {
    nodeType: 'trigger',
    triggerType: 'message',
  } as TriggerConfig));
  x += xStep;

  // ─────────────────────────────────────────────────────────────────────────
  // Node 2: Loop Start (for retries)
  // ─────────────────────────────────────────────────────────────────────────
  const loopStartId = 'loop-start';
  nodes.push(createNode(loopStartId, 'loop', 'Retry Loop', x, y, {
    nodeType: 'loop',
    loopType: 'while',
    condition: {
      field: 'retryCount',
      operator: 'less_than',
      value: opts.maxRetries,
    },
    maxIterations: opts.maxRetries + 1,
  } as LoopConfig));
  edges.push(createEdge('e1', triggerId, 'output', loopStartId, 'input'));
  x += xStep;

  // ─────────────────────────────────────────────────────────────────────────
  // Node 3: Coder Agent
  // ─────────────────────────────────────────────────────────────────────────
  const coderId = 'coder';
  nodes.push(createNode(coderId, 'agent', 'Coder', x, y, {
    nodeType: 'agent',
    roleType: 'coder',
    systemPrompt: opts.coderPrompt,
    model: opts.coderModel,
    streaming: true,
    inputTemplate: `Task: {{task}}

{{#if feedback}}
Previous feedback to address:
{{feedback}}
{{/if}}

{{#if queuedIssues}}
Queued issues (address if possible):
{{queuedIssues}}
{{/if}}`,
  } as AgentConfig));
  edges.push(createEdge('e2', loopStartId, 'output', coderId, 'input'));
  x += xStep;

  // ─────────────────────────────────────────────────────────────────────────
  // Node 4: Split (parallel critics)
  // ─────────────────────────────────────────────────────────────────────────
  const splitId = 'split-critics';
  nodes.push(createNode(splitId, 'split', 'Fan Out', x, y, {
    nodeType: 'split',
    strategy: 'broadcast',
    branchCount: opts.criticCount,
  }));
  edges.push(createEdge('e3', coderId, 'output', splitId, 'input'));
  x += xStep;

  // ─────────────────────────────────────────────────────────────────────────
  // Nodes 5-N: Critic Agents
  // ─────────────────────────────────────────────────────────────────────────
  const criticIds: string[] = [];
  for (let i = 0; i < opts.criticCount; i++) {
    const criticId = `critic-${i + 1}`;
    criticIds.push(criticId);
    nodes.push(createNode(criticId, 'agent', `Critic ${i + 1}`, x, y + (i * yStep) - ((opts.criticCount - 1) * yStep / 2), {
      nodeType: 'agent',
      roleType: 'reviewer',
      systemPrompt: opts.criticPrompt,
      model: opts.criticModel,
      streaming: false,
      inputTemplate: `Review the following work:

{{coderOutput}}

Provide your vote and feedback in JSON format.`,
      outputSchema: {
        type: 'object',
        properties: {
          vote: { type: 'string', enum: ['pass', 'queue', 'fail'] },
          feedback: { type: 'string' },
          issues: { type: 'array' },
        },
      },
    } as AgentConfig));
    edges.push(createEdge(`e-split-${i}`, splitId, `output-${i}`, criticId, 'input'));
  }
  x += xStep;

  // ─────────────────────────────────────────────────────────────────────────
  // Node: Merge (collect critic outputs)
  // ─────────────────────────────────────────────────────────────────────────
  const mergeId = 'merge-critics';
  nodes.push(createNode(mergeId, 'merge', 'Collect', x, y, {
    nodeType: 'merge',
    strategy: 'concatenate',
  } as MergeConfig));
  for (let i = 0; i < opts.criticCount; i++) {
    edges.push(createEdge(`e-merge-${i}`, criticIds[i]!, 'output', mergeId, `input-${i}`));
  }
  x += xStep;

  // ─────────────────────────────────────────────────────────────────────────
  // Node: Vote Tally
  // ─────────────────────────────────────────────────────────────────────────
  const voteId = 'vote-tally';
  nodes.push(createNode(voteId, 'vote', 'Vote', x, y, {
    nodeType: 'vote',
    voteOptions: ['pass', 'queue', 'fail'],
    threshold: opts.voteThreshold,
    tieBreaker: 'escalate',
    voteField: 'vote',
    reasonField: 'feedback',
    voterField: 'criticId',
  } as VoteConfig));
  edges.push(createEdge('e-vote', mergeId, 'output', voteId, 'input'));
  x += xStep;

  // ─────────────────────────────────────────────────────────────────────────
  // Node: Condition (check vote outcome)
  // ─────────────────────────────────────────────────────────────────────────
  const conditionId = 'check-outcome';
  nodes.push(createNode(conditionId, 'condition', 'Outcome?', x, y, {
    nodeType: 'condition',
    rules: [{
      field: 'outcome',
      operator: 'equals',
      value: 'pass',
    }],
    trueLabel: 'Approved',
    falseLabel: 'Issues',
  } as ConditionConfig));
  edges.push(createEdge('e-condition', voteId, 'output', conditionId, 'input'));
  x += xStep;

  // ─────────────────────────────────────────────────────────────────────────
  // Node: Output (success path)
  // ─────────────────────────────────────────────────────────────────────────
  const outputSuccessId = 'output-success';
  nodes.push(createNode(outputSuccessId, 'output', 'Complete', x, y - yStep, {
    nodeType: 'output',
    destination: 'chat',
    messageTemplate: `✅ Task completed successfully!

{{coderOutput}}`,
  } as OutputConfig));
  edges.push(createEdge('e-success', conditionId, 'true', outputSuccessId, 'input', 'Approved'));

  // ─────────────────────────────────────────────────────────────────────────
  // Node: Condition (check retries)
  // ─────────────────────────────────────────────────────────────────────────
  const retryCheckId = 'check-retries';
  nodes.push(createNode(retryCheckId, 'condition', 'Retries?', x, y + yStep, {
    nodeType: 'condition',
    rules: [{
      field: 'retryCount',
      operator: 'less_than',
      value: opts.maxRetries,
    }],
    trueLabel: 'Retry',
    falseLabel: 'Escalate',
  } as ConditionConfig));
  edges.push(createEdge('e-retry-check', conditionId, 'false', retryCheckId, 'input', 'Issues'));
  x += xStep;

  // ─────────────────────────────────────────────────────────────────────────
  // Node: Transform (prepare retry)
  // ─────────────────────────────────────────────────────────────────────────
  const prepareRetryId = 'prepare-retry';
  nodes.push(createNode(prepareRetryId, 'transform', 'Prepare', x, y + yStep - yStep / 2, {
    nodeType: 'transform',
    transformType: 'javascript',
    code: `return {
      ...input,
      retryCount: (input.retryCount || 0) + 1,
      feedback: input.votes.filter(v => v.vote !== 'pass').map(v => v.feedback).join('\\n'),
      queuedIssues: input.votes.flatMap(v => v.issues?.filter(i => i.severity !== 'error') || []),
    };`,
  }));
  edges.push(createEdge('e-prepare-retry', retryCheckId, 'true', prepareRetryId, 'input', 'Retry'));

  // Loop back to coder
  edges.push(createEdge('e-loop-back', prepareRetryId, 'output', loopStartId, 'input'));

  // ─────────────────────────────────────────────────────────────────────────
  // Node: Human (arbiter)
  // ─────────────────────────────────────────────────────────────────────────
  const humanId = 'arbiter';
  nodes.push(createNode(humanId, 'human', 'Arbiter', x, y + yStep * 1.5, {
    nodeType: 'human',
    prompt: `The coder has attempted this task {{retryCount}} times without success.

Latest critic feedback:
{{feedback}}

Current output:
{{coderOutput}}

What would you like to do?`,
    choices: [
      { id: 'approve', label: 'Approve', description: 'Accept the current result despite issues' },
      { id: 'retry', label: 'Retry', description: 'Try again with additional guidance' },
      { id: 'skip', label: 'Skip', description: 'Skip this issue and continue' },
      { id: 'abort', label: 'Abort', description: 'Stop the workflow' },
    ],
    allowFreeText: true,
    contextFields: ['coderOutput', 'feedback', 'retryCount'],
  } as HumanConfig));
  edges.push(createEdge('e-escalate', retryCheckId, 'false', humanId, 'input', 'Escalate'));
  x += xStep;

  // ─────────────────────────────────────────────────────────────────────────
  // Node: Output (approved by arbiter)
  // ─────────────────────────────────────────────────────────────────────────
  const outputApprovedId = 'output-approved';
  nodes.push(createNode(outputApprovedId, 'output', 'Approved', x, y + yStep, {
    nodeType: 'output',
    destination: 'chat',
    messageTemplate: `✅ Approved by arbiter.

{{coderOutput}}`,
  } as OutputConfig));
  edges.push(createEdge('e-human-approve', humanId, 'approve', outputApprovedId, 'input', 'Approve'));

  // Human retry -> loop back with guidance
  const humanRetryId = 'human-retry-prep';
  nodes.push(createNode(humanRetryId, 'transform', 'Add Guidance', x, y + yStep * 2.5, {
    nodeType: 'transform',
    transformType: 'javascript',
    code: `return {
      ...input,
      retryCount: 0, // Reset retries with human guidance
      feedback: input.freeText || 'Please try again with the feedback provided.',
    };`,
  }));
  edges.push(createEdge('e-human-retry', humanId, 'retry', humanRetryId, 'input', 'Retry'));
  edges.push(createEdge('e-human-retry-loop', humanRetryId, 'output', loopStartId, 'input'));

  // ─────────────────────────────────────────────────────────────────────────
  // Node: Output (aborted)
  // ─────────────────────────────────────────────────────────────────────────
  const outputAbortedId = 'output-aborted';
  nodes.push(createNode(outputAbortedId, 'output', 'Aborted', x + xStep, y + yStep * 2, {
    nodeType: 'output',
    destination: 'chat',
    messageTemplate: `❌ Workflow aborted by arbiter.

{{#if freeText}}
Reason: {{freeText}}
{{/if}}`,
  } as OutputConfig));
  edges.push(createEdge('e-human-abort', humanId, 'abort', outputAbortedId, 'input', 'Abort'));

  // Skip goes to success output
  edges.push(createEdge('e-human-skip', humanId, 'skip', outputSuccessId, 'input', 'Skip'));

  // ─────────────────────────────────────────────────────────────────────────
  // Build workflow definition
  // ─────────────────────────────────────────────────────────────────────────
  return {
    id: 'cca-workflow',
    name: 'Coder/Critic/Arbiter (CCA)',
    description: `A multi-agent workflow where:
1. Coder executes tasks
2. Critics (${opts.criticCount}) review and vote (pass/queue/fail)
3. Arbiter (human) resolves repeated issues after ${opts.maxRetries} retries`,
    version: '1.0.0',
    nodes,
    edges,
    variables: {
      retryCount: 0,
      feedback: '',
      queuedIssues: [],
    },
    metadata: {
      author: 'Ultra System',
      createdAt: new Date(),
      tags: ['multi-agent', 'code-review', 'human-in-loop'],
      templateId: 'cca',
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

function createNode(
  id: string,
  type: WorkflowNode['type'],
  label: string,
  x: number,
  y: number,
  config: WorkflowNode['config']
): WorkflowNode {
  // Default ports based on type
  const inputs = type === 'trigger' ? [] : [{ id: 'input', name: 'Input', dataType: 'any' as const, required: true }];
  const outputs = type === 'output' ? [] : [{ id: 'output', name: 'Output', dataType: 'any' as const, required: false }];

  // Add condition-specific outputs
  if (type === 'condition') {
    return {
      id,
      type,
      label,
      position: { x, y },
      inputs,
      outputs: [
        { id: 'true', name: 'Yes', dataType: 'any', required: false, condition: 'true' },
        { id: 'false', name: 'No', dataType: 'any', required: false, condition: 'false' },
      ],
      config,
    };
  }

  // Add vote-specific outputs
  if (type === 'vote') {
    return {
      id,
      type,
      label,
      position: { x, y },
      inputs,
      outputs: [
        { id: 'pass', name: 'Pass', dataType: 'any', required: false, condition: 'pass' },
        { id: 'queue', name: 'Queue', dataType: 'any', required: false, condition: 'queue' },
        { id: 'fail', name: 'Fail', dataType: 'any', required: false, condition: 'fail' },
      ],
      config,
    };
  }

  // Add human-specific outputs based on choices
  if (type === 'human' && config.nodeType === 'human') {
    return {
      id,
      type,
      label,
      position: { x, y },
      inputs,
      outputs: config.choices.map((c) => ({
        id: c.id,
        name: c.label,
        dataType: 'any' as const,
        required: false,
        condition: c.id,
      })),
      config,
    };
  }

  return {
    id,
    type,
    label,
    position: { x, y },
    inputs,
    outputs,
    config,
  };
}

function createEdge(
  id: string,
  sourceNodeId: string,
  sourcePortId: string,
  targetNodeId: string,
  targetPortId: string,
  label?: string
): WorkflowEdge {
  return {
    id,
    sourceNodeId,
    sourcePortId,
    targetNodeId,
    targetPortId,
    label,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Other Templates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simple single-agent chat workflow.
 */
export function createSimpleChatWorkflow(): WorkflowDefinition {
  return {
    id: 'simple-chat',
    name: 'Simple Chat',
    description: 'A basic chat workflow with a single agent.',
    version: '1.0.0',
    nodes: [
      createNode('trigger', 'trigger', 'User Message', 50, 100, {
        nodeType: 'trigger',
        triggerType: 'message',
      } as TriggerConfig),
      createNode('agent', 'agent', 'Claude', 250, 100, {
        nodeType: 'agent',
        roleType: 'general',
        systemPrompt: 'You are a helpful AI assistant.',
        streaming: true,
      } as AgentConfig),
      createNode('output', 'output', 'Response', 450, 100, {
        nodeType: 'output',
        destination: 'chat',
        messageTemplate: '{{input}}',
      } as OutputConfig),
    ],
    edges: [
      createEdge('e1', 'trigger', 'output', 'agent', 'input'),
      createEdge('e2', 'agent', 'output', 'output', 'input'),
    ],
    metadata: {
      author: 'Ultra System',
      createdAt: new Date(),
      tags: ['basic', 'chat'],
      templateId: 'simple-chat',
    },
  };
}

/**
 * Code review workflow (simpler than CCA).
 */
export function createCodeReviewWorkflow(): WorkflowDefinition {
  return {
    id: 'code-review',
    name: 'Code Review',
    description: 'Analyzes code and provides detailed review.',
    version: '1.0.0',
    nodes: [
      createNode('trigger', 'trigger', 'Code Input', 50, 100, {
        nodeType: 'trigger',
        triggerType: 'message',
      } as TriggerConfig),
      createNode('reviewer', 'agent', 'Reviewer', 250, 100, {
        nodeType: 'agent',
        roleType: 'code-reviewer',
        systemPrompt: `You are an expert code reviewer. Analyze the provided code for:
- Code quality and readability
- Potential bugs or issues
- Security vulnerabilities
- Performance concerns
- Best practices

Provide specific, actionable feedback.`,
        streaming: true,
      } as AgentConfig),
      createNode('output', 'output', 'Review', 450, 100, {
        nodeType: 'output',
        destination: 'chat',
      } as OutputConfig),
    ],
    edges: [
      createEdge('e1', 'trigger', 'output', 'reviewer', 'input'),
      createEdge('e2', 'reviewer', 'output', 'output', 'input'),
    ],
    metadata: {
      author: 'Ultra System',
      createdAt: new Date(),
      tags: ['code', 'review'],
      templateId: 'code-review',
    },
  };
}
