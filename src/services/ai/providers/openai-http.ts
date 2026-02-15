/**
 * OpenAI HTTP API Provider
 *
 * Implements the AI provider interface using OpenAI's HTTP API directly.
 * Used for AI critics and other cases where CLI tools aren't suitable.
 */

import {
  BaseAIProvider,
  registerProvider,
  type ChatCompletionRequest,
} from './base.ts';
import type {
  AIProviderType,
  AIProviderConfig,
  AIProviderCapabilities,
  AIResponse,
  ChatMessage,
  StreamEvent,
  TextContent,
  ToolUseContent,
  ToolResultContent,
} from '../types.ts';
import { debugLog, isDebugEnabled } from '../../../debug.ts';
import { localSecretService } from '../../secret/local.ts';

/**
 * OpenAI API message format.
 */
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

/**
 * OpenAI Chat API response format.
 */
interface OpenAIChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}


/**
 * Convert our messages to OpenAI API format.
 */
function formatMessagesForOpenAI(
  messages: ChatMessage[],
  systemPrompt?: string
): OpenAIMessage[] {
  const formatted: OpenAIMessage[] = [];

  // Add system prompt first
  if (systemPrompt) {
    formatted.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of messages) {
    // Extract text content
    const textParts = msg.content
      .filter((c): c is TextContent => c.type === 'text')
      .map((c) => c.text);

    // Handle tool results specially
    const toolResults = msg.content
      .filter((c): c is ToolResultContent => c.type === 'tool_result');

    if (toolResults.length > 0) {
      // Each tool result becomes a separate message
      for (const result of toolResults) {
        const content = typeof result.content === 'string'
          ? result.content
          : JSON.stringify(result.content);
        formatted.push({
          role: 'tool',
          content,
          tool_call_id: result.toolUseId,
        });
      }
      continue;
    }

    // Handle tool use (from assistant)
    const toolUses = msg.content
      .filter((c): c is ToolUseContent => c.type === 'tool_use');

    if (toolUses.length > 0 && msg.role === 'assistant') {
      formatted.push({
        role: 'assistant',
        content: textParts.join('\n') || null,
        tool_calls: toolUses.map((tu) => ({
          id: tu.id,
          type: 'function' as const,
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input),
          },
        })),
      });
      continue;
    }

    // Regular text message
    const text = textParts.join('\n');
    if (!text.trim()) continue;

    formatted.push({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: text,
    });
  }

  return formatted;
}

/**
 * OpenAI HTTP API provider implementation.
 */
export class OpenAIHTTPProvider extends BaseAIProvider {
  readonly type: AIProviderType = 'openai';
  readonly name = 'OpenAI (HTTP)';

  private apiKey: string | null = null;
  private baseUrl: string;

