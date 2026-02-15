/**
 * Built-in Middleware
 *
 * Pre-built middleware for common pipeline tasks.
 */

import type {
  MiddlewareDefinition,
  MiddlewareContext,
  MiddlewareAction,
  PipelineStage,
  AIResponse,
} from '../types.ts';
import type {
  ValidatorMiddlewareOptions,
  CriticMiddlewareOptions,
  FilterMiddlewareOptions,
  LoggerMiddlewareOptions,
  RateLimitMiddlewareOptions,
  ApprovalMiddlewareOptions,
  LogEntry,
} from './types.ts';
import { getMessageText } from '../types.ts';
import { debugLog } from '../../../debug.ts';

/**
 * Create a validator middleware.
 * Validates responses against configurable rules.
 */
export function createValidatorMiddleware(
  options: ValidatorMiddlewareOptions
): MiddlewareDefinition {
  return {
    name: 'validator',
    description: 'Validates AI responses against configurable rules',
    stages: ['post_response'],
    priority: 10,
    enabled: true,
    execute: async (context: MiddlewareContext, stage: PipelineStage): Promise<MiddlewareAction> => {
      if (!context.response) {
        return { type: 'continue' };
      }

      const text = getMessageText(context.response.message);

      // Check max length
      if (options.maxLength && text.length > options.maxLength) {
        return {
          type: 'block',
          reason: `Response exceeds maximum length (${text.length} > ${options.maxLength})`,
        };
      }

      // Check disallowed patterns
      if (options.disallowedPatterns) {
        for (const pattern of options.disallowedPatterns) {
          const regex = new RegExp(pattern, 'gi');
          if (regex.test(text)) {
            return {
              type: 'block',
              reason: `Response contains disallowed pattern: ${pattern}`,
            };
          }
        }
      }

      // Check required patterns
      if (options.requiredPatterns) {
        for (const pattern of options.requiredPatterns) {
          const regex = new RegExp(pattern, 'gi');
          if (!regex.test(text)) {
            return {
              type: 'block',
              reason: `Response missing required pattern: ${pattern}`,
            };
          }
        }
      }

      // Run custom validator
      if (options.customValidator) {
        const result = options.customValidator(context.response);
        if (!result.valid) {
          return {
            type: 'block',
            reason: result.reason || 'Custom validation failed',
          };
        }
      }

      return { type: 'continue' };
    },
  };
}

/**
 * Create a filter middleware.
 * Redacts sensitive content from responses.
 */
