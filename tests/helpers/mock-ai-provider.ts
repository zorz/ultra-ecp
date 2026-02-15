/**
 * Mock AI Provider for Testing
 *
 * A scriptable AI provider that returns queued responses without making
 * real API calls. Supports text responses, tool use content blocks,
 * and DelegateToAgent handoff simulation.
 */

import type {
  AIProviderType,
  AIProviderConfig,
  AIProviderCapabilities,
  AIResponse,
  StopReason,
  StreamEvent,
  MessageContent,
} from '../../src/services/ai/types.ts';
import type { AIProvider, ChatCompletionRequest } from '../../src/services/ai/providers/base.ts';

/**
 * A scripted response that the mock provider will return.
 */
export interface ScriptedResponse {
  /** Content blocks to return */
  content: MessageContent[];
  /** Stop reason for this response */
  stopReason: StopReason;
  /** Simulated token usage */
  usage?: { inputTokens: number; outputTokens: number };
  /** Optional error to throw instead of returning */
  error?: string;
}

/**
 * Mock AI Provider that returns scripted responses.
 */
export class MockAIProvider implements AIProvider {
  readonly type: AIProviderType = 'claude';
  readonly name = 'MockProvider';
  readonly config: AIProviderConfig;

  /** Queued responses consumed in FIFO order */
  private responseQueue: ScriptedResponse[] = [];

  /** All requests received by this provider */
  public receivedRequests: ChatCompletionRequest[] = [];

  /** Count of chat calls made */
  public chatCallCount = 0;

  /** Monotonic counter for unique message IDs */
  private idCounter = 0;

  constructor(config?: Partial<AIProviderConfig>) {
    this.config = {
      type: 'claude',
      name: 'MockProvider',
      model: 'mock-model',
      ...config,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Scripting API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Queue a simple text response.
   */
  queueResponse(text: string, stopReason: StopReason = 'end_turn'): void {
    this.responseQueue.push({
      content: [{ type: 'text', text }],
      stopReason,
      usage: { inputTokens: 100, outputTokens: text.length },
    });
  }

  /**
   * Queue a response containing a tool use block followed by text.
   */
  queueToolUse(
    toolName: string,
    input: Record<string, unknown>,
    finalText?: string,
  ): void {
    const content: MessageContent[] = [
      {
        type: 'tool_use',
        id: `toolu_mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: toolName,
        input,
      },
    ];
    if (finalText) {
      content.push({ type: 'text', text: finalText });
    }

    this.responseQueue.push({
      content,
      stopReason: 'tool_use',
      usage: { inputTokens: 150, outputTokens: 50 },
    });
  }

  /**
   * Queue a DelegateToAgent handoff.
   */
  queueHandoff(targetAgentId: string, message: string): void {
    this.queueToolUse('DelegateToAgent', {
      agentId: targetAgentId,
      message,
    });
  }

  /**
   * Queue an error response.
   */
  queueError(message: string): void {
    this.responseQueue.push({
      content: [],
      stopReason: 'error',
      error: message,
    });
  }

  /**
   * Get the number of remaining queued responses.
   */
  get remainingResponses(): number {
    return this.responseQueue.length;
  }

  /**
   * Reset all state.
   */
  reset(): void {
    this.responseQueue = [];
    this.receivedRequests = [];
    this.chatCallCount = 0;
    this.idCounter = 0;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // AIProvider Interface Implementation
  // ─────────────────────────────────────────────────────────────────────────

  getCapabilities(): AIProviderCapabilities {
    return {
      toolUse: true,
      streaming: true,
      vision: false,
      systemMessages: true,
      maxContextTokens: 200000,
      maxOutputTokens: 8192,
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async getAvailableModels(): Promise<string[]> {
    return ['mock-model'];
  }

  async chat(request: ChatCompletionRequest): Promise<AIResponse> {
    this.receivedRequests.push(request);
    this.chatCallCount++;

    const queued = this.responseQueue.shift();
    if (!queued) {
      // Default response when queue is empty
      return {
        message: {
          id: `msg_mock_${++this.idCounter}`,
          role: 'assistant',
          content: [{ type: 'text', text: '(Mock: no response queued)' }],
          timestamp: Date.now(),
        },
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    }

    if (queued.error) {
      throw new Error(queued.error);
    }

    return {
      message: {
        id: `msg_mock_${++this.idCounter}`,
        role: 'assistant',
        content: queued.content,
        timestamp: Date.now(),
      },
      stopReason: queued.stopReason,
      usage: queued.usage ?? { inputTokens: 100, outputTokens: 50 },
    };
  }

  async chatStream(
    request: ChatCompletionRequest,
    onEvent: (event: StreamEvent) => void,
  ): Promise<AIResponse> {
    this.receivedRequests.push(request);
    this.chatCallCount++;

    const queued = this.responseQueue.shift();
    if (!queued) {
      onEvent({ type: 'message_start' } as StreamEvent);
      onEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '(Mock: no response queued)' },
      } as unknown as StreamEvent);
      onEvent({ type: 'message_stop' } as StreamEvent);

      return {
        message: {
          id: `msg_mock_${++this.idCounter}`,
          role: 'assistant',
          content: [{ type: 'text', text: '(Mock: no response queued)' }],
          timestamp: Date.now(),
        },
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    }

    if (queued.error) {
      onEvent({
        type: 'error',
        error: { message: queued.error },
      } as unknown as StreamEvent);
      throw new Error(queued.error);
    }

    // Emit stream events simulating the provider's streaming behavior
    onEvent({ type: 'message_start' } as StreamEvent);

    for (let i = 0; i < queued.content.length; i++) {
      const block = queued.content[i]!;

      if (block.type === 'text') {
        onEvent({
          type: 'content_block_start',
          index: i,
          content_block: { type: 'text', text: '' },
        } as unknown as StreamEvent);

        // Stream text in chunks
        const text = (block as { text: string }).text;
        const chunkSize = Math.max(10, Math.ceil(text.length / 3));
        for (let j = 0; j < text.length; j += chunkSize) {
          const chunk = text.slice(j, j + chunkSize);
          onEvent({
            type: 'content_block_delta',
            index: i,
            delta: { type: 'text_delta', text: chunk },
          } as unknown as StreamEvent);
        }

        onEvent({ type: 'content_block_stop', index: i } as unknown as StreamEvent);
      } else if (block.type === 'tool_use') {
        const toolBlock = block as { id: string; name: string; input: unknown };
        onEvent({
          type: 'content_block_start',
          index: i,
          content_block: { type: 'tool_use', id: toolBlock.id, name: toolBlock.name },
        } as unknown as StreamEvent);

        onEvent({
          type: 'content_block_delta',
          index: i,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolBlock.input) },
        } as unknown as StreamEvent);

        onEvent({ type: 'content_block_stop', index: i } as unknown as StreamEvent);
      }
    }

    onEvent({
      type: 'message_delta',
      delta: { stop_reason: queued.stopReason },
      usage: queued.usage ?? { output_tokens: 50 },
    } as unknown as StreamEvent);

    onEvent({ type: 'message_stop' } as StreamEvent);

    return {
      message: {
        id: `msg_mock_${++this.idCounter}`,
        role: 'assistant',
        content: queued.content,
        timestamp: Date.now(),
      },
      stopReason: queued.stopReason,
      usage: queued.usage ?? { inputTokens: 100, outputTokens: 50 },
    };
  }

  cancel(): void {
    // No-op for mock
  }
}
