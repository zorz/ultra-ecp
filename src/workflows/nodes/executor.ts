/**
 * Workflow Executor
 *
 * Executes any node-based workflow by traversing the graph.
 * Supports parallel execution, conditions, loops, voting, and human input.
 */

import type {
  WorkflowDefinition,
  WorkflowInstance,
  WorkflowNode,
  WorkflowEdge,
  WorkflowEvent,
  WorkflowEventHandler,
  ExecutionStep,
  VoteType,
  HumanChoice,
} from './types.ts';
import type { LLMExecutor, LLMExecutorFactory } from '../../agents/llm/index.ts';
import { NullLLMExecutor } from '../../agents/llm/index.ts';
import {
  renderTemplate,
  safeEval,
  safeExpression,
  extractVariables,
  type VariableMapping,
} from './transform.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Node Executors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Context provided to node executors.
 */
export interface NodeExecutionContext {
  /** The node being executed */
  node: WorkflowNode;
  /** Input data from connected nodes */
  inputs: Record<string, unknown>;
  /** Workflow-level variables */
  variables: Record<string, unknown>;
  /** LLM executor for agent nodes */
  llm: LLMExecutor;
  /** Emit events */
  emit: (event: WorkflowEvent) => void;
  /** Request human input */
  requestHuman: (prompt: string, choices: HumanChoice[]) => Promise<{ choice: string; freeText?: string }>;
  /** Get current instance state */
  getInstance: () => WorkflowInstance;
}

/**
 * Result from executing a node.
 */
export interface NodeExecutionResult {
  /** Output data */
  output: unknown;
  /** Which output port to use (for condition nodes) */
  outputPort?: string;
  /** Error if failed */
  error?: string;
}

/**
 * Function type for node executors.
 */
export type NodeExecutorFn = (context: NodeExecutionContext) => Promise<NodeExecutionResult>;

/**
 * Registry of node type executors.
 */
const nodeExecutors: Record<string, NodeExecutorFn> = {};

/**
 * Register a node executor.
 */
export function registerNodeExecutor(nodeType: string, executor: NodeExecutorFn): void {
  nodeExecutors[nodeType] = executor;
}

// ─────────────────────────────────────────────────────────────────────────────
// Built-in Node Executors
// ─────────────────────────────────────────────────────────────────────────────

// Trigger node: just passes through the trigger data
registerNodeExecutor('trigger', async (ctx) => {
  return { output: ctx.inputs.trigger ?? ctx.inputs };
});

// Agent node: invokes LLM with the configured role
registerNodeExecutor('agent', async (ctx) => {
  const config = ctx.node.config;
  if (config.nodeType !== 'agent') {
    return { output: null, error: 'Invalid config for agent node' };
  }

  // Build prompt from input template or raw input
  let prompt: string;
  if (config.inputTemplate) {
    prompt = renderTemplate(config.inputTemplate, ctx.inputs);
  } else {
    prompt = typeof ctx.inputs.input === 'string'
      ? ctx.inputs.input
      : JSON.stringify(ctx.inputs.input ?? ctx.inputs);
  }

  // Stream progress
  const result = await ctx.llm.invoke(prompt, {
    systemPrompt: config.systemPrompt,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    streaming: config.streaming ?? true,
    onStream: (event) => {
      if (event.type === 'delta' && event.accumulated) {
        ctx.emit({
          type: 'node:progress',
          nodeId: ctx.node.id,
          content: event.delta ?? '',
          accumulated: event.accumulated,
        });
      }
    },
  });

  if (!result.success) {
    return { output: null, error: result.error ?? 'LLM invocation failed' };
  }

  // Parse output if schema provided
  let output: unknown = result.content;
  if (config.outputSchema) {
    try {
      output = JSON.parse(result.content);
    } catch {
      // Keep as string if not valid JSON
    }
  }

  return { output };
});

// Condition node: evaluates condition and returns which branch
registerNodeExecutor('condition', async (ctx) => {
  const config = ctx.node.config;
  if (config.nodeType !== 'condition') {
    return { output: null, error: 'Invalid config for condition node' };
  }

  // Evaluate all rules (ANDed)
  const result = config.rules.every((rule) => evaluateConditionRule(rule, ctx.inputs));

  return {
    output: ctx.inputs,
    outputPort: result ? 'true' : 'false',
  };
});

