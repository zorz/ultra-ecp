/**
 * Tool Executor
 *
 * Executes tool calls by routing them to ECP methods.
 * Supports tool translation for different AI providers.
 */

import type {
  ToolDefinition,
  ToolUseContent,
  ToolExecutionResult,
} from '../types.ts';
import type { ToolTranslator } from './translator.ts';
import { allECPTools, getToolByName } from './definitions.ts';
import { canonicalECPTools } from './translator.ts';
import { debugLog, isDebugEnabled } from '../../../debug.ts';

/**
 * ECP request function type.
 */
type ECPRequestFn = <T = unknown>(method: string, params?: unknown) => Promise<T>;

type ECPCaller =
  | { type: 'human' }
  | { type: 'agent'; agentId: string; executionId?: string };


/**
 * Custom tool executor function type.
 */
type CustomToolExecutor = (input: Record<string, unknown>) => Promise<ToolExecutionResult>;

/**
 * Tool executor that routes tool calls to ECP or custom handlers.
 * Supports tool translation for different AI providers.
 */
export class ToolExecutor {
  private ecpRequest: ECPRequestFn | null = null;
  private caller: ECPCaller = { type: 'agent', agentId: 'unknown' };
  private translator: ToolTranslator | null = null;
  private customTools: Map<string, { definition: ToolDefinition; executor: CustomToolExecutor }> = new Map();
  private hiddenExecutors: Map<string, CustomToolExecutor> = new Map();

  private log(msg: string): void {
    if (isDebugEnabled()) {
      debugLog(`[ToolExecutor] ${msg}`);
    }
  }

  /**
   * Set the ECP request function.
   */
  setECPRequest(requestFn: ECPRequestFn): void {
    this.ecpRequest = requestFn;
    this.log('ECP request function set');
  }

  /**
   * Set caller context for subsequent tool executions.
   * This is used to distinguish human UI actions vs agent/tool-driven actions at the ECP boundary.
   */
  setCaller(caller: ECPCaller): void {
    this.caller = caller;
  }

  private getCaller(): ECPCaller {
    return this.caller;
  }

  /**
   * Set the tool translator for a specific provider.
   * When set, tool calls from the provider will be translated to ECP format.
   */
  setTranslator(translator: ToolTranslator): void {
    this.translator = translator;
    this.log(`Tool translator set for provider: ${translator.providerId}`);
  }

  /**
   * Get the current translator.
   */
  getTranslator(): ToolTranslator | null {
    return this.translator;
  }

  /**
   * Register a custom tool.
   */
  registerTool(tool: ToolDefinition, executor: CustomToolExecutor): void {
    this.customTools.set(tool.name, { definition: tool, executor });
    this.log(`Registered custom tool: ${tool.name}`);
  }

  /**
   * Register a tool executor without adding its definition to the tool list.
   * The tool will be executable but not visible in getAvailableTools().
   * Use this for tools that should only appear in specific session contexts.
   */
  registerToolExecutor(name: string, executor: CustomToolExecutor): void {
    this.hiddenExecutors.set(name, executor);
    this.log(`Registered hidden tool executor: ${name}`);
  }

  /**
   * Unregister a hidden tool executor.
   */
  unregisterToolExecutor(name: string): boolean {
    const removed = this.hiddenExecutors.delete(name);
    if (removed) {
      this.log(`Unregistered hidden tool executor: ${name}`);
    }
    return removed;
  }

  /**
   * Unregister a custom tool.
   */
  unregisterTool(name: string): boolean {
    const removed = this.customTools.delete(name);
    if (removed) {
      this.log(`Unregistered custom tool: ${name}`);
    }
    return removed;
  }

  /**
   * Get all available tools (ECP + custom).
   * If a translator is set, returns provider-specific tool definitions.
   */
  getAvailableTools(): ToolDefinition[] {
    const customDefs = Array.from(this.customTools.values()).map((t) => t.definition);

    // If translator is set, return translated tool definitions
    if (this.translator) {
      const translatedTools = this.translator.toProviderTools(canonicalECPTools);
      this.log(`Returning ${translatedTools.length} translated tools for ${this.translator.providerId}`);
      return [...translatedTools, ...customDefs];
    }

    return [...allECPTools, ...customDefs];
  }

  /**
   * Get ECP tools only.
   */
  getECPTools(): ToolDefinition[] {
    return [...allECPTools];
  }

  /**
   * Get custom tools only.
   */
  getCustomTools(): ToolDefinition[] {
    return Array.from(this.customTools.values()).map((t) => t.definition);
  }

