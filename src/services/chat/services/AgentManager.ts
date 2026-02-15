/**
 * AgentManager - Multi-Agent Coordination
 *
 * Manages registration, routing, and delegation between multiple AI agents.
 * Supports @mention-based routing and agent specialization.
 */

import { debugLog } from '../../../debug.ts';
import type {
  IAgent,
  IAgentConfig,
  IAgentManager,
  IAgentMention,
  IDelegationRequest,
  IDelegationResult,
  AgentStatus,
  AgentRole,
} from '../types/agents.ts';
import type { IAgentMessage } from '../types/messages.ts';

/** Escape special regex characters in a string for use in new RegExp(). */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Event types emitted by the AgentManager.
 */
export type AgentManagerEvent =
  | { type: 'agent:registered'; agent: IAgent }
  | { type: 'agent:unregistered'; agentId: string }
  | { type: 'agent:status_changed'; agentId: string; status: AgentStatus; previousStatus: AgentStatus }
  | { type: 'delegation:started'; request: IDelegationRequest }
  | { type: 'delegation:completed'; request: IDelegationRequest; result: IDelegationResult };

/**
 * Event listener type.
 */
export type AgentManagerEventListener = (event: AgentManagerEvent) => void;

/**
 * Agent executor function type.
 * This is called when an agent needs to process a message.
 */
export type AgentExecutor = (
  agent: IAgent,
  message: string,
  context: {
    sessionId: string;
    delegatedFrom?: string;
  }
) => Promise<IAgentMessage>;

/**
 * AgentManager implementation.
 */
export class AgentManager implements IAgentManager {
  private agents: Map<string, IAgent> = new Map();
  private primaryAgentId: string | null = null;
  private listeners: Set<AgentManagerEventListener> = new Set();
  private executor: AgentExecutor | null = null;

  /**
   * Set the agent executor function.
   * This must be set before agents can process messages.
   */
  setExecutor(executor: AgentExecutor): void {
    this.executor = executor;
  }

  /**
   * Register a new agent.
   */
  registerAgent(config: IAgentConfig): IAgent {
    const agent: IAgent = {
      ...config,
      status: 'idle',
      lastActiveAt: undefined,
      totalUsage: undefined,
      messageCount: 0,
    };

    this.agents.set(agent.id, agent);

    // Set as primary if it's the first agent or explicitly marked as primary
    if (config.role === 'primary' || this.primaryAgentId === null) {
      this.primaryAgentId = agent.id;
    }

    this.emit({ type: 'agent:registered', agent });
    return agent;
  }

  /**
   * Unregister an agent.
   */
  unregisterAgent(agentId: string): void {
    const existed = this.agents.delete(agentId);

    if (existed) {
      // If we removed the primary agent, try to find another
      if (this.primaryAgentId === agentId) {
        this.primaryAgentId = null;
        for (const [id, agent] of this.agents) {
          if (agent.role === 'primary') {
            this.primaryAgentId = id;
            break;
          }
        }
        // Fall back to first available agent
        if (this.primaryAgentId === null && this.agents.size > 0) {
          this.primaryAgentId = this.agents.keys().next().value ?? null;
        }
      }

      this.emit({ type: 'agent:unregistered', agentId });
    }
  }

  /**
   * Get an agent by ID.
   */
  getAgent(agentId: string): IAgent | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Get the primary agent.
   * Throws if no agents are registered.
   */
  getPrimaryAgent(): IAgent {
    if (this.primaryAgentId === null) {
      throw new Error('No primary agent registered');
    }

    const agent = this.agents.get(this.primaryAgentId);
    if (!agent) {
      throw new Error(`Primary agent ${this.primaryAgentId} not found`);
    }

    return agent;
  }

  /**
   * Check if a primary agent is registered.
   */
  hasPrimaryAgent(): boolean {
    return this.primaryAgentId !== null && this.agents.has(this.primaryAgentId);
  }

  /**
   * List all registered agents.
   */
  listAgents(): IAgent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Find agents matching a keyword or capability.
   */
  findAgents(query: string): IAgent[] {
    const lowerQuery = query.toLowerCase();

    return this.listAgents().filter((agent) => {
      // Match by ID
      if (agent.id.toLowerCase().includes(lowerQuery)) return true;

      // Match by name
      if (agent.name.toLowerCase().includes(lowerQuery)) return true;

      // Match by description
      if (agent.description?.toLowerCase().includes(lowerQuery)) return true;

      // Match by trigger keywords
      if (agent.triggerKeywords?.some((k) => k.toLowerCase().includes(lowerQuery))) {
        return true;
      }

      return false;
    });
  }

