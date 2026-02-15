/**
 * Base AI Provider Interface
 *
 * Abstract interface for AI providers.
 * Each provider (Claude, OpenAI, Gemini, Ollama) implements this interface.
 * Providers use CLI tools in non-interactive mode for chat completions.
 */

import type {
  AIProviderType,
  AIProviderConfig,
  AIProviderCapabilities,
  ChatMessage,
  ToolDefinition,
  AIResponse,
  StreamEvent,
} from '../types.ts';

/**
 * Request options for chat completion.
 */
export interface ChatCompletionRequest {
  /** Messages in the conversation */
  messages: ChatMessage[];
  /** System prompt */
  systemPrompt?: string;
  /** Available tools */
  tools?: ToolDefinition[];
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Temperature for response generation (0-1) */
  temperature?: number;
  /** Whether to stream the response */
  stream?: boolean;
  /** Working directory for CLI execution */
  cwd?: string;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
}

/**
 * Base AI provider interface.
 */
export interface AIProvider {
  /** Provider type */
  readonly type: AIProviderType;

  /** Provider display name */
  readonly name: string;

  /** Provider configuration */
  readonly config: AIProviderConfig;

  /**
   * Get provider capabilities.
   */
  getCapabilities(): AIProviderCapabilities;

  /**
   * Check if the provider is available.
   * For CLI providers, this checks if the CLI is installed.
   * For API providers, this checks if the API key is set.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Get available models for this provider.
   */
  getAvailableModels(): Promise<string[]>;

  /**
   * Send a chat completion request.
   *
   * @param request - Chat completion request
   * @returns AI response
   */
  chat(request: ChatCompletionRequest): Promise<AIResponse>;

  /**
   * Send a chat completion request with streaming.
   *
   * @param request - Chat completion request
   * @param onEvent - Callback for streaming events
   * @returns Final AI response
   */
  chatStream(
    request: ChatCompletionRequest,
    onEvent: (event: StreamEvent) => void
  ): Promise<AIResponse>;

  /**
   * Cancel an in-progress request.
   */
  cancel(): void;
}

/**
 * Base class for CLI-based AI providers.
 * Subclasses implement the specific CLI commands and output parsing.
 */
export abstract class BaseAIProvider implements AIProvider {
  abstract readonly type: AIProviderType;
  abstract readonly name: string;
  readonly config: AIProviderConfig;

  /** Current running process */
  protected currentProcess: { kill: () => void } | null = null;

  constructor(config: AIProviderConfig) {
    this.config = config;
  }

  abstract getCapabilities(): AIProviderCapabilities;
  abstract isAvailable(): Promise<boolean>;
  abstract getAvailableModels(): Promise<string[]>;
  abstract chat(request: ChatCompletionRequest): Promise<AIResponse>;
  abstract chatStream(
    request: ChatCompletionRequest,
    onEvent: (event: StreamEvent) => void
  ): Promise<AIResponse>;

  /**
   * Cancel the current request.
   */
  cancel(): void {
    if (this.currentProcess) {
      this.currentProcess.kill();
      this.currentProcess = null;
    }
  }

  /**
   * Check if a CLI command exists.
   */
  protected async commandExists(command: string): Promise<boolean> {
    try {
      const proc = Bun.spawn(['which', command], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  /**
   * Run a CLI command and return the output.
   */
  protected async runCommand(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      env?: Record<string, string>;
      stdin?: string;
      abortSignal?: AbortSignal;
    } = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn([command, ...args], {
      cwd: options.cwd ?? process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: options.stdin ? 'pipe' : undefined,
      env: {
        ...process.env,
        ...options.env,
        TERM: 'xterm-256color',
      },
    });

    this.currentProcess = proc;

    // Handle abort signal
    if (options.abortSignal) {
      options.abortSignal.addEventListener('abort', () => {
        proc.kill();
      });
    }

    // Write stdin if provided
    if (options.stdin && proc.stdin) {
      proc.stdin.write(options.stdin);
      proc.stdin.end();
    }

    // Read stdout and stderr
    const [stdoutBytes, stderrBytes, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).arrayBuffer(),
      proc.exited,
    ]);

    this.currentProcess = null;

    const stdout = new TextDecoder().decode(stdoutBytes);
    const stderr = new TextDecoder().decode(stderrBytes);

    return { stdout, stderr, exitCode };
  }

  /**
   * Run a CLI command with streaming output.
   */
  protected async runCommandStreaming(
    command: string,
    args: string[],
    onOutput: (data: string) => void,
    options: {
      cwd?: string;
      env?: Record<string, string>;
      stdin?: string;
      abortSignal?: AbortSignal;
    } = {}
  ): Promise<{ stderr: string; exitCode: number }> {
    const proc = Bun.spawn([command, ...args], {
      cwd: options.cwd ?? process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: options.stdin ? 'pipe' : undefined,
      env: {
        ...process.env,
        ...options.env,
        TERM: 'xterm-256color',
      },
    });

    this.currentProcess = proc;

    // Handle abort signal
    if (options.abortSignal) {
      options.abortSignal.addEventListener('abort', () => {
        proc.kill();
      });
    }

    // Write stdin if provided
    if (options.stdin && proc.stdin) {
      proc.stdin.write(options.stdin);
      proc.stdin.end();
    }

    // Stream stdout
    const stdoutReader = proc.stdout.getReader();
    const decoder = new TextDecoder();

    const readStdout = async () => {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        onOutput(decoder.decode(value));
      }
    };

    // Read stderr
    const stderrPromise = new Response(proc.stderr).text();

    await readStdout();
    const [stderr, exitCode] = await Promise.all([stderrPromise, proc.exited]);

    this.currentProcess = null;

    return { stderr, exitCode };
  }
}

/**
 * Factory function to create a provider.
 */
export type ProviderFactory = (config: AIProviderConfig) => AIProvider;

/**
 * Provider registry.
 */
const providerFactories = new Map<AIProviderType, ProviderFactory>();

/**
 * Register a provider factory.
 * @param type - Provider type (e.g., 'claude', 'openai')
 * @param factory - Factory function to create provider instances
 * @param isHttp - Whether this is an HTTP provider (will be registered as 'type-http')
 */
export function registerProvider(
  type: AIProviderType | string,
  factory: ProviderFactory,
  isHttp = false
): void {
  const key = isHttp ? `${type}-http` : type;
  providerFactories.set(key as AIProviderType, factory);
}

/**
 * Create a provider instance.
 * By default, uses HTTP providers when available. Set useHttp: false for CLI.
 */
export function createProvider(config: AIProviderConfig): AIProvider | null {
  // Default to HTTP unless explicitly set to false
  const useHttp = config.useHttp !== false;

  // Try HTTP provider first if useHttp is true
  if (useHttp) {
    const httpKey = `${config.type}-http` as AIProviderType;
    const httpFactory = providerFactories.get(httpKey);
    if (httpFactory) {
      return httpFactory(config);
    }
  }

  // Fall back to CLI provider
  const factory = providerFactories.get(config.type);
  if (!factory) {
    return null;
  }
  return factory(config);
}

/**
 * Get registered provider types.
 */
export function getRegisteredProviders(): AIProviderType[] {
  // Return unique base types (without -http suffix)
  const types = new Set<AIProviderType>();
  for (const key of providerFactories.keys()) {
    const baseType = key.replace('-http', '') as AIProviderType;
    types.add(baseType);
  }
  return Array.from(types);
}
