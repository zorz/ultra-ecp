/**
 * Validation Service Errors Unit Tests
 *
 * Tests for ValidationError class and error codes.
 */

import { describe, it, expect } from 'bun:test';
import { ValidationError, ValidationErrorCode, TimeoutError } from '../../../src/services/validation/errors.ts';

describe('ValidationError', () => {
  describe('constructor', () => {
    it('should create error with code and message', () => {
      const error = new ValidationError(
        ValidationErrorCode.VALIDATOR_NOT_FOUND,
        'Validator not found'
      );

      expect(error.code).toBe(ValidationErrorCode.VALIDATOR_NOT_FOUND);
      expect(error.message).toBe('Validator not found');
      expect(error.name).toBe('ValidationError');
    });

    it('should create error with cause', () => {
      const cause = new Error('Original error');
      const error = new ValidationError(
        ValidationErrorCode.PIPELINE_EXECUTION_FAILED,
        'Pipeline failed',
        cause
      );

      expect(error.cause).toBe(cause);
    });

    it('should be instanceof Error', () => {
      const error = new ValidationError(
        ValidationErrorCode.VALIDATOR_NOT_FOUND,
        'Not found'
      );

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(ValidationError);
    });
  });

  describe('factory methods', () => {
    describe('validatorNotFound', () => {
      it('should create VALIDATOR_NOT_FOUND error with ID', () => {
        const error = ValidationError.validatorNotFound('my-validator');

        expect(error.code).toBe(ValidationErrorCode.VALIDATOR_NOT_FOUND);
        expect(error.message).toContain('my-validator');
      });
    });

    describe('executionFailed', () => {
      it('should create VALIDATOR_EXECUTION_FAILED error', () => {
        const error = ValidationError.executionFailed('test-validator', 'Command failed');

        expect(error.code).toBe(ValidationErrorCode.VALIDATOR_EXECUTION_FAILED);
        expect(error.message).toContain('test-validator');
        expect(error.message).toContain('Command failed');
      });

      it('should include cause if provided', () => {
        const cause = new Error('Original');
        const error = ValidationError.executionFailed('test', 'reason', cause);

        expect(error.cause).toBe(cause);
      });
    });

    describe('timeout', () => {
      it('should create VALIDATOR_TIMEOUT error', () => {
        const error = ValidationError.timeout('slow-validator', 30000);

        expect(error.code).toBe(ValidationErrorCode.VALIDATOR_TIMEOUT);
        expect(error.message).toContain('slow-validator');
        expect(error.message).toContain('30000');
      });
    });

    describe('invalidConfig', () => {
      it('should create INVALID_VALIDATOR_CONFIG error', () => {
        const error = ValidationError.invalidConfig('bad-validator', 'missing command');

        expect(error.code).toBe(ValidationErrorCode.INVALID_VALIDATOR_CONFIG);
        expect(error.message).toContain('bad-validator');
        expect(error.message).toContain('missing command');
      });
    });

    describe('contextResolutionFailed', () => {
      it('should create CONTEXT_RESOLUTION_FAILED error', () => {
        const error = ValidationError.contextResolutionFailed('src/test.ts', 'file not found');

        expect(error.code).toBe(ValidationErrorCode.CONTEXT_RESOLUTION_FAILED);
        expect(error.message).toContain('src/test.ts');
        expect(error.message).toContain('file not found');
      });
    });

    describe('contextParseError', () => {
      it('should create CONTEXT_PARSE_ERROR error', () => {
        const error = ValidationError.contextParseError('.validation/context.md', 'invalid markdown');

        expect(error.code).toBe(ValidationErrorCode.CONTEXT_PARSE_ERROR);
        expect(error.message).toContain('.validation/context.md');
        expect(error.message).toContain('invalid markdown');
      });
    });

    describe('cacheError', () => {
      it('should create CACHE_ERROR error', () => {
        const error = ValidationError.cacheError('get', 'key not found');

        expect(error.code).toBe(ValidationErrorCode.CACHE_ERROR);
        expect(error.message).toContain('get');
        expect(error.message).toContain('key not found');
      });
    });

    describe('consensusNotReached', () => {
      it('should create CONSENSUS_NOT_REACHED error', () => {
        const error = ValidationError.consensusNotReached('insufficient responses');

        expect(error.code).toBe(ValidationErrorCode.CONSENSUS_NOT_REACHED);
        expect(error.message).toContain('insufficient responses');
      });
    });

    describe('pipelineExecutionFailed', () => {
      it('should create PIPELINE_EXECUTION_FAILED error', () => {
        const error = ValidationError.pipelineExecutionFailed('validation loop detected');

        expect(error.code).toBe(ValidationErrorCode.PIPELINE_EXECUTION_FAILED);
        expect(error.message).toContain('validation loop detected');
      });
    });

    describe('invalidTrigger', () => {
      it('should create INVALID_TRIGGER error', () => {
        const error = ValidationError.invalidTrigger('unknown-trigger');

        expect(error.code).toBe(ValidationErrorCode.INVALID_TRIGGER);
        expect(error.message).toContain('unknown-trigger');
      });
    });

    describe('fileNotFound', () => {
      it('should create FILE_NOT_FOUND error', () => {
        const error = ValidationError.fileNotFound('/path/to/missing.ts');

        expect(error.code).toBe(ValidationErrorCode.FILE_NOT_FOUND);
        expect(error.message).toContain('/path/to/missing.ts');
      });
    });

    describe('commandExecutionFailed', () => {
      it('should create COMMAND_EXECUTION_FAILED error', () => {
        const error = ValidationError.commandExecutionFailed('tsc --noEmit', 1, 'Type error');

        expect(error.code).toBe(ValidationErrorCode.COMMAND_EXECUTION_FAILED);
        expect(error.message).toContain('tsc --noEmit');
        expect(error.message).toContain('1');
        expect(error.message).toContain('Type error');
      });
    });

    describe('aiProviderError', () => {
      it('should create AI_PROVIDER_ERROR error', () => {
        const error = ValidationError.aiProviderError('claude', 'rate limited');

        expect(error.code).toBe(ValidationErrorCode.AI_PROVIDER_ERROR);
        expect(error.message).toContain('claude');
        expect(error.message).toContain('rate limited');
      });
    });
  });

  describe('wrap', () => {
    it('should return existing ValidationError unchanged', () => {
      const original = ValidationError.validatorNotFound('test');
      const wrapped = ValidationError.wrap(original);

      expect(wrapped).toBe(original);
    });

    it('should wrap regular Error', () => {
      const original = new Error('Something failed');
      const wrapped = ValidationError.wrap(original);

      expect(wrapped).toBeInstanceOf(ValidationError);
      expect(wrapped.code).toBe(ValidationErrorCode.PIPELINE_EXECUTION_FAILED);
      expect(wrapped.message).toBe('Something failed');
      expect(wrapped.cause).toBe(original);
    });

    it('should wrap string', () => {
      const wrapped = ValidationError.wrap('String error');

      expect(wrapped).toBeInstanceOf(ValidationError);
      expect(wrapped.code).toBe(ValidationErrorCode.PIPELINE_EXECUTION_FAILED);
      expect(wrapped.message).toBe('String error');
    });

    it('should wrap unknown types', () => {
      const wrapped = ValidationError.wrap({ custom: 'object' });

      expect(wrapped).toBeInstanceOf(ValidationError);
      expect(wrapped.code).toBe(ValidationErrorCode.PIPELINE_EXECUTION_FAILED);
    });
  });
});

