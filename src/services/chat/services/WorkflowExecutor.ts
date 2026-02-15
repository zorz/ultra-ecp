/**
 * WorkflowExecutor - Workflow Execution Orchestrator
 *
 * Coordinates workflow execution by managing the execution lifecycle,
 * delegating to specialized services, and handling node execution.
 */

import { Database } from 'bun:sqlite';
import { WorkflowService } from './WorkflowService.ts';
import { WorkflowExecutionService } from './WorkflowExecutionService.ts';
import { ContextItemService } from './ContextItemService.ts';
import { CheckpointService } from './CheckpointService.ts';
import { FeedbackQueueService } from './FeedbackQueueService.ts';
import { WorkflowPermissionService } from './WorkflowPermissionService.ts';
import { ExecutionMessageService } from './ExecutionMessageService.ts';
import { AgentService } from './AgentService.ts';
import { WorkflowToolCallService } from './WorkflowToolCallService.ts';
import { ReviewPanelService } from './ReviewPanelService.ts';
import { debugLog } from '../../../debug.ts';
import type {
  Workflow,
  WorkflowExecution,
  NodeExecution,
  ContextItem,
  Checkpoint,
  WorkflowStep,
  Agent,
} from '../types/workflow-schema.ts';
import type {
  ReviewPanelConfig,
  ReviewerConfig,
  PanelOutcome,
  ReviewVote,
  ReviewPanelStep,
  AggregationSummary,
  VotingThresholds,
} from '../types/review-panel.ts';

/**
 * Node execution context passed to node handlers.
 */
export interface NodeContext {
  execution: WorkflowExecution;
  workflow: Workflow;
  node: WorkflowStep;
  nodeExecution: NodeExecution;
  input: unknown;
  contextItems: ContextItem[];
}

/**
 * Result from executing a node.
 */
export interface NodeResult {
  /** Output from the node */
  output: unknown;
  /** Next node to execute (null = workflow complete) */
  nextNodeId: string | null;
  /** Whether execution should pause (e.g., for checkpoint) */
  shouldPause: boolean;
  /** Tokens used */
  tokensIn?: number;
  tokensOut?: number;
}

/**
 * Options for starting execution.
 */
export interface StartExecutionOptions {
  workflowId: string;
  input?: unknown;
  chatSessionId?: string;
  maxIterations?: number;
}

/**
 * Execution step result.
 */
export interface ExecutionStepResult {
  execution: WorkflowExecution;
  nodeExecution?: NodeExecution;
  checkpoint?: Checkpoint;
  completed: boolean;
  paused: boolean;
  error?: string;
}

/**
 * AI execution request for workflow nodes.
 */
export interface AIExecutionRequest {
  /** Agent ID to use for execution */
  agentId: string;
  /** Prompt/message to send to the AI */
  prompt: string;
  /** System prompt override (optional) */
  systemPrompt?: string;
  /** Context from previous steps */
  context?: string;
  /** Execution metadata */
  metadata?: {
    workflowId: string;
    executionId: string;
    nodeId: string;
  };
}

/**
 * AI execution response from workflow nodes.
 */
export interface AIExecutionResponse {
  /** Content from the AI */
  content: string;
  /** Token usage */
  tokensIn?: number;
  tokensOut?: number;
  /** Agent that responded */
  agentId?: string;
  agentName?: string;
  /** Handoff request from DelegateToAgent tool */
  handoff?: {
    targetAgentId: string;
    targetAgentName: string;
    message: string;
    context?: string;
  };
}

/**
 * Streaming callback for workflow AI execution.
 * Events:
 * - 'delta': New text content from the current iteration
 * - 'tool_use': AI is calling a tool (iteration boundary)
 * - 'iteration': A new iteration is starting after tool execution
 * - 'complete': AI has finished (final iteration)
 * - 'error': An error occurred
 * - 'permission_request': A tool needs user permission to execute
 */
export type WorkflowStreamCallback = (event: {
  type: 'delta' | 'tool_use' | 'iteration' | 'complete' | 'error' | 'permission_request';
  delta?: string;
  content?: string;
  error?: string;
  /** Iteration number (1-based) */
  iteration?: number;
  /** Content from the completed iteration (for tool_use/complete events) */
  iterationContent?: string;
  /** Permission request fields (for permission_request events) */
  toolId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  description?: string;
  sessionId?: string;
}) => void;

/**
 * AI executor function type for workflow nodes.
 * This is called when a workflow node needs to execute an AI agent.
 * Optionally accepts a streaming callback for real-time updates.
 */
export type WorkflowAIExecutor = (
  request: AIExecutionRequest,
  onStream?: WorkflowStreamCallback
) => Promise<AIExecutionResponse>;

/**
 * Notification handler type for workflow events.
 */
export type WorkflowNotificationHandler = (method: string, params: unknown) => void;

/**
 * WorkflowExecutor orchestrates workflow execution.
 */
export class WorkflowExecutor {
  private workflowService: WorkflowService;
  private executionService: WorkflowExecutionService;
  private contextService: ContextItemService;
  private checkpointService: CheckpointService;
  private feedbackService: FeedbackQueueService;
  private permissionService: WorkflowPermissionService;
  private messageService: ExecutionMessageService;
  private agentService: AgentService;
  private toolCallService: WorkflowToolCallService;
  private reviewPanelService: ReviewPanelService;
  private aiExecutor: WorkflowAIExecutor | null = null;
  private notificationHandler: WorkflowNotificationHandler | null = null;

  /** Dynamic nodes created by agent handoffs (keyed by node ID) */
  private dynamicNodes: Map<string, WorkflowStep> = new Map();
  /** Handoff depth tracking per execution to prevent infinite delegation loops */
  private handoffDepths: Map<string, number> = new Map();
  /** Maximum handoff chain depth before breaking */
  private static MAX_HANDOFF_DEPTH = 5;

  constructor(db: Database) {
    this.workflowService = new WorkflowService(db);
    this.executionService = new WorkflowExecutionService(db);
    this.contextService = new ContextItemService(db);
    this.checkpointService = new CheckpointService(db);
    this.feedbackService = new FeedbackQueueService(db);
    this.permissionService = new WorkflowPermissionService(db);
    this.messageService = new ExecutionMessageService(db);
    this.agentService = new AgentService(db);
    this.toolCallService = new WorkflowToolCallService(db);
    this.reviewPanelService = new ReviewPanelService(db);
  }

  /**
   * Set the AI executor function.
   * This must be called before agent nodes can execute.
   */
  setAIExecutor(executor: WorkflowAIExecutor): void {
    this.aiExecutor = executor;
  }

  /**
   * Set the notification handler for real-time updates.
   */
  setNotificationHandler(handler: WorkflowNotificationHandler): void {
    this.notificationHandler = handler;
  }

  /**
   * Send a notification if handler is configured.
   */
  private notify(method: string, params: unknown): void {
    if (this.notificationHandler) {
      this.notificationHandler(method, params);
    } else {
      debugLog(`[WorkflowExecutor] WARNING: No notification handler for ${method}`);
    }
  }

  /**
   * Check if AI executor is configured.
   */
  hasAIExecutor(): boolean {
    return this.aiExecutor !== null;
  }

  /**
   * Get the agent service for agent management.
   */
  getAgentService(): AgentService {
    return this.agentService;
  }

  /**
   * Get an agent by ID.
   */
  getAgent(agentId: string): Agent | null {
    return this.agentService.getAgent(agentId);
  }

  /**
   * List agents with optional filtering.
   */
  listAgents(options?: {
    role?: string;
    includeSystem?: boolean;
    activeOnly?: boolean;
    limit?: number;
    offset?: number;
  }): Agent[] {
    return this.agentService.listAgents(options as import('./AgentService.ts').ListAgentsOptions | undefined);
  }

