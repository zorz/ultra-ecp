/**
 * Agent Session Registry
 *
 * Manages per-agent AI sessions within a chat. Each agent gets its own
 * isolated session with its own system prompt, model, message history,
 * and tool set. The registry creates sessions lazily on first message
 * to an agent.
 */

import { debugLog } from '../../debug.ts';
import type { LocalAIService } from './local.ts';
import type {
  AIProviderType,
  AgentSessionEntry,
  CreateSessionOptions,
  ToolDefinition,
} from './types.ts';
import type { IAgentConfig } from '../chat/types/agents.ts';
import { buildAgentSystemPrompt, buildWorkflowAgentSystemPrompt } from './system-prompt.ts';

/**
 * Registry that maps (chatSessionId, agentId) → agent AI session.
 */
export class AgentSessionRegistry {
  /** Map<chatSessionId, Map<agentId, AgentSessionEntry>> */
  private registry: Map<string, Map<string, AgentSessionEntry>> = new Map();
  /** Available agents for delegation roster in system prompts */
  private availableAgents: Array<{ id: string; name: string; role?: string; description?: string }> = [];

  constructor(
    private service: LocalAIService,
    private getAgentConfig: (agentId: string) => IAgentConfig | undefined | Promise<IAgentConfig | undefined>,
    private workspaceRoot: string,
  ) {}

  /**
   * Update the list of available agents for delegation roster.
   * Called when agents are loaded or updated.
   */
  setAvailableAgents(agents: Array<{ id: string; name: string; role?: string; description?: string }>): void {
    this.availableAgents = agents;
    debugLog(`[AgentSessionRegistry] Updated available agents roster: ${agents.map(a => a.name).join(', ')}`);
  }

  /**
   * Get or create an agent's AI session for a given chat.
   * If the session already exists, updates lastUsedAt and optionally
   * injects transcript context. If new, creates the session with the
   * agent's config.
   */
  async getOrCreateSession(
    chatSessionId: string,
    agentId: string,
    fallbackProvider: { type: AIProviderType; model?: string },
    transcriptContext?: string,
    sourceAgentId?: string,
  ): Promise<AgentSessionEntry> {
    let chatMap = this.registry.get(chatSessionId);
    if (!chatMap) {
      chatMap = new Map();
      this.registry.set(chatSessionId, chatMap);
    }

    const existing = chatMap.get(agentId);
    if (existing) {
      existing.lastUsedAt = Date.now();

      // Inject transcript delta as a system message if provided
      if (transcriptContext) {
        this.service.addMessage(existing.aiSessionId, {
          id: `ctx-${crypto.randomUUID()}`,
          role: 'system',
          content: [{ type: 'text', text: `[Conversation context from group chat]\n${transcriptContext}` }],
          timestamp: Date.now(),
        });
        debugLog(`[AgentSessionRegistry] Injected transcript context into session for agent ${agentId}`);
      }

      return existing;
    }

    // Create new session for this agent (resolver may be sync or async)
    const agentConfig = await Promise.resolve(this.getAgentConfig(agentId));
    const { type: providerType, model: fallbackModel } = fallbackProvider;

    // Resolve provider and model from agent config
    const resolved = this.resolveProviderAndModel(
      agentConfig?.provider,
      agentConfig?.model,
      providerType,
      fallbackModel,
    );

    // Build agent-specific system prompt (with agent roster if multiple agents available)
    // When this session is created via handoff, exclude the delegating agent from the roster
    const excludeAgentIds = sourceAgentId ? [sourceAgentId] : undefined;
    const systemPrompt = this.availableAgents.length > 1
      ? buildWorkflowAgentSystemPrompt(
          agentConfig,
          this.workspaceRoot,
          this.availableAgents,
          agentId,
          transcriptContext,
          excludeAgentIds,
        )
      : buildAgentSystemPrompt(
          agentConfig,
          this.workspaceRoot,
          transcriptContext,
        );

    // Filter tools for this agent
    const tools = this.filterToolsForAgent(agentConfig, resolved.type);

    const sessionOptions: CreateSessionOptions = {
      provider: {
        type: resolved.type,
        name: resolved.type.charAt(0).toUpperCase() + resolved.type.slice(1),
        model: resolved.model,
      },
      systemPrompt,
      tools,
      cwd: this.workspaceRoot,
      metadata: {
        agentId,
        agentName: agentConfig?.name || agentId,
        chatSessionId,
      },
    };

    console.log(`[AgentSessionRegistry] Creating session for agent "${agentConfig?.name || agentId}":`, {
      provider: resolved.type,
      model: resolved.model || 'default',
      systemPromptLength: systemPrompt.length,
      hasCustomPrompt: !!agentConfig?.systemPrompt,
      toolCount: tools.length,
      toolNames: tools.slice(0, 10).map(t => t.name),
    });

    const session = await this.service.createSession(sessionOptions);

    const entry: AgentSessionEntry = {
      aiSessionId: session.id,
      agentId,
      chatSessionId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messageCount: 0,
    };

    chatMap.set(agentId, entry);
    debugLog(`[AgentSessionRegistry] Created session ${session.id} for agent ${agentId} (provider: ${resolved.type}, model: ${resolved.model || 'default'})`);

    return entry;
  }

