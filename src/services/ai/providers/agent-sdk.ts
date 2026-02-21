/**
 * Claude Agent SDK Provider
 *
 * Uses the @anthropic-ai/claude-agent-sdk package to run Claude with full
 * agentic capabilities (tool use, sessions, etc.) via the user's local
 * API key / subscription. The SDK handles the entire agentic loop internally;
 * this provider maps SDK messages to ECP stream events.
 */

import {
  BaseAIProvider,
  registerProvider,
  type ChatCompletionRequest,
} from './base.ts';
import type {
  AIProviderType,
  AIProviderCapabilities,
  AIResponse,
  StreamEvent,
  ToolUseContent,
} from '../types.ts';
import { debugLog } from '../../../debug.ts';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';

/** Callback to register a pending permission with LocalAIService */
type PermissionRegistryFn = (
  toolUseId: string,
  pending: {
    toolUse: ToolUseContent;
    sessionId: string;
    resolve: (approved: boolean, answers?: Record<string, string>) => void;
    timestamp: number;
  }
) => void;

/** Callback to make internal ECP requests */
type EcpRequestFn = (method: string, params?: unknown) => Promise<unknown>;

/** Local pending permission entry for Agent SDK canUseTool */
interface AgentSDKPendingEntry {
  toolName: string;
  input: Record<string, unknown>;
  canUseResolve: (result: PermissionResult) => void;
}

/**
 * Built-in Claude Code tools that auto-execute without user approval.
 * These skip `canUseTool` entirely (passed as `allowedTools`).
 */
const AUTO_APPROVED_TOOLS = new Set([
  // Read-only file tools
  'Read', 'Glob', 'Grep', 'LS', 'LSP',
  // Todo (Claude Code built-in)
  'TodoWrite', 'TodoRead',
  // Chat history search
  'SearchChatHistory',
  // Web tools (read-only)
  'WebSearch', 'WebFetch',
]);

/**
 * MCP tool names (prefixed with mcp__ecp__) that are auto-approved.
 * These are ECP-specific tools exposed via in-process MCP server.
 */
const ECP_MCP_TOOL_NAMES = [
  'mcp__ecp__document_create',
  'mcp__ecp__document_get',
  'mcp__ecp__document_list',
  'mcp__ecp__document_update',
  'mcp__ecp__document_search',
];

export class AgentSDKProvider extends BaseAIProvider {
  readonly type: AIProviderType = 'agent-sdk';
  readonly name = 'Claude (Agent SDK)';

  /** SDK session ID for multi-turn resume */
  private sdkSessionId: string | null = null;

  /** Active query handle for cancellation */
  private activeQuery: { close(): void } | null = null;

  /** Local pending permissions for canUseTool callback */
  private pendingPermissions: Map<string, AgentSDKPendingEntry> = new Map();

  /** Active sub-agents keyed by parent_tool_use_id (the Task tool_use.id) */
  private activeSubAgents: Map<string, {
    toolUseId: string;
    subagentType: string;
    description: string;
    startedAt: number;
  }> = new Map();

  /** Track which agent is currently producing messages (null = main agent) */
  private currentAgentToolUseId: string | null = null;

  /** Callback to register permissions with LocalAIService */
  private registerPermission?: PermissionRegistryFn;

  /** Callback to make internal ECP requests */
  private ecpRequest?: EcpRequestFn;

  getCapabilities(): AIProviderCapabilities {
    return {
      toolUse: true,
      streaming: true,
      vision: true,
      systemMessages: true,
      maxContextTokens: 200000,
      maxOutputTokens: 16000,
    };
  }

  /** Auth method detected from SDK messages during query. */
  private detectedAuthMethod: string | null = null;