  /**
   * Start a new workflow execution.
   */
  async startExecution(options: StartExecutionOptions): Promise<WorkflowExecution> {
    const workflow = this.workflowService.getWorkflow(options.workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${options.workflowId}`);
    }

    // Create execution record
    const execution = this.executionService.startExecution({
      workflowId: options.workflowId,
      chatSessionId: options.chatSessionId,
      initialInput: options.input,
      maxIterations: options.maxIterations ?? workflow.definition?.max_iterations ?? 100,
    });

    // Add initial input as context item and execution message
    // Skip empty objects/null/undefined
    const hasInput = options.input !== undefined &&
      options.input !== null &&
      (typeof options.input !== 'object' || Object.keys(options.input as object).length > 0);

    if (hasInput) {
      const inputContent = typeof options.input === 'string' ? options.input : JSON.stringify(options.input);

      this.contextService.createContextItem({
        executionId: execution.id,
        itemType: 'user_input',
        role: 'user',
        content: inputContent,
      });

      // Create unified execution message for chat display
      this.messageService.createMessage({
        executionId: execution.id,
        role: 'user',
        content: inputContent,
      });
    }

    // Set status to running
    this.executionService.updateStatus(execution.id, 'running');

    // Notify execution started (activity logging)
    this.notify('workflow/activity', {
      type: 'execution_started',
      executionId: execution.id,
      workflowId: workflow.id,
      workflowName: workflow.name,
      timestamp: Date.now(),
    });

    return this.executionService.getExecution(execution.id)!;
  }

  /**
   * Execute the next step in a workflow.
   */
  async executeStep(executionId: string): Promise<ExecutionStepResult> {
    debugLog(`[WorkflowExecutor] executeStep called for ${executionId}`);

    const execution = this.executionService.getExecution(executionId);
    if (!execution) {
      throw new Error(`Execution not found: ${executionId}`);
    }
    debugLog(`[WorkflowExecutor] Execution status: ${execution.status}, currentNodeId: ${execution.currentNodeId}`);

    // Check if execution can proceed
    if (!this.canProceed(execution)) {
      debugLog(`[WorkflowExecutor] Cannot proceed - status: ${execution.status}`);
      return {
        execution,
        completed: execution.status === 'completed',
        paused: ['paused', 'awaiting_input'].includes(execution.status),
        error: execution.status === 'failed' ? execution.errorMessage ?? undefined : undefined,
      };
    }

    const workflow = this.workflowService.getWorkflow(execution.workflowId);
    if (!workflow || !workflow.definition) {
      debugLog(`[WorkflowExecutor] ERROR: Workflow or definition not found for ${execution.workflowId}`);
      this.executionService.failExecution(executionId, 'Workflow or definition not found');
      return {
        execution: this.executionService.getExecution(executionId)!,
        completed: false,
        paused: false,
        error: 'Workflow or definition not found',
      };
    }
    debugLog(`[WorkflowExecutor] Workflow found: ${workflow.name}, steps: ${workflow.definition.steps?.length ?? 0}`);

    // Determine next node to execute
    const nextNode = this.getNextNode(execution, workflow);
    debugLog(`[WorkflowExecutor] getNextNode returned: ${nextNode?.id ?? 'null'}`);
    if (!nextNode) {
      // Workflow complete
      debugLog(`[WorkflowExecutor] No next node - workflow complete`);
      this.executionService.completeExecution(executionId);
      this.cleanupExecution(executionId);
      return {
        execution: this.executionService.getExecution(executionId)!,
        completed: true,
        paused: false,
      };
    }

    // Check iteration limit
    if (this.executionService.hasReachedMaxIterations(executionId)) {
      this.executionService.failExecution(executionId, 'Max iterations reached');
      return {
        execution: this.executionService.getExecution(executionId)!,
        completed: false,
        paused: false,
        error: 'Max iterations reached',
      };
    }

    // Create node execution
    const nodeExecution = this.executionService.createNodeExecution({
      executionId,
      nodeId: nextNode.id,
      nodeType: nextNode.type ?? 'agent',
      iterationNumber: execution.iterationCount,
      input: this.buildNodeInput(execution, nextNode),
    });

    // Update current node
    this.executionService.setCurrentNode(executionId, nextNode.id);
    this.executionService.startNodeExecution(nodeExecution.id);
    debugLog(`[WorkflowExecutor] Starting node execution for ${nextNode.id} (type: ${nextNode.type ?? 'agent'})`);

    // Notify node started (activity logging)
    this.notify('workflow/activity', {
      type: 'node_started',
      executionId,
      nodeId: nextNode.id,
      nodeType: nextNode.type ?? 'agent',
      agentId: nodeExecution.agentId,
      agentName: nodeExecution.agentName,
      timestamp: Date.now(),
    });

    try {
      // Execute the node
      debugLog(`[WorkflowExecutor] Calling executeNode for ${nextNode.id}...`);
      const startTime = Date.now();
      const result = await this.executeNode({
        execution,
        workflow,
        node: nextNode,
        nodeExecution,
        input: nodeExecution.input,
        contextItems: this.contextService.getActiveContext(executionId),
      });
      debugLog(`[WorkflowExecutor] executeNode completed in ${Date.now() - startTime}ms, output length: ${JSON.stringify(result.output).length}`);

      // Complete node execution
      this.executionService.completeNodeExecution(nodeExecution.id, result.output, {
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
      });

      // Notify node completed (activity logging)
      this.notify('workflow/activity', {
        type: 'node_completed',
        executionId,
        nodeId: nextNode.id,
        nodeType: nextNode.type ?? 'agent',
        agentId: nodeExecution.agentId,
        agentName: nodeExecution.agentName,
        durationMs: Date.now() - startTime,
        timestamp: Date.now(),
      });

      // Handle pause request (e.g., checkpoint)
      if (result.shouldPause) {
        this.executionService.awaitInput(executionId);
        const checkpoint = this.checkpointService.getPendingCheckpoint(executionId);
        return {
          execution: this.executionService.getExecution(executionId)!,
          nodeExecution: this.executionService.getNodeExecution(nodeExecution.id)!,
          checkpoint: checkpoint ?? undefined,
          completed: false,
          paused: true,
        };
      }

      // Update for next step
      if (result.nextNodeId) {
        this.executionService.setCurrentNode(executionId, result.nextNodeId);
      } else {
        // No next node - workflow complete
        this.executionService.completeExecution(executionId, result.output);
        this.cleanupExecution(executionId);

        // Notify execution completed (activity logging)
        this.notify('workflow/activity', {
          type: 'execution_completed',
          executionId,
          workflowId: workflow.id,
          workflowName: workflow.name,
          status: 'completed',
          timestamp: Date.now(),
        });
      }

      return {
        execution: this.executionService.getExecution(executionId)!,
        nodeExecution: this.executionService.getNodeExecution(nodeExecution.id)!,
        completed: result.nextNodeId === null,
        paused: false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.executionService.failNodeExecution(nodeExecution.id, errorMessage);
      this.executionService.failExecution(executionId, errorMessage);
      this.cleanupExecution(executionId);

      // Notify execution failed (activity logging)
      this.notify('workflow/activity', {
        type: 'execution_failed',
        executionId,
        workflowId: workflow.id,
        workflowName: workflow.name,
        error: errorMessage,
        timestamp: Date.now(),
      });
      return {
        execution: this.executionService.getExecution(executionId)!,
        nodeExecution: this.executionService.getNodeExecution(nodeExecution.id)!,
        completed: false,
        paused: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Execute a single node.
   * This is the extension point for different node types.
   */
  async executeNode(context: NodeContext): Promise<NodeResult> {
    const { node } = context;
    const nodeType = node.type ?? 'agent';

    switch (nodeType) {
      case 'agent':
        return this.executeAgentNode(context);
      case 'router':
        return this.executeRouterNode(context);
      case 'checkpoint':
      case 'human':
        return this.executeCheckpointNode(context);
      case 'decision':
      case 'vote':
        return this.executeDecisionNode(context);
      case 'permission_gate':
        return this.executePermissionGateNode(context);
      case 'await_input':
        return this.executeAwaitInputNode(context);
      case 'review_panel':
        return this.executeReviewPanelNode(context);
      case 'trigger':
        return this.executeTriggerNode(context);
      case 'split':
        return this.executeSplitNode(context);
      case 'merge':
        return this.executeMergeNode(context);
      case 'loop':
        return this.executeLoopNode(context);
      case 'condition':
        return this.executeConditionNode(context);
      case 'transform':
        return this.executeTransformNode(context);
      case 'output':
        return this.executeOutputNode(context);
      default:
        throw new Error(`Unknown node type: ${nodeType}`);
    }
  }

  /**
   * Execute an agent node.
   * Calls the AI executor to get a response from the specified agent.
   * Supports streaming for real-time feedback.
   */
  private async executeAgentNode(context: NodeContext): Promise<NodeResult> {
    const { node, execution, workflow } = context;

    // Resolve agent from registry - fall back to workflow default or 'assistant'
    const requestedAgentId = node.agent || workflow.defaultAgentId || 'assistant';
    const agent = this.agentService.getAgent(requestedAgentId);

    // Use resolved agent or create fallback
    const agentId = agent?.id || requestedAgentId;
    const agentName = agent?.name || requestedAgentId;

    debugLog(`[WorkflowExecutor] Resolved agent: ${agentId} (requested: ${requestedAgentId}, found: ${!!agent})`);

    // Check if AI executor is available
    if (!this.aiExecutor) {
      debugLog(`[WorkflowExecutor] No AI executor configured for node ${node.id}`);
      this.contextService.createContextItem({
        executionId: execution.id,
        nodeExecutionId: context.nodeExecution.id,
        itemType: 'agent_output',
        role: 'assistant',
        content: `[Agent node ${node.id}: No AI executor configured]`,
        agentId,
        agentName,
      });

      return {
        output: { status: 'no_executor', error: 'No AI executor configured' },
        nextNodeId: this.findNextNode(context),
        shouldPause: false,
      };
    }

    // Build context from previous steps
    const previousContext = this.buildContextFromPreviousSteps(context);

    // Build the prompt for this node
    const prompt = this.buildAgentPrompt(node, previousContext);

    // Use agent's system prompt from registry, or build one from node/workflow
    const systemPrompt = agent?.systemPrompt || this.buildSystemPrompt(node, workflow, agent);

    debugLog(`[WorkflowExecutor] Executing agent node ${node.id} with agent ${agentId}`);

    // Create a placeholder message that we'll update with streaming content
    const message = this.messageService.createMessage({
      executionId: execution.id,
      role: 'agent',
      content: '', // Will be updated as content streams in
      agentId,
      agentName,
      nodeExecutionId: context.nodeExecution.id,
    });

    // Track current message for streaming updates
    // We create new messages for each iteration to separate thinking/tool-use from final response
    let currentMessage = message;
    let currentIterationContent = '';
    let currentIteration = 1;
    const iterationMessages: string[] = [message.id]; // Track all messages created

    debugLog(`[WorkflowExecutor] STREAMING: Created initial message ${message.id} for iteration ${currentIteration}`);

    // Notify that we're starting to stream
    this.notify('workflow/message/started', {
      executionId: execution.id,
      messageId: currentMessage.id,
      agentId,
      agentName,
      nodeId: node.id,
      iteration: currentIteration,
    });
    debugLog(`[WorkflowExecutor] STREAMING: Sent workflow/message/started for ${currentMessage.id}`);

    try {
      // Execute the AI call with streaming callback
      const response = await this.aiExecutor(
        {
          agentId,
          prompt,
          systemPrompt,
          context: previousContext,
          metadata: {
            workflowId: execution.workflowId,
            executionId: execution.id,
            nodeId: node.id,
          },
        },
        // Streaming callback - handles iteration boundaries
        (event) => {
          if (event.type === 'delta' && event.delta) {
            currentIterationContent += event.delta;
            // Send streaming notification for current iteration's message
            this.notify('workflow/message/delta', {
              executionId: execution.id,
              messageId: currentMessage.id,
              delta: event.delta,
              content: currentIterationContent,
              agentId,
              agentName,
              iteration: event.iteration,
            });
          } else if (event.type === 'tool_use') {
            debugLog(`[WorkflowExecutor] STREAMING: tool_use event, iteration ${event.iteration}, currentMessage=${currentMessage.id}, contentLen=${currentIterationContent.length}`);
            // Tool use - finalize current iteration's message (even if empty)
            // Update content and mark complete
            this.messageService.updateContent(currentMessage.id, currentIterationContent, true);
            this.notify('workflow/message/completed', {
              executionId: execution.id,
              messageId: currentMessage.id,
              content: currentIterationContent,
              agentId,
              agentName,
              iteration: event.iteration,
              isToolUseIteration: true,
            });
            debugLog(`[WorkflowExecutor] STREAMING: Sent workflow/message/completed for tool_use iteration, message ${currentMessage.id}`);
            // Notify about tool use
            this.notify('workflow/message/tool_use', {
              executionId: execution.id,
              messageId: currentMessage.id,
              iteration: event.iteration,
            });
          } else if (event.type === 'iteration') {
            debugLog(`[WorkflowExecutor] STREAMING: iteration event, new iteration ${event.iteration}, previous message=${currentMessage.id}`);
            // New iteration starting - create a new message
            currentIteration = event.iteration || currentIteration + 1;
            currentIterationContent = '';

            // Create new message for this iteration
            currentMessage = this.messageService.createMessage({
              executionId: execution.id,
              role: 'agent',
              content: '',
              agentId,
              agentName,
              nodeExecutionId: context.nodeExecution.id,
            });
            iterationMessages.push(currentMessage.id);
            debugLog(`[WorkflowExecutor] STREAMING: Created NEW message ${currentMessage.id} for iteration ${currentIteration}, total messages: ${iterationMessages.length}`);

            this.notify('workflow/message/started', {
              executionId: execution.id,
              messageId: currentMessage.id,
              agentId,
              agentName,
              nodeId: node.id,
              iteration: currentIteration,
            });
            debugLog(`[WorkflowExecutor] STREAMING: Sent workflow/message/started for new message ${currentMessage.id}`);
          } else if (event.type === 'complete') {
            debugLog(`[WorkflowExecutor] STREAMING: complete event, iteration ${event.iteration}, contentLen=${(event.iterationContent || event.content || '').length}`);
            // AI finished - just update currentIterationContent so the post-callback code has it
            // The actual message update and notification is handled after the callback returns
            if (event.iterationContent || event.content) {
              currentIterationContent = event.iterationContent || event.content || '';
            }
          }
        }
      );

      debugLog(`[WorkflowExecutor] STREAMING COMPLETE: Agent ${agentId} responded, iterationMessages=[${iterationMessages.join(', ')}]`);
      debugLog(`[WorkflowExecutor] STREAMING COMPLETE: response.content.length=${response.content.length}, currentMessage.id=${currentMessage.id}`);

      // Update final message with the response content and mark complete
      const updateResult = this.messageService.updateContent(currentMessage.id, response.content, true);
      debugLog(`[WorkflowExecutor] STREAMING COMPLETE: Updated message ${currentMessage.id}, success: ${updateResult}`);

      // Verify the update worked
      const updatedMessage = this.messageService.getMessage(currentMessage.id);
      debugLog(`[WorkflowExecutor] STREAMING COMPLETE: Verified message content length: ${updatedMessage?.content?.length ?? 0}`);

      // Log all iteration messages for debugging
      for (const msgId of iterationMessages) {
        const msg = this.messageService.getMessage(msgId);
        debugLog(`[WorkflowExecutor] STREAMING COMPLETE: Message ${msgId}: isComplete=${msg?.isComplete}, contentLen=${msg?.content?.length ?? 0}`);
      }

      // Notify completion of final message
      this.notify('workflow/message/completed', {
        executionId: execution.id,
        messageId: currentMessage.id,
        content: response.content,
        agentId,
        agentName,
        isFinalIteration: true,
      });

      // Store only the final response as context item (not intermediate thinking)
      this.contextService.createContextItem({
        executionId: execution.id,
        nodeExecutionId: context.nodeExecution.id,
        itemType: 'agent_output',
        role: 'assistant',
        content: response.content,
        agentId,
        agentName,
      });

      // Check for handoff request from DelegateToAgent tool
      if (response.handoff) {
        const { targetAgentId, targetAgentName, message: handoffMessage, context: handoffContext } = response.handoff;

        // Check handoff depth to prevent infinite delegation loops
        const depthKey = `${execution.id}`;
        const currentDepth = this.handoffDepths.get(depthKey) || 0;
        if (currentDepth >= WorkflowExecutor.MAX_HANDOFF_DEPTH) {
          debugLog(`[WorkflowExecutor] Handoff depth limit reached (${currentDepth}), not delegating to ${targetAgentId}`);
          // Continue normally without handoff
        } else {
          this.handoffDepths.set(depthKey, currentDepth + 1);

          // Create a dynamic workflow node for the target agent
          const dynamicNodeId = `handoff-${execution.id}-${Date.now()}-${targetAgentId}`;
          const dynamicNode: WorkflowStep = {
            id: dynamicNodeId,
            type: 'agent',
            agent: targetAgentId,
            prompt: handoffMessage,
            depends: [node.id],
          };
          this.dynamicNodes.set(dynamicNodeId, dynamicNode);

          // Add handoff context so the target agent receives it
          if (handoffContext) {
            this.contextService.createContextItem({
              executionId: execution.id,
              itemType: 'agent_output',
              role: 'assistant',
              content: `[Handoff context from ${agentName}]: ${handoffContext}`,
              agentId,
              agentName,
            });
          }

          // Notify about the handoff
          this.notify('workflow/activity', {
            type: 'agent_handoff',
            executionId: execution.id,
            sourceAgentId: agentId,
            sourceAgentName: agentName,
            targetAgentId,
            targetAgentName,
            message: handoffMessage,
            dynamicNodeId,
            timestamp: Date.now(),
          });

          debugLog(`[WorkflowExecutor] Agent handoff: ${agentName} → ${targetAgentName} (node: ${dynamicNodeId}, depth: ${currentDepth + 1})`);

          return {
            output: {
              status: 'handoff',
              content: response.content,
              agentId: response.agentId,
              handoff: { targetAgentId, targetAgentName, message: handoffMessage },
            },
            nextNodeId: dynamicNodeId,
            shouldPause: false,
            tokensIn: response.tokensIn,
            tokensOut: response.tokensOut,
          };
        }
      }

      // Find next node
      const nextNodeId = this.findNextNode(context);

      return {
        output: {
          status: 'completed',
          content: response.content,
          agentId: response.agentId,
        },
        nextNodeId,
        shouldPause: false,
        tokensIn: response.tokensIn,
        tokensOut: response.tokensOut,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      debugLog(`[WorkflowExecutor] Agent execution failed for ${node.id}: ${errorMessage}`);

      // Update message with error
      this.messageService.updateContent(message.id, `[Error: ${errorMessage}]`, true);

      // Notify error
      this.notify('workflow/message/error', {
        executionId: execution.id,
        messageId: message.id,
        error: errorMessage,
        agentId,
        agentName,
      });

      // Store error as context item
      this.contextService.createContextItem({
        executionId: execution.id,
        nodeExecutionId: context.nodeExecution.id,
        itemType: 'agent_output',
        role: 'assistant',
        content: `[Error executing agent ${agentId}: ${errorMessage}]`,
        agentId,
        agentName,
      });

      throw error;
    }
  }

  /**
   * Build context string from previous workflow steps.
   */
  private buildContextFromPreviousSteps(context: NodeContext): string {
    const contextItems = context.contextItems;
    if (!contextItems || contextItems.length === 0) {
      return '';
    }

    // Build a summary of previous agent outputs
    const parts: string[] = [];
    for (const item of contextItems) {
      if (item.itemType === 'agent_output' && item.content) {
        const agentLabel = item.agentName || item.agentId || 'Agent';
        parts.push(`### ${agentLabel}'s Output:\n${item.content}`);
      } else if (item.itemType === 'user_input' && item.content) {
        parts.push(`### User Input:\n${item.content}`);
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Build the prompt for an agent node.
   */
  private buildAgentPrompt(node: WorkflowStep, previousContext: string): string {
    const parts: string[] = [];

    // Add previous context if available
    if (previousContext) {
      parts.push('## Previous Context\n');
      parts.push(previousContext);
      parts.push('\n---\n');
    }

    // Add the node's prompt
    if (node.prompt) {
      parts.push('## Your Task\n');
      parts.push(node.prompt);
    }

    return parts.join('\n');
  }

  /**
   * Build system prompt for an agent node.
   * Uses agent registry system prompt if available, otherwise builds from context.
   */
  private buildSystemPrompt(node: WorkflowStep, workflow: Workflow, agent?: Agent | null): string {
    const parts: string[] = [];

    // Use agent's display name from registry if available
    const agentDisplayName = agent?.name || node.agent || 'Agent';

    parts.push(`You are the "${agentDisplayName}" agent in the "${workflow.name}" workflow.`);

    if (workflow.description) {
      parts.push(`\nWorkflow Description: ${workflow.description}`);
    }

    // Add role-specific instructions based on agent's role from registry or node action
    const agentRole = agent?.role;
    if (agentRole === 'reviewer') {
      parts.push('\nYour role is to REVIEW work. Be thorough and critical.');
      parts.push('Point out any issues, bugs, or improvements needed.');
    } else if (agentRole === 'specialist') {
      parts.push('\nYour role is to provide specialized expertise.');
    } else if (agentRole === 'orchestrator') {
      parts.push('\nYour role is to coordinate and plan tasks.');
    } else {
      // Fall back to node action
      switch (node.action) {
        case 'review':
          parts.push('\nYour role is to REVIEW the work of previous agents. Be thorough and critical.');
          parts.push('Point out any issues, bugs, or improvements needed.');
          break;
        case 'implement':
          parts.push('\nYour role is to IMPLEMENT code or solutions based on the requirements.');
          parts.push('Write clean, well-structured code with appropriate comments.');
          break;
        case 'analyze':
          parts.push('\nYour role is to ANALYZE the input and provide insights.');
          break;
        case 'summarize':
          parts.push('\nYour role is to SUMMARIZE the outputs from previous agents.');
          break;
      }
    }

    return parts.join('\n');
  }

  /**
   * Execute a router node.
   */
  private async executeRouterNode(context: NodeContext): Promise<NodeResult> {
    // Router logic - determine which agent/node to route to
    // For now, just proceed to next node
    const nextNodeId = this.findNextNode(context);

    return {
      output: { routed: true },
      nextNodeId,
      shouldPause: false,
    };
  }

  /**
   * Execute a checkpoint node.
   */
  private async executeCheckpointNode(context: NodeContext): Promise<NodeResult> {
    const { node, execution, nodeExecution } = context;

    // Create checkpoint
    this.checkpointService.createCheckpoint({
      executionId: execution.id,
      nodeExecutionId: nodeExecution.id,
      checkpointType: 'confirmation',
      promptMessage: node.checkpointMessage ?? node.prompt ?? 'Please confirm to continue',
      options: ['approve', 'reject'],
    });

    return {
      output: { checkpointCreated: true },
      nextNodeId: context.node.id, // Stay on this node until resolved
      shouldPause: true,
    };
  }

  /**
   * Execute a decision node.
   * Parses votes from previous agent outputs and determines the next action.
   */
  private async executeDecisionNode(context: NodeContext): Promise<NodeResult> {
    const { workflow, execution } = context;

    // Get all context items that are agent outputs from dependent steps
    const dependentOutputs = context.contextItems.filter(
      (item) => item.itemType === 'agent_output' && item.content
    );

    // Parse votes from reviewer outputs
    // Expected format: "VOTE: [critical|queue|approve]"
    const votes: Array<{ agentId: string; vote: string; feedback: string }> = [];

    for (const output of dependentOutputs) {
      const content = output.content || '';
      const voteMatch = content.match(/VOTE:\s*(critical|queue|approve)/i);
      const feedbackMatch = content.match(/FEEDBACK:\s*([\s\S]*?)(?=$|\n##|\nVOTE:)/i);

      if (voteMatch && voteMatch[1]) {
        votes.push({
          agentId: output.agentId || 'unknown',
          vote: voteMatch[1].toLowerCase(),
          feedback: feedbackMatch?.[1]?.trim() || '',
        });
      }
    }

    debugLog(`[WorkflowExecutor] Decision node parsed ${votes.length} votes: ${votes.map(v => `${v.agentId}: ${v.vote}`).join(', ')}`);

    // If no votes found, default to approve (workflow may not be a review workflow)
    if (votes.length === 0) {
      debugLog('[WorkflowExecutor] No votes found, defaulting to approve');
      return {
        output: { decision: 'approve', votes: [], reason: 'No votes found' },
        nextNodeId: this.findNextNode(context),
        shouldPause: false,
      };
    }

    // Count votes
    const criticalCount = votes.filter(v => v.vote === 'critical').length;
    const queueCount = votes.filter(v => v.vote === 'queue').length;
    const approveCount = votes.filter(v => v.vote === 'approve').length;
    const totalVotes = votes.length;

    // Decision logic from CCA config:
    // - 100% critical → escalate to arbiter (checkpoint)
    // - ≥50% critical → address_immediately (return to coder, but for now continue)
    // - any queue → queue_feedback (continue but remember)
    // - all approve → approve (proceed)

    let decision: string;
    let shouldPause = false;

    if (criticalCount === totalVotes && criticalCount > 0) {
      // All critical - escalate to arbiter
      decision = 'escalate';
      shouldPause = true;
      debugLog('[WorkflowExecutor] All votes critical - escalating to arbiter');
    } else if (criticalCount >= totalVotes * 0.5) {
      // ≥50% critical - address immediately
      decision = 'address_critical';
      debugLog('[WorkflowExecutor] ≥50% critical - should address issues');
    } else if (queueCount > 0) {
      // Some queue - continue but note feedback
      decision = 'queue_feedback';
      debugLog('[WorkflowExecutor] Some queue votes - proceeding with queued feedback');
    } else {
      // All approve
      decision = 'approve';
      debugLog('[WorkflowExecutor] All approved - proceeding');
    }

    // Create a system message summarizing the decision
    const decisionSummary = `## Review Decision: ${decision.toUpperCase()}\n\n` +
      `**Votes:** ${approveCount} approve, ${queueCount} queue, ${criticalCount} critical\n\n` +
      votes.map(v => `- **${v.agentId}**: ${v.vote.toUpperCase()}${v.feedback ? `\n  ${v.feedback.substring(0, 200)}${v.feedback.length > 200 ? '...' : ''}` : ''}`).join('\n');

    this.messageService.createMessage({
      executionId: execution.id,
      role: 'system',
      content: decisionSummary,
    });

    // Route based on decision using workflow definition for dynamic node lookup
    // Find nodes by type/characteristics rather than hardcoded IDs
    const steps = workflow.definition?.steps || [];
    const checkpointNode = steps.find(s => s.type === 'checkpoint');
    const feedbackNode = steps.find(s => s.id === 'feedback_queue' || s.id?.includes('feedback'));
    const firstAgentNode = steps.find(s => s.type === 'agent' && (!s.depends || s.depends.length === 0));

    let nextNodeId: string | null;

    switch (decision) {
      case 'escalate':
        // Go to checkpoint node (arbiter)
        nextNodeId = checkpointNode?.id || null;
        shouldPause = !!checkpointNode;
        if (!checkpointNode) {
          debugLog('[WorkflowExecutor] No checkpoint node found for escalation');
        }
        break;
      case 'address_critical':
        // Go back to first agent (coder) with feedback
        // Increment iteration to allow re-running nodes
        this.executionService.incrementIteration(execution.id);
        debugLog(`[WorkflowExecutor] Incremented iteration for address_critical loop`);
        nextNodeId = firstAgentNode?.id || null;
        if (!firstAgentNode) {
          debugLog('[WorkflowExecutor] No first agent node found for iteration');
        }
        break;
      case 'queue_feedback':
        // Go to feedback node to surface feedback
        nextNodeId = feedbackNode?.id || null;
        if (!feedbackNode) {
          debugLog('[WorkflowExecutor] No feedback node found, completing workflow');
        }
        break;
      case 'approve':
      default:
        // All approved - workflow complete
        nextNodeId = null;
        break;
    }

    debugLog(`[WorkflowExecutor] Decision routing: ${decision} → ${nextNodeId ?? 'complete'}`);

    return {
      output: {
        decision,
        votes,
        summary: { critical: criticalCount, queue: queueCount, approve: approveCount },
      },
      nextNodeId,
      shouldPause,
    };
  }

  /**
   * Execute a permission gate node.
   */
  private async executePermissionGateNode(context: NodeContext): Promise<NodeResult> {
    // Check permissions
    // For now, just proceed
    const nextNodeId = this.findNextNode(context);

    return {
      output: { permissionGranted: true },
      nextNodeId,
      shouldPause: false,
    };
  }

  /**
   * Execute an await_input node.
   * This pauses execution waiting for user input.
   * When the user sends a message via workflow/message/send, execution resumes.
   * This enables multi-turn conversation workflows.
   */
  private async executeAwaitInputNode(context: NodeContext): Promise<NodeResult> {
    const { node, execution } = context;

    // Create a system message indicating we're waiting for input
    const promptMessage = node.prompt || 'Waiting for your input...';

    this.messageService.createMessage({
      executionId: execution.id,
      role: 'system',
      content: promptMessage,
    });

    // Notify that we're awaiting input
    this.notify('workflow/awaiting_input', {
      executionId: execution.id,
      nodeId: node.id,
      prompt: promptMessage,
    });

    debugLog(`[WorkflowExecutor] await_input node ${node.id}: pausing for user input`);

    // The node completes and execution pauses
    // When user sends a message via workflow/message/send:
    // 1. resumeAfterInput() is called
    // 2. It increments the iteration counter
    // 3. It sets currentNodeId to the first node
    // 4. Execution loop resumes from the first node
    //
    // This creates the conversation loop where each user message
    // triggers a new iteration of the workflow.
    return {
      output: { awaiting: true, prompt: promptMessage },
      nextNodeId: null, // Workflow is "complete" for this iteration
      shouldPause: true, // But pause and wait for user input
    };
  }

  /**
   * Execute a trigger node.
   * Trigger nodes are entry points - they just pass through input.
   */
  private async executeTriggerNode(context: NodeContext): Promise<NodeResult> {
    const nextNodeId = this.findNextNode(context);
    return {
      output: context.input,
      nextNodeId,
      shouldPause: false,
    };
  }

  /**
   * Execute a split node.
   * Split nodes prepare data for parallel execution.
   * The actual parallel execution is handled by the orchestration layer.
   */
  private async executeSplitNode(context: NodeContext): Promise<NodeResult> {
    const { node, execution } = context;

    debugLog(`[WorkflowExecutor] split node ${node.id}: preparing parallel branches`);

    // Notify that we're splitting
    this.notify('workflow/split/started', {
      executionId: execution.id,
      nodeId: node.id,
      parallelLimit: node.parallelLimit ?? 0,
    });

    // Output goes to all connected branches - findNextNode will handle them
    const nextNodeId = this.findNextNode(context);

    return {
      output: context.input,
      nextNodeId,
      shouldPause: false,
    };
  }

  /**
   * Execute a merge node.
   * Merge nodes combine inputs from multiple branches.
   */
  private async executeMergeNode(context: NodeContext): Promise<NodeResult> {
    const { node, execution } = context;
    const strategy = node.mergeStrategy ?? 'wait_all';

    debugLog(`[WorkflowExecutor] merge node ${node.id}: strategy=${strategy}`);

    // Gather inputs from all dependency nodes
    const deps = node.depends ?? [];
    const nodeExecutions = this.executionService.listNodeExecutions(execution.id);
    const completedDeps = nodeExecutions.filter(
      (ne) => deps.includes(ne.nodeId) && ne.status === 'completed'
    );

    // Combine outputs based on strategy
    let mergedOutput: unknown;

    if (strategy === 'wait_any') {
      // Take the first completed dependency's output
      mergedOutput = completedDeps[0]?.output ?? context.input;
    } else {
      // wait_all: combine all outputs into an object
      const outputs: Record<string, unknown> = {};
      for (const ne of completedDeps) {
        outputs[ne.nodeId] = ne.output;
      }
      mergedOutput = outputs;
    }

    this.notify('workflow/merge/completed', {
      executionId: execution.id,
      nodeId: node.id,
      strategy,
      branchCount: completedDeps.length,
    });

    const nextNodeId = this.findNextNode(context);

    return {
      output: mergedOutput,
      nextNodeId,
      shouldPause: false,
    };
  }

  /**
   * Execute a loop node.
   * Loop nodes handle iteration (for_each, while, times).
   */
  private async executeLoopNode(context: NodeContext): Promise<NodeResult> {
    const { node, execution } = context;
    const loopType = node.loopType ?? 'for_each';
    const maxIterations = node.loopMaxIterations ?? 100;

    debugLog(`[WorkflowExecutor] loop node ${node.id}: type=${loopType}`);

    // Get loop state
    const loopState = this.getLoopState(execution.id, node.id);

    switch (loopType) {
      case 'for_each': {
        // Get array to iterate over
        const input = context.input as Record<string, unknown>;
        const arrayField = node.loopArrayField ?? 'items';
        const items = Array.isArray(input[arrayField]) ? input[arrayField] : [input];

        if (loopState.currentIndex >= items.length || loopState.currentIndex >= maxIterations) {
          // Loop complete
          return {
            output: { done: true, iterations: loopState.currentIndex, items },
            nextNodeId: this.findNextNode(context),
            shouldPause: false,
          };
        }

        // Continue loop - return current item
        return {
          output: {
            continue: true,
            currentIndex: loopState.currentIndex,
            currentItem: items[loopState.currentIndex],
            totalItems: items.length,
          },
          nextNodeId: this.findNextNode(context),
          shouldPause: false,
        };
      }

      case 'times': {
        const count = node.loopMaxIterations ?? 1;
        if (loopState.currentIndex >= count || loopState.currentIndex >= maxIterations) {
          return {
            output: { done: true, iterations: loopState.currentIndex },
            nextNodeId: this.findNextNode(context),
            shouldPause: false,
          };
        }

        return {
          output: {
            continue: true,
            currentIndex: loopState.currentIndex,
            totalIterations: count,
          },
          nextNodeId: this.findNextNode(context),
          shouldPause: false,
        };
      }

      case 'while': {
        // While loops continue until a condition is false
        // For now, just check iteration count
        if (loopState.currentIndex >= maxIterations) {
          return {
            output: { done: true, reason: 'max_iterations', iterations: loopState.currentIndex },
            nextNodeId: this.findNextNode(context),
            shouldPause: false,
          };
        }

        return {
          output: {
            continue: true,
            currentIndex: loopState.currentIndex,
            input: context.input,
          },
          nextNodeId: this.findNextNode(context),
          shouldPause: false,
        };
      }

      default:
        return {
          output: context.input,
          nextNodeId: this.findNextNode(context),
          shouldPause: false,
        };
    }
  }

  /**
   * Execute a condition node.
   * Condition nodes evaluate expressions and route to different branches.
   */
  private async executeConditionNode(context: NodeContext): Promise<NodeResult> {
    const { node, workflow } = context;

    debugLog(`[WorkflowExecutor] condition node ${node.id}`);

    // Simple condition evaluation based on input
    // In a full implementation, this would evaluate expressions
    const input = context.input as Record<string, unknown>;
    const conditionMet = !!input && Object.keys(input).length > 0;

    // Find the appropriate next node based on condition
    // Convention: nodes depending on this with "true" or "false" in their id/config
    const steps = workflow.definition?.steps ?? [];
    const dependents = steps.filter((s) => s.depends?.includes(node.id));

    let nextNodeId: string | null = null;
    if (conditionMet) {
      // Look for a "true" branch
      nextNodeId = dependents.find((s) => s.id.includes('true'))?.id ?? dependents[0]?.id ?? null;
    } else {
      // Look for a "false" branch
      nextNodeId = dependents.find((s) => s.id.includes('false'))?.id ?? dependents[1]?.id ?? null;
    }

    return {
      output: { conditionMet, input },
      nextNodeId,
      shouldPause: false,
    };
  }

  /**
   * Execute a transform node.
   * Transform nodes modify/transform data without AI calls.
   */
  private async executeTransformNode(context: NodeContext): Promise<NodeResult> {
    const { node } = context;

    debugLog(`[WorkflowExecutor] transform node ${node.id}`);

    // Pass through input - in a full implementation, this would apply transformations
    const nextNodeId = this.findNextNode(context);

    return {
      output: context.input,
      nextNodeId,
      shouldPause: false,
    };
  }

  /**
   * Execute an output node.
   * Output nodes are terminal nodes that produce final results.
   */
  private async executeOutputNode(context: NodeContext): Promise<NodeResult> {
    const { node, execution } = context;

    debugLog(`[WorkflowExecutor] output node ${node.id}: workflow complete`);

    // Store final output as context
    const output = context.input;
    this.contextService.createContextItem({
      executionId: execution.id,
      nodeExecutionId: context.nodeExecution.id,
      itemType: 'agent_output',
      role: 'assistant',
      content: typeof output === 'string' ? output : JSON.stringify(output),
    });

    this.notify('workflow/output', {
      executionId: execution.id,
      nodeId: node.id,
      output,
    });

    // Output nodes are terminal - no next node
    return {
      output,
      nextNodeId: null,
      shouldPause: false,
    };
  }

  /**
   * Execute a review panel node.
   * Runs multiple reviewer agents, collects their votes, and determines outcome.
   *
   * Review Panel Configuration:
   * - reviewers: Array of agents to run as reviewers with optional weights
   * - voting.strategy: How to aggregate votes (weighted_threshold, unanimous, majority, etc.)
   * - voting.thresholds: Thresholds for approval, changes, critical blocking
   * - outcomes: Routing based on aggregated result
   *
   * @example
   * ```yaml
   * - id: reviews
   *   type: review_panel
   *   reviewers:
   *     - agent: security-reviewer
   *       weight: 3
   *     - agent: style-reviewer
   *       weight: 1
   *   voting:
   *     strategy: weighted_threshold
   *     thresholds:
   *       critical_blocks: true
   *       approve_threshold: 0.7
   *   outcomes:
   *     address_critical:
   *       action: loop
   *       target: coder
   *     approved:
   *       action: continue
   * ```
   */
  private async executeReviewPanelNode(context: NodeContext): Promise<NodeResult> {
    const { node, execution, nodeExecution } = context;

    // Build panel config from node definition
    const panelConfig = this.buildReviewPanelConfig(node);

    debugLog(`[WorkflowExecutor] review_panel ${node.id}: starting with ${panelConfig.reviewers.length} reviewers`);

    // Create panel execution record
    const panelExecution = this.reviewPanelService.createPanelExecution({
      nodeExecutionId: nodeExecution.id,
      executionId: execution.id,
      config: panelConfig,
    });

    // Start collecting votes
    this.reviewPanelService.startCollecting(panelExecution.id);

    // Build context from previous steps for reviewers
    const previousContext = this.buildContextFromPreviousSteps(context);

    // Get the review question/prompt from node config
    const reviewQuestion = node.reviewQuestion || node.prompt || 'Review the following content:';

    // Notify panel start (include context so UI can display what's being reviewed)
    this.notify('workflow/review_panel/started', {
      executionId: execution.id,
      nodeId: node.id,
      panelExecutionId: panelExecution.id,
      reviewerCount: panelConfig.reviewers.length,
      reviewQuestion,
      reviewContext: previousContext,
    });

    // Execute each reviewer
    const reviewPromises = panelConfig.reviewers.map(async (reviewerConfig) => {
      return this.executeReviewer(
        panelExecution.id,
        reviewerConfig,
        context,
        previousContext
      );
    });

    // Run reviewers (parallel or sequential based on config)
    if (panelConfig.parallel !== false) {
      // Parallel execution (default)
      await Promise.all(reviewPromises);
    } else {
      // Sequential execution
      for (const promise of reviewPromises) {
        await promise;
      }
    }

    // Aggregate votes and determine outcome
    const { outcome, summary } = this.reviewPanelService.aggregateVotes(panelExecution.id);

    debugLog(`[WorkflowExecutor] review_panel ${node.id}: outcome=${outcome}, reason=${summary.outcomeReason}`);

    // Create summary message
    this.messageService.createMessage({
      executionId: execution.id,
      role: 'system',
      content: this.formatPanelSummary(outcome, summary),
      nodeExecutionId: nodeExecution.id,
    });

    // Notify panel completion (include context for UI display and actions)
    this.notify('workflow/review_panel/completed', {
      executionId: execution.id,
      nodeId: node.id,
      panelExecutionId: panelExecution.id,
      outcome,
      summary,
      reviewQuestion,
      reviewContext: previousContext,
    });

    // Determine next node based on outcome
    const outcomeConfig = panelConfig.outcomes[outcome];
    let nextNodeId: string | null = null;
    let shouldPause = false;

    if (outcomeConfig) {
      switch (outcomeConfig.action) {
        case 'loop':
          // Loop back to specified target node
          if (outcomeConfig.target) {
            nextNodeId = outcomeConfig.target;
            // Increment iteration for loop
            this.executionService.incrementIteration(execution.id);
          }
          break;
        case 'continue':
          // Continue to specified target or find next based on dependencies
          nextNodeId = outcomeConfig.target || this.findNextNode(context);
          break;
        case 'pause':
          shouldPause = true;
          break;
        case 'complete':
          nextNodeId = null;
          break;
      }
    } else {
      // Default: find next node based on dependencies
      nextNodeId = this.findNextNode(context);
    }

    return {
      output: {
        panelExecutionId: panelExecution.id,
        outcome,
        summary,
        voteCount: panelConfig.reviewers.length,
      },
      nextNodeId,
      shouldPause,
    };
  }

  /**
   * Execute a single reviewer within a panel.
   */
  private async executeReviewer(
    panelExecutionId: string,
    reviewerConfig: ReviewerConfig,
    context: NodeContext,
    previousContext: string
  ): Promise<void> {
    const { execution, node } = context;
    const agentId = reviewerConfig.agent;
    const agent = this.agentService.getAgent(agentId);
    const weight = reviewerConfig.weight ?? 1;

    debugLog(`[WorkflowExecutor] review_panel: executing reviewer ${agentId} (weight: ${weight})`);

    // Build reviewer prompt
    const reviewPrompt = this.buildReviewerPrompt(reviewerConfig, previousContext);
    const systemPrompt = agent?.systemPrompt || this.buildDefaultReviewerSystemPrompt(agentId);

    // Check if AI executor is available
    if (!this.aiExecutor) {
      // Record abstain vote if no executor
      this.reviewPanelService.addVote({
        panelExecutionId,
        reviewerId: agentId,
        vote: 'abstain',
        feedback: 'No AI executor configured',
        weight,
      });
      return;
    }

    try {
      // Execute the reviewer
      const response = await this.aiExecutor(
        {
          agentId,
          prompt: reviewPrompt,
          systemPrompt,
          metadata: {
            workflowId: context.workflow.id,
            executionId: execution.id,
            nodeId: node.id,
          },
        },
        // Simple streaming handler - just accumulate for now
        () => {}
      );

      // Parse the reviewer response
      const parsed = this.reviewPanelService.parseReviewerResponse(response.content);

      // Record the vote
      this.reviewPanelService.addVote({
        panelExecutionId,
        reviewerId: agentId,
        vote: parsed.vote || 'abstain',
        feedback: parsed.feedback || response.content,
        issues: parsed.issues,
        weight,
      });

      // Create message for the reviewer's response
      this.messageService.createMessage({
        executionId: execution.id,
        role: 'agent',
        content: response.content,
        agentId,
        agentName: agent?.name || agentId,
      });

      // Notify vote received
      this.notify('workflow/review_panel/vote', {
        executionId: execution.id,
        panelExecutionId,
        reviewerId: agentId,
        vote: parsed.vote || 'abstain',
      });

    } catch (error) {
      debugLog(`[WorkflowExecutor] Reviewer ${agentId} failed: ${error}`);
      // Record abstain with error
      this.reviewPanelService.addVote({
        panelExecutionId,
        reviewerId: agentId,
        vote: 'abstain',
        feedback: `Error during review: ${error instanceof Error ? error.message : 'Unknown error'}`,
        weight,
      });
    }
  }

  /**
   * Build panel config from node definition.
   */
  private buildReviewPanelConfig(node: WorkflowStep): ReviewPanelConfig {
    // Cast to ReviewPanelStep for type-safe access to review panel properties
    const panelNode = node as ReviewPanelStep;

    // Get reviewers from node definition
    const reviewers: ReviewerConfig[] = panelNode.reviewers || [];

    // Default voting thresholds
    const defaultThresholds: VotingThresholds = {
      criticalBlocks: true,
      approveThreshold: 0.7,
      changesThreshold: 0.4,
    };

    // Default voting configuration
    const voting = panelNode.voting || {
      strategy: 'weighted_threshold' as const,
      thresholds: defaultThresholds,
    };

    // Default outcomes - sensible defaults that can be overridden
    const outcomes = panelNode.outcomes || {
      address_critical: { action: 'loop' as const },
      queue_changes: { action: 'continue' as const },
      approved: { action: 'continue' as const },
      escalate: { action: 'pause' as const },
    };

    return {
      reviewers,
      voting,
      outcomes,
      parallel: panelNode.parallel ?? true,
      timeout: panelNode.timeout,
    };
  }

  /**
   * Build prompt for a reviewer.
   */
  private buildReviewerPrompt(reviewerConfig: ReviewerConfig, previousContext: string): string {
    if (reviewerConfig.prompt) {
      return `${reviewerConfig.prompt}\n\n## Context\n${previousContext}`;
    }

    return `Please review the following code/changes and provide your assessment.

## Context
${previousContext}

## Response Format
Please respond with:
VOTE: critical|request_changes|approve|abstain
FEEDBACK: <your detailed feedback>

Vote meanings:
- critical: Major issues that must be fixed immediately (security vulnerabilities, crashes, data loss)
- request_changes: Issues that should be addressed (bugs, code quality, missing tests)
- approve: Code looks good for your area of expertise
- abstain: Outside your area of expertise or not enough context`;
  }

  /**
   * Build default system prompt for a reviewer.
   */
  private buildDefaultReviewerSystemPrompt(agentId: string): string {
    return `You are a code reviewer (${agentId}). Your job is to review code changes and provide constructive feedback.

Be thorough but fair. Focus on:
- Correctness: Does the code do what it's supposed to?
- Security: Are there any vulnerabilities?
- Performance: Are there obvious inefficiencies?
- Maintainability: Is the code readable and well-structured?

Always provide actionable feedback when requesting changes.`;
  }

  /**
   * Format the panel summary as a human-readable message.
   */
  private formatPanelSummary(outcome: PanelOutcome, summary: AggregationSummary): string {
    const outcomeLabels: Record<PanelOutcome, string> = {
      address_critical: 'Critical Issues Found',
      queue_changes: 'Changes Requested',
      approved: 'Approved',
      escalate: 'Needs Human Decision',
    };

    let message = `## Review Panel: ${outcomeLabels[outcome]}\n\n`;
    message += `**Reason:** ${summary.outcomeReason}\n\n`;
    message += `**Votes:** ${summary.approveWeight} approve, ${summary.changesWeight} changes, ${summary.criticalWeight} critical\n`;
    message += `**Approval:** ${(summary.approvalPercentage * 100).toFixed(0)}%\n`;

    if (summary.criticalIssues?.length > 0) {
      message += `\n### Critical Issues\n`;
      for (const issue of summary.criticalIssues) {
        message += `- ${issue.description}`;
        if (issue.file) message += ` (${issue.file}${issue.lines ? `:${issue.lines.start}` : ''})`;
        message += '\n';
      }
    }

    if (summary.otherIssues?.length > 0) {
      message += `\n### Other Issues\n`;
      for (const issue of summary.otherIssues.slice(0, 5)) {
        message += `- [${issue.severity}] ${issue.description}\n`;
      }
      if (summary.otherIssues.length > 5) {
        message += `- ... and ${summary.otherIssues.length - 5} more\n`;
      }
    }

    return message;
  }

  /**
   * Resume execution after user input (for await_input nodes).
   * Called when workflow/message/send is received while in awaiting_input state.
   *
   * For conversation loops, this increments the iteration and resets to the first node,
   * allowing the workflow to process the new user input from the beginning.
   */
  async resumeAfterInput(executionId: string): Promise<void> {
    const execution = this.executionService.getExecution(executionId);
    if (!execution) {
      throw new Error(`Execution not found: ${executionId}`);
    }

    if (execution.status !== 'awaiting_input' && execution.status !== 'paused') {
      debugLog(`[WorkflowExecutor] resumeAfterInput: execution ${executionId} not awaiting input (status: ${execution.status})`);
      return;
    }

    const workflow = this.workflowService.getWorkflow(execution.workflowId);
    if (!workflow?.definition?.steps || workflow.definition.steps.length === 0) {
      throw new Error(`Workflow or definition not found: ${execution.workflowId}`);
    }

    // For conversation loop: increment iteration and start from the first node
    // This allows the workflow to re-run with the new user input
    this.executionService.incrementIteration(executionId);

    // Set the current node to the first node in the workflow
    const firstNode = workflow.definition.steps[0];
    if (firstNode) {
      this.executionService.setCurrentNode(executionId, firstNode.id);
      debugLog(`[WorkflowExecutor] resumeAfterInput: starting new iteration from ${firstNode.id}`);
    }

    // Resume execution
    this.executionService.resumeExecution(executionId);
    debugLog(`[WorkflowExecutor] resumeAfterInput: resumed execution ${executionId}`);
  }

  /**
   * Resume execution after a checkpoint.
   */
  async resumeAfterCheckpoint(
    executionId: string,
    checkpointId: string,
    decision: string,
    feedback?: string
  ): Promise<ExecutionStepResult> {
    const execution = this.executionService.getExecution(executionId);
    if (!execution) {
      throw new Error(`Execution not found: ${executionId}`);
    }

    const workflow = this.workflowService.getWorkflow(execution.workflowId);
    if (!workflow) {
      throw new Error(`Workflow not found: ${execution.workflowId}`);
    }

    // Record decision
    this.checkpointService.recordDecision(checkpointId, decision, feedback);

    // Add feedback as context item and message if provided
    if (feedback) {
      this.contextService.createContextItem({
        executionId,
        itemType: 'feedback',
        role: 'user',
        content: feedback,
        feedbackStatus: 'pending',
      });

      // Create unified execution message for chat display
      this.messageService.createMessage({
        executionId,
        role: 'user',
        content: feedback,
      });
    }

    // Resume execution
    this.executionService.resumeExecution(executionId);

    // Increment iteration if appropriate
    if (decision === 'iterate' || decision === 'reject') {
      this.executionService.incrementIteration(executionId);
    }

    // Advance to next node after checkpoint (unless rejected/iterate which may loop back)
    if (decision === 'approved' || decision === 'approve') {
      // Find the current checkpoint node and advance to the next one
      const currentNode = workflow.definition?.steps?.find(
        (s) => s.id === execution.currentNodeId
      );
      if (currentNode) {
        const currentIndex = workflow.definition?.steps?.findIndex(
          (s) => s.id === currentNode.id
        ) ?? -1;
        const nextNode = workflow.definition?.steps?.[currentIndex + 1];
        if (nextNode) {
          this.executionService.setCurrentNode(executionId, nextNode.id);
        } else {
          // No more nodes - workflow complete
          this.executionService.completeExecution(executionId);
          return {
            execution: this.executionService.getExecution(executionId)!,
            completed: true,
            paused: false,
          };
        }
      }
    }

    // Continue execution
    return this.executeStep(executionId);
  }

  /**
   * Pause execution.
   */
  pauseExecution(executionId: string): boolean {
    return this.executionService.pauseExecution(executionId);
  }

  /**
   * Resume a paused execution.
   */
  resumeExecution(executionId: string): boolean {
    return this.executionService.resumeExecution(executionId);
  }

  /**
   * Cancel execution.
   */
  cancelExecution(executionId: string): boolean {
    return this.executionService.cancelExecution(executionId);
  }

  /**
   * Get execution status.
   */
  getExecution(executionId: string): WorkflowExecution | null {
    return this.executionService.getExecution(executionId);
  }

  /**
   * Get execution context items.
   */
  getContext(executionId: string): ContextItem[] {
    return this.contextService.getActiveContext(executionId);
  }

  /**
   * Clean up dynamic nodes and handoff state for a completed/failed execution.
   */
  cleanupExecution(executionId: string): void {
    // Remove dynamic nodes for this execution
    for (const [nodeId] of this.dynamicNodes) {
      if (nodeId.startsWith(`handoff-${executionId}-`)) {
        this.dynamicNodes.delete(nodeId);
      }
    }
    // Remove handoff depth tracking
    this.handoffDepths.delete(executionId);
  }

  /**
   * Check if execution can proceed.
   */
  private canProceed(execution: WorkflowExecution): boolean {
    return execution.status === 'running';
  }

  /**
   * Get the next node to execute.
   * currentNodeId represents the NEXT node to execute (set after previous node completes).
   */
  private getNextNode(execution: WorkflowExecution, workflow: Workflow): WorkflowStep | null {
    if (!workflow.definition?.steps || workflow.definition.steps.length === 0) {
      return null;
    }

    const currentIteration = execution.iterationCount;

    // Get all node executions and track what's completed in the current iteration
    const nodeExecutions = this.executionService.listNodeExecutions(execution.id);
    const completedInCurrentIteration = new Set<string>();
    const completedEver = new Set<string>();

    for (const ne of nodeExecutions) {
      if (ne.status === 'completed') {
        completedEver.add(ne.nodeId);
        if (ne.iterationNumber === currentIteration) {
          completedInCurrentIteration.add(ne.nodeId);
        }
      }
    }

    debugLog(`[WorkflowExecutor] getNextNode: iteration=${currentIteration}, completedInIteration=${[...completedInCurrentIteration].join(',')}, completedEver=${[...completedEver].join(',')}, currentNodeId=${execution.currentNodeId}`);

    // If currentNodeId is set and not yet completed IN THIS ITERATION, return it
    // This handles explicit routing (like decision node routing back to coder)
    if (execution.currentNodeId && !completedInCurrentIteration.has(execution.currentNodeId)) {
      const node = workflow.definition.steps.find((s) => s.id === execution.currentNodeId)
        || this.dynamicNodes.get(execution.currentNodeId);
      if (node) {
        debugLog(`[WorkflowExecutor] getNextNode: returning currentNodeId ${execution.currentNodeId} (not completed in iteration ${currentIteration})`);
        return node;
      }
    }

    // Find the first node whose dependencies are satisfied but hasn't been executed in this iteration
    for (const step of workflow.definition.steps) {
      // Skip nodes already completed in this iteration
      if (completedInCurrentIteration.has(step.id)) continue;

      // Check if all dependencies are satisfied
      const deps = step.depends || [];

      // If no dependencies, this is a root node
      if (deps.length === 0) {
        // Root nodes can run at the start of each iteration
        if (completedInCurrentIteration.size === 0) {
          debugLog(`[WorkflowExecutor] getNextNode: found root node ${step.id} for iteration ${currentIteration}`);
          return step;
        }
        // Otherwise skip root nodes that weren't executed yet this iteration
        continue;
      }

      // Check if all dependencies are satisfied (completed in current iteration)
      const allDepsSatisfied = deps.every((dep) => completedInCurrentIteration.has(dep));
      if (allDepsSatisfied) {
        debugLog(`[WorkflowExecutor] getNextNode: found node ${step.id} with satisfied deps [${deps.join(',')}]`);
        return step;
      }
    }

    // Also check dynamic nodes (created by handoffs) for this execution
    for (const [stepId, step] of this.dynamicNodes) {
      if (!stepId.startsWith(`handoff-${execution.id}-`)) continue;
      if (completedInCurrentIteration.has(stepId)) continue;

      const deps = step.depends || [];
      if (deps.length === 0) continue; // Dynamic nodes always have dependencies

      const allDepsSatisfied = deps.every((dep) => completedInCurrentIteration.has(dep));
      if (allDepsSatisfied) {
        debugLog(`[WorkflowExecutor] getNextNode: found dynamic handoff node ${stepId} with satisfied deps [${deps.join(',')}]`);
        return step;
      }
    }

    // No more nodes to execute in this iteration
    debugLog(`[WorkflowExecutor] getNextNode: no more nodes to execute in iteration ${currentIteration}`);
    return null;
  }

  /**
   * Find the next node based on dependencies.
   * Returns the first node whose dependencies have all been satisfied.
   * Checks both workflow definition steps and dynamic nodes (from handoffs).
   */
  private findNextNode(context: NodeContext): string | null {
    const { workflow, execution, node } = context;
    if (!workflow.definition?.steps) return null;

    // Get all completed node IDs (including the one that just finished)
    const completedNodeIds = new Set<string>();
    completedNodeIds.add(node.id); // Current node is now complete

    // Get completed nodes from the execution record
    const nodeExecutions = this.executionService.listNodeExecutions(execution.id);
    for (const ne of nodeExecutions) {
      if (ne.status === 'completed') {
        completedNodeIds.add(ne.nodeId);
      }
    }

    // Find all nodes whose dependencies are now satisfied (static steps)
    for (const step of workflow.definition.steps) {
      // Skip already completed nodes
      if (completedNodeIds.has(step.id)) continue;

      // Check if all dependencies are satisfied
      const deps = step.depends || [];
      const allDepsSatisfied = deps.every((dep) => completedNodeIds.has(dep));

      // If this node has dependencies and they're all satisfied, it's ready
      // If it has no dependencies but isn't the first node, it shouldn't run yet
      if (deps.length > 0 && allDepsSatisfied) {
        return step.id;
      }
    }

    // Also check dynamic nodes (created by handoffs)
    for (const [stepId, step] of this.dynamicNodes) {
      if (completedNodeIds.has(stepId)) continue;

      const deps = step.depends || [];
      const allDepsSatisfied = deps.length > 0 && deps.every((dep) => completedNodeIds.has(dep));
      if (allDepsSatisfied) {
        return stepId;
      }
    }

    // No more nodes with satisfied dependencies - workflow is complete
    return null;
  }

  /**
   * Find ALL nodes whose dependencies are satisfied.
   * Returns multiple nodes for parallel execution.
   */
  findAllReadyNodes(executionId: string): WorkflowStep[] {
    const execution = this.executionService.getExecution(executionId);
    if (!execution) return [];

    const workflow = this.workflowService.getWorkflow(execution.workflowId);
    if (!workflow?.definition?.steps) return [];

    // Get completed and in-progress node IDs
    const nodeExecutions = this.executionService.listNodeExecutions(executionId);
    const completedNodeIds = new Set<string>();
    const inProgressNodeIds = new Set<string>();

    for (const ne of nodeExecutions) {
      if (ne.status === 'completed') {
        completedNodeIds.add(ne.nodeId);
      } else if (ne.status === 'running' || ne.status === 'pending') {
        inProgressNodeIds.add(ne.nodeId);
      }
    }

    const readyNodes: WorkflowStep[] = [];

    for (const step of workflow.definition.steps) {
      // Skip completed or in-progress nodes
      if (completedNodeIds.has(step.id) || inProgressNodeIds.has(step.id)) continue;

      // Check if all dependencies are satisfied
      const deps = step.depends || [];

      // Root nodes (no deps) only run at start
      if (deps.length === 0 && completedNodeIds.size === 0 && inProgressNodeIds.size === 0) {
        readyNodes.push(step);
        continue;
      }

      // Special handling for merge nodes
      if (step.type === 'merge') {
        const isMergeReady = this.checkMergeReady(step, completedNodeIds, workflow);
        if (isMergeReady) {
          readyNodes.push(step);
        }
        continue;
      }

      // Regular nodes: all deps must be completed
      const allDepsSatisfied = deps.length > 0 && deps.every((dep) => completedNodeIds.has(dep));
      if (allDepsSatisfied) {
        readyNodes.push(step);
      }
    }

    return readyNodes;
  }

  /**
   * Check if a merge node is ready based on its wait strategy.
   */
  private checkMergeReady(
    mergeStep: WorkflowStep,
    completedNodeIds: Set<string>,
    workflow: Workflow
  ): boolean {
    const deps = mergeStep.depends || [];
    if (deps.length === 0) return false;

    // Get merge strategy from step config (default to wait_all)
    const strategy = (mergeStep as WorkflowStep & { mergeStrategy?: string }).mergeStrategy || 'wait_all';

    if (strategy === 'wait_any') {
      // Proceed when ANY dependency is complete
      return deps.some((dep) => completedNodeIds.has(dep));
    }

    // wait_all: all dependencies must be complete
    return deps.every((dep) => completedNodeIds.has(dep));
  }

  /**
   * Execute multiple nodes in parallel.
   * Returns when all nodes complete.
   */
  async executeParallel(executionId: string, nodeIds: string[]): Promise<ExecutionStepResult[]> {
    debugLog(`[WorkflowExecutor] executeParallel: executing ${nodeIds.length} nodes in parallel`);

    const promises = nodeIds.map((nodeId) => this.executeStepForNode(executionId, nodeId));
    const results = await Promise.all(promises);

    return results;
  }

  /**
   * Execute a specific node (for parallel execution).
   */
  private async executeStepForNode(executionId: string, nodeId: string): Promise<ExecutionStepResult> {
    const execution = this.executionService.getExecution(executionId);
    if (!execution) {
      throw new Error(`Execution not found: ${executionId}`);
    }

    const workflow = this.workflowService.getWorkflow(execution.workflowId);
    if (!workflow?.definition?.steps) {
      throw new Error('Workflow definition not found');
    }

    const node = workflow.definition.steps.find((s) => s.id === nodeId);
    if (!node) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    // Create node execution
    const nodeExecution = this.executionService.createNodeExecution({
      executionId,
      nodeId: node.id,
      nodeType: node.type ?? 'agent',
      iterationNumber: execution.iterationCount,
      input: this.buildNodeInput(execution, node),
    });

    this.executionService.startNodeExecution(nodeExecution.id);
    debugLog(`[WorkflowExecutor] executeStepForNode: starting ${nodeId}`);

    // Notify node started
    this.notify('workflow/activity', {
      type: 'node_started',
      executionId,
      nodeId: node.id,
      nodeType: node.type ?? 'agent',
      timestamp: Date.now(),
    });

    try {
      const result = await this.executeNode({
        execution,
        workflow,
        node,
        nodeExecution,
        input: nodeExecution.input,
        contextItems: this.contextService.getActiveContext(executionId),
      });

      this.executionService.completeNodeExecution(nodeExecution.id, result.output, {
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
      });

      // Notify node completed
      this.notify('workflow/activity', {
        type: 'node_completed',
        executionId,
        nodeId: node.id,
        timestamp: Date.now(),
      });

      return {
        execution: this.executionService.getExecution(executionId)!,
        nodeExecution: this.executionService.getNodeExecution(nodeExecution.id)!,
        completed: false,
        paused: result.shouldPause,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.executionService.failNodeExecution(nodeExecution.id, errorMessage);

      return {
        execution: this.executionService.getExecution(executionId)!,
        nodeExecution: this.executionService.getNodeExecution(nodeExecution.id)!,
        completed: false,
        paused: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Track loop iteration state.
   * Returns whether the loop should continue and the current item (for for_each).
   */
  getLoopState(executionId: string, loopNodeId: string): {
    shouldContinue: boolean;
    currentIndex: number;
    currentItem?: unknown;
    items?: unknown[];
  } {
    const execution = this.executionService.getExecution(executionId);
    if (!execution) return { shouldContinue: false, currentIndex: 0 };

    // Get loop node executions to track iteration
    const nodeExecutions = this.executionService.listNodeExecutions(executionId, {
      status: 'completed',
    });

    const loopExecutions = nodeExecutions.filter((ne) => ne.nodeId === loopNodeId);
    const currentIndex = loopExecutions.length;

    // Check if there's loop output with items
    const lastLoopExec = loopExecutions[loopExecutions.length - 1];
    if (lastLoopExec?.output) {
      const output = lastLoopExec.output as { items?: unknown[]; totalItems?: number; done?: boolean };
      if (output.items && Array.isArray(output.items)) {
        const shouldContinue = currentIndex < output.items.length && !output.done;
        return {
          shouldContinue,
          currentIndex,
          currentItem: output.items[currentIndex],
          items: output.items,
        };
      }
      if (output.done) {
        return { shouldContinue: false, currentIndex };
      }
    }

    return { shouldContinue: true, currentIndex };
  }

  /**
   * Build input for a node from context.
   */
  private buildNodeInput(execution: WorkflowExecution, node: WorkflowStep): unknown {
    // Get recent context items
    const contextItems = this.contextService.getActiveContext(execution.id);

    return {
      initialInput: execution.initialInput,
      recentContext: contextItems.slice(-10).map((item) => ({
        type: item.itemType,
        role: item.role,
        content: item.content,
        agentId: item.agentId,
      })),
      nodeConfig: {
        agent: node.agent,
        action: node.action,
        prompt: node.prompt,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Service Accessors
  // ─────────────────────────────────────────────────────────────────────────

  get workflows(): WorkflowService {
    return this.workflowService;
  }

  get executions(): WorkflowExecutionService {
    return this.executionService;
  }

  get context(): ContextItemService {
    return this.contextService;
  }

  get checkpoints(): CheckpointService {
    return this.checkpointService;
  }

  get feedback(): FeedbackQueueService {
    return this.feedbackService;
  }

  get permissions(): WorkflowPermissionService {
    return this.permissionService;
  }

  get messages(): ExecutionMessageService {
    return this.messageService;
  }

  get toolCalls(): WorkflowToolCallService {
    return this.toolCallService;
  }

  get reviewPanels(): ReviewPanelService {
    return this.reviewPanelService;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Debug & Diagnostics
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get detailed debug information about an execution.
   * Useful for troubleshooting workflow issues.
   */
  getDebugInfo(executionId: string): WorkflowDebugInfo | null {
    const execution = this.executionService.getExecution(executionId);
    if (!execution) return null;

    const workflow = this.workflowService.getWorkflow(execution.workflowId);
    const nodeExecutions = this.executionService.listNodeExecutions(executionId);
    const messages = this.messageService.listMessages(executionId);
    const contextItems = this.contextService.listContextItems(executionId);
    const toolCalls = this.toolCallService.listToolCalls(executionId);
    const feedbackItems = this.feedbackService.getQueuedFeedback(executionId);

    // Build node state map
    const nodeStates: Record<string, NodeDebugState> = {};
    for (const ne of nodeExecutions) {
      const existingState = nodeStates[ne.nodeId];
      if (!existingState || ne.iterationNumber > existingState.iterationNumber) {
        nodeStates[ne.nodeId] = {
          nodeId: ne.nodeId,
          nodeType: ne.nodeType,
          status: ne.status,
          iterationNumber: ne.iterationNumber,
          agentId: ne.agentId,
          agentName: ne.agentName,
          startedAt: ne.startedAt,
          completedAt: ne.completedAt,
          duration: ne.completedAt && ne.startedAt ? ne.completedAt - ne.startedAt : null,
          errorMessage: ne.status === 'failed' ? 'Node execution failed' : null,
          hasOutput: !!ne.output,
        };
      }
    }

    // Identify potential issues
    const issues: string[] = [];

    // Check for missing workflow
    if (!workflow) {
      issues.push(`Workflow not found: ${execution.workflowId}`);
    }

    // Check for stuck execution
    if (execution.status === 'running' && nodeExecutions.length === 0) {
      issues.push('Execution is running but no nodes have been executed');
    }

    // Check for failed nodes
    const failedNodes = nodeExecutions.filter((ne) => ne.status === 'failed');
    if (failedNodes.length > 0) {
      issues.push(`${failedNodes.length} node(s) failed: ${failedNodes.map((n) => n.nodeId).join(', ')}`);
    }

    // Check for missing agent
    if (workflow?.definition?.steps) {
      for (const step of workflow.definition.steps) {
        if (step.agent && !this.agentService.getAgent(step.agent)) {
          issues.push(`Agent not found: ${step.agent} (used in node: ${step.id})`);
        }
      }
    }

    // Check for max iterations reached
    if (execution.iterationCount >= (workflow?.definition?.max_iterations ?? 1000)) {
      issues.push(`Max iterations reached: ${execution.iterationCount}`);
    }

    return {
      execution: {
        id: execution.id,
        workflowId: execution.workflowId,
        status: execution.status,
        currentNodeId: execution.currentNodeId,
        iterationCount: execution.iterationCount,
        startedAt: execution.createdAt,
        completedAt: execution.completedAt,
        errorMessage: execution.errorMessage,
      },
      workflow: workflow ? {
        id: workflow.id,
        name: workflow.name,
        stepCount: workflow.definition?.steps?.length ?? 0,
        steps: workflow.definition?.steps?.map((s) => ({
          id: s.id,
          type: s.type ?? 'agent',
          agent: s.agent,
          depends: s.depends,
        })) ?? [],
        maxIterations: workflow.definition?.max_iterations ?? 1000,
      } : null,
      nodeStates,
      summary: {
        totalNodeExecutions: nodeExecutions.length,
        completedNodes: nodeExecutions.filter((ne) => ne.status === 'completed').length,
        failedNodes: failedNodes.length,
        runningNodes: nodeExecutions.filter((ne) => ne.status === 'running').length,
        pendingNodes: nodeExecutions.filter((ne) => ne.status === 'pending').length,
        totalMessages: messages.length,
        totalContextItems: contextItems.length,
        totalToolCalls: toolCalls.length,
        pendingFeedback: feedbackItems.filter((f) => f.status === 'queued' || f.status === 'pending_review').length,
      },
      issues,
      timestamp: Date.now(),
    };
  }
}

/**
 * Debug information about a workflow execution.
 */
export interface WorkflowDebugInfo {
  execution: {
    id: string;
    workflowId: string;
    status: string;
    currentNodeId: string | null;
    iterationCount: number;
    startedAt: number;
    completedAt: number | null;
    errorMessage: string | null;
  };
  workflow: {
    id: string;
    name: string;
    stepCount: number;
    steps: Array<{
      id: string;
      type: string;
      agent?: string;
      depends?: string[];
    }>;
    maxIterations: number;
  } | null;
  nodeStates: Record<string, NodeDebugState>;
  summary: {
    totalNodeExecutions: number;
    completedNodes: number;
    failedNodes: number;
    runningNodes: number;
    pendingNodes: number;
    totalMessages: number;
    totalContextItems: number;
    totalToolCalls: number;
    pendingFeedback: number;
  };
  issues: string[];
  timestamp: number;
}

export interface NodeDebugState {
  nodeId: string;
  nodeType: string;
  status: string;
  iterationNumber: number;
  agentId: string | null;
  agentName: string | null;
  startedAt: number | null;
  completedAt: number | null;
  duration: number | null;
  errorMessage: string | null;
  hasOutput: boolean;
}

/**
 * Create a new WorkflowExecutor instance.
 */
export function createWorkflowExecutor(db: Database): WorkflowExecutor {
  return new WorkflowExecutor(db);
}
