/**
 * Framework Pipeline
 *
 * Orchestrates the middleware pipeline for AI requests and responses.
 * Middleware can validate, critique, filter, or modify AI interactions.
 */

import type {
  MiddlewareContext,
  MiddlewareDefinition,
  MiddlewareAction,
  PipelineConfig,
  PipelineResult,
  PipelineStage,
  ChatSession,
  SendMessageOptions,
  AIResponse,
  ToolUseContent,
  ToolExecutionResult,
} from '../types.ts';
import { debugLog, isDebugEnabled } from '../../../debug.ts';

/**
 * Default pipeline configuration.
 */
const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  middleware: [],
  haltOnBlock: true,
  timeout: 30000, // 30 seconds
};

/**
 * Pipeline executor.
 */
export class Pipeline {
  private config: PipelineConfig;

  constructor(config: Partial<PipelineConfig> = {}) {
    this.config = { ...DEFAULT_PIPELINE_CONFIG, ...config };
  }

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[Pipeline] ${msg}`);
    }
  }

  /**
   * Get pipeline configuration.
   */
  getConfig(): PipelineConfig {
    return { ...this.config };
  }

  /**
   * Set pipeline configuration.
   */
  setConfig(config: Partial<PipelineConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Register middleware.
   */
  registerMiddleware(middleware: MiddlewareDefinition): void {
    // Insert in priority order
    const index = this.config.middleware.findIndex(
      (m) => m.priority > middleware.priority
    );
    if (index === -1) {
      this.config.middleware.push(middleware);
    } else {
      this.config.middleware.splice(index, 0, middleware);
    }
    this.log(`Registered middleware: ${middleware.name} (priority: ${middleware.priority})`);
  }

  /**
   * Unregister middleware.
   */
  unregisterMiddleware(name: string): boolean {
    const index = this.config.middleware.findIndex((m) => m.name === name);
    if (index === -1) return false;
    this.config.middleware.splice(index, 1);
    this.log(`Unregistered middleware: ${name}`);
    return true;
  }

  /**
   * Get registered middleware.
   */
  getMiddleware(): MiddlewareDefinition[] {
    return [...this.config.middleware];
  }

  /**
   * Set middleware enabled state.
   */
  setMiddlewareEnabled(name: string, enabled: boolean): boolean {
    const middleware = this.config.middleware.find((m) => m.name === name);
    if (!middleware) return false;
    middleware.enabled = enabled;
    this.log(`Set middleware ${name} enabled: ${enabled}`);
    return true;
  }

  /**
   * Execute the pipeline for a stage.
   */
  async execute(
    stage: PipelineStage,
    context: MiddlewareContext
  ): Promise<PipelineResult> {
    this.log(`Executing pipeline for stage: ${stage}`);

    const enabledMiddleware = this.config.middleware.filter(
      (m) => m.enabled && m.stages.includes(stage)
    );

    if (enabledMiddleware.length === 0) {
      this.log('No middleware enabled for this stage');
      return {
        success: true,
        context,
        actions: [],
      };
    }

    const actions: Array<{ middleware: string; action: MiddlewareAction }> = [];
    let currentContext = { ...context };
    let blocked = false;
    let blockReason = '';

    for (const middleware of enabledMiddleware) {
      if (blocked && this.config.haltOnBlock) {
        this.log(`Skipping ${middleware.name} due to previous block`);
        continue;
      }

      this.log(`Running middleware: ${middleware.name}`);

      try {
        const action = await this.executeWithTimeout(
          () => middleware.execute(currentContext, stage),
          this.config.timeout
        );

        actions.push({ middleware: middleware.name, action });

        switch (action.type) {
          case 'continue':
            this.log(`${middleware.name}: continue`);
            break;

          case 'modify':
            this.log(`${middleware.name}: modify context`);
            currentContext = {
              ...currentContext,
              ...action.context,
              data: {
                ...currentContext.data,
                ...action.context.data,
              },
            };
            break;

          case 'block':
            this.log(`${middleware.name}: block - ${action.reason}`);
            blocked = true;
            blockReason = action.reason;
            break;

          case 'require_approval':
            this.log(`${middleware.name}: require approval - ${action.message}`);
            // For now, we'll need to handle approval asynchronously
            // The caller should check for this action and handle it
            break;
        }
      } catch (error) {
        this.log(`${middleware.name}: error - ${error}`);
        actions.push({
          middleware: middleware.name,
          action: { type: 'block', reason: `Middleware error: ${error}` },
        });

        if (this.config.haltOnBlock) {
          blocked = true;
          blockReason = `Middleware ${middleware.name} error: ${error}`;
        }
      }
    }

    return {
      success: !blocked,
      context: currentContext,
      actions,
      error: blocked ? blockReason : undefined,
    };
  }

  /**
   * Execute pre-request middleware.
   */
  async executePreRequest(
    session: ChatSession,
    request: SendMessageOptions
  ): Promise<PipelineResult> {
    const context: MiddlewareContext = {
      session,
      request,
      data: {},
    };
    return this.execute('pre_request', context);
  }

  /**
   * Execute post-response middleware.
   */
  async executePostResponse(
    session: ChatSession,
    response: AIResponse
  ): Promise<PipelineResult> {
    const context: MiddlewareContext = {
      session,
      response,
      data: {},
    };
    return this.execute('post_response', context);
  }

  /**
   * Execute tool execution middleware.
   */
  async executeToolExecution(
    session: ChatSession,
    toolCall: ToolUseContent,
    toolResult?: ToolExecutionResult
  ): Promise<PipelineResult> {
    const context: MiddlewareContext = {
      session,
      toolCall,
      toolResult,
      data: {},
    };
    return this.execute('tool_execution', context);
  }

  /**
   * Execute a function with a timeout.
   */
  private async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeout: number
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Middleware execution timed out after ${timeout}ms`));
      }, timeout);

      fn()
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }
}

/**
 * Create a new pipeline instance.
 */
export function createPipeline(config?: Partial<PipelineConfig>): Pipeline {
  return new Pipeline(config);
}