// Transform node: transforms data using templates, JQ, JavaScript, or variable mapping
registerNodeExecutor('transform', async (ctx) => {
  const config = ctx.node.config;
  if (config.nodeType !== 'transform') {
    return { output: null, error: 'Invalid config for transform node' };
  }

  let output: unknown;

  switch (config.transformType) {
    case 'template':
      // Handlebars-style template with conditionals, loops, and helpers
      try {
        output = renderTemplate(
          config.template ?? '',
          ctx.inputs as Record<string, unknown>,
          { strict: false }
        );
      } catch (err) {
        return { output: null, error: `Template error: ${err}` };
      }
      break;

    case 'jq':
      // JQ-style JSON transformation
      // Supports basic path expressions like .foo.bar, .foo[0], .foo[]
      try {
        output = evaluateJqExpression(config.jqExpression ?? '.', ctx.inputs.input ?? ctx.inputs);
      } catch (err) {
        return { output: null, error: `JQ transform error: ${err}` };
      }
      break;

    case 'extract':
      // Extract specific fields from input
      output = {};
      for (const field of config.fields ?? []) {
        (output as Record<string, unknown>)[field] = getNestedValue(ctx.inputs, field);
      }
      break;

    case 'map':
      // Map over array with template
      if (Array.isArray(ctx.inputs.input)) {
        output = ctx.inputs.input.map((item: unknown, index: number) => {
          const itemContext = {
            item,
            index,
            first: index === 0,
            last: index === (ctx.inputs.input as unknown[]).length - 1,
          };
          return renderTemplate(
            config.mapExpression ?? '{{item}}',
            itemContext as Record<string, unknown>
          );
        });
      } else {
        output = ctx.inputs.input;
      }
      break;

    case 'javascript':
      // Safe JavaScript evaluation with sandbox
      try {
        output = safeEval(
          config.code ?? 'return input',
          ctx.inputs,
          ctx.variables,
          { timeout: 1000 }
        );
      } catch (err) {
        return { output: null, error: `JavaScript error: ${err}` };
      }
      break;

    case 'expression':
      // Simple expression evaluation (no statements)
      try {
        output = safeExpression(
          config.expression ?? 'input',
          { input: ctx.inputs, variables: ctx.variables, ...ctx.inputs as Record<string, unknown> }
        );
      } catch (err) {
        return { output: null, error: `Expression error: ${err}` };
      }
      break;

    case 'mapping':
      // Variable extraction and mapping
      try {
        const mappings = (config.mappings ?? []) as VariableMapping[];
        output = extractVariables(ctx.inputs, mappings);
      } catch (err) {
        return { output: null, error: `Mapping error: ${err}` };
      }
      break;

    default:
      output = ctx.inputs;
  }

  return { output };
});

// Merge node: combines inputs from multiple branches
registerNodeExecutor('merge', async (ctx) => {
  const config = ctx.node.config;
  if (config.nodeType !== 'merge') {
    return { output: null, error: 'Invalid config for merge node' };
  }

  let output: unknown;

  switch (config.strategy) {
    case 'concatenate':
      output = Object.values(ctx.inputs).flat();
      break;

    case 'object':
      output = {};
      for (const [portId, key] of Object.entries(config.keyMapping ?? {})) {
        (output as Record<string, unknown>)[key] = ctx.inputs[portId];
      }
      break;

    case 'wait_all':
    case 'wait_any':
    default:
      // Just pass through all inputs as an object
      output = ctx.inputs;
      break;
  }

  return { output };
});

// Split node: prepares data for parallel branches
registerNodeExecutor('split', async (ctx) => {
  const config = ctx.node.config;
  if (config.nodeType !== 'split') {
    return { output: null, error: 'Invalid config for split node' };
  }

  // Output goes to all connected branches
  return { output: ctx.inputs.input ?? ctx.inputs };
});