export function createFilterMiddleware(
  options: FilterMiddlewareOptions
): MiddlewareDefinition {
  // Common secret patterns
  const secretPatterns = [
    // API keys
    { pattern: /\b(sk|pk|api)[_-]?[a-zA-Z0-9]{20,}/gi, replacement: '[REDACTED_API_KEY]' },
    // AWS keys
    { pattern: /AKIA[0-9A-Z]{16}/gi, replacement: '[REDACTED_AWS_KEY]' },
    // Private keys
    { pattern: /-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (RSA |EC |DSA )?PRIVATE KEY-----/gi, replacement: '[REDACTED_PRIVATE_KEY]' },
    // JWT tokens
    { pattern: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/gi, replacement: '[REDACTED_JWT]' },
  ];

  // PII patterns
  const piiPatterns = [
    // Email addresses
    { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/gi, replacement: '[REDACTED_EMAIL]' },
    // Phone numbers
    { pattern: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, replacement: '[REDACTED_PHONE]' },
    // SSN
    { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[REDACTED_SSN]' },
    // Credit card numbers
    { pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, replacement: '[REDACTED_CARD]' },
  ];

  return {
    name: 'filter',
    description: 'Redacts sensitive content from AI responses',
    stages: ['post_response'],
    priority: 20,
    enabled: true,
    execute: async (context: MiddlewareContext, stage: PipelineStage): Promise<MiddlewareAction> => {
      if (!context.response) {
        return { type: 'continue' };
      }

      let text = getMessageText(context.response.message);
      let modified = false;

      // Apply custom redact patterns
      if (options.redactPatterns) {
        for (const { pattern, replacement } of options.redactPatterns) {
          const regex = new RegExp(pattern, 'gi');
          if (regex.test(text)) {
            text = text.replace(regex, replacement);
            modified = true;
          }
        }
      }

      // Apply secret patterns
      if (options.filterSecrets) {
        for (const { pattern, replacement } of secretPatterns) {
          if (pattern.test(text)) {
            text = text.replace(pattern, replacement);
            modified = true;
          }
        }
      }

      // Apply PII patterns
      if (options.filterPII) {
        for (const { pattern, replacement } of piiPatterns) {
          if (pattern.test(text)) {
            text = text.replace(pattern, replacement);
            modified = true;
          }
        }
      }

      if (modified) {
        // Create modified response
        const modifiedResponse: AIResponse = {
          ...context.response,
          message: {
            ...context.response.message,
            content: [{ type: 'text', text }],
          },
        };

        return {
          type: 'modify',
          context: { response: modifiedResponse },
        };
      }

      return { type: 'continue' };
    },
  };
}

/**
 * Create a logger middleware.
 * Logs AI interactions for debugging and auditing.
 */
export function createLoggerMiddleware(
  options: LoggerMiddlewareOptions
): MiddlewareDefinition {
  const logFn = options.handler || ((entry: LogEntry) => {
    const prefix = `[AILogger:${options.level}]`;
    switch (options.level) {
      case 'debug':
        debugLog(`${prefix} ${JSON.stringify(entry)}`);
        break;
      case 'info':
        console.log(`${prefix}`, entry);
        break;
      case 'warn':
        console.warn(`${prefix}`, entry);
        break;
      case 'error':
        console.error(`${prefix}`, entry);
        break;
    }
  });

  return {
    name: 'logger',
    description: 'Logs AI interactions for debugging and auditing',
    stages: ['pre_request', 'post_response', 'tool_execution'],
    priority: 0, // Run first to capture everything
    enabled: true,
    execute: async (context: MiddlewareContext, stage: PipelineStage): Promise<MiddlewareAction> => {
      const entry: LogEntry = {
        timestamp: Date.now(),
        stage,
        sessionId: context.session.id,
        data: {},
      };

      if (stage === 'pre_request' && options.logRequest && context.request) {
        entry.data = { request: context.request };
        logFn(entry);
      }

      if (stage === 'post_response' && options.logResponse && context.response) {
        entry.data = {
          response: {
            stopReason: context.response.stopReason,
            messageLength: getMessageText(context.response.message).length,
            usage: context.response.usage,
          },
        };
        logFn(entry);
      }

      if (stage === 'tool_execution' && options.logTools && context.toolCall) {
        entry.data = {
          tool: context.toolCall.name,
          hasResult: !!context.toolResult,
          isError: !!context.toolResult?.error,
        };
        logFn(entry);
      }

      return { type: 'continue' };
    },
  };
}

/**
 * Create a rate limit middleware.
 * Limits the rate of AI requests.
 */
export function createRateLimitMiddleware(
  options: RateLimitMiddlewareOptions
): MiddlewareDefinition {
  // Track requests per session
  const requestCounts = new Map<string, { count: number; windowStart: number }>();

  return {
    name: 'ratelimit',
    description: 'Limits the rate of AI requests',
    stages: ['pre_request'],
    priority: 5,
    enabled: true,
    execute: async (context: MiddlewareContext, stage: PipelineStage): Promise<MiddlewareAction> => {
      const sessionId = context.session.id;
      const now = Date.now();

      let state = requestCounts.get(sessionId);

      // Reset if window expired
      if (!state || now - state.windowStart > options.windowMs) {
        state = { count: 0, windowStart: now };
      }

      // Check rate limit
      if (state.count >= options.maxRequests) {
        if (options.onLimit === 'block') {
          const resetIn = Math.ceil((state.windowStart + options.windowMs - now) / 1000);
          return {
            type: 'block',
            reason: `Rate limit exceeded. Try again in ${resetIn} seconds.`,
          };
        } else {
          // Wait until window resets
          const waitTime = state.windowStart + options.windowMs - now;
          await new Promise((resolve) => setTimeout(resolve, waitTime));
          state = { count: 0, windowStart: Date.now() };
        }
      }

      // Increment count
      state.count++;
      requestCounts.set(sessionId, state);

      return { type: 'continue' };
    },
  };
}

/**
 * Create an approval middleware.
 * Requires user approval before proceeding.
 */
export function createApprovalMiddleware(
  options: ApprovalMiddlewareOptions
): MiddlewareDefinition {
  return {
    name: 'approval',
    description: 'Requires user approval before proceeding',
    stages: options.stages,
    priority: 100, // Run last
    enabled: true,
    execute: async (context: MiddlewareContext, stage: PipelineStage): Promise<MiddlewareAction> => {
      return new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
          if (options.onTimeout === 'approve') {
            resolve({ type: 'continue' });
          } else {
            resolve({ type: 'block', reason: 'Approval timeout' });
          }
        }, options.timeout);

        const approve = () => {
          clearTimeout(timeoutId);
          resolve({ type: 'continue' });
        };

        const reject = (reason: string) => {
          clearTimeout(timeoutId);
          resolve({ type: 'block', reason });
        };

        // Call approval handler
        if (options.onApprovalRequired) {
          options.onApprovalRequired(context, approve, reject);
        } else {
          // No handler, auto-approve
          clearTimeout(timeoutId);
          resolve({ type: 'continue' });
        }
      });
    },
  };
}

/**
 * Create a simple content length validator.
 */
export function createMaxLengthValidator(maxLength: number): MiddlewareDefinition {
  return createValidatorMiddleware({ maxLength });
}

/**
 * Create a simple secret filter.
 */
export function createSecretFilter(): MiddlewareDefinition {
  return createFilterMiddleware({ filterSecrets: true });
}

/**
 * Create a simple PII filter.
 */
export function createPIIFilter(): MiddlewareDefinition {
  return createFilterMiddleware({ filterPII: true });
}

/**
 * Create a debug logger.
 */
export function createDebugLogger(): MiddlewareDefinition {
  return createLoggerMiddleware({
    level: 'debug',
    logRequest: true,
    logResponse: true,
    logTools: true,
  });
}
