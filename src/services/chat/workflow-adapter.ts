/**
 * Workflow Service Adapter
 *
 * ECP adapter for workflow operations.
 * Provides routes for workflow CRUD, execution management, and real-time updates.
 */

import { type HandlerResult, ECPErrorCodes, type NotificationHandler } from '../../protocol/types.ts';
import { getChatDatabase, type ChatDatabase } from './database.ts';
import { WorkflowExecutor, type WorkflowAIExecutor } from './services/WorkflowExecutor.ts';
import { loadWorkflowsFromDirectory } from './config/workflow-loader.ts';
import { join } from 'node:path';
import { debugLog } from '../../debug.ts';
import {
  editorWorkflowToBackend,
  backendWorkflowToEditor,
  validateWorkflow,
  type EditorNode,
  type EditorWorkflow,
} from '../../workflows/nodes/conversion.ts';
import { type WorkflowDefinition as GraphWorkflowDefinition } from '../../workflows/nodes/types.ts';
import type {
  Workflow,
  WorkflowDefinition,
  WorkflowExecution,
  NodeExecution,
  ContextItem,
  Checkpoint,
  WorkflowTriggerType,
  ExecutionStatus,
  ExecutionMessageRole,
  ContextItemType,
  MessageRole,
  PermissionScope,
  FeedbackQueueStatus,
  ToolCallStatus,
  AgentRole,
  Agent,
} from './types/workflow-schema.ts';

/**
 * Workflow Service Adapter for ECP.
 */
