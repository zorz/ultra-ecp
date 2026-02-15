/**
 * Validation Service Errors
 *
 * Custom error types for the validation middleware system.
 */

/**
 * Error codes for validation operations.
 */
export enum ValidationErrorCode {
  /** Validator not found */
  VALIDATOR_NOT_FOUND = 'VALIDATOR_NOT_FOUND',
  /** Validator execution failed */
  VALIDATOR_EXECUTION_FAILED = 'VALIDATOR_EXECUTION_FAILED',
  /** Validator timed out */
  VALIDATOR_TIMEOUT = 'VALIDATOR_TIMEOUT',
  /** Invalid validator configuration */
  INVALID_VALIDATOR_CONFIG = 'INVALID_VALIDATOR_CONFIG',
  /** Context resolution failed */
  CONTEXT_RESOLUTION_FAILED = 'CONTEXT_RESOLUTION_FAILED',
  /** Context file parse error */
  CONTEXT_PARSE_ERROR = 'CONTEXT_PARSE_ERROR',
  /** Cache error */
  CACHE_ERROR = 'CACHE_ERROR',
  /** Consensus not reached */
  CONSENSUS_NOT_REACHED = 'CONSENSUS_NOT_REACHED',
  /** Pipeline execution failed */
  PIPELINE_EXECUTION_FAILED = 'PIPELINE_EXECUTION_FAILED',
  /** Invalid trigger */
  INVALID_TRIGGER = 'INVALID_TRIGGER',
  /** File not found */
  FILE_NOT_FOUND = 'FILE_NOT_FOUND',
  /** Command execution failed */
  COMMAND_EXECUTION_FAILED = 'COMMAND_EXECUTION_FAILED',
  /** AI provider error */
  AI_PROVIDER_ERROR = 'AI_PROVIDER_ERROR',
}

/**
 * Custom error class for validation operations.
 */
export class ValidationError extends Error {
  /** Error code */
  readonly code: ValidationErrorCode;
  /** Original cause */
  override readonly cause?: Error;

  constructor(code: ValidationErrorCode, message: string, cause?: Error) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.cause = cause;
  }

  /**
   * Create an error for validator not found.
   */
  static validatorNotFound(validatorId: string): ValidationError {
    return new ValidationError(
      ValidationErrorCode.VALIDATOR_NOT_FOUND,
      `Validator not found: ${validatorId}`
    );
  }

  /**
   * Create an error for validator execution failure.
   */
  static executionFailed(validatorId: string, reason: string, cause?: Error): ValidationError {
    return new ValidationError(
      ValidationErrorCode.VALIDATOR_EXECUTION_FAILED,
      `Validator ${validatorId} execution failed: ${reason}`,
      cause
    );
  }

  /**
   * Create an error for validator timeout.
   */
  static timeout(validatorId: string, timeoutMs: number): ValidationError {
    return new ValidationError(
      ValidationErrorCode.VALIDATOR_TIMEOUT,
      `Validator ${validatorId} timed out after ${timeoutMs}ms`
    );
  }

  /**
   * Create an error for invalid validator configuration.
   */
  static invalidConfig(validatorId: string, reason: string): ValidationError {
    return new ValidationError(
      ValidationErrorCode.INVALID_VALIDATOR_CONFIG,
      `Invalid configuration for validator ${validatorId}: ${reason}`
    );
  }

  /**
   * Create an error for context resolution failure.
   */
  static contextResolutionFailed(filePath: string, reason: string, cause?: Error): ValidationError {
    return new ValidationError(
      ValidationErrorCode.CONTEXT_RESOLUTION_FAILED,
      `Failed to resolve context for ${filePath}: ${reason}`,
      cause
    );
  }

  /**
   * Create an error for context file parse error.
   */
  static contextParseError(filePath: string, reason: string, cause?: Error): ValidationError {
    return new ValidationError(
      ValidationErrorCode.CONTEXT_PARSE_ERROR,
      `Failed to parse context file ${filePath}: ${reason}`,
      cause
    );
  }

  /**
   * Create an error for cache operations.
   */
  static cacheError(operation: string, reason: string, cause?: Error): ValidationError {
    return new ValidationError(
      ValidationErrorCode.CACHE_ERROR,
      `Cache ${operation} failed: ${reason}`,
      cause
    );
  }

  /**
   * Create an error for consensus not reached.
   */
  static consensusNotReached(reason: string): ValidationError {
    return new ValidationError(
      ValidationErrorCode.CONSENSUS_NOT_REACHED,
      `Consensus not reached: ${reason}`
    );
  }

  /**
   * Create an error for pipeline execution failure.
   */
  static pipelineExecutionFailed(reason: string, cause?: Error): ValidationError {
    return new ValidationError(
      ValidationErrorCode.PIPELINE_EXECUTION_FAILED,
      `Pipeline execution failed: ${reason}`,
      cause
    );
  }

  /**
   * Create an error for invalid trigger.
   */
  static invalidTrigger(trigger: string): ValidationError {
    return new ValidationError(
      ValidationErrorCode.INVALID_TRIGGER,
      `Invalid validation trigger: ${trigger}`
    );
  }

  /**
   * Create an error for file not found.
   */
  static fileNotFound(filePath: string): ValidationError {
    return new ValidationError(
      ValidationErrorCode.FILE_NOT_FOUND,
      `File not found: ${filePath}`
    );
  }

  /**
   * Create an error for command execution failure.
   */
  static commandExecutionFailed(
    command: string,
    exitCode: number | null,
    stderr: string
  ): ValidationError {
    return new ValidationError(
      ValidationErrorCode.COMMAND_EXECUTION_FAILED,
      `Command "${command}" failed with exit code ${exitCode}: ${stderr}`
    );
  }

  /**
   * Create an error for AI provider issues.
   */
  static aiProviderError(provider: string, reason: string, cause?: Error): ValidationError {
    return new ValidationError(
      ValidationErrorCode.AI_PROVIDER_ERROR,
      `AI provider ${provider} error: ${reason}`,
      cause
    );
  }

  /**
   * Wrap any error as a ValidationError.
   */
  static wrap(error: unknown): ValidationError {
    if (error instanceof ValidationError) {
      return error;
    }

    if (error instanceof Error) {
      return new ValidationError(
        ValidationErrorCode.PIPELINE_EXECUTION_FAILED,
        error.message,
        error
      );
    }

    if (typeof error === 'string') {
      return new ValidationError(
        ValidationErrorCode.PIPELINE_EXECUTION_FAILED,
        error
      );
    }

    return new ValidationError(
      ValidationErrorCode.PIPELINE_EXECUTION_FAILED,
      `Unknown error: ${JSON.stringify(error)}`
    );
  }
}

/**
 * Timeout error for internal use.
 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}