  /**
   * Look up an agent session (no creation).
   */
  getSession(chatSessionId: string, agentId: string): AgentSessionEntry | undefined {
    return this.registry.get(chatSessionId)?.get(agentId);
  }

  /**
   * List all agent sessions for a chat.
   */
  listSessions(chatSessionId: string): AgentSessionEntry[] {
    const chatMap = this.registry.get(chatSessionId);
    if (!chatMap) return [];
    return Array.from(chatMap.values());
  }

  /**
   * Delete all agent sessions for a chat.
   */
  deleteChatSessions(chatSessionId: string): void {
    const chatMap = this.registry.get(chatSessionId);
    if (!chatMap) return;

    for (const entry of chatMap.values()) {
      this.service.deleteSession(entry.aiSessionId);
    }
    this.registry.delete(chatSessionId);
    debugLog(`[AgentSessionRegistry] Deleted all sessions for chat ${chatSessionId}`);
  }

  /**
   * Delete a single agent session.
   */
  deleteAgentSession(chatSessionId: string, agentId: string): void {
    const chatMap = this.registry.get(chatSessionId);
    if (!chatMap) return;

    const entry = chatMap.get(agentId);
    if (entry) {
      this.service.deleteSession(entry.aiSessionId);
      chatMap.delete(agentId);
      debugLog(`[AgentSessionRegistry] Deleted session for agent ${agentId} in chat ${chatSessionId}`);
    }
  }

  /**
   * Delete all sessions for a specific agent across all chats.
   * Used when an agent's config changes and sessions need to be recreated.
   */
  deleteAllSessionsForAgent(agentId: string): void {
    let count = 0;
    for (const [, chatMap] of this.registry) {
      const entry = chatMap.get(agentId);
      if (entry) {
        this.service.deleteSession(entry.aiSessionId);
        chatMap.delete(agentId);
        count++;
      }
    }
    if (count > 0) {
      debugLog(`[AgentSessionRegistry] Invalidated ${count} session(s) for agent ${agentId}`);
    }
  }

  /**
   * Filter tools based on agent's allowedTools/deniedTools config.
   */
  private filterToolsForAgent(
    agentConfig: IAgentConfig | undefined,
    providerType: AIProviderType,
  ): ToolDefinition[] {
    let tools = this.service.getToolsForProvider(providerType);

    if (agentConfig?.allowedTools?.length) {
      const allowedSet = new Set(agentConfig.allowedTools);
      tools = tools.filter(t => allowedSet.has(t.name));
    }

    if (agentConfig?.deniedTools?.length) {
      const deniedSet = new Set(agentConfig.deniedTools);
      tools = tools.filter(t => !deniedSet.has(t.name));
    }

    return tools;
  }

  /**
   * Resolve provider type and model from an agent's model string.
   * Uses heuristic mapping for common model name patterns.
   */
  private resolveProviderAndModel(
    agentProvider?: string,
    agentModel?: string,
    fallbackType?: AIProviderType,
    fallbackModel?: string,
  ): { type: AIProviderType; model?: string } {
    // If agent has an explicit provider, use it directly
    if (agentProvider) {
      return {
        type: agentProvider as AIProviderType,
        model: agentModel || fallbackModel,
      };
    }

    if (!agentModel) {
      return { type: fallbackType || 'claude', model: fallbackModel };
    }

    // Infer provider from model name
    const lower = agentModel.toLowerCase();

    // Claude models
    if (lower.includes('claude') || lower.includes('opus') || lower.includes('sonnet') || lower.includes('haiku')) {
      return { type: 'claude', model: agentModel };
    }

    // OpenAI models
    if (lower.includes('gpt') || lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4')) {
      return { type: 'openai', model: agentModel };
    }

    // Gemini models
    if (lower.includes('gemini') || lower.includes('palm')) {
      return { type: 'gemini', model: agentModel };
    }

    // Ollama models (common local model names)
    if (lower.includes('llama') || lower.includes('mistral') || lower.includes('codellama') || lower.includes('deepseek')) {
      return { type: 'ollama', model: agentModel };
    }

    // Unrecognized — use as model name with fallback provider
    console.warn(`[AgentSessionRegistry] Unrecognized model "${agentModel}", using fallback provider ${fallbackType || 'claude'}`);
    return { type: fallbackType || 'claude', model: agentModel };
  }
}
