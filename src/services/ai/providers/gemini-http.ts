/**
 * Gemini HTTP API Provider
 *
 * Implements the AI provider interface using Google's Gemini HTTP API directly.
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
} from '../types.ts';
import { debugLog, isDebugEnabled } from '../../../debug.ts';
import { localSecretService } from '../../secret/local.ts';

/**
 * Gemini API content format.
 */
interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{
    text?: string;
    functionCall?: {
      name: string;
      args: Record<string, unknown>;
    };
    functionResponse?: {
      name: string;
      response: Record<string, unknown>;
    };
    /** Gemini thought signature - required for multi-turn tool use in Gemini 3+ */
    thoughtSignature?: string;
  }>;
}

/**
 * Gemini API response format.
 */
interface GeminiResponse {
  candidates: Array<{
    content: {
      role: string;
      parts: Array<{
        text?: string;
        functionCall?: {
          name: string;
          args: Record<string, unknown>;
        };
        /** Gemini thought signature for function calls */
        thoughtSignature?: string;
      }>;
    };
    finishReason: string;
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

/**
 * Convert our messages to Gemini API format.
 */
function formatMessagesForGemini(
  messages: ChatMessage[],
  systemPrompt?: string
): { contents: GeminiContent[]; systemInstruction?: { parts: Array<{ text: string }> } } {
  const contents: GeminiContent[] = [];
  let systemInstruction: { parts: Array<{ text: string }> } | undefined;

  // System prompt goes in systemInstruction
  if (systemPrompt) {
    systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  for (const msg of messages) {
    const parts: GeminiContent['parts'] = [];

    for (const content of msg.content) {
      if (content.type === 'text') {
        parts.push({ text: content.text });
      } else if (content.type === 'tool_use') {
        // Include thoughtSignature if present (required for Gemini 3+)
        const part: GeminiContent['parts'][0] = {
          functionCall: {
            name: content.name,
            args: content.input as Record<string, unknown>,
          },
        };
        if (content.thoughtSignature) {
          part.thoughtSignature = content.thoughtSignature;
        }
        parts.push(part);
      } else if (content.type === 'tool_result') {
        const response = typeof content.content === 'string'
          ? { result: content.content }
          : content.content as Record<string, unknown>;
        parts.push({
          functionResponse: {
            name: content.toolUseId, // Gemini uses the function name here
            response,
          },
        });
      }
    }

    if (parts.length === 0) continue;

    // Map roles
    const role = msg.role === 'assistant' ? 'model' : 'user';
    contents.push({ role, parts });
  }

  return { contents, systemInstruction };
}

/**
 * Gemini HTTP API provider implementation.
 */
export class GeminiHTTPProvider extends BaseAIProvider {
  readonly type: AIProviderType = 'gemini';
  readonly name = 'Gemini (HTTP)';

  private apiKey: string | null = null;
  private baseUrl: string;

  constructor(config: AIProviderConfig) {
    super(config);
    this.baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
  }

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[GeminiHTTPProvider] ${msg}`);
    }
  }

  getCapabilities(): AIProviderCapabilities {
    return {
      streaming: true,
      toolUse: true,
      vision: true,
      systemMessages: true,
      maxContextTokens: 2000000,
      maxOutputTokens: 65536,
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
      this.log('Checking secret service for GEMINI_API_KEY...');
      const geminiSecret = await localSecretService.get('GEMINI_API_KEY');
      if (geminiSecret) {
        this.log('Found GEMINI_API_KEY in secret service');
        this.apiKey = geminiSecret;
        return this.apiKey;
      }
      this.log('GEMINI_API_KEY not found, trying GOOGLE_API_KEY...');
      const googleSecret = await localSecretService.get('GOOGLE_API_KEY');
      if (googleSecret) {
        this.log('Found GOOGLE_API_KEY in secret service');
        this.apiKey = googleSecret;
        return this.apiKey;
      }
      this.log('GOOGLE_API_KEY not found, trying gemini-api-key...');
      const altSecret = await localSecretService.get('gemini-api-key');
      if (altSecret) {
        this.log('Found gemini-api-key in secret service');
        this.apiKey = altSecret;
        return this.apiKey;
      }
      this.log('No API key found in secret service');
    } catch (err) {
      this.log(`Secret service error: ${err}`);
    }

    // Try environment
    const envKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (envKey) {
      this.log('Using API key from environment variable');
      this.apiKey = envKey;
      return this.apiKey;
    }

    this.log('No API key found anywhere');
    throw new Error('Gemini API key not found');
  }

  async getAvailableModels(): Promise<string[]> {
    return [
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-1.5-pro',
      'gemini-1.5-flash',
      'gemini-3-pro',
    ];
  }

  async chat(request: ChatCompletionRequest): Promise<AIResponse> {
    const apiKey = await this.getApiKey();
    const model = this.config.model || 'gemini-1.5-pro';

    this.log(`Chat request to ${model}`);

    const { contents, systemInstruction } = formatMessagesForGemini(
      request.messages,
      request.systemPrompt
    );

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 0.7,
      },
    };

    if (systemInstruction) {
      body.systemInstruction = systemInstruction;
    }

    // Add tools if provided
    if (request.tools && request.tools.length > 0) {
      body.tools = [{
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        })),
      }];
    }

    const url = `${this.baseUrl}/models/${model}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: request.abortSignal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as GeminiResponse;
    return this.parseResponse(data);
  }

  async chatStream(
    request: ChatCompletionRequest,
    onEvent: (event: StreamEvent) => void
  ): Promise<AIResponse> {
    const apiKey = await this.getApiKey();
    const model = this.config.model || 'gemini-1.5-pro';

    this.log(`Stream chat request to ${model}`);

    const { contents, systemInstruction } = formatMessagesForGemini(
      request.messages,
      request.systemPrompt
    );

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 0.7,
      },
    };

    if (systemInstruction) {
      body.systemInstruction = systemInstruction;
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = [{
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        })),
      }];
    }

    const url = `${this.baseUrl}/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: request.abortSignal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${errorText}`);
    }

    // Parse SSE stream
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let fullText = '';
    const functionCalls: Array<{ name: string; args: Record<string, unknown>; thoughtSignature?: string }> = [];

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

        try {
          const event = JSON.parse(data) as GeminiResponse;
          const candidate = event.candidates?.[0];
          if (!candidate) continue;

          for (const part of candidate.content?.parts || []) {
            if (part.text) {
              fullText += part.text;
              onEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part.text } });
            }
            if (part.functionCall) {
              functionCalls.push({
                name: part.functionCall.name,
                args: part.functionCall.args,
                thoughtSignature: part.thoughtSignature,
              });
            }
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    onEvent({ type: 'message_stop' });

    // Build final response
    const content: Array<TextContent | ToolUseContent> = [];
    if (fullText) {
      content.push({ type: 'text', text: fullText });
    }
    for (let i = 0; i < functionCalls.length; i++) {
      const fc = functionCalls[i]!;
      content.push({
        type: 'tool_use',
        id: `call-${Date.now()}-${i}`,
        name: fc.name,
        input: fc.args,
        thoughtSignature: fc.thoughtSignature,
      });
    }

    return {
      message: {
        id: `msg-${Date.now()}`,
        role: 'assistant',
        content,
        timestamp: Date.now(),
      },
      stopReason: functionCalls.length > 0 ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  private parseResponse(data: GeminiResponse): AIResponse {
    const candidate = data.candidates?.[0];
    if (!candidate) {
      throw new Error('No response candidate from Gemini');
    }

    const content: Array<TextContent | ToolUseContent> = [];

    for (const part of candidate.content?.parts || []) {
      if (part.text) {
        content.push({ type: 'text', text: part.text });
      }
      if (part.functionCall) {
        content.push({
          type: 'tool_use',
          id: `call-${Date.now()}`,
          name: part.functionCall.name,
          input: part.functionCall.args,
          thoughtSignature: part.thoughtSignature,
        });
      }
    }

    let stopReason: AIResponse['stopReason'] = 'end_turn';
    if (candidate.finishReason === 'STOP') {
      stopReason = content.some(c => c.type === 'tool_use') ? 'tool_use' : 'end_turn';
    } else if (candidate.finishReason === 'MAX_TOKENS') {
      stopReason = 'max_tokens';
    }

    return {
      message: {
        id: `msg-${Date.now()}`,
        role: 'assistant',
        content,
        timestamp: Date.now(),
      },
      stopReason,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }

  override cancel(): void {
    // HTTP requests are cancelled via AbortController
  }
}

/**
 * Create a Gemini HTTP provider instance.
 */
export function createGeminiHTTPProvider(config: AIProviderConfig): GeminiHTTPProvider {
  return new GeminiHTTPProvider(config);
}

// Register as HTTP provider for 'gemini'
registerProvider('gemini', (config) => new GeminiHTTPProvider(config), true);