// Loop node: handles iteration
// Note: The loop node prepares iteration data. The actual looping is handled
// by the WorkflowExecutor which detects loop nodes and re-executes downstream nodes.
registerNodeExecutor('loop', async (ctx) => {
  const config = ctx.node.config;
  if (config.nodeType !== 'loop') {
    return { output: null, error: 'Invalid config for loop node' };
  }

  const maxIterations = config.maxIterations ?? 100;

  switch (config.loopType) {
    case 'for_each': {
      // Return array of items to iterate over
      const array = getNestedValue(ctx.inputs, config.arrayField ?? 'input');
      const items = Array.isArray(array) ? array : [array];

      // Emit loop info for the executor
      ctx.emit({
        type: 'node:progress',
        nodeId: ctx.node.id,
        content: `Iterating over ${items.length} items`,
        accumulated: `Loop: ${items.length} items`,
      });

      return {
        output: {
          items,
          totalItems: items.length,
          loopType: 'for_each',
        },
      };
    }

    case 'while': {
      // For 'while' loops, we evaluate the condition and return iteration info
      // The executor will re-invoke this node until condition is false
      const instance = ctx.getInstance();
      const nodeState = instance.nodeStates[ctx.node.id];
      const iteration = nodeState?.executionCount ?? 1;

      if (iteration > maxIterations) {
        return {
          output: { done: true, reason: 'max_iterations', iteration },
          error: `Loop exceeded maximum iterations (${maxIterations})`,
        };
      }

      // Evaluate condition
      const conditionMet = config.condition
        ? evaluateConditionRule(config.condition, ctx.inputs as Record<string, unknown>)
        : false;

      return {
        output: {
          continue: conditionMet,
          done: !conditionMet,
          iteration,
          loopType: 'while',
          input: ctx.inputs,
        },
        outputPort: conditionMet ? 'continue' : 'done',
      };
    }

    case 'times': {
      // For 'times' loops, iterate N times
      const count = config.count ?? 1;
      const instance = ctx.getInstance();
      const nodeState = instance.nodeStates[ctx.node.id];
      const iteration = nodeState?.executionCount ?? 1;

      const effectiveCount = Math.min(count, maxIterations);
      const shouldContinue = iteration <= effectiveCount;

      return {
        output: {
          continue: shouldContinue,
          done: !shouldContinue,
          iteration,
          totalIterations: effectiveCount,
          loopType: 'times',
          input: ctx.inputs,
        },
        outputPort: shouldContinue ? 'continue' : 'done',
      };
    }

    default:
      return { output: ctx.inputs };
  }
});

// Vote node: collects and tallies votes
registerNodeExecutor('vote', async (ctx) => {
  const config = ctx.node.config;
  if (config.nodeType !== 'vote') {
    return { output: null, error: 'Invalid config for vote node' };
  }

  // Input should be an array of vote objects
  const votes = Array.isArray(ctx.inputs.input) ? ctx.inputs.input : [ctx.inputs.input];
  const tally: Record<VoteType, number> = { pass: 0, queue: 0, fail: 0 };

  for (const voteObj of votes) {
    const vote = getNestedValue(voteObj, config.voteField) as VoteType;
    const voterId = getNestedValue(voteObj, config.voterField ?? 'voterId') as string;
    const reason = getNestedValue(voteObj, config.reasonField ?? 'reason') as string | undefined;

    if (vote && config.voteOptions.includes(vote)) {
      tally[vote]++;
      ctx.emit({ type: 'vote:cast', nodeId: ctx.node.id, voterId, vote, reason });
    }
  }

  // Determine outcome
  const totalVotes = Object.values(tally).reduce((a, b) => a + b, 0);
  let outcome: VoteType = 'queue'; // Default to queue

  for (const option of config.voteOptions) {
    if (tally[option] / totalVotes >= config.threshold) {
      outcome = option;
      break;
    }
  }

  ctx.emit({ type: 'vote:tallied', nodeId: ctx.node.id, tally, outcome });

  return {
    output: { tally, outcome, votes },
    outputPort: outcome,
  };
});

// Human node: requests human input
registerNodeExecutor('human', async (ctx) => {
  const config = ctx.node.config;
  if (config.nodeType !== 'human') {
    return { output: null, error: 'Invalid config for human node' };
  }

  // Build context for display
  const contextData: Record<string, unknown> = {};
  for (const field of config.contextFields ?? []) {
    contextData[field] = getNestedValue(ctx.inputs, field);
  }

  // Request human input
  const response = await ctx.requestHuman(
    renderTemplate(config.prompt, { ...ctx.inputs, context: contextData }),
    config.choices
  );

  return {
    output: {
      choice: response.choice,
      freeText: response.freeText,
      input: ctx.inputs,
    },
    outputPort: response.choice,
  };
});