  /**
   * Parse @mentions from text and identify target agents.
   * Supports both single-word (@claude) and multi-word (@Ball Buster) mentions.
   */
  parseMentions(text: string): { mentions: IAgentMention[]; cleanText: string } {
    const mentions: IAgentMention[] = [];
    let cleanText = text;

    // First pass: try multi-word agent name matching.
    // For each agent, check if "@<name>" appears in the text (case-insensitive).
    // Sort by name length descending so longer matches take priority.
    const agentsByNameLength = Array.from(this.agents.values())
      .sort((a, b) => b.name.length - a.name.length);

    const usedRanges: Array<[number, number]> = [];

    for (const agent of agentsByNameLength) {
      // Try matching @<agent name> (case-insensitive)
      const pattern = new RegExp(`@${escapeRegex(agent.name)}(?=\\s|$|[.,!?;:])`, 'gi');
      let nameMatch;
      while ((nameMatch = pattern.exec(text)) !== null) {
        // Check if this range overlaps with an existing match
        const start = nameMatch.index;
        const end = start + nameMatch[0].length;
        if (usedRanges.some(([s, e]) => start < e && end > s)) continue;

        mentions.push({
          agentId: agent.id,
          startIndex: start,
          endIndex: end,
          matchedText: nameMatch[0],
        });
        usedRanges.push([start, end]);
      }
    }

    // Second pass: single-word @mentions for IDs, trigger keywords, and partial matches
    const singleWordPattern = /@(\w+(?:-\w+)*)/g;
    let match;
    while ((match = singleWordPattern.exec(text)) !== null) {
      // Skip if this position is already matched by a multi-word mention
      if (usedRanges.some(([s, e]) => match!.index >= s && match!.index < e)) continue;

      const captured = match[1];
      if (!captured) continue;

      const agent = this.findAgentByMention(captured.toLowerCase());
      if (agent) {
        mentions.push({
          agentId: agent.id,
          startIndex: match.index,
          endIndex: match.index + match[0].length,
          matchedText: match[0],
        });
      }
    }

    // Remove mentions from text (in reverse order to preserve indices)
    const sortedMentions = [...mentions].sort((a, b) => b.startIndex - a.startIndex);
    for (const mention of sortedMentions) {
      cleanText =
        cleanText.slice(0, mention.startIndex) +
        cleanText.slice(mention.endIndex);
    }

    // Clean up extra whitespace
    cleanText = cleanText.trim().replace(/\s+/g, ' ');

    return { mentions, cleanText };
  }

  /**
   * Find an agent by single-word mention text (ID, name, or trigger keyword).
   */
  private findAgentByMention(mentionText: string): IAgent | undefined {
    for (const agent of this.agents.values()) {
      // Exact ID match
      if (agent.id.toLowerCase() === mentionText) return agent;

      // Exact name match (single word)
      if (agent.name.toLowerCase() === mentionText) return agent;

      // Trigger keyword match
      if (agent.triggerKeywords?.some((k) => k.toLowerCase() === mentionText)) {
        return agent;
      }
    }
    return undefined;
  }

  /**
   * Delegate a task to an agent.
   */
  async delegate(request: IDelegationRequest): Promise<IDelegationResult> {
    const startTime = Date.now();

    this.emit({ type: 'delegation:started', request });

    const targetAgent = this.agents.get(request.toAgentId);
    if (!targetAgent) {
      const result: IDelegationResult = {
        success: false,
        error: `Agent ${request.toAgentId} not found`,
        durationMs: Date.now() - startTime,
      };
      this.emit({ type: 'delegation:completed', request, result });
      return result;
    }

    if (!this.executor) {
      const result: IDelegationResult = {
        success: false,
        error: 'No agent executor configured',
        durationMs: Date.now() - startTime,
      };
      this.emit({ type: 'delegation:completed', request, result });
      return result;
    }

    try {
      // Update agent status
      this.updateStatus(request.toAgentId, 'thinking');

      // Build the task message with context
      const taskMessage = request.context
        ? `${request.context}\n\nTask: ${request.task}`
        : request.task;

      // Execute the agent
      const response = await this.executor(targetAgent, taskMessage, {
        sessionId: '', // Will be filled by orchestrator
        delegatedFrom: request.fromAgentId,
      });

      // Update agent statistics
      this.updateAgentStats(request.toAgentId, response);

      this.updateStatus(request.toAgentId, 'idle');

      const result: IDelegationResult = {
        success: true,
        response,
        durationMs: Date.now() - startTime,
      };

      this.emit({ type: 'delegation:completed', request, result });
      return result;
    } catch (error) {
      this.updateStatus(request.toAgentId, 'error');

      const result: IDelegationResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };

      this.emit({ type: 'delegation:completed', request, result });
      return result;
    }
  }

  /**
   * Update agent status.
   */
  updateStatus(agentId: string, status: AgentStatus): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const previousStatus = agent.status;
    agent.status = status;
    agent.lastActiveAt = Date.now();

    this.emit({
      type: 'agent:status_changed',
      agentId,
      status,
      previousStatus,
    });
  }

  /**
   * Update agent statistics after a response.
   */
  private updateAgentStats(agentId: string, response: IAgentMessage): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    agent.messageCount = (agent.messageCount ?? 0) + 1;

    if (response.usage) {
      if (!agent.totalUsage) {
        agent.totalUsage = { inputTokens: 0, outputTokens: 0 };
      }
      agent.totalUsage.inputTokens += response.usage.inputTokens;
      agent.totalUsage.outputTokens += response.usage.outputTokens;
    }
  }

  /**
   * Get agent by role.
   */
  getAgentsByRole(role: AgentRole): IAgent[] {
    return this.listAgents().filter((a) => a.role === role);
  }

  /**
   * Set the primary agent explicitly.
   */
  setPrimaryAgent(agentId: string): void {
    if (!this.agents.has(agentId)) {
      throw new Error(`Agent ${agentId} not found`);
    }
    this.primaryAgentId = agentId;
  }

  /**
   * Add an event listener.
   */
  addEventListener(listener: AgentManagerEventListener): void {
    this.listeners.add(listener);
  }

  /**
   * Remove an event listener.
   */
  removeEventListener(listener: AgentManagerEventListener): void {
    this.listeners.delete(listener);
  }

  /**
   * Emit an event to all listeners.
   */
  private emit(event: AgentManagerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        debugLog(`[AgentManager] Event listener error: ${error}`);
      }
    }
  }

  /**
   * Clear all agents and reset state.
   */
  clear(): void {
    this.agents.clear();
    this.primaryAgentId = null;
  }

  /**
   * Get the number of registered agents.
   */
  get size(): number {
    return this.agents.size;
  }
}

/**
 * Create a new AgentManager instance.
 */
export function createAgentManager(): AgentManager {
  return new AgentManager();
}