  /**
   * Execute a tool call.
   * If a translator is set, translates provider-specific tool calls to ECP format.
   */
  async execute(toolCall: ToolUseContent): Promise<ToolExecutionResult> {
    const { name, input } = toolCall;
    this.log(`Executing tool: ${name}`);

    try {
      // Check for custom tool first
      const customTool = this.customTools.get(name);
      if (customTool) {
        this.log(`Executing custom tool: ${name}`);
        return await customTool.executor(input);
      }

      // Check hidden executors (workflow-only tools like DelegateToAgent)
      const hiddenExecutor = this.hiddenExecutors.get(name);
      if (hiddenExecutor) {
        this.log(`Executing hidden tool: ${name}`);
        return await hiddenExecutor(input);
      }

      // If translator is set, try to translate the tool call
      if (this.translator && this.translator.isSupported(name)) {
        const mapped = this.translator.mapToolCall(toolCall);
        if (mapped) {
          if (!this.ecpRequest) {
            return {
              success: false,
              error: 'ECP request function not configured',
            };
          }

          this.log(`Translated tool: ${name} -> ${mapped.ecpMethod}`);
          const result = await this.ecpRequest(mapped.ecpMethod, {
            ...(mapped.params ?? {}),
          });

          // For terminal commands, check exitCode to determine success
          if (mapped.ecpMethod === 'terminal/execute' || mapped.ecpMethod === 'terminal/spawn') {
            const termResult = result as { exitCode?: number; stdout?: string; stderr?: string };
            const exitCode = termResult.exitCode ?? 0;
            if (exitCode !== 0) {
              // Command failed - format result to make failure clear
              return {
                success: false,
                error: `Command failed with exit code ${exitCode}`,
                result: {
                  ...termResult,
                  _commandFailed: true,
                  _exitCode: exitCode,
                },
              };
            }
          }

          return {
            success: true,
            result,
          };
        }
      }

      // Check for ECP tool (direct mapping without translator)
      const ecpTool = getToolByName(name);
      if (ecpTool && ecpTool.ecpMethod) {
        if (!this.ecpRequest) {
          return {
            success: false,
            error: 'ECP request function not configured',
          };
        }

        this.log(`Executing ECP tool: ${name} -> ${ecpTool.ecpMethod}`);
        const result = await this.ecpRequest(ecpTool.ecpMethod, {
          ...(input ?? {}),
        });

        // For terminal commands, check exitCode to determine success
        if (ecpTool.ecpMethod === 'terminal/execute' || ecpTool.ecpMethod === 'terminal/spawn') {
          const termResult = result as { exitCode?: number; stdout?: string; stderr?: string };
          const exitCode = termResult.exitCode ?? 0;
          if (exitCode !== 0) {
            // Command failed - format result to make failure clear
            return {
              success: false,
              error: `Command failed with exit code ${exitCode}`,
              result: {
                ...termResult,
                _commandFailed: true,
                _exitCode: exitCode,
              },
            };
          }
        }

        return {
          success: true,
          result,
        };
      }

      // Tool not found
      return {
        success: false,
        error: `Unknown tool: ${name}`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log(`Tool execution error: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Execute multiple tool calls.
   */
  async executeAll(
    toolCalls: ToolUseContent[]
  ): Promise<Map<string, ToolExecutionResult>> {
    const results = new Map<string, ToolExecutionResult>();

    for (const toolCall of toolCalls) {
      const result = await this.execute(toolCall);
      results.set(toolCall.id, result);
    }

    return results;
  }

  /**
   * Validate tool input against schema.
   */
  validateInput(
    toolName: string,
    input: Record<string, unknown>
  ): { valid: boolean; errors: string[] } {
    const tool = getToolByName(toolName) || this.customTools.get(toolName)?.definition;

    if (!tool) {
      return { valid: false, errors: [`Unknown tool: ${toolName}`] };
    }

    const errors: string[] = [];
    const schema = tool.inputSchema;

    // Check required fields
    if (schema.required) {
      for (const field of schema.required) {
        if (!(field in input) || input[field] === undefined) {
          errors.push(`Missing required field: ${field}`);
        }
      }
    }

    // Basic type checking
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in input && input[key] !== undefined) {
          const value = input[key];
          const expectedType = propSchema.type;

          let actualType: string;
          if (Array.isArray(value)) {
            actualType = 'array';
          } else if (value === null) {
            actualType = 'null';
          } else {
            actualType = typeof value;
          }

          if (expectedType !== actualType) {
            errors.push(`Field ${key}: expected ${expectedType}, got ${actualType}`);
          }
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }
}

/**
 * Create a new tool executor.
 */
export function createToolExecutor(): ToolExecutor {
  return new ToolExecutor();
}