// Output node: produces final output
registerNodeExecutor('output', async (ctx) => {
  const config = ctx.node.config;
  if (config.nodeType !== 'output') {
    return { output: null, error: 'Invalid config for output node' };
  }

  let output = ctx.inputs.input ?? ctx.inputs;

  switch (config.destination) {
    case 'chat':
      // Format message for chat display
      if (config.messageTemplate) {
        output = renderTemplate(config.messageTemplate, ctx.inputs);
      }
      ctx.emit({
        type: 'node:progress',
        nodeId: ctx.node.id,
        content: String(output),
        accumulated: String(output),
      });
      break;

    case 'file':
      // Write output to file
      if (config.filePath) {
        const filePath = renderTemplate(config.filePath, ctx.inputs);
        const content = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
        try {
          // Use Bun's file API if available, otherwise store for later handling
          if (typeof Bun !== 'undefined') {
            await Bun.write(filePath, content);
            ctx.emit({
              type: 'node:progress',
              nodeId: ctx.node.id,
              content: `Wrote to file: ${filePath}`,
              accumulated: `File output: ${filePath}`,
            });
          } else {
            // Store file write request for handler to process
            output = { type: 'file_write', path: filePath, content };
          }
        } catch (err) {
          return { output: null, error: `Failed to write file: ${err}` };
        }
      }
      break;

    case 'webhook':
      // POST to webhook URL
      if (config.webhookUrl) {
        const url = renderTemplate(config.webhookUrl, ctx.inputs);
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(config.webhookHeaders ?? {}),
            },
            body: JSON.stringify(output),
          });

          if (!response.ok) {
            return { output: null, error: `Webhook failed: ${response.status} ${response.statusText}` };
          }

          const responseData = await response.json().catch(() => response.text());
          output = {
            sent: output,
            response: responseData,
            status: response.status,
          };

          ctx.emit({
            type: 'node:progress',
            nodeId: ctx.node.id,
            content: `Webhook POST to ${url}: ${response.status}`,
            accumulated: `Webhook: ${response.status}`,
          });
        } catch (err) {
          return { output: null, error: `Webhook error: ${err}` };
        }
      }
      break;

    case 'variable':
      // Store in workflow variable
      if (config.variableName) {
        ctx.variables[config.variableName] = output;
        ctx.emit({
          type: 'node:progress',
          nodeId: ctx.node.id,
          content: `Stored in variable: ${config.variableName}`,
          accumulated: `Variable: ${config.variableName}`,
        });
      }
      break;

    case 'log':
      // Log output for debugging
      console.log(`[Workflow Output] ${ctx.node.label}:`, output);
      ctx.emit({
        type: 'node:progress',
        nodeId: ctx.node.id,
        content: `Logged: ${JSON.stringify(output).substring(0, 100)}...`,
        accumulated: 'Logged to console',
      });
      break;

    default:
      // Unknown destination, just pass through
      break;
  }

  return { output };
});

// ─────────────────────────────────────────────────────────────────────────────
// Workflow Executor
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkflowExecutorOptions {
  /** LLM executor factory (creates LLM for each agent node) */
  llmFactory?: LLMExecutorFactory;
  /** Event handler */
  onEvent?: WorkflowEventHandler;
  /** Human input handler */
  onHumanRequest?: (prompt: string, choices: HumanChoice[]) => Promise<{ choice: string; freeText?: string }>;
  /** Initial trigger data */
  triggerData?: unknown;
}

/**
 * Executes a workflow definition.
 */
export class WorkflowExecutor {
  private workflow: WorkflowDefinition;
  private instance: WorkflowInstance;
  private options: WorkflowExecutorOptions;
  private llm: LLMExecutor;
  private pendingHuman: {
    resolve: (value: { choice: string; freeText?: string }) => void;
    reject: (error: Error) => void;
  } | null = null;

  constructor(workflow: WorkflowDefinition, options: WorkflowExecutorOptions = {}) {
    this.workflow = workflow;
    this.options = options;
    this.llm = new NullLLMExecutor(); // Default, replaced if factory provided

    // Create instance
    this.instance = {
      id: crypto.randomUUID(),
      workflowId: workflow.id,
      status: 'idle',
      nodeStates: {},
      data: { ...(workflow.variables ?? {}) },
      history: [],
      startedAt: new Date(),
    };

    // Initialize node states
    for (const node of workflow.nodes) {
      this.instance.nodeStates[node.id] = {
        nodeId: node.id,
        status: 'idle',
        inputs: {},
        executionCount: 0,
      };
    }
  }

