/**
 * Compaction Service — summarizes old messages to reduce context window usage.
 *
 * Uses an AI session to generate a summary of older messages, then stores
 * the compaction record and marks original messages as inactive via Rust.
 */

import type { LocalAIService } from './local.ts';
import type { StoredChatMessage } from '../chat/storage.ts';
import { estimateTokens } from './context-window.ts';
import { debugLog } from '../../debug.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface CompactionResult {
  compactionId: string;
  summary: string;
  messagesCompacted: number;
  originalTokenCount: number;
  compressedTokenCount: number;
}

export interface CompactOptions {
  sessionId: string;
  messages: StoredChatMessage[];
  /** Number of recent messages to keep uncompacted (default: 10) */
  keepRecentCount?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// CompactionService
// ─────────────────────────────────────────────────────────────────────────────

export class CompactionService {
  constructor(
    private aiService: LocalAIService,
    private ecpRequest: (method: string, params?: unknown) => Promise<unknown>,
  ) {}

  /**
   * Compact older messages in a session into a summary.
   *
   * Flow:
   * 1. Select messages to compact (all except keepRecentCount most recent)
   * 2. Build conversation text with agent attribution
   * 3. Create a temp AI session to generate summary
   * 4. Store compaction record via Rust
   * 5. Apply compaction (mark messages inactive) via Rust
   * 6. Clean up temp session
   */
  async compact(options: CompactOptions): Promise<CompactionResult> {
    const { sessionId, messages, keepRecentCount = 10 } = options;

    // Select messages to compact
    const toCompact = messages.slice(0, Math.max(0, messages.length - keepRecentCount));

    if (toCompact.length < 3) {
      throw new Error(`Not enough messages to compact (need at least 3, got ${toCompact.length})`);
    }

    debugLog(`[CompactionService] Compacting ${toCompact.length} messages for session ${sessionId}`);

    // Build conversation text with agent attribution
    const conversationText = toCompact
      .map(msg => {
        const speaker = msg.agentName
          ? `${msg.agentName} (${msg.role})`
          : msg.role;
        const content = msg.content.length > 1000
          ? msg.content.slice(0, 1000) + '...'
          : msg.content;
        return `[${speaker}]: ${content}`;
      })
      .join('\n\n');

    // Estimate original tokens
    const originalTokenCount = toCompact.reduce(
      (sum, msg) => sum + estimateTokens(msg.content),
      0,
    );

    // Create temp AI session for summarization (no tools needed)
    let tempSessionId: string | undefined;
    let summary: string;

    try {
      const tempSession = await this.aiService.createSession({
        provider: { type: 'claude', name: 'Claude', model: 'claude-sonnet-4-20250514' },
        systemPrompt: 'You are a conversation summarizer. Be concise but comprehensive.',
      });
      tempSessionId = tempSession.id;

      // Send summarization prompt
      const prompt = [
        `Summarize this conversation (${toCompact.length} messages) for context continuity.`,
        'Preserve: key decisions, file paths, code changes, errors, outstanding tasks.',
        'Be concise but comprehensive. Use bullet points.',
        '',
        '---',
        conversationText,
      ].join('\n');

      const response = await this.aiService.sendMessage({
        sessionId: tempSessionId,
        content: prompt,
      });

      // Extract text from response message
      summary = response.message.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('\n');

      if (!summary || summary.trim().length === 0) {
        throw new Error('AI summarization returned empty response');
      }
    } finally {
      // Clean up temp session
      if (tempSessionId) {
        try {
          this.aiService.deleteSession(tempSessionId);
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    const compressedTokenCount = estimateTokens(summary);

    // Store compaction record via Rust
    // Safe: we already validated toCompact.length >= 3
    const firstMsg = toCompact[0] as StoredChatMessage;
    const lastMsg = toCompact[toCompact.length - 1] as StoredChatMessage;
    const startMessageId = firstMsg.id;
    const endMessageId = lastMsg.id;

    const createResult = await this.ecpRequest('chat/compaction/create', {
      sessionId,
      summary,
      startMessageId,
      endMessageId,
      messagesCompacted: toCompact.length,
      originalTokenCount,
      compressedTokenCount,
    }) as { compactionId: string };

    const compactionId = createResult.compactionId;

    // Apply compaction — mark messages as inactive
    const messageIds = toCompact.map(m => m.id);
    await this.ecpRequest('chat/compaction/apply', {
      compactionId,
      messageIds,
    });

    debugLog(`[CompactionService] Compacted ${toCompact.length} messages → ${compressedTokenCount} tokens (was ${originalTokenCount})`);

    return {
      compactionId,
      summary,
      messagesCompacted: toCompact.length,
      originalTokenCount,
      compressedTokenCount,
    };
  }
}