describe('TimeoutError', () => {
  it('should create timeout error', () => {
    const error = new TimeoutError('Operation timed out');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.name).toBe('TimeoutError');
    expect(error.message).toBe('Operation timed out');
  });
});

describe('ValidationErrorCode', () => {
  it('should have all error codes defined', () => {
    expect(ValidationErrorCode.VALIDATOR_NOT_FOUND).toBeDefined();
    expect(ValidationErrorCode.VALIDATOR_EXECUTION_FAILED).toBeDefined();
    expect(ValidationErrorCode.VALIDATOR_TIMEOUT).toBeDefined();
    expect(ValidationErrorCode.INVALID_VALIDATOR_CONFIG).toBeDefined();
    expect(ValidationErrorCode.CONTEXT_RESOLUTION_FAILED).toBeDefined();
    expect(ValidationErrorCode.CONTEXT_PARSE_ERROR).toBeDefined();
    expect(ValidationErrorCode.CACHE_ERROR).toBeDefined();
    expect(ValidationErrorCode.CONSENSUS_NOT_REACHED).toBeDefined();
    expect(ValidationErrorCode.PIPELINE_EXECUTION_FAILED).toBeDefined();
    expect(ValidationErrorCode.INVALID_TRIGGER).toBeDefined();
    expect(ValidationErrorCode.FILE_NOT_FOUND).toBeDefined();
    expect(ValidationErrorCode.COMMAND_EXECUTION_FAILED).toBeDefined();
    expect(ValidationErrorCode.AI_PROVIDER_ERROR).toBeDefined();
  });

  it('should have unique values', () => {
    const codes = Object.values(ValidationErrorCode);
    const uniqueCodes = new Set(codes);
    expect(codes.length).toBe(uniqueCodes.size);
  });
});