  /**
   * Execute the workflow.
   */
  async execute(): Promise<WorkflowInstance> {
    this.instance.status = 'running';
    this.instance.startedAt = new Date();
    this.emit({ type: 'workflow:started', instance: this.instance });

    try {
      // Find trigger node(s)
      const triggers = this.workflow.nodes.filter((n) => n.type === 'trigger');
      if (triggers.length === 0) {
        throw new Error('Workflow has no trigger nodes');
      }

      // Execute from each trigger
      for (const trigger of triggers) {
        await this.executeNode(trigger.id, { trigger: this.options.triggerData });
      }

      // Mark complete
      this.instance.status = 'completed';
      this.instance.completedAt = new Date();

      // Get final output from output nodes
      const outputNodes = this.workflow.nodes.filter((n) => n.type === 'output');
      if (outputNodes.length > 0) {
        const outputs = outputNodes.map((n) => this.instance.nodeStates[n.id]?.output);
        this.instance.output = outputs.length === 1 ? outputs[0] : outputs;
      }

      this.emit({ type: 'workflow:completed', instance: this.instance, output: this.instance.output });
    } catch (error) {
      this.instance.status = 'failed';
      this.instance.completedAt = new Date();
      this.instance.error = error instanceof Error ? error.message : String(error);
      this.emit({ type: 'workflow:failed', instance: this.instance, error: this.instance.error });
    }

    return this.instance;
  }

  /**
   * Execute a single node.
   */
  private async executeNode(nodeId: string, inputs: Record<string, unknown>): Promise<void> {
    const node = this.workflow.nodes.find((n) => n.id === nodeId);
    if (!node) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    const state = this.instance.nodeStates[nodeId]!;
    state.status = 'running';
    state.inputs = inputs;
    state.startedAt = new Date();
    state.executionCount++;

    this.addHistoryStep(node, 'started', inputs);
    this.emit({ type: 'node:started', nodeId, nodeLabel: node.label, input: inputs });

    // Get executor for this node type
    const executor = nodeExecutors[node.type];
    if (!executor) {
      state.status = 'error';
      state.error = `No executor for node type: ${node.type}`;
      this.addHistoryStep(node, 'failed', undefined, state.error);
      this.emit({ type: 'node:failed', nodeId, nodeLabel: node.label, error: state.error });
      throw new Error(state.error);
    }

    // Create execution context
    const context: NodeExecutionContext = {
      node,
      inputs,
      variables: this.instance.data,
      llm: this.llm,
      emit: (event) => this.emit(event),
      requestHuman: (prompt, choices) => this.requestHuman(nodeId, prompt, choices),
      getInstance: () => this.instance,
    };

    try {
      const result = await executor(context);

      if (result.error) {
        state.status = 'error';
        state.error = result.error;
        state.completedAt = new Date();
        const durationMs = state.completedAt.getTime() - state.startedAt!.getTime();
        this.addHistoryStep(node, 'failed', undefined, result.error, durationMs);
        this.emit({ type: 'node:failed', nodeId, nodeLabel: node.label, error: result.error });
        throw new Error(result.error);
      }

      state.status = 'success';
      state.output = result.output;
      state.completedAt = new Date();
      const durationMs = state.completedAt.getTime() - state.startedAt!.getTime();

      this.addHistoryStep(node, 'completed', result.output, undefined, durationMs);
      this.emit({ type: 'node:completed', nodeId, nodeLabel: node.label, output: result.output, durationMs });

      // Find and execute downstream nodes
      await this.executeDownstream(node, result.output, result.outputPort);
    } catch (error) {
      if (state.status !== 'error') {
        state.status = 'error';
        state.error = error instanceof Error ? error.message : String(error);
        state.completedAt = new Date();
        const durationMs = state.startedAt ? state.completedAt.getTime() - state.startedAt.getTime() : 0;
        this.addHistoryStep(node, 'failed', undefined, state.error, durationMs);
        this.emit({ type: 'node:failed', nodeId, nodeLabel: node.label, error: state.error });
      }
      throw error;
    }
  }