  /** Returns the authentication method being used. */
  getAuthMethod(): string | null {
    // Prefer what the SDK reported at runtime
    if (this.detectedAuthMethod) return this.detectedAuthMethod;
    // Fall back to env var detection
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return 'oauth';
    if (process.env.ANTHROPIC_API_KEY) return 'api-key';
    return null;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await import('@anthropic-ai/claude-agent-sdk');
      return true;
    } catch {
      return false;
    }
  }

  async getAvailableModels(): Promise<string[]> {
    return [
      'claude-opus-4-6',
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20251001',
    ];
  }

  /** Expose session ID for LocalAIService cliSessionId capture */
  getSessionId(): string | null {
    return this.sdkSessionId;
  }

  /** Restore session ID for resume (matches claude/openai/gemini providers) */
  setSessionId(sessionId: string): void {
    this.sdkSessionId = sessionId;
  }

  /** Set the permission registry callback for bridging to LocalAIService */
  setPermissionRegistry(register: PermissionRegistryFn): void {
    this.registerPermission = register;
  }

  /** Set the ECP request callback for MCP tools */
  setEcpRequest(fn: EcpRequestFn): void {
    this.ecpRequest = fn;
  }

  /** Approve a pending permission from external caller (LocalAIService) */
  approvePermission(toolUseId: string, answers?: Record<string, string>): boolean {
    const entry = this.pendingPermissions.get(toolUseId);
    if (!entry) return false;
    this.pendingPermissions.delete(toolUseId);

    if (entry.toolName === 'AskUserQuestion' && answers) {
      entry.canUseResolve({
        behavior: 'allow',
        updatedInput: { ...entry.input, answers },
      });
    } else {
      entry.canUseResolve({ behavior: 'allow', updatedInput: entry.input });
    }
    return true;
  }

  /** Deny a pending permission from external caller (LocalAIService) */
  denyPermission(toolUseId: string): boolean {
    const entry = this.pendingPermissions.get(toolUseId);
    if (!entry) return false;
    this.pendingPermissions.delete(toolUseId);
    entry.canUseResolve({ behavior: 'deny', message: 'User denied' });
    return true;
  }

  async chat(request: ChatCompletionRequest): Promise<AIResponse> {
    return this.chatStream(request, () => {});
  }

  /** Create an in-process MCP server with ECP document/plan/spec tools. */
  private async createEcpMcpServer() {
    const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');
    const { z } = await import('zod');
    const ecpReq = this.ecpRequest!;

    return createSdkMcpServer({
      name: 'ecp',
      tools: [
        tool(
          'document_create',
          `Create a document in the ECP workspace. Use docType to specify kind:
- 'plan' for implementation plans
- 'spec' for specifications/requirements
- 'prd' for product requirement documents
- 'assessment' for assessments
- 'note' for general notes
- 'decision' for decision records
- 'report' for reports
- 'runbook' for operational runbooks`,
          {
            docType: z.enum(['prd', 'assessment', 'spec', 'plan', 'report', 'decision', 'runbook', 'note']),
            title: z.string().describe('Document title'),
            content: z.string().describe('Document content (markdown)'),
            summary: z.string().optional().describe('Brief summary'),
            sessionId: z.string().optional().describe('Session to associate with'),
            parentId: z.string().optional().describe('Parent document ID for hierarchy'),
            status: z.enum(['draft', 'active', 'in_review', 'approved', 'completed', 'archived']).optional(),
            priority: z.number().optional().describe('Priority level (0=normal)'),
          },
          async (args) => {
            try {
              const result = await ecpReq('chat/document/create', args);
              return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
            } catch (err) {
              return { content: [{ type: 'text' as const, text: `Error: ${err}` }], isError: true };
            }
          }
        ),

        tool(
          'document_get',
          'Get a document by its ID. Returns the full document with content, metadata, and status.',
          {
            id: z.string().describe('Document ID'),
          },
          async (args) => {
            try {
              const result = await ecpReq('chat/document/get', args);
              return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
            } catch (err) {
              return { content: [{ type: 'text' as const, text: `Error: ${err}` }], isError: true };
            }
          }
        ),

        tool(
          'document_list',
          'List documents with optional filters. Filter by docType (plan, spec, prd, etc.), status, or session.',
          {
            docType: z.enum(['prd', 'assessment', 'spec', 'plan', 'report', 'decision', 'runbook', 'note']).optional(),
            status: z.enum(['draft', 'active', 'in_review', 'approved', 'completed', 'archived']).optional(),
            sessionId: z.string().optional(),
            limit: z.number().optional().describe('Max results (default 100)'),
          },
          async (args) => {
            try {
              const result = await ecpReq('chat/document/list', args);
              return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
            } catch (err) {
              return { content: [{ type: 'text' as const, text: `Error: ${err}` }], isError: true };
            }
          }
        ),

        tool(
          'document_update',
          'Update an existing document. Only provide fields that should change.',
          {
            id: z.string().describe('Document ID to update'),
            title: z.string().optional(),
            content: z.string().optional(),
            summary: z.string().optional(),
            status: z.enum(['draft', 'active', 'in_review', 'approved', 'completed', 'archived']).optional(),
            priority: z.number().optional(),
          },
          async (args) => {
            try {
              const result = await ecpReq('chat/document/update', args);
              return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
            } catch (err) {
              return { content: [{ type: 'text' as const, text: `Error: ${err}` }], isError: true };
            }
          }
        ),

        tool(
          'document_search',
          'Search documents by text query. Searches titles and content.',
          {
            query: z.string().describe('Search query'),
            docType: z.enum(['prd', 'assessment', 'spec', 'plan', 'report', 'decision', 'runbook', 'note']).optional(),
            limit: z.number().optional().describe('Max results (default 50)'),
          },
          async (args) => {
            try {
              const result = await ecpReq('chat/document/search', args);
              return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
            } catch (err) {
              return { content: [{ type: 'text' as const, text: `Error: ${err}` }], isError: true };
            }
          }
        ),
      ],
    });
  }

  async chatStream(
    request: ChatCompletionRequest,
    onEvent: (event: StreamEvent) => void
  ): Promise<AIResponse> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    // Extract the latest user message text as the prompt
    const lastUserMsg = [...request.messages]
      .reverse()
      .find((m) => m.role === 'user');
    const prompt =
      lastUserMsg?.content
        .filter((c: { type: string }) => c.type === 'text')
        .map((c: { type: string; text?: string }) => c.text)
        .join('\n') || '';

    // Strip "agent-sdk:" prefix if present (model registry uses prefixed IDs)
    const model = (this.config.model || 'claude-sonnet-4-5-20250929')
      .replace(/^agent-sdk:/, '');

    // Resolve claude CLI path — compiled Bun binaries have a virtual FS,
    // so the SDK can't find it via its default resolution.
    const claudePath = await this.resolveClaudePath();

    // Create in-process MCP server for ECP tools (documents, plans, specs)
    const ecpMcpServer = this.ecpRequest ? await this.createEcpMcpServer() : null;
    const allAllowedTools = [
      ...AUTO_APPROVED_TOOLS,
      ...(ecpMcpServer ? ECP_MCP_TOOL_NAMES : []),
    ];

    const q = query({
      prompt,
      options: {
        model,
        pathToClaudeCodeExecutable: claudePath,
        cwd: request.cwd || process.cwd(),
        systemPrompt: request.systemPrompt || undefined,
        resume: this.sdkSessionId || undefined,
        abortController: request.abortSignal
          ? ({ signal: request.abortSignal, abort() {} } as AbortController)
          : undefined,
        includePartialMessages: true,
        maxTurns: 50,
        allowedTools: allAllowedTools,
        mcpServers: ecpMcpServer ? { ecp: ecpMcpServer } : undefined,
        canUseTool: async (toolName, input, options) => {
          return new Promise<PermissionResult>((canUseResolve) => {
            debugLog(`[AgentSDK] canUseTool: ${toolName} (${options.toolUseID})`);
            const entry: AgentSDKPendingEntry = {
              toolName,
              input: input as Record<string, unknown>,
              canUseResolve,
            };
            this.pendingPermissions.set(options.toolUseID, entry);

            // Register with LocalAIService so ECP approve/deny endpoints work
            if (this.registerPermission) {
              this.registerPermission(options.toolUseID, {
                toolUse: {
                  type: 'tool_use',
                  id: options.toolUseID,
                  name: toolName,
                  input: input as Record<string, unknown>,
                },
                sessionId: this.sdkSessionId || '',
                resolve: (approved: boolean, answers?: Record<string, string>) => {
                  const local = this.pendingPermissions.get(options.toolUseID);
                  if (!local) {
                    debugLog(`[AgentSDK] WARNING: resolve called but entry missing from pendingPermissions: ${options.toolUseID}`);
                    return;
                  }
                  this.pendingPermissions.delete(options.toolUseID);
                  if (approved) {
                    debugLog(`[AgentSDK] Approved ${toolName} (${options.toolUseID}), resolving SDK promise`);
                    // Resolve agent attribution for approval event
                    const approvalAgent = this.currentAgentToolUseId
                      ? this.activeSubAgents.get(this.currentAgentToolUseId)
                      : null;
                    // Emit tool_use_started to convert the permission card → execution spinner
                    onEvent({
                      type: 'tool_use_started',
                      toolUseId: options.toolUseID,
                      toolName,
                      input: input as Record<string, unknown>,
                      autoApproved: false,
                      ...(approvalAgent && {
                        agentId: approvalAgent.toolUseId,
                        agentName: approvalAgent.description || approvalAgent.subagentType,
                        agentRole: 'specialist' as const,
                      }),
                    } as StreamEvent);

                    if (toolName === 'AskUserQuestion' && answers) {
                      canUseResolve({
                        behavior: 'allow',
                        updatedInput: { ...input, answers },
                      });
                    } else {
                      canUseResolve({ behavior: 'allow', updatedInput: input as Record<string, unknown> });
                    }
                  } else {
                    debugLog(`[AgentSDK] Denied ${toolName} (${options.toolUseID})`);
                    canUseResolve({ behavior: 'deny', message: 'User denied' });
                  }
                },
                timestamp: Date.now(),
              });
            } else {
              debugLog(`[AgentSDK] WARNING: registerPermission not set, canUseTool will hang for ${toolName}`);
            }

            // Resolve agent attribution from current stream context
            const permAgent = this.currentAgentToolUseId
              ? this.activeSubAgents.get(this.currentAgentToolUseId)
              : null;

            // Emit permission request event to GUI
            onEvent({
              type: 'tool_use_request',
              id: options.toolUseID,
              name: toolName,
              input: input as Record<string, unknown>,
              description: options.decisionReason || `Use ${toolName}`,
              requiresApproval: true,
              ...(permAgent && {
                agentId: permAgent.toolUseId,
                agentName: permAgent.description || permAgent.subagentType,
                agentRole: 'specialist' as const,
              }),
            } as StreamEvent);
          });
        },
      },
    });

    this.activeQuery = q;
    let fullText = '';
    const messageId = `msg-sdk-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    onEvent({ type: 'message_start' } as StreamEvent);

    for await (const message of q) {
      // SDKMessage is a union of 15+ types. We handle the essential ones
      // and ignore the rest (auth_status, hook messages, compact_boundary, etc.)
      const msg = message as Record<string, unknown>;
      const type = msg.type as string;

      switch (type) {
        case 'system': {
          const subtype = msg.subtype as string;
          if (subtype === 'init') {
            this.sdkSessionId = msg.session_id as string;
            debugLog(`[AgentSDK] Session initialized: ${this.sdkSessionId}`);
          } else if (subtype === 'compact_boundary') {
            const metadata = msg.compact_metadata as {
              trigger: 'manual' | 'auto';
              pre_tokens: number;
            } | undefined;
            if (metadata) {
              onEvent({
                type: 'compact_boundary',
                trigger: metadata.trigger,
                preTokens: metadata.pre_tokens,
              } as StreamEvent);
              debugLog(`[AgentSDK] Compact boundary: trigger=${metadata.trigger}, pre_tokens=${metadata.pre_tokens}`);
            }
          }
          break;
        }

        case 'assistant': {
          // SDKAssistantMessage: finalized turn from Claude.
          // message.message is BetaMessage with content blocks (text, tool_use).
          const betaMsg = msg.message as {
            content: Array<Record<string, unknown>>;
          };
          if (!betaMsg?.content) break;

          // Track which agent produced this assistant message
          const parentId = msg.parent_tool_use_id as string | null;
          this.currentAgentToolUseId = parentId || null;

          for (const block of betaMsg.content) {
            if (block.type === 'tool_use') {
              const toolName = block.name as string;

              // Detect sub-agent spawn via Task tool
              if (toolName === 'Task') {
                const input = block.input as { subagent_type?: string; description?: string; prompt?: string } | undefined;
                const subagentType = input?.subagent_type || 'unknown';
                const description = input?.description || subagentType;
                this.activeSubAgents.set(block.id as string, {
                  toolUseId: block.id as string,
                  subagentType,
                  description,
                  startedAt: Date.now(),
                });
                onEvent({
                  type: 'agent_joined',
                  agentId: block.id as string,
                  agentName: description,
                  agentRole: 'specialist',
                } as StreamEvent);
                onEvent({
                  type: 'agent_status',
                  agentId: block.id as string,
                  agentName: description,
                  agentRole: 'specialist',
                  status: 'executing',
                } as StreamEvent);
              }

              // Resolve agent attribution for tool events
              const agent = parentId ? this.activeSubAgents.get(parentId) : null;

              // Only emit tool_use_started for auto-approved tools.
              // Non-auto-approved tools go through canUseTool → tool_use_request,
              // and tool_use_started is emitted when the user approves.
              if (AUTO_APPROVED_TOOLS.has(toolName) || ECP_MCP_TOOL_NAMES.includes(toolName)) {
                onEvent({
                  type: 'tool_use_started',
                  toolUseId: block.id,
                  toolName,
                  input: block.input,
                  autoApproved: true,
                  ...(agent && {
                    agentId: agent.toolUseId,
                    agentName: agent.description || agent.subagentType,
                    agentRole: 'specialist' as const,
                  }),
                } as StreamEvent);

                // Bridge TodoWrite to ECP — emit synthetic todo_update
                if (toolName === 'TodoWrite' && block.input) {
                  const inp = block.input as Record<string, unknown>;
                  if (Array.isArray(inp.todos)) {
                    onEvent({
                      type: 'todo_update',
                      todos: inp.todos,
                    } as StreamEvent);
                  }
                }
              }
              // Non-auto-approved tools: canUseTool handles events
            }
            // Text blocks: accumulate for return value only.
            // Real-time text comes via stream_event — don't re-emit here.
            if (block.type === 'text') {
              fullText += (block.text as string) || '';
            }
          }
          break;
        }

        case 'user': {
          // SDKUserMessage: contains tool_result content blocks
          const userMsg = msg.message as { content: unknown };
          if (!userMsg?.content || !Array.isArray(userMsg.content)) break;

          for (const block of userMsg.content as Array<
            Record<string, unknown>
          >) {
            if (block.type === 'tool_result') {
              const toolUseId = block.tool_use_id as string;

              // Resolve agent attribution for this tool result
              const parentId = msg.parent_tool_use_id as string | null;
              const agent = parentId ? this.activeSubAgents.get(parentId) : null;

              onEvent({
                type: 'tool_use_result',
                toolUseId,
                success: !block.is_error,
                result:
                  typeof block.content === 'string'
                    ? block.content
                    : JSON.stringify(block.content),
                ...(agent && {
                  agentId: agent.toolUseId,
                  agentName: agent.description || agent.subagentType,
                  agentRole: 'specialist' as const,
                }),
              } as StreamEvent);

              // Detect sub-agent completion (tool_result for a Task tool_use)
              const completedAgent = this.activeSubAgents.get(toolUseId);
              if (completedAgent) {
                onEvent({
                  type: 'agent_status',
                  agentId: completedAgent.toolUseId,
                  agentName: completedAgent.description || completedAgent.subagentType,
                  agentRole: 'specialist',
                  status: 'idle',
                  previousStatus: 'executing',
                } as StreamEvent);
                onEvent({
                  type: 'agent_left',
                  agentId: completedAgent.toolUseId,
                  agentName: completedAgent.description || completedAgent.subagentType,
                } as StreamEvent);
                this.activeSubAgents.delete(toolUseId);
              }
            }
          }
          break;
        }

        case 'stream_event': {
          // SDKPartialAssistantMessage: real-time streaming deltas
          // event is BetaRawMessageStreamEvent
          const evt = msg.event as Record<string, unknown>;
          if (!evt) break;

          // Track which agent is producing this stream
          const streamParentId = msg.parent_tool_use_id as string | null;
          this.currentAgentToolUseId = streamParentId || null;
          const streamAgent = streamParentId ? this.activeSubAgents.get(streamParentId) : null;

          if (evt.type === 'content_block_delta') {
            const delta = evt.delta as Record<string, unknown>;
            if (delta?.type === 'text_delta' && delta.text) {
              onEvent({
                type: 'content_block_delta',
                delta: { type: 'text_delta', text: delta.text },
                ...(streamAgent && {
                  agentId: streamAgent.toolUseId,
                  agentName: streamAgent.description || streamAgent.subagentType,
                  agentRole: 'specialist' as const,
                }),
              } as StreamEvent);
              // Don't accumulate here — fullText comes from 'assistant' messages
            }
          }
          break;
        }

        case 'auth_status': {
          // SDKAuthStatusMessage: reports authentication state
          debugLog(`[AgentSDK] Auth status: authenticating=${msg.isAuthenticating}`);
          break;
        }

        case 'result': {
          // SDKResultMessage: query complete (success or error)
          const subtype = msg.subtype as string;
          if (subtype === 'success') {
            // Capture auth source from the result
            const apiKeySource = msg.apiKeySource as string | undefined;
            if (apiKeySource) {
              this.detectedAuthMethod = apiKeySource;
              debugLog(`[AgentSDK] Auth method: ${apiKeySource}`);
            }

            // Relay usage/cost data to client
            const usage = msg.usage as { input_tokens: number; output_tokens: number } | undefined;
            const modelUsage = msg.modelUsage as Record<string, { contextWindow: number; costUSD: number }> | undefined;
            const cost = msg.total_cost_usd as number | undefined;
            if (usage || modelUsage || cost != null) {
              onEvent({
                type: 'result_usage',
                usage,
                modelUsage,
                totalCostUsd: cost,
              } as StreamEvent);
            }
          } else {
            const errors = (msg.errors as string[]) || [];
            debugLog(
              `[AgentSDK] Query error: ${subtype} - ${errors.join(', ')}`
            );
          }
          break;
        }

        case 'tool_progress': {
          // SDKToolProgressMessage: elapsed time for running tools
          // Could map to ECP iteration events in future
          break;
        }

        // Ignore: system/status, hook messages,
        // compact_boundary, task_notification, tool_use_summary, etc.
      }
    }

    this.activeQuery = null;

    // Defensive cleanup: emit agent_left for any sub-agents still tracked
    for (const [id, agent] of this.activeSubAgents) {
      onEvent({
        type: 'agent_left',
        agentId: agent.toolUseId,
        agentName: agent.description || agent.subagentType,
      } as StreamEvent);
    }
    this.activeSubAgents.clear();
    this.currentAgentToolUseId = null;

    onEvent({ type: 'message_stop' } as StreamEvent);

    return {
      message: {
        id: messageId,
        role: 'assistant',
        content: [{ type: 'text', text: fullText }],
        timestamp: Date.now(),
      },
      stopReason: 'end_turn', // Always end_turn — SDK handled the tool loop
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  /** Resolve the claude CLI path from PATH or common locations. */
  private async resolveClaudePath(): Promise<string | undefined> {
    // Check common locations
    const candidates = [
      `${process.env.HOME}/.local/bin/claude`,
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
    ];

    const { existsSync } = await import('fs');
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }

    // Try PATH via `which`
    try {
      const proc = Bun.spawn(['which', 'claude'], { stdout: 'pipe', stderr: 'ignore' });
      const out = await new Response(proc.stdout).text();
      const resolved = out.trim();
      if (resolved && existsSync(resolved)) return resolved;
    } catch { /* ignore */ }

    return undefined;
  }

  cancel(): void {
    // Reject all pending permission promises so the SDK doesn't hang
    for (const [id, entry] of this.pendingPermissions) {
      entry.canUseResolve({ behavior: 'deny', message: 'Stream cancelled' });
    }
    this.pendingPermissions.clear();

    // Clean up sub-agent tracking (no onEvent available here)
    this.activeSubAgents.clear();
    this.currentAgentToolUseId = null;

    this.activeQuery?.close();
    this.activeQuery = null;
  }
}

registerProvider('agent-sdk', (config) => new AgentSDKProvider(config));