  constructor(config: AIProviderConfig) {
    super(config);
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
  }

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[OpenAIHTTPProvider] ${msg}`);
    }
  }

  getCapabilities(): AIProviderCapabilities {
    return {
      streaming: true,
      toolUse: true,
      vision: true,
      systemMessages: true,
      maxContextTokens: 128000,
      maxOutputTokens: 16384,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const apiKey = await this.getApiKey();
      return !!apiKey;
    } catch {
      return false;
    }
  }

  private async getApiKey(): Promise<string> {
    if (this.apiKey) {
      this.log('Using cached API key');
      return this.apiKey;
    }

    // Try config first
    if (this.config.apiKey) {
      this.log('Using API key from config');
      this.apiKey = this.config.apiKey;
      return this.apiKey;
    }

    // Try secret service (check both naming conventions)
    try {
      await localSecretService.init();
      this.log('Checking secret service for OPENAI_API_KEY...');
      const secret = await localSecretService.get('OPENAI_API_KEY');
      if (secret) {
        this.log('Found OPENAI_API_KEY in secret service');
        this.apiKey = secret;
        return this.apiKey;
      }
      this.log('OPENAI_API_KEY not found, trying openai-api-key...');
      const secretAlt = await localSecretService.get('openai-api-key');
      if (secretAlt) {
        this.log('Found openai-api-key in secret service');
        this.apiKey = secretAlt;
        return this.apiKey;
      }
      this.log('No API key found in secret service');
    } catch (err) {
      this.log(`Secret service error: ${err}`);
    }

    // Try environment
    const envKey = process.env.OPENAI_API_KEY;
    if (envKey) {
      this.log('Using API key from environment variable');
      this.apiKey = envKey;
      return this.apiKey;
    }

    this.log('No API key found anywhere');
    throw new Error('OpenAI API key not found');
  }

  async getAvailableModels(): Promise<string[]> {
    return [
      'gpt-5.2',
      'gpt-5.2-pro',
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4.1-nano',
      'o3',
      'o3-mini',
      'o3-pro',
      'o4-mini',
    ];
  }

  async chat(request: ChatCompletionRequest): Promise<AIResponse> {
    const apiKey = await this.getApiKey();
    const model = this.config.model || 'gpt-4o';

    this.log(`Chat request to ${model}`);

    const messages = formatMessagesForOpenAI(request.messages, request.systemPrompt);

    // Newer models (gpt-5.x, o1, o3) use max_completion_tokens instead of max_tokens
    const useNewTokenParam = model.startsWith('gpt-5') || model.startsWith('gpt-4.1') || /^o[1-9]/.test(model);
    const tokenParam = useNewTokenParam ? 'max_completion_tokens' : 'max_tokens';

    const body: Record<string, unknown> = {
      model,
      messages,
      [tokenParam]: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.7,
    };

    // Add tools if provided
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: request.abortSignal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as OpenAIChatResponse;
    return this.parseChatResponse(data);
  }

  async chatStream(
    request: ChatCompletionRequest,
    onEvent: (event: StreamEvent) => void
  ): Promise<AIResponse> {
    const apiKey = await this.getApiKey();
    const model = this.config.model || 'gpt-4o';

    this.log(`Stream chat request to ${model}`);

    const messages = formatMessagesForOpenAI(request.messages, request.systemPrompt);

    // Newer models (gpt-5.x, o1, o3) use max_completion_tokens instead of max_tokens
    const useNewTokenParam = model.startsWith('gpt-5') || model.startsWith('gpt-4.1') || /^o[1-9]/.test(model);
    const tokenParam = useNewTokenParam ? 'max_completion_tokens' : 'max_tokens';

    const body: Record<string, unknown> = {
      model,
      messages,
      [tokenParam]: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.7,
      stream: true,
    };

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: request.abortSignal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
    }

    // Parse SSE stream
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let fullText = '';
    const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();

    onEvent({ type: 'message_start', message: { id: '', role: 'assistant' } });

    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;

        try {
          const event = JSON.parse(data);
          const delta = event.choices?.[0]?.delta;

          if (delta?.content) {
            fullText += delta.content;
            onEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content } });
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const existing = toolCalls.get(tc.index) || { id: '', name: '', arguments: '' };
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name = tc.function.name;
              if (tc.function?.arguments) existing.arguments += tc.function.arguments;
              toolCalls.set(tc.index, existing);
            }
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    // Detect empty response before finalizing
    if (!fullText.trim() && toolCalls.size === 0) {
      onEvent({
        type: 'error',
        error: { message: 'The API returned an empty response. The model may be unavailable or the request was rejected.' },
      } as StreamEvent);
      throw new Error('API returned empty response');
    }

    onEvent({ type: 'message_stop' });

    // Build final response
    const content: Array<TextContent | ToolUseContent> = [];
    if (fullText) {
      content.push({ type: 'text', text: fullText });
    }
    for (const tc of toolCalls.values()) {
      try {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: JSON.parse(tc.arguments),
        });
      } catch {
        // Invalid JSON in arguments
      }
    }

    return {
      message: {
        id: `msg-${Date.now()}`,
        role: 'assistant',
        content,
        timestamp: Date.now(),
      },
      stopReason: toolCalls.size > 0 ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  private parseChatResponse(data: OpenAIChatResponse): AIResponse {
    const choice = data.choices[0];
    if (!choice) {
      throw new Error('No response choice from OpenAI');
    }

    const content: Array<TextContent | ToolUseContent> = [];

    if (choice.message.content) {
      content.push({ type: 'text', text: choice.message.content });
    }

    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        try {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments),
          });
        } catch {
          // Invalid JSON in arguments
        }
      }
    }

    let stopReason: AIResponse['stopReason'] = 'end_turn';
    if (choice.finish_reason === 'tool_calls') {
      stopReason = 'tool_use';
    } else if (choice.finish_reason === 'length') {
      stopReason = 'max_tokens';
    }

    return {
      message: {
        id: data.id,
        role: 'assistant',
        content,
        timestamp: Date.now(),
      },
      stopReason,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }

  override cancel(): void {
    // HTTP requests are cancelled via AbortController
  }
}

/**
 * Create an OpenAI HTTP provider instance.
 */
export function createOpenAIHTTPProvider(config: AIProviderConfig): OpenAIHTTPProvider {
  return new OpenAIHTTPProvider(config);
}

// Register as HTTP provider for 'openai'
registerProvider('openai', (config) => new OpenAIHTTPProvider(config), true);