export class WorkflowServiceAdapter {
  private workspacePath: string;
  private chatDb: ChatDatabase | null = null;
  private executor: WorkflowExecutor | null = null;
  private notificationHandler?: NotificationHandler;
  private pendingNotifications: Array<{ method: string; params: unknown }> = [];
  private initialized = false;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }

  /**
   * Set notification handler for real-time updates.
   * If called after init(), also wires up the WorkflowExecutor.
   */
  setNotificationHandler(handler: NotificationHandler): void {
    debugLog(`[WorkflowServiceAdapter] setNotificationHandler called, executor exists: ${!!this.executor}`);
    this.notificationHandler = handler;

    // Flush any notifications that were buffered before the handler was set
    if (this.pendingNotifications.length > 0) {
      debugLog(`[WorkflowServiceAdapter] Flushing ${this.pendingNotifications.length} buffered notifications`);
      for (const n of this.pendingNotifications) {
        this.sendNotification(n.method, n.params);
      }
      this.pendingNotifications = [];
    }

    // If executor already exists (init was called first), wire it up now
    if (this.executor) {
      this.executor.setNotificationHandler((method, params) => {
        this.sendNotification(method, params);
      });
      debugLog('[WorkflowServiceAdapter] Notification handler wired to executor (post-init)');
    }
  }

  /**
   * Set the AI executor for workflow agent nodes.
   * This must be called after init() to enable actual AI execution.
   */
  setAIExecutor(executor: WorkflowAIExecutor): void {
    if (this.executor) {
      this.executor.setAIExecutor(executor);
      debugLog('[WorkflowServiceAdapter] AI executor configured');
    } else {
      debugLog('[WorkflowServiceAdapter] Cannot set AI executor - WorkflowExecutor not initialized');
    }
  }

  /**
   * Get the WorkflowExecutor instance.
   */
  getExecutor(): WorkflowExecutor | null {
    return this.executor;
  }

  /**
   * Get the executor, throwing a typed error if not available.
   * All handler methods should use this instead of `this.exec`.
   */
  private get exec(): WorkflowExecutor {
    if (!this.executor) {
      throw new Error('Workflow executor not initialized');
    }
    return this.executor;
  }

  /**
   * Send a notification to connected clients.
   */
  private sendNotification(method: string, params: unknown): void {
    debugLog(`[WorkflowServiceAdapter] SENDING notification: ${method}`);
    if (this.notificationHandler) {
      this.notificationHandler({
        jsonrpc: '2.0',
        method,
        params,
      });
      debugLog(`[WorkflowServiceAdapter] Notification SENT via handler: ${method}`);
    } else {
      debugLog(`[WorkflowServiceAdapter] NO notification handler for: ${method}`);
    }
  }

  /**
   * Emit a permission request notification to the frontend.
   * This is called when a workflow AI execution needs user permission for a tool.
   */
  emitPermissionRequest(request: {
    toolId: string;
    toolName: string;
    input: Record<string, unknown>;
    description: string;
    sessionId: string;
    executionId?: string;
    nodeId?: string;
    workflowId?: string;
  }): void {
    debugLog(`[WorkflowServiceAdapter] Emitting permission request for tool: ${request.toolName}`);
    this.sendNotification('workflow/permission/request', {
      toolId: request.toolId,
      toolName: request.toolName,
      input: request.input,
      description: request.description,
      sessionId: request.sessionId,
      executionId: request.executionId,
      nodeId: request.nodeId,
      workflowId: request.workflowId,
      timestamp: Date.now(),
    });
  }

  // Track mapping from external toolId to internal database ID.
  // Bounded: entries are cleaned on completion, error, and cancel events.
  // A max-size cap evicts oldest entries to prevent unbounded growth.
  private toolIdMap = new Map<string, string>();
  private static readonly TOOL_ID_MAP_MAX_SIZE = 1000;

  // Track running execution loops to prevent concurrent loops on the same execution
  private runningLoops = new Set<string>();

  /**
   * Emit a tool execution event notification to the frontend.
   * This is called when a tool starts or completes execution (including auto-approved tools).
   * Also persists tool call records to the database for the Tools tab.
   */
  emitToolExecution(event: {
    type: 'started' | 'completed';
    toolId: string;
    toolName: string;
    input?: unknown;
    output?: unknown;
    success?: boolean;
    error?: string;
    autoApproved?: boolean;
    approvalScope?: string;
    executionId?: string;
    nodeId?: string;
    nodeExecutionId?: string;
    workflowId?: string;
  }): void {
    debugLog(`[WorkflowServiceAdapter] Emitting tool execution event: ${event.type} for ${event.toolName}, autoApproved: ${event.autoApproved}`);

    const timestamp = Date.now();

    // Persist tool call to database for the Tools tab
    if (this.executor && event.executionId) {
      if (event.type === 'started') {
        // Create a new tool call record
        try {
          const toolCall = this.executor.toolCalls.createToolCall({
            executionId: event.executionId,
            nodeExecutionId: event.nodeExecutionId,
            toolName: event.toolName,
            input: event.input,
          });
          // Map external toolId to internal database ID
          this.toolIdMap.set(event.toolId, toolCall.id);
          // Evict oldest entries if map exceeds max size
          if (this.toolIdMap.size > WorkflowServiceAdapter.TOOL_ID_MAP_MAX_SIZE) {
            const firstKey = this.toolIdMap.keys().next().value;
            if (firstKey) this.toolIdMap.delete(firstKey);
          }
          debugLog(`[WorkflowServiceAdapter] Created tool call record: ${toolCall.id} for external ${event.toolId}`);
        } catch (err) {
          debugLog(`[WorkflowServiceAdapter] Failed to create tool call record: ${err}`);
        }
      } else if (event.type === 'completed') {
        // Update existing tool call record with result
        try {
          const internalId = this.toolIdMap.get(event.toolId);
          if (internalId) {
            if (event.success) {
              this.executor.toolCalls.completeToolCall(internalId, event.output);
            } else {
              this.executor.toolCalls.failToolCall(internalId, event.error || 'Unknown error');
            }
            // Clean up the mapping
            this.toolIdMap.delete(event.toolId);
            debugLog(`[WorkflowServiceAdapter] Updated tool call record: ${internalId}`);
          } else {
            debugLog(`[WorkflowServiceAdapter] No internal ID found for toolId: ${event.toolId}`);
          }
        } catch (err) {
          debugLog(`[WorkflowServiceAdapter] Failed to update tool call record: ${err}`);
        }
      }
    }

    // Emit as workflow/tool/execution for ToolPanel subscriptions
    this.sendNotification('workflow/tool/execution', {
      type: event.type,
      toolId: event.toolId,
      toolName: event.toolName,
      input: event.input,
      output: event.output,
      success: event.success,
      error: event.error,
      autoApproved: event.autoApproved,
      approvalScope: event.approvalScope,
      executionId: event.executionId,
      nodeId: event.nodeId,
      workflowId: event.workflowId,
      timestamp,
    });

    // Also emit as workflow/activity for ActivityLog's "Tools" filter
    const activityType = event.type === 'started' ? 'tool_call_started' : 'tool_call_completed';
    const approvalInfo = event.autoApproved
      ? ` (auto-approved via ${event.approvalScope || 'workflow'})`
      : '';
    const summary = event.type === 'started'
      ? `Tool: ${event.toolName}${approvalInfo}`
      : `Tool: ${event.toolName} ${event.success ? 'succeeded' : 'failed'}`;

    this.sendNotification('workflow/activity', {
      activityType,
      entityType: 'tool_call',
      entityId: event.toolId,
      summary,
      details: {
        toolName: event.toolName,
        input: event.input,
        output: event.output,
        success: event.success,
        error: event.error,
        autoApproved: event.autoApproved,
        approvalScope: event.approvalScope,
      },
      createdAt: timestamp,
      executionId: event.executionId,
      nodeId: event.nodeId,
      workflowId: event.workflowId,
    });
  }

  /**
   * Clean up all toolIdMap entries for a completed/failed/cancelled execution.
   * This prevents leaked entries from tool calls that started but never completed.
   */
  private cleanupToolIdMapForExecution(executionId: string): void {
    if (!this.executor || this.toolIdMap.size === 0) return;
    // We don't track which toolIds belong to which execution in the map,
    // so we clean up entries whose internal IDs belong to this execution.
    const toDelete: string[] = [];
    for (const [externalId, internalId] of this.toolIdMap) {
      try {
        const toolCall = this.executor.toolCalls.getToolCall(internalId);
        if (toolCall && toolCall.executionId === executionId) {
          toDelete.push(externalId);
        }
      } catch {
        // If we can't look it up, clean it up anyway
        toDelete.push(externalId);
      }
    }
    for (const key of toDelete) {
      this.toolIdMap.delete(key);
    }
    if (toDelete.length > 0) {
      debugLog(`[WorkflowServiceAdapter] Cleaned up ${toDelete.length} toolIdMap entries for execution ${executionId}`);
    }
  }

  /**
   * Initialize the adapter.
   */
  async init(): Promise<void> {
    debugLog('[WorkflowServiceAdapter] init() called, initialized=' + this.initialized + ', hasHandler=' + !!this.notificationHandler);
    if (this.initialized) return;

    try {
      debugLog('[WorkflowServiceAdapter] Getting chat database for: ' + this.workspacePath);
      this.chatDb = await getChatDatabase(this.workspacePath);
      debugLog('[WorkflowServiceAdapter] Database obtained: ' + !!this.chatDb);
      if (this.chatDb) {
        const db = this.chatDb.getDb();
        debugLog('[WorkflowServiceAdapter] Database handle obtained');

        debugLog('[WorkflowServiceAdapter] Creating WorkflowExecutor');
        this.executor = new WorkflowExecutor(db);

        // Wire up notification handler for streaming updates
        if (this.notificationHandler) {
          this.executor.setNotificationHandler((method, params) => {
            this.sendNotification(method, params);
          });
          debugLog('[WorkflowServiceAdapter] Notification handler wired to executor (in init)');
        } else {
          // Buffer notifications until setNotificationHandler() is called
          this.executor.setNotificationHandler((method, params) => {
            this.pendingNotifications.push({ method, params });
          });
          debugLog('[WorkflowServiceAdapter] Notification handler not set during init - buffering notifications');
        }

        // Load system workflows from config
        const configDir = join(process.cwd(), 'config', 'workflows');
        const result = await loadWorkflowsFromDirectory(configDir, this.executor.workflows);
        debugLog(`[WorkflowServiceAdapter] Loaded workflows: ${result.loaded.join(', ')}`);
        if (result.errors.length > 0) {
          debugLog(`[WorkflowServiceAdapter] Workflow load errors: ${result.errors.map(e => e.error).join(', ')}`);
        }

        this.initialized = true;
        debugLog('[WorkflowServiceAdapter] Initialized successfully');
      }
    } catch (error) {
      debugLog(`[WorkflowServiceAdapter] Init error: ${error}`);
    }
  }

  /**
   * Update workspace path and reinitialize.
   */
  async setWorkspacePath(path: string): Promise<void> {
    if (this.workspacePath !== path) {
      this.workspacePath = path;
      this.initialized = false;
      await this.init();
    }
  }

  /**
   * Handle ECP requests.
   */
  async handleRequest(method: string, params: unknown): Promise<HandlerResult> {
    // Ensure initialized
    if (!this.initialized) {
      await this.init();
    }

    if (!this.executor) {
      return {
        error: {
          code: ECPErrorCodes.ServerNotInitialized,
          message: 'Workflow service not initialized',
        },
      };
    }

    try {
      switch (method) {
        // ─────────────────────────────────────────────────────────────────────
        // Workflow CRUD
        // ─────────────────────────────────────────────────────────────────────

        case 'workflow/list':
          return this.handleListWorkflows(params);

        case 'workflow/get':
          return this.handleGetWorkflow(params);

        case 'workflow/create':
          return this.handleCreateWorkflow(params);

        case 'workflow/update':
          return this.handleUpdateWorkflow(params);

        case 'workflow/delete':
          return this.handleDeleteWorkflow(params);

        case 'workflow/setDefault':
          return this.handleSetDefaultWorkflow(params);

        // ─────────────────────────────────────────────────────────────────────
        // Conversion (Editor ↔ Backend)
        // ─────────────────────────────────────────────────────────────────────

        case 'workflow/convert':
          return this.handleConvertWorkflow(params);

        case 'workflow/validate':
          return this.handleValidateWorkflow(params);

        case 'workflow/convertToEditor':
          return this.handleConvertToEditor(params);

        // ─────────────────────────────────────────────────────────────────────
        // Execution Management
        // ─────────────────────────────────────────────────────────────────────

        case 'workflow/execute/start':
          return this.handleStartExecution(params);

        case 'workflow/execute/step':
          return this.handleExecuteStep(params);

        case 'workflow/execute/pause':
          return this.handlePauseExecution(params);

        case 'workflow/execute/resume':
          return this.handleResumeExecution(params);

        case 'workflow/execute/cancel':
          return this.handleCancelExecution(params);

        case 'workflow/execute/get':
          return this.handleGetExecution(params);

        case 'workflow/execute/list':
          return this.handleListExecutions(params);

        // ─────────────────────────────────────────────────────────────────────
        // Context Items
        // ─────────────────────────────────────────────────────────────────────

        case 'workflow/context/list':
          return this.handleListContext(params);

        case 'workflow/context/add':
          return this.handleAddContext(params);

        case 'workflow/context/compact':
          return this.handleCompactContext(params);

        case 'workflow/context/expand':
          return this.handleExpandContext(params);

        case 'workflow/context/budget':
          return this.handleGetContextBudget(params);

        // ─────────────────────────────────────────────────────────────────────
        // Checkpoints
        // ─────────────────────────────────────────────────────────────────────

        case 'workflow/checkpoint/respond':
          return this.handleCheckpointRespond(params);

        case 'workflow/checkpoint/get':
          return this.handleGetCheckpoint(params);

        case 'workflow/checkpoint/list':
          return this.handleListCheckpoints(params);

        // ─────────────────────────────────────────────────────────────────────
        // Feedback Queue
        // ─────────────────────────────────────────────────────────────────────

        case 'workflow/feedback/list':
          return this.handleListFeedback(params);

        case 'workflow/feedback/address':
          return this.handleAddressFeedback(params);

        case 'workflow/feedback/dismiss':
          return this.handleDismissFeedback(params);

        // ─────────────────────────────────────────────────────────────────────
        // Permissions
        // ─────────────────────────────────────────────────────────────────────

        case 'workflow/permission/check':
          return this.handleCheckPermission(params);

        case 'workflow/permission/grant':
          return this.handleGrantPermission(params);

        case 'workflow/permission/deny':
          return this.handleDenyPermission(params);

        // ─────────────────────────────────────────────────────────────────────
        // Execution Messages (Unified Chat Model)
        // ─────────────────────────────────────────────────────────────────────

        case 'workflow/message/list':
          return this.handleListMessages(params);

        case 'workflow/message/send':
          return this.handleSendMessage(params);

        case 'workflow/message/get':
          return this.handleGetMessage(params);

        // ─────────────────────────────────────────────────────────────────────
        // Agent Registry
        // ─────────────────────────────────────────────────────────────────────

        case 'workflow/agent/list':
          return this.handleListAgents(params);

        case 'workflow/agent/get':
          return this.handleGetAgent(params);

        case 'workflow/agent/create':
          return this.handleCreateAgent(params);

        case 'workflow/agent/update':
          return this.handleUpdateAgent(params);

        case 'workflow/agent/delete':
          return this.handleDeleteAgent(params);

        case 'workflow/agent/duplicate':
          return this.handleDuplicateAgent(params);

        // ─────────────────────────────────────────────────────────────────────
        // Tool Calls
        // ─────────────────────────────────────────────────────────────────────

        case 'workflow/execution/tools':
          return this.handleListExecutionTools(params);

        case 'workflow/execution/tools/grouped':
          return this.handleListToolsGroupedByNode(params);

        case 'workflow/toolCall/get':
          return this.handleGetToolCall(params);

        case 'workflow/toolCall/create':
          return this.handleCreateToolCall(params);

        case 'workflow/toolCall/approve':
          return this.handleApproveToolCall(params);

        case 'workflow/toolCall/deny':
          return this.handleDenyToolCall(params);

        // ─────────────────────────────────────────────────────────────────────
        // Activity Log (for historical tool calls and permissions)
        // ─────────────────────────────────────────────────────────────────────

        case 'workflow/activity/log':
          return this.handleGetActivityLog(params);

        // ─────────────────────────────────────────────────────────────────────
        // Review Panel
        // ─────────────────────────────────────────────────────────────────────

        case 'workflow/review_panel/decide':
          return this.handleReviewPanelDecide(params);

        // ─────────────────────────────────────────────────────────────────────
        // Debug / Diagnostics
        // ─────────────────────────────────────────────────────────────────────

        case 'workflow/debug/info':
          return this.handleGetDebugInfo(params);

        default:
          return {
            error: {
              code: ECPErrorCodes.MethodNotFound,
              message: `Unknown workflow method: ${method}`,
            },
          };
      }
    } catch (error) {
      return {
        error: {
          code: ECPErrorCodes.InternalError,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Workflow CRUD Handlers
  // ─────────────────────────────────────────────────────────────────────────────

  private async handleListWorkflows(params: unknown): Promise<HandlerResult> {
    const p = params as {
      triggerType?: WorkflowTriggerType;
      includeSystem?: boolean;
      limit?: number;
      offset?: number;
    };

    const workflows = this.exec.workflows.listWorkflows({
      triggerType: p.triggerType,
      includeSystem: p.includeSystem ?? true,
      limit: p.limit,
      offset: p.offset,
    });

    return { result: { workflows } };
  }

  private async handleGetWorkflow(params: unknown): Promise<HandlerResult> {
    const p = params as { id: string };
    if (!p.id) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'id required' } };
    }

    const workflow = this.exec.workflows.getWorkflow(p.id);
    if (!workflow) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'Workflow not found' } };
    }

    return { result: { workflow } };
  }

  private async handleCreateWorkflow(params: unknown): Promise<HandlerResult> {
    const p = params as {
      name: string;
      description?: string;
      definition?: unknown;
      triggerType?: WorkflowTriggerType;
      isDefault?: boolean;
      agentPool?: string[];
      defaultAgentId?: string;
    };

    if (!p.name) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'name required' } };
    }

    const workflow = this.exec.workflows.createWorkflow({
      name: p.name,
      description: p.description,
      definition: p.definition as WorkflowDefinition | undefined,
      triggerType: p.triggerType,
      isDefault: p.isDefault,
      agentPool: p.agentPool,
      defaultAgentId: p.defaultAgentId,
    });

    this.sendNotification('workflow/created', { workflow });

    return { result: { workflow } };
  }

  private async handleUpdateWorkflow(params: unknown): Promise<HandlerResult> {
    const p = params as {
      id: string;
      name?: string;
      description?: string;
      definition?: unknown;
      triggerType?: WorkflowTriggerType;
      isDefault?: boolean;
      agentPool?: string[];
      defaultAgentId?: string;
    };

    debugLog(`[WorkflowServiceAdapter] handleUpdateWorkflow called with id=${p.id}, name=${p.name}`);
    debugLog(`[WorkflowServiceAdapter] definition steps count: ${(p.definition as { steps?: unknown[] })?.steps?.length ?? 'undefined'}`);

    if (!p.id) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'id required' } };
    }

    const workflow = this.exec.workflows.updateWorkflow(p.id, {
      name: p.name,
      description: p.description,
      definition: p.definition as WorkflowDefinition | undefined,
      triggerType: p.triggerType,
      isDefault: p.isDefault,
      agentPool: p.agentPool,
      defaultAgentId: p.defaultAgentId,
    });

    if (!workflow) {
      debugLog(`[WorkflowServiceAdapter] Workflow not found for update: ${p.id}`);
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'Workflow not found' } };
    }

    debugLog(`[WorkflowServiceAdapter] Workflow updated successfully: ${workflow.id}, steps: ${workflow.definition?.steps?.length ?? 0}`);
    this.sendNotification('workflow/updated', { workflow });

    return { result: { workflow } };
  }

  private async handleDeleteWorkflow(params: unknown): Promise<HandlerResult> {
    const p = params as { id: string };
    if (!p.id) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'id required' } };
    }

    const deleted = this.exec.workflows.deleteWorkflow(p.id);
    if (!deleted) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'Workflow not found' } };
    }

    this.sendNotification('workflow/deleted', { id: p.id });

    return { result: { success: true } };
  }

  private async handleSetDefaultWorkflow(params: unknown): Promise<HandlerResult> {
    const p = params as { id: string };
    if (!p.id) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'id required' } };
    }

    const success = this.exec.workflows.setDefaultWorkflow(p.id);
    if (!success) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'Workflow not found' } };
    }

    this.sendNotification('workflow/defaultChanged', { id: p.id });

    return { result: { success: true } };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Conversion Handlers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Convert editor workflow model to backend workflow definition.
   * Optionally validates the result.
   */
  private async handleConvertWorkflow(params: unknown): Promise<HandlerResult> {
    const p = params as {
      workflow: EditorWorkflow;
      nodes?: EditorNode[];
      validate?: boolean;
    };

    if (!p.workflow) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'workflow required' } };
    }

    try {
      const definition = editorWorkflowToBackend(p.workflow, p.nodes);

      // Optionally validate
      let errors: ReturnType<typeof validateWorkflow> = [];
      if (p.validate !== false) {
        errors = validateWorkflow(definition);
      }

      return {
        result: {
          definition,
          errors,
          valid: errors.filter(e => e.severity === 'error').length === 0,
        },
      };
    } catch (err) {
      return {
        error: {
          code: ECPErrorCodes.InternalError,
          message: `Conversion failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }

  /**
   * Validate a workflow definition (graph-based).
   */
  private async handleValidateWorkflow(params: unknown): Promise<HandlerResult> {
    const p = params as {
      definition: GraphWorkflowDefinition;
    };

    if (!p.definition) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'definition required' } };
    }

    try {
      const errors = validateWorkflow(p.definition);

      return {
        result: {
          errors,
          valid: errors.filter(e => e.severity === 'error').length === 0,
        },
      };
    } catch (err) {
      return {
        error: {
          code: ECPErrorCodes.InternalError,
          message: `Validation failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }

  /**
   * Convert graph-based workflow definition to editor format (step-based).
   * Takes a GraphWorkflowDefinition (with nodes and edges) and returns
   * EditorWorkflow with nodes and edges for the visual editor.
   */
  private async handleConvertToEditor(params: unknown): Promise<HandlerResult> {
    const p = params as {
      definition: GraphWorkflowDefinition;
    };

    if (!p.definition) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'definition required' } };
    }

    try {
      const { workflow, nodes, edges } = backendWorkflowToEditor(p.definition);

      return {
        result: {
          workflow,
          nodes,
          edges,
        },
      };
    } catch (err) {
      return {
        error: {
          code: ECPErrorCodes.InternalError,
          message: `Conversion failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Execution Management Handlers
  // ─────────────────────────────────────────────────────────────────────────────

  private async handleStartExecution(params: unknown): Promise<HandlerResult> {
    debugLog('[WorkflowServiceAdapter] handleStartExecution called');
    const p = params as {
      workflowId: string;
      input?: unknown;
      chatSessionId?: string;
      maxIterations?: number;
    };

    debugLog(`[WorkflowServiceAdapter] Starting workflow: ${p.workflowId}, input: ${JSON.stringify(p.input)?.slice(0, 100)}`);

    if (!p.workflowId) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'workflowId required' } };
    }

    const execution = await this.exec.startExecution({
      workflowId: p.workflowId,
      input: p.input,
      chatSessionId: p.chatSessionId,
      maxIterations: p.maxIterations,
    });

    debugLog(`[WorkflowServiceAdapter] Execution started: ${execution.id}, status: ${execution.status}`);
    debugLog(`[WorkflowServiceAdapter] Has notification handler: ${!!this.notificationHandler}`);
    this.sendNotification('workflow/execution/started', { execution });

    // Send notification for the initial user message if one was created
    const initialMessages = this.exec.messages.listMessages(execution.id, {
      role: 'user',
      limit: 1,
    });
    if (initialMessages.length > 0) {
      this.sendNotification('workflow/message/created', {
        executionId: execution.id,
        message: initialMessages[0],
      });
      debugLog(`[WorkflowServiceAdapter] Sent initial user message notification`);
    }

    // Run the workflow execution loop in the background
    this.runExecutionLoop(execution.id).catch((error) => {
      debugLog(`[WorkflowServiceAdapter] Execution loop error: ${error}`);
    });

    return { result: { execution } };
  }

  /**
   * Run the workflow execution loop until completion, pause, or error.
   * Protected by a mutex to prevent concurrent loops on the same execution.
   */
  private async runExecutionLoop(executionId: string): Promise<void> {
    // Prevent concurrent loops on the same execution
    if (this.runningLoops.has(executionId)) {
      debugLog(`[WorkflowServiceAdapter] Execution loop already running for ${executionId}, skipping`);
      return;
    }
    this.runningLoops.add(executionId);

    try {
      debugLog(`[WorkflowServiceAdapter] Starting execution loop for ${executionId}`);

      // Check workflow and definition before starting
      const execution = this.exec.getExecution(executionId);
      if (!execution) {
        debugLog(`[WorkflowServiceAdapter] ERROR: Execution not found: ${executionId}`);
        return;
      }
      const workflow = this.exec.workflows.getWorkflow(execution.workflowId);
      debugLog(`[WorkflowServiceAdapter] Workflow: ${workflow?.name}, definition steps: ${workflow?.definition?.steps?.length ?? 'null'}`);
      if (workflow?.definition?.steps) {
        debugLog(`[WorkflowServiceAdapter] Steps: ${workflow.definition.steps.map(s => s.id).join(', ')}`);
      }

      // W-005: Respect workflow's configured max_iterations with a global safety cap
      const GLOBAL_MAX_ITERATIONS = 1000;
      const workflowLimit = workflow?.definition?.max_iterations;
      const maxIterations = Math.min(workflowLimit ?? 100, GLOBAL_MAX_ITERATIONS);
      let iterations = 0;

      while (iterations < maxIterations) {
        iterations++;
        debugLog(`[WorkflowServiceAdapter] Iteration ${iterations}/${maxIterations} starting...`);

        try {
          debugLog(`[WorkflowServiceAdapter] Calling executeStep...`);
          const result = await this.exec.executeStep(executionId);
          debugLog(`[WorkflowServiceAdapter] executeStep returned: completed=${result.completed}, paused=${result.paused}, error=${result.error}, nodeExecution=${result.nodeExecution?.nodeId ?? 'none'}`);

          // Send appropriate notification based on result
          if (result.nodeExecution) {
            this.sendNotification('workflow/node/completed', {
              executionId,
              nodeExecution: result.nodeExecution,
            });
            debugLog(`[WorkflowServiceAdapter] Node ${result.nodeExecution.nodeId} completed`);

            // Send notifications for any messages created by this node
            const nodeMessages = this.exec.messages.listMessages(executionId, {
              orderDir: 'ASC',
              limit: 100,
            });
            debugLog(`[WorkflowServiceAdapter] Found ${nodeMessages.length} messages for execution`);
            for (const message of nodeMessages) {
              debugLog(`[WorkflowServiceAdapter] Message ${message.id}: nodeExecId=${message.nodeExecutionId}, expected=${result.nodeExecution.id}, content=${message.content?.substring(0, 50)}...`);
              if (message.nodeExecutionId === result.nodeExecution.id) {
                this.sendNotification('workflow/message/created', {
                  executionId,
                  message,
                });
                debugLog(`[WorkflowServiceAdapter] Sent message notification for ${message.id}`);
              }
            }
          } else if (!result.completed && !result.paused && !result.error) {
            // No node executed and no terminal state - execution is stalled
            debugLog(`[WorkflowServiceAdapter] Execution stalled - no node executed, status: ${result.execution.status}`);
            this.sendNotification('workflow/execution/failed', {
              executionId,
              error: `Execution stalled at status: ${result.execution.status}`,
            });
            break;
          }

          if (result.checkpoint) {
            this.sendNotification('workflow/checkpoint/reached', {
              executionId,
              checkpoint: result.checkpoint,
            });
            debugLog(`[WorkflowServiceAdapter] Checkpoint reached, pausing execution`);
            break; // Stop loop at checkpoint
          }

          if (result.paused) {
            this.sendNotification('workflow/execution/paused', { executionId });
            debugLog(`[WorkflowServiceAdapter] Execution paused`);
            break; // Stop loop when paused
          }

          if (result.completed) {
            this.sendNotification('workflow/execution/completed', {
              execution: result.execution,
            });
            debugLog(`[WorkflowServiceAdapter] Execution completed`);
            break; // Stop loop when done
          }

          if (result.error) {
            this.sendNotification('workflow/execution/failed', {
              executionId,
              error: result.error,
            });
            debugLog(`[WorkflowServiceAdapter] Execution failed: ${result.error}`);
            break; // Stop loop on error
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          debugLog(`[WorkflowServiceAdapter] Execution step error: ${errorMessage}`);
          this.sendNotification('workflow/execution/failed', {
            executionId,
            error: errorMessage,
          });
          break;
        }
      }

      if (iterations >= maxIterations) {
        debugLog(`[WorkflowServiceAdapter] Execution loop hit iteration limit (${maxIterations})`);
        this.sendNotification('workflow/execution/failed', {
          executionId,
          error: `Execution loop exceeded iteration limit (${maxIterations})`,
        });
      }

      // Clean up toolIdMap entries for this execution to prevent memory leaks
      this.cleanupToolIdMapForExecution(executionId);

      // Clean up dynamic handoff nodes and depth tracking
      this.exec.cleanupExecution(executionId);
    } finally {
      // Always clean up the running loop tracker, even on exceptions
      this.runningLoops.delete(executionId);
    }
  }

  private async handleExecuteStep(params: unknown): Promise<HandlerResult> {
    const p = params as { executionId: string };
    if (!p.executionId) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'executionId required' } };
    }

    const result = await this.exec.executeStep(p.executionId);

    // Send appropriate notification based on result
    if (result.nodeExecution) {
      this.sendNotification('workflow/node/completed', {
        executionId: p.executionId,
        nodeExecution: result.nodeExecution,
      });
    }

    if (result.checkpoint) {
      this.sendNotification('workflow/checkpoint/reached', {
        executionId: p.executionId,
        checkpoint: result.checkpoint,
      });
    }

    if (result.completed) {
      this.sendNotification('workflow/execution/completed', {
        execution: result.execution,
      });
    }

    if (result.error) {
      this.sendNotification('workflow/execution/failed', {
        executionId: p.executionId,
        error: result.error,
      });
    }

    return { result };
  }

  private async handlePauseExecution(params: unknown): Promise<HandlerResult> {
    const p = params as { executionId: string };
    if (!p.executionId) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'executionId required' } };
    }

    const success = this.exec.pauseExecution(p.executionId);
    if (success) {
      this.sendNotification('workflow/execution/paused', { executionId: p.executionId });
    }

    return { result: { success } };
  }

  private async handleResumeExecution(params: unknown): Promise<HandlerResult> {
    const p = params as { executionId: string };
    if (!p.executionId) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'executionId required' } };
    }

    const success = this.exec.resumeExecution(p.executionId);
    if (success) {
      this.sendNotification('workflow/execution/resumed', { executionId: p.executionId });
    }

    return { result: { success } };
  }

  private async handleCancelExecution(params: unknown): Promise<HandlerResult> {
    const p = params as { executionId: string };
    if (!p.executionId) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'executionId required' } };
    }

    const success = this.exec.cancelExecution(p.executionId);
    if (success) {
      this.sendNotification('workflow/execution/cancelled', { executionId: p.executionId });
      this.cleanupToolIdMapForExecution(p.executionId);
    }

    return { result: { success } };
  }

  private async handleGetExecution(params: unknown): Promise<HandlerResult> {
    const p = params as { executionId: string };
    if (!p.executionId) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'executionId required' } };
    }

    const execution = this.exec.getExecution(p.executionId);
    if (!execution) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'Execution not found' } };
    }

    return { result: { execution } };
  }

  private async handleListExecutions(params: unknown): Promise<HandlerResult> {
    const p = params as {
      workflowId?: string;
      status?: ExecutionStatus | ExecutionStatus[];
      chatSessionId?: string;
      limit?: number;
      offset?: number;
    };

    const executions = this.exec.executions.listExecutions({
      workflowId: p.workflowId,
      status: p.status,
      chatSessionId: p.chatSessionId,
      limit: p.limit,
      offset: p.offset,
    });

    return { result: { executions } };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Context Handlers
  // ─────────────────────────────────────────────────────────────────────────────

  private async handleListContext(params: unknown): Promise<HandlerResult> {
    const p = params as {
      executionId: string;
      activeOnly?: boolean;
      limit?: number;
    };

    if (!p.executionId) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'executionId required' } };
    }

    const items = this.exec.context.listContextItems(p.executionId, {
      activeOnly: p.activeOnly ?? true,
      limit: p.limit,
    });

    return { result: { items } };
  }

  private async handleAddContext(params: unknown): Promise<HandlerResult> {
    const p = params as {
      executionId: string;
      itemType: string;
      content: string;
      role?: string;
      agentId?: string;
      agentName?: string;
    };

    if (!p.executionId || !p.itemType || !p.content) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'executionId, itemType, content required' } };
    }

    const item = this.exec.context.createContextItem({
      executionId: p.executionId,
      itemType: p.itemType as ContextItemType,
      content: p.content,
      role: p.role as MessageRole | undefined,
      agentId: p.agentId,
      agentName: p.agentName,
    });

    this.sendNotification('workflow/context/added', { executionId: p.executionId, item });

    return { result: { item } };
  }

  private async handleCompactContext(params: unknown): Promise<HandlerResult> {
    const p = params as {
      executionId: string;
      strategy?: 'summarize' | 'truncate' | 'sliding_window';
      keepRecentCount?: number;
      maxTokens?: number;
    };

    if (!p.executionId) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'executionId required' } };
    }

    const strategy = p.strategy || 'summarize';
    const keepRecentCount = p.keepRecentCount ?? 10;

    // Get all context items
    const items = this.exec.context.listContextItems(p.executionId, {
      activeOnly: true,
      orderDir: 'ASC',
    });

    if (items.length <= keepRecentCount) {
      return { result: { compacted: false, message: 'Not enough items to compact' } };
    }

    // Items to compact (all but the most recent N)
    const itemsToCompact = items.slice(0, items.length - keepRecentCount);
    const itemIds = itemsToCompact.map(item => item.id);

    // Build summary content based on strategy
    let summaryContent: string;

    if (strategy === 'summarize') {
      // Build a text representation for summarization
      const conversationText = itemsToCompact.map(item => {
        const prefix = item.agentName ? `[${item.agentName}]` : `[${item.role || item.itemType}]`;
        return `${prefix}: ${item.content.substring(0, 500)}${item.content.length > 500 ? '...' : ''}`;
      }).join('\n\n');

      // Create summary prompt (this could be enhanced with AI later)
      summaryContent = `[Context Summary]\nCompacted ${itemsToCompact.length} items:\n\n${conversationText.substring(0, 2000)}${conversationText.length > 2000 ? '\n\n[... truncated ...]' : ''}`;
    } else if (strategy === 'truncate') {
      summaryContent = `[Truncated Context]\n${itemsToCompact.length} earlier items have been truncated to save context space.`;
    } else {
      // sliding_window - just mark as compacted with minimal summary
      summaryContent = `[Sliding Window]\n${itemsToCompact.length} earlier items moved out of active context.`;
    }

    // Create the compaction summary item
    const summaryItem = this.exec.context.createContextItem({
      executionId: p.executionId,
      itemType: 'compaction',
      role: 'system',
      content: summaryContent,
      tokens: Math.ceil(summaryContent.length / 4),
    });

    // Mark items as compacted
    const compactedCount = this.exec.context.compactItems(itemIds, summaryItem.id);

    // Calculate new token budget
    const activeTokens = this.exec.context.countActiveTokens(p.executionId);

    this.sendNotification('workflow/context/compacted', {
      executionId: p.executionId,
      compactedCount,
      summaryItemId: summaryItem.id,
      strategy,
    });

    return {
      result: {
        compacted: true,
        compactedCount,
        summaryItem,
        activeTokens,
      },
    };
  }

  private async handleExpandContext(params: unknown): Promise<HandlerResult> {
    const p = params as {
      executionId: string;
      compactionId: string;
    };

    if (!p.executionId || !p.compactionId) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'executionId and compactionId required' } };
    }

    const expandedCount = this.exec.context.expandCompaction(p.compactionId);

    // Optionally delete the summary item
    this.exec.context.deleteContextItem(p.compactionId);

    this.sendNotification('workflow/context/expanded', {
      executionId: p.executionId,
      compactionId: p.compactionId,
      expandedCount,
    });

    return {
      result: {
        expanded: true,
        expandedCount,
      },
    };
  }

  private async handleGetContextBudget(params: unknown): Promise<HandlerResult> {
    const p = params as {
      executionId: string;
      maxTokens?: number;
    };

    if (!p.executionId) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'executionId required' } };
    }

    const maxTokens = p.maxTokens ?? 128000; // Default context window

    // Get all active context items
    const items = this.exec.context.listContextItems(p.executionId, {
      activeOnly: true,
      includeCompacted: false,
    });

    // Calculate token usage by type
    let systemTokens = 0;
    let contextTokens = 0;
    let messageTokens = 0;

    for (const item of items) {
      const tokens = item.tokens ?? Math.ceil(item.content.length / 4);
      if (item.itemType === 'system') {
        systemTokens += tokens;
      } else if (item.itemType === 'tool_call' || item.itemType === 'tool_result') {
        contextTokens += tokens;
      } else {
        messageTokens += tokens;
      }
    }

    const usedTokens = systemTokens + contextTokens + messageTokens;
    const remainingTokens = maxTokens - usedTokens;
    const usagePercent = (usedTokens / maxTokens) * 100;
    const healthStatus = usagePercent > 90 ? 'critical' : usagePercent > 70 ? 'warning' : 'healthy';

    // Count compacted items
    const compactedItems = this.exec.context.listContextItems(p.executionId, {
      activeOnly: false,
      includeCompacted: true,
    }).filter(item => item.compactedIntoId !== null);

    return {
      result: {
        budget: {
          totalTokens: maxTokens,
          usedTokens,
          systemTokens,
          contextTokens,
          messageTokens,
          remainingTokens,
          healthStatus,
          itemCount: items.length,
          compactedItemCount: compactedItems.length,
        },
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Checkpoint Handlers
  // ─────────────────────────────────────────────────────────────────────────────

  private async handleCheckpointRespond(params: unknown): Promise<HandlerResult> {
    const p = params as {
      executionId: string;
      checkpointId: string;
      decision: string;
      feedback?: string;
    };

    if (!p.executionId || !p.checkpointId || !p.decision) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'executionId, checkpointId, decision required' } };
    }

    const result = await this.exec.resumeAfterCheckpoint(
      p.executionId,
      p.checkpointId,
      p.decision,
      p.feedback
    );

    this.sendNotification('workflow/checkpoint/responded', {
      executionId: p.executionId,
      checkpointId: p.checkpointId,
      decision: p.decision,
    });

    return { result };
  }

  private async handleGetCheckpoint(params: unknown): Promise<HandlerResult> {
    const p = params as { executionId: string };
    if (!p.executionId) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'executionId required' } };
    }

    const checkpoint = this.exec.checkpoints.getPendingCheckpoint(p.executionId);

    return { result: { checkpoint } };
  }

  private async handleListCheckpoints(params: unknown): Promise<HandlerResult> {
    const p = params as {
      executionId: string;
      pendingOnly?: boolean;
    };

    if (!p.executionId) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'executionId required' } };
    }

    const checkpoints = this.exec.checkpoints.listCheckpoints(p.executionId, {
      pendingOnly: p.pendingOnly,
    });

    return { result: { checkpoints } };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Feedback Queue Handlers
  // ─────────────────────────────────────────────────────────────────────────────

  private async handleListFeedback(params: unknown): Promise<HandlerResult> {
    const p = params as {
      executionId: string;
      status?: string | string[];
    };

    if (!p.executionId) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'executionId required' } };
    }

    const items = this.exec.feedback.getQueuedFeedback(p.executionId, {
      status: p.status as FeedbackQueueStatus | FeedbackQueueStatus[] | undefined,
    });

    return { result: { items } };
  }

  private async handleAddressFeedback(params: unknown): Promise<HandlerResult> {
    const p = params as { feedbackId: string };
    if (!p.feedbackId) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'feedbackId required' } };
    }

    const success = this.exec.feedback.markAddressed(p.feedbackId);

    return { result: { success } };
  }

  private async handleDismissFeedback(params: unknown): Promise<HandlerResult> {
    const p = params as { feedbackId: string };
    if (!p.feedbackId) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'feedbackId required' } };
    }

    const success = this.exec.feedback.markDismissed(p.feedbackId);

    return { result: { success } };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Permission Handlers
  // ─────────────────────────────────────────────────────────────────────────────

  private async handleCheckPermission(params: unknown): Promise<HandlerResult> {
    const p = params as {
      toolName: string;
      executionId?: string;
      workflowId?: string;
      pattern?: string;
    };

    if (!p.toolName) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'toolName required' } };
    }

    const result = this.exec.permissions.checkPermission({
      toolName: p.toolName,
      executionId: p.executionId,
      workflowId: p.workflowId,
      pattern: p.pattern,
    });

    return { result };
  }

  private async handleGrantPermission(params: unknown): Promise<HandlerResult> {
    const p = params as {
      toolName: string;
      scope: string;
      executionId?: string;
      workflowId?: string;
      pattern?: string;
      expiresAt?: number;
    };

    if (!p.toolName || !p.scope) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'toolName, scope required' } };
    }

    const permission = this.exec.permissions.grantPermission({
      toolName: p.toolName,
      scope: p.scope as PermissionScope,
      executionId: p.executionId,
      workflowId: p.workflowId,
      pattern: p.pattern,
      expiresAt: p.expiresAt,
    });

    this.sendNotification('workflow/permission/granted', { permission });

    return { result: { permission } };
  }

  private async handleDenyPermission(params: unknown): Promise<HandlerResult> {
    const p = params as {
      toolName: string;
      scope: string;
      executionId?: string;
      workflowId?: string;
      pattern?: string;
    };

    if (!p.toolName || !p.scope) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'toolName, scope required' } };
    }

    const permission = this.exec.permissions.denyPermission({
      toolName: p.toolName,
      scope: p.scope as PermissionScope,
      executionId: p.executionId,
      workflowId: p.workflowId,
      pattern: p.pattern,
    });

    this.sendNotification('workflow/permission/denied', { permission });

    return { result: { permission } };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Message Handlers (Unified Chat Model)
  // ─────────────────────────────────────────────────────────────────────────────

  private async handleListMessages(params: unknown): Promise<HandlerResult> {
    const p = params as {
      executionId: string;
      role?: string | string[];
      agentId?: string;
      limit?: number;
      offset?: number;
    };

    if (!p.executionId) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'executionId required' } };
    }

    const messages = this.exec.messages.listMessages(p.executionId, {
      role: p.role as ExecutionMessageRole | ExecutionMessageRole[] | undefined,
      agentId: p.agentId,
      limit: p.limit,
      offset: p.offset,
    });

    return { result: { messages } };
  }

  private async handleSendMessage(params: unknown): Promise<HandlerResult> {
    const p = params as {
      executionId: string;
      content: string;
      targetAgentId?: string;
    };

    if (!p.executionId || !p.content) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'executionId, content required' } };
    }

    // Create user message
    const message = this.exec.messages.createMessage({
      executionId: p.executionId,
      role: 'user',
      content: p.content,
    });

    // Also add as context item for workflow processing
    this.exec.context.createContextItem({
      executionId: p.executionId,
      itemType: 'user_input',
      role: 'user',
      content: p.content,
    });

    // Notify about new message
    this.sendNotification('workflow/message/created', {
      executionId: p.executionId,
      message,
    });

    // Check execution state and trigger workflow accordingly
    const execution = this.exec.getExecution(p.executionId);
    if (!execution) {
      return { result: { message } };
    }

    if (execution.status === 'paused' || execution.status === 'awaiting_input') {
      // Execution is waiting for input - resume from where it left off
      debugLog(`[WorkflowServiceAdapter] User message triggering workflow continuation for ${p.executionId}`);
      await this.exec.resumeAfterInput(p.executionId);
      this.runExecutionLoop(p.executionId).catch((error) => {
        debugLog(`[WorkflowServiceAdapter] Execution loop error after user message: ${error}`);
      });
    } else if (execution.status === 'completed') {
      // Execution completed - for on_message triggers, re-run the workflow
      // This is the N8N model: each message triggers a new execution of the workflow
      const workflow = this.exec.workflows.getWorkflow(execution.workflowId);
      const triggerType = workflow?.definition?.trigger?.type;

      if (triggerType === 'on_message' || triggerType === 'manual') {
        debugLog(`[WorkflowServiceAdapter] User message re-triggering workflow for ${p.executionId} (trigger: ${triggerType})`);

        // Increment iteration and reset to first node
        this.exec.executions.incrementIteration(p.executionId);
        const firstNode = workflow?.definition?.steps?.[0];
        if (firstNode) {
          this.exec.executions.setCurrentNode(p.executionId, firstNode.id);
          // Set status back to running
          this.exec.executions.updateStatus(p.executionId, 'running');

          // Notify execution restarted
          this.sendNotification('workflow/execution/started', {
            execution: this.exec.getExecution(p.executionId),
          });

          // Run execution loop
          this.runExecutionLoop(p.executionId).catch((error) => {
            debugLog(`[WorkflowServiceAdapter] Execution loop error after re-trigger: ${error}`);
          });
        }
      }
    }

    return { result: { message } };
  }

  private async handleGetMessage(params: unknown): Promise<HandlerResult> {
    const p = params as { messageId: string };
    if (!p.messageId) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'messageId required' } };
    }

    const message = this.exec.messages.getMessage(p.messageId);
    if (!message) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'Message not found' } };
    }

    return { result: { message } };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Agent Registry Handlers
  // ─────────────────────────────────────────────────────────────────────────────

  private async handleListAgents(params: unknown): Promise<HandlerResult> {
    const p = params as {
      role?: string;
      includeSystem?: boolean;
      activeOnly?: boolean;
      limit?: number;
      offset?: number;
    };

    const agents = this.exec.listAgents({
      role: p.role,
      includeSystem: p.includeSystem,
      activeOnly: p.activeOnly,
      limit: p.limit,
      offset: p.offset,
    });
    return { result: { agents } };
  }

  private async handleGetAgent(params: unknown): Promise<HandlerResult> {
    const p = params as { agentId: string };
    if (!p.agentId) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'agentId required' } };
    }

    const agent = this.exec.getAgent(p.agentId);
    if (!agent) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'Agent not found' } };
    }

    return { result: { agent } };
  }

  private async handleCreateAgent(params: unknown): Promise<HandlerResult> {
    const p = params as {
      id?: string;
      name: string;
      description?: string;
      role?: string;
      provider?: string;
      model?: string;
      systemPrompt?: string;
      tools?: string[];
    };

    if (!p.name) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'name required' } };
    }

    const agent = this.exec.getAgentService().createAgent({
      id: p.id,
      name: p.name,
      description: p.description,
      role: p.role as AgentRole | undefined,
      provider: p.provider,
      model: p.model,
      systemPrompt: p.systemPrompt,
      tools: p.tools,
    });

    this.sendNotification('workflow/agent/created', { agent });

    return { result: { agent } };
  }

  private async handleUpdateAgent(params: unknown): Promise<HandlerResult> {
    const p = params as {
      agentId: string;
      name?: string;
      description?: string;
      role?: string;
      provider?: string;
      model?: string;
      systemPrompt?: string;
      tools?: string[];
      isActive?: boolean;
    };

    if (!p.agentId) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'agentId required' } };
    }

    const agent = this.exec.getAgentService().updateAgent(p.agentId, {
      name: p.name,
      description: p.description,
      role: p.role as AgentRole | undefined,
      provider: p.provider,
      model: p.model,
      systemPrompt: p.systemPrompt,
      tools: p.tools,
      isActive: p.isActive,
    });

    if (!agent) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'Agent not found or cannot be modified' } };
    }

    this.sendNotification('workflow/agent/updated', { agent });

    return { result: { agent } };
  }

  private async handleDeleteAgent(params: unknown): Promise<HandlerResult> {
    const p = params as { agentId: string };
    if (!p.agentId) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'agentId required' } };
    }

    const success = this.exec.getAgentService().deleteAgent(p.agentId);
    if (!success) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'Agent not found or cannot be deleted (system agents cannot be deleted)' } };
    }

    this.sendNotification('workflow/agent/deleted', { agentId: p.agentId });

    return { result: { success } };
  }

  private async handleDuplicateAgent(params: unknown): Promise<HandlerResult> {
    const p = params as {
      agentId: string;
      newName?: string;
    };

    if (!p.agentId) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'agentId required' } };
    }

    const agent = this.exec.getAgentService().duplicateAgent(p.agentId, p.newName);
    if (!agent) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'Agent not found' } };
    }

    this.sendNotification('workflow/agent/created', { agent });

    return { result: { agent } };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool Call Handlers
  // ─────────────────────────────────────────────────────────────────────────────

  private async handleListExecutionTools(params: unknown): Promise<HandlerResult> {
    const p = params as {
      executionId: string;
      status?: string | string[];
      limit?: number;
      offset?: number;
    };

    if (!p.executionId) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'executionId required' } };
    }

    const toolCalls = this.exec.toolCalls.listToolCallsWithNodes(p.executionId, {
      status: p.status as ToolCallStatus | ToolCallStatus[] | undefined,
      limit: p.limit,
      offset: p.offset,
    });

    // Count by status for summary
    const counts = this.exec.toolCalls.countByStatus(p.executionId);

    return {
      result: {
        toolCalls,
        counts,
        total: toolCalls.length,
      },
    };
  }

  private async handleListToolsGroupedByNode(params: unknown): Promise<HandlerResult> {
    const p = params as {
      executionId: string;
    };

    if (!p.executionId) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'executionId required' } };
    }

    const groups = this.exec.toolCalls.listToolCallsGroupedByNode(p.executionId);
    const counts = this.exec.toolCalls.countByStatus(p.executionId);

    return {
      result: {
        groups,
        counts,
      },
    };
  }

  private async handleGetToolCall(params: unknown): Promise<HandlerResult> {
    const p = params as { toolCallId: string };
    if (!p.toolCallId) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'toolCallId required' } };
    }

    const toolCall = this.exec.toolCalls.getToolCall(p.toolCallId);
    if (!toolCall) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'Tool call not found' } };
    }

    return { result: { toolCall } };
  }

  private async handleCreateToolCall(params: unknown): Promise<HandlerResult> {
    const p = params as {
      executionId: string;
      nodeExecutionId?: string;
      toolName: string;
      input?: unknown;
    };

    if (!p.executionId || !p.toolName) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'executionId and toolName required' } };
    }

    const toolCall = this.exec.toolCalls.createToolCall({
      executionId: p.executionId,
      nodeExecutionId: p.nodeExecutionId,
      toolName: p.toolName,
      input: p.input,
    });

    this.sendNotification('workflow/toolCall/created', {
      executionId: p.executionId,
      toolCall,
    });

    return { result: { toolCall } };
  }

  private async handleApproveToolCall(params: unknown): Promise<HandlerResult> {
    const p = params as {
      toolCallId: string;
      executionId?: string;
    };

    if (!p.toolCallId) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'toolCallId required' } };
    }

    const success = this.exec.toolCalls.approveToolCall(p.toolCallId);
    if (!success) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'Tool call not found' } };
    }

    const toolCall = this.exec.toolCalls.getToolCall(p.toolCallId);

    this.sendNotification('workflow/toolCall/approved', {
      executionId: p.executionId || toolCall?.executionId,
      toolCallId: p.toolCallId,
      toolCall,
    });

    return { result: { success, toolCall } };
  }

  private async handleDenyToolCall(params: unknown): Promise<HandlerResult> {
    const p = params as {
      toolCallId: string;
      executionId?: string;
      reason?: string;
    };

    if (!p.toolCallId) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'toolCallId required' } };
    }

    const success = this.exec.toolCalls.denyToolCall(p.toolCallId);
    if (!success) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'Tool call not found' } };
    }

    const toolCall = this.exec.toolCalls.getToolCall(p.toolCallId);

    this.sendNotification('workflow/toolCall/denied', {
      executionId: p.executionId || toolCall?.executionId,
      toolCallId: p.toolCallId,
      toolCall,
      reason: p.reason,
    });

    return { result: { success, toolCall } };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Activity Log Handler
  // ─────────────────────────────────────────────────────────────────────────────

  private async handleGetActivityLog(params: unknown): Promise<HandlerResult> {
    const p = params as {
      executionId?: string;
      limit?: number;
    };

    const limit = p.limit ?? 100;

    // Collect tool calls as activity entries
    const activityEntries: Array<{
      id: number;
      sessionId: string | null;
      activityType: string;
      entityType: string;
      entityId: string;
      summary: string;
      details: unknown;
      createdAt: number;
      executionId?: string;
      workflowId?: string;
      workflowName?: string;
      nodeId?: string;
      nodeType?: string;
      agentId?: string;
      agentName?: string;
    }> = [];

    // Get recent tool calls from all executions or a specific one
    let toolCalls: Array<{
      id: string;
      executionId: string;
      toolName: string;
      status: string;
      input: unknown;
      output: unknown;
      startedAt: number | null;
      completedAt: number | null;
      nodeId?: string | null;
      nodeType?: string | null;
      agentId?: string | null;
      agentName?: string | null;
    }> = [];

    if (p.executionId) {
      // Get tool calls for specific execution
      toolCalls = this.exec.toolCalls.listToolCallsWithNodes(p.executionId, {
        limit,
        orderDir: 'DESC',
      });
    } else {
      // Get tool calls from recent executions
      const executions = this.exec.executions.listExecutions({ limit: 10 });
      for (const exec of executions) {
        const execToolCalls = this.exec.toolCalls.listToolCallsWithNodes(exec.id, {
          limit: Math.floor(limit / 10),
          orderDir: 'DESC',
        });
        toolCalls.push(...execToolCalls);
      }
    }

    // Convert tool calls to activity entries
    for (const tc of toolCalls) {
      // Get execution for workflow info
      const execution = this.exec.getExecution(tc.executionId);
      const workflow = execution ? this.exec.workflows.getWorkflow(execution.workflowId) : null;

      // Create "started" entry
      if (tc.startedAt) {
        activityEntries.push({
          id: Date.now() - activityEntries.length, // Unique ID
          sessionId: null,
          activityType: 'tool_call_started',
          entityType: 'tool_call',
          entityId: tc.id,
          summary: `Tool started: ${tc.toolName}`,
          details: { input: tc.input, status: tc.status },
          createdAt: tc.startedAt,
          executionId: tc.executionId,
          workflowId: execution?.workflowId,
          workflowName: workflow?.name,
          nodeId: tc.nodeId ?? undefined,
          nodeType: tc.nodeType ?? undefined,
          agentId: tc.agentId ?? undefined,
          agentName: tc.agentName ?? undefined,
        });
      }

      // Create "completed" entry
      if (tc.completedAt && tc.status === 'success') {
        activityEntries.push({
          id: Date.now() - activityEntries.length,
          sessionId: null,
          activityType: 'tool_call_completed',
          entityType: 'tool_call',
          entityId: tc.id,
          summary: `Tool completed: ${tc.toolName}`,
          details: { output: tc.output, status: tc.status },
          createdAt: tc.completedAt,
          executionId: tc.executionId,
          workflowId: execution?.workflowId,
          workflowName: workflow?.name,
          nodeId: tc.nodeId ?? undefined,
          nodeType: tc.nodeType ?? undefined,
          agentId: tc.agentId ?? undefined,
          agentName: tc.agentName ?? undefined,
        });
      }

      // Create permission entries
      if (tc.status === 'awaiting_permission') {
        activityEntries.push({
          id: Date.now() - activityEntries.length,
          sessionId: null,
          activityType: 'permission_requested',
          entityType: 'permission',
          entityId: tc.id,
          summary: `Permission requested: ${tc.toolName}`,
          details: { input: tc.input, toolName: tc.toolName },
          createdAt: tc.startedAt || Date.now(),
          executionId: tc.executionId,
          workflowId: execution?.workflowId,
          workflowName: workflow?.name,
          nodeId: tc.nodeId ?? undefined,
          agentId: tc.agentId ?? undefined,
          agentName: tc.agentName ?? undefined,
        });
      } else if (tc.status === 'approved') {
        activityEntries.push({
          id: Date.now() - activityEntries.length,
          sessionId: null,
          activityType: 'permission_granted',
          entityType: 'permission',
          entityId: tc.id,
          summary: `Permission granted: ${tc.toolName}`,
          details: { toolName: tc.toolName },
          createdAt: tc.completedAt || tc.startedAt || Date.now(),
          executionId: tc.executionId,
          workflowId: execution?.workflowId,
          workflowName: workflow?.name,
          nodeId: tc.nodeId ?? undefined,
          agentId: tc.agentId ?? undefined,
          agentName: tc.agentName ?? undefined,
        });
      } else if (tc.status === 'denied') {
        activityEntries.push({
          id: Date.now() - activityEntries.length,
          sessionId: null,
          activityType: 'permission_denied',
          entityType: 'permission',
          entityId: tc.id,
          summary: `Permission denied: ${tc.toolName}`,
          details: { toolName: tc.toolName },
          createdAt: tc.completedAt || tc.startedAt || Date.now(),
          executionId: tc.executionId,
          workflowId: execution?.workflowId,
          workflowName: workflow?.name,
          nodeId: tc.nodeId ?? undefined,
          agentId: tc.agentId ?? undefined,
          agentName: tc.agentName ?? undefined,
        });
      }
    }

    // Sort by createdAt descending and limit
    activityEntries.sort((a, b) => b.createdAt - a.createdAt);
    const limitedEntries = activityEntries.slice(0, limit);

    return { result: limitedEntries };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Review Panel Handlers
  // ─────────────────────────────────────────────────────────────────────────────

  private async handleReviewPanelDecide(params: unknown): Promise<HandlerResult> {
    const p = params as {
      panelExecutionId: string;
      executionId: string;
      decision: 'approve' | 'reject' | 'revise';
    };

    if (!p.panelExecutionId || !p.executionId || !p.decision) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'panelExecutionId, executionId, and decision required' } };
    }

    debugLog(`[WorkflowServiceAdapter] Review panel decision: ${p.panelExecutionId} -> ${p.decision}`);

    // Get the execution
    const execution = this.exec.getExecution(p.executionId);
    if (!execution) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'Execution not found' } };
    }

    // Send notification about the decision
    this.sendNotification('workflow/review_panel/decision', {
      panelExecutionId: p.panelExecutionId,
      executionId: p.executionId,
      decision: p.decision,
    });

    // If execution is paused (waiting for decision), resume it
    if (execution.status === 'paused') {
      // Set the decision as context for the workflow to use
      this.exec.context.createContextItem({
        executionId: p.executionId,
        nodeExecutionId: execution.currentNodeId || '',
        itemType: 'user_input',
        role: 'user',
        content: `Review panel decision: ${p.decision}`,
      });

      // Resume the execution
      this.exec.resumeExecution(p.executionId);
      this.sendNotification('workflow/execution/resumed', { executionId: p.executionId });

      // Continue execution loop
      this.runExecutionLoop(p.executionId).catch((error) => {
        debugLog(`[WorkflowServiceAdapter] Execution loop error after review decision: ${error}`);
      });
    }

    return { result: { success: true } };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Debug / Diagnostics Handlers
  // ─────────────────────────────────────────────────────────────────────────────

  private async handleGetDebugInfo(params: unknown): Promise<HandlerResult> {
    const p = params as { executionId: string };

    if (!p.executionId) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'executionId required' } };
    }

    const debugInfo = this.exec.getDebugInfo(p.executionId);
    if (!debugInfo) {
      return { error: { code: ECPErrorCodes.InvalidParams, message: 'Execution not found' } };
    }

    return { result: { debugInfo } };
  }
}
