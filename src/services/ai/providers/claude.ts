/**
 * Claude CLI Provider
 *
 * Implements the AI provider interface for Claude Code CLI.
 * Uses claude CLI in non-interactive mode with stream-json output.
 */

import {
  BaseAIProvider,
  type ChatCompletionRequest,
  registerProvider,
} from './base.ts';
import type {
  AIProviderType,
  AIProviderConfig,
  AIProviderCapabilities,
  AIResponse,
  ChatMessage,
  StreamEvent,
  ToolDefinition,
  MessageContent,
  TextContent,
  ToolUseContent,
  ToolResultContent,
  generateMessageId,
  generateToolUseId,
} from '../types.ts';
import { debugLog, isDebugEnabled } from '../../../debug.ts';
import settings from '../../../config/settings.ts';
import { localSecretService } from '../../secret/local.ts';

/**
 * Claude CLI stream JSON event types.
 */
interface ClaudeStreamEvent {
  type: string;
  session_id?: string;
  message?: {
    id?: string;
    role?: string;
    content?: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
  content_block?: {
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
  };
  index?: number;
  subtype?: string;
  cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  is_error?: boolean;
  result?: string;
  tool_use_id?: string;
  num_turns?: number;
}

/**
 * Convert our messages to Claude CLI format.
 * Claude CLI accepts messages via stdin as JSON.
 */
function formatMessagesForCli(messages: ChatMessage[]): string {
  // Claude CLI with -p flag takes a single prompt
  // For conversation history, we need to format it as context
  const formattedParts: string[] = [];

  for (const msg of messages) {
    // Extract text content
    const textParts = msg.content
      .filter((c): c is TextContent => c.type === 'text')
      .map((c) => c.text);

    // Extract tool use content (from assistant messages)
    const toolUseParts = msg.content
      .filter((c): c is ToolUseContent => c.type === 'tool_use')
      .map((c) => `[Called tool: ${c.name} with ${JSON.stringify(c.input)}]`);

    // Extract tool result content (from tool messages)
    const toolResultParts = msg.content
      .filter((c): c is ToolResultContent => c.type === 'tool_result')
      .map((c) => {
        const resultStr = typeof c.content === 'string'
          ? c.content
          : JSON.stringify(c.content, null, 2);
        // Truncate very long results to avoid context issues
        const maxLen = 2000;
        const truncated = resultStr.length > maxLen
          ? resultStr.substring(0, maxLen) + `\n... (truncated, ${resultStr.length - maxLen} more chars)`
          : resultStr;
        return `[Tool result for ${c.toolUseId}${c.isError ? ' (ERROR)' : ''}:\n${truncated}]`;
      });

    const allParts = [...textParts, ...toolUseParts, ...toolResultParts];
    const text = allParts.join('\n');

    if (!text.trim()) continue;

    if (msg.role === 'user') {
      formattedParts.push(`User: ${text}`);
    } else if (msg.role === 'assistant') {
      formattedParts.push(`Assistant: ${text}`);
    } else if (msg.role === 'system') {
      // System messages go at the beginning
      formattedParts.unshift(`[System: ${text}]`);
    } else if (msg.role === 'tool') {
      // Tool results are formatted as system-like messages
      formattedParts.push(`${text}`);
    }
  }

  return formattedParts.join('\n\n');
}

/**
 * Format tool definitions for Claude CLI.
 * Handles both string tool names (from ECP) and full ToolDefinition objects.
 */
function formatToolsForCli(tools: (ToolDefinition | string)[]): string {
  if (tools.length === 0) return '';

  const toolDescriptions = tools.map((tool) => {
    // Handle string tool names (from ECP) - just list the name
    if (typeof tool === 'string') {
      return `- ${tool}`;
    }

    // Handle full ToolDefinition objects
    let desc = `- ${tool.name}: ${tool.description}`;
    if (tool.inputSchema?.properties) {
      const params = Object.entries(tool.inputSchema.properties)
        .map(([name, schema]) => {
          const required = tool.inputSchema.required?.includes(name) ? ' (required)' : '';
          return `    - ${name}: ${(schema as { description?: string; type?: string }).description || (schema as { type?: string }).type}${required}`;
        })
        .join('\n');
      desc += `\n  Parameters:\n${params}`;
    }
    return desc;
  });

  return `\n\nAvailable tools:\n${toolDescriptions.join('\n')}`;
}

/**
 * Claude CLI provider implementation.
 */
export class ClaudeProvider extends BaseAIProvider {
  readonly type: AIProviderType = 'claude';
  readonly name = 'Claude';