  /**
   * Execute downstream nodes.
   */
  private async executeDownstream(
    sourceNode: WorkflowNode,
    output: unknown,
    outputPort?: string
  ): Promise<void> {
    // Find edges from this node
    const edges = this.workflow.edges.filter((e) => e.sourceNodeId === sourceNode.id);

    // Filter by output port if specified
    const activeEdges = outputPort
      ? edges.filter((e) => e.sourcePortId === outputPort || e.label === outputPort)
      : edges;

    // Mark non-active edges as skipped
    const skippedEdges = outputPort
      ? edges.filter((e) => e.sourcePortId !== outputPort && e.label !== outputPort)
      : [];

    for (const edge of skippedEdges) {
      const targetNode = this.workflow.nodes.find((n) => n.id === edge.targetNodeId);
      if (targetNode) {
        const state = this.instance.nodeStates[edge.targetNodeId]!;
        state.status = 'skipped';
        this.addHistoryStep(targetNode, 'skipped');
        this.emit({
          type: 'node:skipped',
          nodeId: edge.targetNodeId,
          nodeLabel: targetNode.label,
          reason: `Condition branch not taken: ${edge.label ?? edge.sourcePortId}`,
        });
      }
    }

    // Group edges by target for merge handling
    const targetGroups = new Map<string, WorkflowEdge[]>();
    for (const edge of activeEdges) {
      const group = targetGroups.get(edge.targetNodeId) ?? [];
      group.push(edge);
      targetGroups.set(edge.targetNodeId, group);
    }

    // Execute downstream nodes (potentially in parallel for split)
    const isSplit = sourceNode.type === 'split';
    const promises: Promise<void>[] = [];

    for (const [targetNodeId, targetEdges] of targetGroups) {
      const targetNode = this.workflow.nodes.find((n) => n.id === targetNodeId);
      if (!targetNode) continue;

      // Build inputs for target node
      const inputs: Record<string, unknown> = {};
      for (const edge of targetEdges) {
        inputs[edge.targetPortId] = output;
      }

      // Check if this is a merge node waiting for more inputs
      if (targetNode.type === 'merge') {
        const allInputEdges = this.workflow.edges.filter((e) => e.targetNodeId === targetNodeId);
        const completedInputs = allInputEdges.filter((e) => {
          const sourceState = this.instance.nodeStates[e.sourceNodeId];
          return sourceState?.status === 'success' || sourceState?.status === 'skipped';
        });

        // Don't execute merge until all inputs are ready
        if (completedInputs.length < allInputEdges.length) {
          // Store partial input
          const state = this.instance.nodeStates[targetNodeId]!;
          state.inputs = { ...state.inputs, ...inputs };
          continue;
        }

        // All inputs ready, include previously stored inputs
        const state = this.instance.nodeStates[targetNodeId]!;
        Object.assign(inputs, state.inputs);
      }

      // Execute (parallel for split, sequential otherwise)
      const execPromise = this.executeNode(targetNodeId, inputs);
      if (isSplit) {
        promises.push(execPromise);
      } else {
        await execPromise;
      }
    }

    // Wait for parallel executions
    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }

  /**
   * Request human input.
   */
  private async requestHuman(
    nodeId: string,
    prompt: string,
    choices: HumanChoice[]
  ): Promise<{ choice: string; freeText?: string }> {
    this.instance.status = 'waiting_human';
    this.emit({ type: 'human:requested', nodeId, prompt, choices });

    if (this.options.onHumanRequest) {
      const response = await this.options.onHumanRequest(prompt, choices);
      this.emit({ type: 'human:responded', nodeId, ...response });
      this.instance.status = 'running';
      return response;
    }

    // Wait for external response
    return new Promise((resolve, reject) => {
      this.pendingHuman = { resolve, reject };
    });
  }

  /**
   * Provide human input (external API).
   */
  respondHuman(choice: string, freeText?: string): void {
    if (this.pendingHuman) {
      this.pendingHuman.resolve({ choice, freeText });
      this.pendingHuman = null;
      this.instance.status = 'running';
    }
  }

  /**
   * Cancel the workflow.
   */
  cancel(): void {
    if (this.pendingHuman) {
      this.pendingHuman.reject(new Error('Workflow cancelled'));
      this.pendingHuman = null;
    }
    this.instance.status = 'cancelled';
    this.instance.completedAt = new Date();
    this.emit({ type: 'workflow:cancelled', instance: this.instance });
  }

