/**
 * Context Window Service — builds curated context for AI session resume.
 *
 * Implements a head/torso/tail model:
 * - Head: System prompt (always included)
 * - Torso: Compaction summaries + active messages (chronological)
 * - Tail: Optional trailing instructions (reserved from budget)
 */

import type { ChatMessage, MessageRole } from './types.ts';
import type { StoredChatMessage, StoredCompaction } from '../chat/storage.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Token estimation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rough token estimate: ~4 chars per token (works for English, good enough for budgeting).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface CuratedContext {
  /** Messages ready for AI session creation */
  messages: ChatMessage[];
  /** Estimated total tokens */
  totalTokens: number;
  /** Max context window */
  contextWindow: number;
  /** Number of active messages included */
  messagesLoaded: number;
  /** Number of compaction summaries included */
  compactionsApplied: number;
  /** Whether the context exceeds the window (needs compaction) */
  exceedsWindow: boolean;
}

export interface ContextBuildParams {
  systemPrompt: string;
  activeMessages: StoredChatMessage[];
  compactions: StoredCompaction[];
  contextWindow: number;
  tailInstructions?: string;
}

export interface ContextWindowStrategy {
  name: string;
  buildContext(params: ContextBuildParams): CuratedContext;
}

// ─────────────────────────────────────────────────────────────────────────────
// Message conversion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a StoredChatMessage to a ChatMessage suitable for AI providers.
 * Filters out tool_call/tool_result roles, empty messages, and placeholders.
 */
function convertMessage(msg: StoredChatMessage): ChatMessage | null {
  // Only include user/assistant/system roles
  if (msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'system') return null;
  // Skip empty or placeholder content
  if (!msg.content || msg.content.trim() === '') return null;
  if (msg.content === '(No response)') return null;
  if (msg.role === 'assistant' && msg.content.trim().length < 5) return null;

  return {
    id: msg.id,
    role: msg.role as MessageRole,
    content: [{ type: 'text', text: msg.content }],
    timestamp: msg.createdAt,
    metadata: msg.agentName ? { agentName: msg.agentName, agentId: msg.agentId } : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RollingContextWindow (default strategy)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default context window strategy using head/torso/tail model.
 *
 * - Head: System prompt. Always included.
 * - Torso: Compaction summaries (as system messages) interleaved with active messages.
 *   If over budget, trim oldest entries first.
 * - Tail: Optional rules/guidelines appended as system message.
 *
 * Response reserve: min(25% of window, 8000 tokens).
 */
export class RollingContextWindow implements ContextWindowStrategy {
  name = 'rolling';

  buildContext(params: ContextBuildParams): CuratedContext {
    const { systemPrompt, activeMessages, compactions, contextWindow, tailInstructions } = params;

    // Budget calculation
    const headTokens = estimateTokens(systemPrompt);
    const tailTokens = tailInstructions ? estimateTokens(tailInstructions) : 0;
    const responseReserve = Math.min(Math.floor(contextWindow * 0.25), 8000);
    const budget = contextWindow - headTokens - tailTokens - responseReserve;

    // Build the set of active message IDs for compaction interleaving check
    const activeMessageIds = new Set(activeMessages.map(m => m.id));

    // Determine which compactions are "applied" (their range messages are NOT in active list)
    // An applied compaction means its original messages were marked inactive
    const appliedCompactions = compactions.filter(c =>
      c.isActive && !activeMessageIds.has(c.startMessageId)
    );

    // Build torso entries: compaction summaries + active messages, chronologically sorted
    interface TorsoEntry {
      type: 'compaction' | 'message';
      timestamp: number;
      tokens: number;
      message?: ChatMessage;
      compaction?: StoredCompaction;
    }

    const torsoEntries: TorsoEntry[] = [];

    // Add compaction summaries as system messages
    for (const c of appliedCompactions) {
      const text = `[Summary of earlier conversation]\n${c.summary}`;
      const msg: ChatMessage = {
        id: `compaction-${c.id}`,
        role: 'system',
        content: [{ type: 'text', text }],
        timestamp: c.createdAt,
      };
      torsoEntries.push({
        type: 'compaction',
        timestamp: c.createdAt,
        tokens: estimateTokens(text),
        message: msg,
        compaction: c,
      });
    }

    // Convert and add active messages
    let messagesLoaded = 0;
    for (const stored of activeMessages) {
      const converted = convertMessage(stored);
      if (converted) {
        torsoEntries.push({
          type: 'message',
          timestamp: stored.createdAt,
          tokens: estimateTokens(stored.content),
          message: converted,
        });
        messagesLoaded++;
      }
    }

    // Sort chronologically
    torsoEntries.sort((a, b) => a.timestamp - b.timestamp);

    // Trim from the front (oldest) if over budget
    let totalTorsoTokens = torsoEntries.reduce((sum, e) => sum + e.tokens, 0);
    let trimmedCompactions = 0;

    while (totalTorsoTokens > budget && torsoEntries.length > 1) {
      const removed = torsoEntries.shift()!;
      totalTorsoTokens -= removed.tokens;
      if (removed.type === 'compaction') trimmedCompactions++;
      if (removed.type === 'message') messagesLoaded--;
    }

    // Build final messages array
    const messages: ChatMessage[] = torsoEntries
      .map(e => e.message!)
      .filter(Boolean);

    // Add tail instructions if present
    if (tailInstructions) {
      messages.push({
        id: 'context-tail',
        role: 'system',
        content: [{ type: 'text', text: tailInstructions }],
        timestamp: Date.now(),
      });
    }

    const totalTokens = headTokens + totalTorsoTokens + tailTokens;
    const compactionsApplied = appliedCompactions.length - trimmedCompactions;

    return {
      messages,
      totalTokens,
      contextWindow,
      messagesLoaded,
      compactionsApplied,
      exceedsWindow: totalTokens + responseReserve > contextWindow,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ContextWindowService
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thin wrapper around a ContextWindowStrategy.
 * Defaults to RollingContextWindow.
 */
export class ContextWindowService {
  private strategy: ContextWindowStrategy;

  constructor(strategy?: ContextWindowStrategy) {
    this.strategy = strategy ?? new RollingContextWindow();
  }

  buildContext(params: ContextBuildParams): CuratedContext {
    return this.strategy.buildContext(params);
  }

  setStrategy(strategy: ContextWindowStrategy): void {
    this.strategy = strategy;
  }

  getStrategyName(): string {
    return this.strategy.name;
  }
}
