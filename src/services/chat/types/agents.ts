/**
 * Agent Types for Multi-Agent Orchestration
 *
 * Defines the types and interfaces for managing multiple AI agents
 * within a conversation.
 */

import type { IAgentMessage, IUsageStats } from './messages.ts';
import type { AgentAgency } from './workflow-schema.ts';

/**
 * Agent role - determines the agent's responsibilities.
 */
export type AgentRole = 'primary' | 'specialist' | 'reviewer' | 'orchestrator';

/**
 * Agent status.
 */
export type AgentStatus = 'idle' | 'thinking' | 'executing' | 'waiting' | 'error';

/**
 * Agent configuration.
 */
export interface IAgentConfig {
  /** Unique agent identifier */
  id: string;
  /** Display name for the agent */
  name: string;
  /** Role in the conversation */
  role: AgentRole;
  /** Provider type for this agent (e.g. 'anthropic', 'openai', 'gemini') */
  provider?: string;
  /** Model to use for this agent */
  model?: string;
  /** System prompt for this agent */
  systemPrompt?: string;
  /** Tools this agent can use */
  allowedTools?: string[];
  /** Tools this agent cannot use */
  deniedTools?: string[];
  /** Maximum tokens for responses */
  maxTokens?: number;
  /** Temperature for responses */
  temperature?: number;
  /** Description of the agent's expertise */
  description?: string;
  /** Keywords that trigger this agent (for @mention routing) */
  triggerKeywords?: string[];
  /** Compressed persona text for system prompt injection */
  personaCompressed?: string;
  /** Structured agency definition */
  agency?: AgentAgency;
}

/**
 * Agent instance - runtime state of an agent.
 */
export interface IAgent extends IAgentConfig {
  /** Current status */
  status: AgentStatus;
  /** Last activity timestamp */
  lastActiveAt?: number;
  /** Accumulated usage for this agent */
  totalUsage?: IUsageStats;
  /** Number of messages generated */
  messageCount?: number;
}

/**
 * Agent delegation request - when one agent asks another to handle a task.
 */
export interface IDelegationRequest {
  /** Requesting agent ID */
  fromAgentId: string;
  /** Target agent ID */
  toAgentId: string;
  /** Task description */
  task: string;
  /** Context to pass to the target agent */
  context?: string;
  /** Whether the requesting agent should wait for a response */
  waitForResponse?: boolean;
  /** Maximum time to wait (ms) */
  timeout?: number;
}

/**
 * Agent delegation result.
 */
export interface IDelegationResult {
  /** Whether the delegation was successful */
  success: boolean;
  /** The agent's response (if any) */
  response?: IAgentMessage;
  /** Error message (if failed) */
  error?: string;
  /** Time taken (ms) */
  durationMs?: number;
}

/**
 * Agent mention - parsed @mention from user input.
 */
export interface IAgentMention {
  /** The agent ID mentioned */
  agentId: string;
  /** Position in the original text */
  startIndex: number;
  /** End position in the original text */
  endIndex: number;
  /** The matched text (e.g., "@code-reviewer") */
  matchedText: string;
}

/**
 * Agent manager interface.
 */
export interface IAgentManager {
  /**
   * Register a new agent.
   */
  registerAgent(config: IAgentConfig): IAgent;

  /**
   * Unregister an agent.
   */
  unregisterAgent(agentId: string): void;

  /**
   * Get an agent by ID.
   */
  getAgent(agentId: string): IAgent | undefined;

  /**
   * Get the primary agent.
   */
  getPrimaryAgent(): IAgent;

  /**
   * List all registered agents.
   */
  listAgents(): IAgent[];

  /**
   * Find agents matching a keyword or capability.
   */
  findAgents(query: string): IAgent[];

  /**
   * Parse @mentions from text.
   */
  parseMentions(text: string): {
    mentions: IAgentMention[];
    cleanText: string;
  };

  /**
   * Delegate a task to an agent.
   */
  delegate(request: IDelegationRequest): Promise<IDelegationResult>;

  /**
   * Update agent status.
   */
  updateStatus(agentId: string, status: AgentStatus): void;
}

/**
 * Default agent configurations for common roles.
 */
export const DEFAULT_AGENTS: IAgentConfig[] = [
  {
    id: 'assistant',
    name: 'Assistant',
    role: 'primary',
    description: 'Primary AI assistant for general tasks',
    triggerKeywords: ['assistant', 'ai', 'help'],
  },
  {
    id: 'code-reviewer',
    name: 'Code Reviewer',
    role: 'specialist',
    description: 'Specialized in code review and best practices',
    triggerKeywords: ['reviewer', 'review', 'cr'],
    systemPrompt: 'You are a code reviewer. Focus on code quality, bugs, and best practices.',
  },
  {
    id: 'architect',
    name: 'Architect',
    role: 'specialist',
    description: 'Specialized in system design and architecture',
    triggerKeywords: ['architect', 'design', 'architecture'],
    systemPrompt: 'You are a software architect. Focus on system design, scalability, and maintainability.',
  },
];

/**
 * Parse @mentions from text.
 * Returns the mentions found and the text with mentions removed.
 *
 * @example
 * ```typescript
 * const { mentions, cleanText } = parseAgentMentions("@reviewer please check this code", agents);
 * // mentions: [{ agentId: 'code-reviewer', matchedText: '@reviewer', ... }]
 * // cleanText: "please check this code"
 * ```
 */
export function parseAgentMentions(
  text: string,
  agents: IAgent[]
): { mentions: IAgentMention[]; cleanText: string } {
  const mentionPattern = /@(\w+(?:-\w+)*)/g;
  const mentions: IAgentMention[] = [];
  let cleanText = text;

  let match;
  while ((match = mentionPattern.exec(text)) !== null) {
    const captured = match[1];
    if (!captured) continue;
    const mentionText = captured.toLowerCase();

    // Find matching agent
    const agent = agents.find(
      (a) =>
        a.id.toLowerCase() === mentionText ||
        a.name.toLowerCase() === mentionText ||
        a.triggerKeywords?.some((k) => k.toLowerCase() === mentionText)
    );

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
  for (const mention of mentions.reverse()) {
    cleanText =
      cleanText.slice(0, mention.startIndex) +
      cleanText.slice(mention.endIndex);
  }

  // Clean up extra whitespace
  cleanText = cleanText.trim().replace(/\s+/g, ' ');

  return { mentions: mentions.reverse(), cleanText };
}