  /**
   * Get current instance.
   */
  getInstance(): WorkflowInstance {
    return this.instance;
  }

  private emit(event: WorkflowEvent): void {
    this.options.onEvent?.(event);
  }

  private addHistoryStep(
    node: WorkflowNode,
    action: ExecutionStep['action'],
    output?: unknown,
    error?: string,
    durationMs?: number
  ): void {
    this.instance.history.push({
      id: crypto.randomUUID(),
      nodeId: node.id,
      nodeLabel: node.label,
      action,
      timestamp: new Date(),
      output,
      error,
      durationMs,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get a nested value from an object using dot notation.
 */
function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Evaluate a condition rule.
 */
function evaluateConditionRule(
  rule: { field: string; operator: string; value?: unknown; expression?: string },
  data: Record<string, unknown>
): boolean {
  const fieldValue = getNestedValue(data, rule.field);

  switch (rule.operator) {
    case 'equals':
      return fieldValue === rule.value;
    case 'not_equals':
      return fieldValue !== rule.value;
    case 'contains':
      return String(fieldValue).includes(String(rule.value));
    case 'not_contains':
      return !String(fieldValue).includes(String(rule.value));
    case 'greater_than':
      return Number(fieldValue) > Number(rule.value);
    case 'less_than':
      return Number(fieldValue) < Number(rule.value);
    case 'is_empty':
      return fieldValue === null || fieldValue === undefined || fieldValue === '';
    case 'is_not_empty':
      return fieldValue !== null && fieldValue !== undefined && fieldValue !== '';
    case 'matches_regex':
      return new RegExp(String(rule.value)).test(String(fieldValue));
    case 'custom':
      try {
        const fn = new Function('value', 'data', rule.expression ?? 'return true');
        return fn(fieldValue, data);
      } catch {
        return false;
      }
    default:
      return true;
  }
}

/**
 * Evaluate a JQ-style expression.
 * Supports basic path expressions:
 * - `.` - identity (return input as-is)
 * - `.foo` - get property 'foo'
 * - `.foo.bar` - nested property access
 * - `.foo[0]` - array index
 * - `.foo[]` - iterate array (returns array of results)
 * - `.foo | .bar` - pipe (apply second expression to result of first)
 * - `.foo, .bar` - multiple outputs (returns array)
 * - `select(.foo == "bar")` - filter
 * - `map(.foo)` - map over array
 * - `keys` - get object keys
 * - `values` - get object values
 * - `length` - get length of array/string/object
 */
function evaluateJqExpression(expression: string, data: unknown): unknown {
  const trimmed = expression.trim();

  // Identity
  if (trimmed === '.') {
    return data;
  }

  // Pipe operator - process left side, then apply right side to result
  if (trimmed.includes(' | ')) {
    const [left, ...rest] = trimmed.split(' | ');
    const intermediate = evaluateJqExpression(left!, data);
    return evaluateJqExpression(rest.join(' | '), intermediate);
  }

  // Multiple outputs (comma-separated)
  if (trimmed.includes(', ') && !trimmed.startsWith('select(') && !trimmed.startsWith('map(')) {
    const parts = trimmed.split(', ');
    return parts.map(part => evaluateJqExpression(part.trim(), data));
  }

  // Built-in functions
  if (trimmed === 'keys') {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return Object.keys(data);
    }
    return [];
  }

  if (trimmed === 'values') {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return Object.values(data);
    }
    return Array.isArray(data) ? data : [];
  }

  if (trimmed === 'length') {
    if (Array.isArray(data)) return data.length;
    if (typeof data === 'string') return data.length;
    if (data && typeof data === 'object') return Object.keys(data).length;
    return 0;
  }

  // select(condition) - filter
  const selectMatch = trimmed.match(/^select\((.+)\)$/);
  if (selectMatch) {
    const condition = selectMatch[1];
    if (Array.isArray(data)) {
      return data.filter(item => evaluateJqCondition(condition!, item));
    }
    return evaluateJqCondition(condition!, data) ? data : null;
  }

  // map(expression) - transform array
  const mapMatch = trimmed.match(/^map\((.+)\)$/);
  if (mapMatch) {
    const mapExpr = mapMatch[1];
    if (Array.isArray(data)) {
      return data.map(item => evaluateJqExpression(mapExpr!, item));
    }
    return evaluateJqExpression(mapExpr!, data);
  }

  // Path expression starting with .
  if (trimmed.startsWith('.')) {
    return evaluateJqPath(trimmed.substring(1), data);
  }

  // Literal values
  if (trimmed === 'null') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }

  // Unknown expression, return as-is
  return data;
}

/**
 * Evaluate a JQ path expression (without leading dot).
 */
function evaluateJqPath(path: string, data: unknown): unknown {
  if (!path || path === '') {
    return data;
  }

  // Handle array iteration: foo[]
  if (path.endsWith('[]')) {
    const basePath = path.slice(0, -2);
    const baseValue = basePath ? evaluateJqPath(basePath, data) : data;
    if (Array.isArray(baseValue)) {
      return baseValue;
    }
    return [baseValue];
  }

  // Handle array index: foo[0]
  const indexMatch = path.match(/^([^[]*)\[(\d+)\](.*)$/);
  if (indexMatch) {
    const [, basePath, indexStr, rest] = indexMatch;
    const baseValue = basePath ? evaluateJqPath(basePath, data) : data;
    const index = parseInt(indexStr!, 10);
    if (Array.isArray(baseValue) && index < baseValue.length) {
      const element = baseValue[index];
      return rest ? evaluateJqPath(rest.replace(/^\./, ''), element) : element;
    }
    return undefined;
  }

  // Handle property access: foo.bar
  const dotIndex = path.indexOf('.');
  const bracketIndex = path.indexOf('[');

  let propEnd: number;
  if (dotIndex === -1 && bracketIndex === -1) {
    propEnd = path.length;
  } else if (dotIndex === -1) {
    propEnd = bracketIndex;
  } else if (bracketIndex === -1) {
    propEnd = dotIndex;
  } else {
    propEnd = Math.min(dotIndex, bracketIndex);
  }

  const prop = path.substring(0, propEnd);
  const rest = path.substring(propEnd).replace(/^\./, '');

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const value = (data as Record<string, unknown>)[prop];
    return rest ? evaluateJqPath(rest, value) : value;
  }

  return undefined;
}

/**
 * Evaluate a simple JQ condition (for select).
 */
function evaluateJqCondition(condition: string, data: unknown): boolean {
  const trimmed = condition.trim();

  // Equality: .foo == "bar" or .foo == 123
  const eqMatch = trimmed.match(/^(.+?)\s*==\s*(.+)$/);
  if (eqMatch) {
    const left = evaluateJqExpression(eqMatch[1]!.trim(), data);
    const rightStr = eqMatch[2]!.trim();
    let right: unknown;
    if (rightStr.startsWith('"') && rightStr.endsWith('"')) {
      right = rightStr.slice(1, -1);
    } else if (rightStr === 'null') {
      right = null;
    } else if (rightStr === 'true') {
      right = true;
    } else if (rightStr === 'false') {
      right = false;
    } else {
      right = Number(rightStr);
    }
    return left === right;
  }

  // Inequality: .foo != "bar"
  const neqMatch = trimmed.match(/^(.+?)\s*!=\s*(.+)$/);
  if (neqMatch) {
    const left = evaluateJqExpression(neqMatch[1]!.trim(), data);
    const rightStr = neqMatch[2]!.trim();
    let right: unknown;
    if (rightStr.startsWith('"') && rightStr.endsWith('"')) {
      right = rightStr.slice(1, -1);
    } else {
      right = Number(rightStr);
    }
    return left !== right;
  }

  // Greater than: .foo > 5
  const gtMatch = trimmed.match(/^(.+?)\s*>\s*(.+)$/);
  if (gtMatch) {
    const left = Number(evaluateJqExpression(gtMatch[1]!.trim(), data));
    const right = Number(gtMatch[2]!.trim());
    return left > right;
  }

  // Less than: .foo < 5
  const ltMatch = trimmed.match(/^(.+?)\s*<\s*(.+)$/);
  if (ltMatch) {
    const left = Number(evaluateJqExpression(ltMatch[1]!.trim(), data));
    const right = Number(ltMatch[2]!.trim());
    return left < right;
  }

  // Truthy check: just .foo means check if truthy
  const value = evaluateJqExpression(trimmed, data);
  return Boolean(value);
}