  private sessionId: string | null = null;

  constructor(config: AIProviderConfig) {
    super(config);
  }

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[ClaudeProvider] ${msg}`);
    }
  }

  getCapabilities(): AIProviderCapabilities {
    return {
      toolUse: true,
      streaming: true,
      vision: true,
      systemMessages: true,
      maxContextTokens: 200000,
      maxOutputTokens: 8192,
    };
  }

  async isAvailable(): Promise<boolean> {
    return this.commandExists('claude');
  }

  async getAvailableModels(): Promise<string[]> {
    // Try to fetch models from Anthropic API if API key is available
    // Check secret service first (keychain), then falls back to env vars
    const apiKey = await localSecretService.get('ANTHROPIC_API_KEY');
    if (apiKey) {
      try {
        const response = await fetch('https://api.anthropic.com/v1/models', {
          headers: {
            'anthropic-version': '2023-06-01',
            'x-api-key': apiKey,
          },
        });

        if (response.ok) {
          const data = await response.json() as {
            data: Array<{ id: string; display_name: string }>;
          };
          const models = data.data.map((m) => m.id);
          this.log(`Fetched ${models.length} models from Anthropic API`);
          return models;
        }
        this.log(`Failed to fetch models from API: ${response.status}`);
      } catch (error) {
        this.log(`Error fetching models from API: ${error}`);
      }
    }

    // Fall back to common model identifiers
    this.log('Using fallback model list (no API key or API error)');
    return [
      'claude-sonnet-4-20250514',
      'claude-opus-4-20250514',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
    ];
  }

  async chat(request: ChatCompletionRequest): Promise<AIResponse> {
    // Try with resume first, retry without if it fails
    const hadSessionId = !!this.sessionId;

    try {
      return await this.doChat(request);
    } catch (error) {
      // If we had a session ID and it failed, try again without resume
      if (hadSessionId) {
        this.log(`Chat failed with session resume, retrying without resume...`);
        this.sessionId = null;
        return await this.doChat(request);
      }
      throw error;
    }
  }

  /**
   * Internal implementation of chat.
   */
  private async doChat(request: ChatCompletionRequest): Promise<AIResponse> {
    this.log('Starting chat request');

    const args = this.buildCliArgs(request);

    this.log(`Running: claude ${args.join(' ')}`);

    const { stdout, stderr, exitCode } = await this.runCommand('claude', args, {
      cwd: request.cwd,
      stdin: undefined,
      abortSignal: request.abortSignal,
    });

    if (exitCode !== 0) {
      this.log(`Claude CLI error (exit code ${exitCode})`);
      this.log(`Claude CLI stderr: ${stderr}`);
      this.log(`Claude CLI stdout: ${stdout.substring(0, 500)}`);
      // Try to extract error message from stdout (stream-json format may have error there)
      let errorMsg = stderr || 'Unknown error';
      try {
        const lines = stdout.split('\n');
        for (const line of lines) {
          if (line.includes('"type":"error"') || line.includes('"is_error":true')) {
            const parsed = JSON.parse(line);
            if (parsed.result || parsed.message) {
              errorMsg = parsed.result || parsed.message;
              break;
            }
          }
        }
      } catch { /* ignore parse errors */ }
      throw new Error(`Claude CLI exited with code ${exitCode}: ${errorMsg}`);
    }

    return this.parseResponse(stdout);
  }

  async chatStream(
    request: ChatCompletionRequest,
    onEvent: (event: StreamEvent) => void
  ): Promise<AIResponse> {
    // Try with resume first, retry without if it fails
    const hadSessionId = !!this.sessionId;

    try {
      return await this.doChatStream(request, onEvent);
    } catch (error) {
      // If we had a session ID and it failed, try again without resume
      if (hadSessionId) {
        this.log(`Chat failed with session resume, retrying without resume...`);
        this.sessionId = null;
        return await this.doChatStream(request, onEvent);
      }
      throw error;
    }
  }

  /**
   * Internal implementation of chatStream.
   */
  private async doChatStream(
    request: ChatCompletionRequest,
    onEvent: (event: StreamEvent) => void
  ): Promise<AIResponse> {
    this.log('Starting streaming chat request');

    const args = this.buildCliArgs(request, true);

    this.log(`Running: claude ${args.join(' ')}`);

    let fullResponse = '';

    // Shared state object that persists across event handler calls
    const state = {
      contentBlocks: [] as MessageContent[],
      currentBlockIndex: 0,
      currentText: '',
      currentToolInput: '',
      currentToolName: '',
      currentToolId: '',
      messageId: '',
    };

    const { stderr, exitCode } = await this.runCommandStreaming(
      'claude',
      args,
      (data) => {
        fullResponse += data;
        this.log(`Received data chunk: ${data.substring(0, 100)}...`);

        // Parse line by line (stream-json format)
        const lines = data.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const event = JSON.parse(line) as ClaudeStreamEvent;
            this.log(`Parsed event type: ${event.type}`);
            this.handleStreamEvent(event, onEvent, state);

            // Update state based on event
            if (event.session_id && !this.sessionId) {
              this.sessionId = event.session_id;
            }
            if (event.message?.id) {
              state.messageId = event.message.id;
            }
          } catch (e) {
            // Not valid JSON, might be partial line
            this.log(`Failed to parse JSON: ${line.substring(0, 50)}`);
          }
        }
      },
      {
        cwd: request.cwd,
        abortSignal: request.abortSignal,
      }
    );

    if (exitCode !== 0 && exitCode !== null) {
      this.log(`Claude CLI streaming error (exit code ${exitCode})`);
      this.log(`Claude CLI stderr: ${stderr}`);
      this.log(`Claude CLI full response: ${fullResponse.substring(0, 500)}`);
      // Try to extract error message from response
      let errorMsg = stderr || 'Unknown error';
      try {
        const lines = fullResponse.split('\n');
        for (const line of lines) {
          if (line.includes('"type":"error"') || line.includes('"is_error":true')) {
            const parsed = JSON.parse(line);
            if (parsed.result || parsed.message) {
              errorMsg = parsed.result || parsed.message;
              break;
            }
          }
        }
      } catch { /* ignore parse errors */ }
      throw new Error(`Claude CLI exited with code ${exitCode}: ${errorMsg}`);
    }

    // Parse final response
    return this.parseStreamingResponse(fullResponse);
  }

  /**
   * Build CLI arguments for the request.
   */
  private buildCliArgs(request: ChatCompletionRequest, streaming = false): string[] {
    const args: string[] = [];

    // Use prompt mode
    args.push('-p', this.buildPrompt(request));

    // Output format
    args.push('--output-format', streaming ? 'stream-json' : 'json');

    // Enable partial messages for true streaming
    if (streaming) {
      args.push('--include-partial-messages');
    }

    // Add verbose for more info
    args.push('--verbose');

    // Model override if specified
    if (this.config.model) {
      args.push('--model', this.config.model);
    }

    // Note: Claude CLI doesn't support --max-tokens flag
    // Token limits are handled by the model configuration

    // Resume session if we have one - this maintains conversation context
    if (this.sessionId) {
      args.push('--resume', this.sessionId);
      this.log(`Resuming CLI session: ${this.sessionId}`);
    }

    // Pass allowed tools if any are specified
    // This enables the Claude CLI to actually call tools instead of just describing them
    if (request.tools && request.tools.length > 0) {
      // Handle both string[] and {name: string}[] formats (ECP sends strings, internal uses objects)
      const toolNames = request.tools.map(t => typeof t === 'string' ? t : t.name).join(',');
      args.push('--allowedTools', toolNames);
      this.log(`Passing ${request.tools.length} tools: ${toolNames}`);
    }

    return args;
  }

  /**
   * Build the prompt string from request.
   * When resuming a session, only send the latest user message since
   * the CLI already has the conversation context.
   */
  private buildPrompt(request: ChatCompletionRequest): string {
    // When resuming a session, only send the latest user message
    // The CLI already has the full conversation context
    if (this.sessionId && request.messages.length > 0) {
      // Find the last user message
      const lastUserMessage = [...request.messages].reverse().find(m => m.role === 'user');
      if (lastUserMessage) {
        const text = lastUserMessage.content
          .filter((c): c is TextContent => c.type === 'text')
          .map((c) => c.text)
          .join('\n');
        this.log(`Resuming session, sending only last user message: ${text.substring(0, 100)}...`);
        return text;
      }
    }

    // For new sessions, build the full prompt with limited context
    let prompt = '';

    // Add system prompt
    if (request.systemPrompt) {
      prompt += `[System Instructions]\n${request.systemPrompt}\n\n`;
    }

    // Add conversation history - limit to configurable number of messages
    if (request.messages.length > 0) {
      const maxMessages = settings.get('ai.context.maxMessages');
      const messagesToSend = request.messages.length > maxMessages
        ? request.messages.slice(-maxMessages)
        : request.messages;

      if (request.messages.length > maxMessages) {
        this.log(`Limiting context: sending ${maxMessages} of ${request.messages.length} messages`);
        prompt += `[Previous conversation truncated for context...]\n\n`;
      }

      prompt += formatMessagesForCli(messagesToSend);
    }

    // Add tool descriptions if any
    if (request.tools && request.tools.length > 0) {
      prompt += formatToolsForCli(request.tools);
      prompt += '\n\nWhen you need to use a tool, respond with a JSON object in this format:\n';
      prompt += '{"tool": "tool_name", "input": {"param1": "value1"}}\n';
    }

    return prompt;
  }

  /**
   * Handle a streaming event from Claude CLI.
   */
  private handleStreamEvent(
    event: ClaudeStreamEvent,
    onEvent: (event: StreamEvent) => void,
    state: {
      contentBlocks: MessageContent[];
      currentBlockIndex: number;
      currentText: string;
      currentToolInput: string;
      currentToolName: string;
      currentToolId: string;
      messageId: string;
    }
  ): void {
    switch (event.type) {
      case 'system':
        // System info, session_id captured above
        break;

      case 'assistant':
        // Assistant message - may be partial with --include-partial-messages
        onEvent({
          type: 'message_start',
          message: {
            id: event.message?.id || state.messageId || `msg-${Date.now()}`,
            role: 'assistant',
          },
        });

        // Extract text content from message and emit as delta
        if (event.message?.content) {
          this.log(`Assistant message has ${event.message.content.length} content blocks`);
          for (const block of event.message.content) {
            if (block.type === 'text' && block.text) {
              // Emit any new text as a delta (for partial messages with --include-partial-messages)
              const newText = block.text.substring(state.currentText.length);
              this.log(`Text block: total=${block.text.length}, previous=${state.currentText.length}, new=${newText.length}`);
              if (newText) {
                state.currentText = block.text;
                this.log(`Emitting text delta: ${newText.substring(0, 50)}...`);
                onEvent({
                  type: 'content_block_delta',
                  index: 0,
                  delta: {
                    type: 'text_delta',
                    text: newText,
                  },
                });
              }
            }
          }
        }
        break;

      case 'content_block_start':
        if (event.content_block) {
          // Track tool_use blocks for later input accumulation
          if (event.content_block.type === 'tool_use') {
            state.currentToolId = event.content_block.id || '';
            state.currentToolName = event.content_block.name || '';
            state.currentToolInput = '';
          }
          onEvent({
            type: 'content_block_start',
            index: event.index ?? state.currentBlockIndex,
            contentBlock: {
              type: event.content_block.type === 'tool_use' ? 'tool_use'
                : event.content_block.type === 'thinking' ? 'thinking' : 'text',
              id: event.content_block.id,
              name: event.content_block.name,
            },
          });
        }
        break;

      case 'content_block_delta':
        if (event.delta) {
          // Accumulate tool input JSON
          if (event.delta.type === 'input_json_delta' && event.delta.partial_json) {
            state.currentToolInput += event.delta.partial_json;
          }
          onEvent({
            type: 'content_block_delta',
            index: event.index ?? state.currentBlockIndex,
            delta: {
              type: event.delta.type === 'input_json_delta' ? 'input_json_delta'
                : event.delta.type === 'thinking_delta' ? 'thinking_delta' : 'text_delta',
              text: event.delta.text ?? event.delta.thinking,
              partialJson: event.delta.partial_json,
            },
          });
        }
        break;

      case 'content_block_stop':
        // Check if this was a tool_use block
        if (state.currentToolId) {
          // Emit tool_use_complete even if input is empty (some tools have no input)
          let parsedInput = {};
          if (state.currentToolInput) {
            try {
              parsedInput = JSON.parse(state.currentToolInput);
            } catch {
              this.log(`Failed to parse tool input JSON: ${state.currentToolInput}`);
            }
          }
          this.log(`Tool use complete: ${state.currentToolName} (${state.currentToolId}) input: ${JSON.stringify(parsedInput)}`);
          onEvent({
            type: 'tool_use_complete',
            id: state.currentToolId,
            name: state.currentToolName,
            input: parsedInput,
          } as StreamEvent);
          // Reset tool state
          state.currentToolId = '';
          state.currentToolName = '';
          state.currentToolInput = '';
        }
        onEvent({
          type: 'content_block_stop',
          index: event.index ?? state.currentBlockIndex,
        });
        break;

      case 'result':
        // Final result event - check if it's an error
        if (event.is_error || event.subtype === 'error') {
          this.log(`Result event indicates error: ${event.result}`);
          onEvent({
            type: 'error',
            error: {
              type: 'api_error',
              message: event.result || 'Unknown error',
            },
          });
        } else {
          onEvent({
            type: 'message_delta',
            delta: {
              stopReason: 'end_turn',
            },
          });
          onEvent({ type: 'message_stop' });
        }
        break;

      case 'error':
        this.log(`Error event: ${event.result}`);
        onEvent({
          type: 'error',
          error: {
            type: 'api_error',
            message: event.result || 'Unknown error',
          },
        });
        break;
    }
  }

  /**
   * Try to parse a tool call from text content.
   * The AI sometimes outputs tool calls as JSON text like:
   * {"tool": "Edit", "input": {"file_path": "...", ...}}
   */
  private parseToolFromText(text: string): ToolUseContent | null {
    try {
      // Try to find JSON object in the text
      const jsonMatch = text.match(/\{[\s\S]*"tool"\s*:\s*"[^"]+"\s*,[\s\S]*"input"\s*:\s*\{[\s\S]*\}\s*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.tool && parsed.input && typeof parsed.tool === 'string') {
        this.log(`Parsed tool from text: ${parsed.tool}`);
        return {
          type: 'tool_use',
          id: `toolu-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
          name: parsed.tool,
          input: parsed.input,
        };
      }
    } catch (e) {
      // Not valid JSON or doesn't match expected format
      this.log(`Failed to parse tool from text: ${e}`);
    }
    return null;
  }

  /**
   * Parse non-streaming response.
   */
  private parseResponse(output: string): AIResponse {
    const content: MessageContent[] = [];
    let sessionId: string | null = null;

    // Parse JSON lines
    const lines = output.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line) as ClaudeStreamEvent;

        if (event.session_id && !sessionId) {
          sessionId = event.session_id;
        }

        // Handle "result" type from --output-format json
        if (event.type === 'result' && event.result) {
          this.log(`Parsed result event: ${event.result.substring(0, 100)}...`);
          // Check if the result contains a tool call JSON
          const toolUse = this.parseToolFromText(event.result);
          if (toolUse) {
            content.push(toolUse);
          } else {
            content.push({ type: 'text', text: event.result });
          }
        }

        // Handle "assistant" type from stream-json format
        if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'text' && block.text) {
              // Check if the text contains a tool call JSON
              const toolUse = this.parseToolFromText(block.text);
              if (toolUse) {
                content.push(toolUse);
              } else {
                content.push({ type: 'text', text: block.text });
              }
            } else if (block.type === 'tool_use' && block.name && block.input) {
              content.push({
                type: 'tool_use',
                id: block.id || `toolu-${Date.now()}`,
                name: block.name,
                input: block.input,
              });
            }
          }
        }
      } catch {
        // Not valid JSON
      }
    }

    if (sessionId && !this.sessionId) {
      this.sessionId = sessionId;
    }

    // If no structured content found, treat whole output as text
    if (content.length === 0) {
      // Try to extract just the text response
      const textMatch = output.match(/"text"\s*:\s*"([^"]+)"/);
      if (textMatch && textMatch[1]) {
        // Check if it's a tool call
        const toolUse = this.parseToolFromText(textMatch[1]);
        if (toolUse) {
          content.push(toolUse);
        } else {
          content.push({ type: 'text', text: textMatch[1] });
        }
      } else {
        // Check if the raw output contains a tool call
        const toolUse = this.parseToolFromText(output);
        if (toolUse) {
          content.push(toolUse);
        } else {
          content.push({ type: 'text', text: output.trim() });
        }
      }
    }

    const hasToolUse = content.some((c) => c.type === 'tool_use');

    return {
      message: {
        id: `msg-${Date.now()}`,
        role: 'assistant',
        content,
        timestamp: Date.now(),
      },
      stopReason: hasToolUse ? 'tool_use' : 'end_turn',
    };
  }

  /**
   * Parse streaming response (after stream completes).
   */
  private parseStreamingResponse(output: string): AIResponse {
    return this.parseResponse(output);
  }

  /**
   * Get the current session ID.
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Set the session ID for resume.
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }
}

// Register the provider
registerProvider('claude', (config) => new ClaudeProvider(config));

/**
 * Create a Claude provider instance.
 */
export function createClaudeProvider(config?: Partial<AIProviderConfig>): ClaudeProvider {
  return new ClaudeProvider({
    type: 'claude',
    name: 'Claude',
    ...config,
  });
}
