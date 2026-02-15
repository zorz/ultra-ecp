/**
 * Secret Service Errors Unit Tests
 *
 * Tests for SecretError class and error codes.
 */

import { describe, it, expect } from 'bun:test';
import { SecretError, SecretErrorCode } from '../../../src/services/secret/errors.ts';

describe('SecretError', () => {
  describe('constructor', () => {
    it('should create error with code and message', () => {
      const error = new SecretError(SecretErrorCode.SECRET_NOT_FOUND, 'Secret not found');

      expect(error.code).toBe(SecretErrorCode.SECRET_NOT_FOUND);
      expect(error.message).toBe('Secret not found');
      expect(error.name).toBe('SecretError');
    });

    it('should create error with cause', () => {
      const cause = new Error('Original error');
      const error = new SecretError(SecretErrorCode.STORAGE_ERROR, 'Storage failed', cause);

      expect(error.cause).toBe(cause);
    });

    it('should be instanceof Error', () => {
      const error = new SecretError(SecretErrorCode.SECRET_NOT_FOUND, 'Not found');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(SecretError);
    });
  });

  describe('factory methods', () => {
    describe('noWritableProvider', () => {
      it('should create NO_WRITABLE_PROVIDER error', () => {
        const error = SecretError.noWritableProvider();

        expect(error.code).toBe(SecretErrorCode.NO_WRITABLE_PROVIDER);
        expect(error.message).toContain('No writable');
      });
    });

    describe('providerNotFound', () => {
      it('should create PROVIDER_NOT_FOUND error with provider ID', () => {
        const error = SecretError.providerNotFound('my-provider');

        expect(error.code).toBe(SecretErrorCode.PROVIDER_NOT_FOUND);
        expect(error.message).toContain('my-provider');
      });
    });

    describe('providerReadOnly', () => {
      it('should create PROVIDER_READ_ONLY error with provider ID', () => {
        const error = SecretError.providerReadOnly('env');

        expect(error.code).toBe(SecretErrorCode.PROVIDER_READ_ONLY);
        expect(error.message).toContain('env');
        expect(error.message).toContain('read-only');
      });
    });

    describe('secretNotFound', () => {
      it('should create SECRET_NOT_FOUND error with key', () => {
        const error = SecretError.secretNotFound('api.key');

        expect(error.code).toBe(SecretErrorCode.SECRET_NOT_FOUND);
        expect(error.message).toContain('api.key');
      });
    });

    describe('secretExpired', () => {
      it('should create SECRET_EXPIRED error with key', () => {
        const error = SecretError.secretExpired('token.temp');

        expect(error.code).toBe(SecretErrorCode.SECRET_EXPIRED);
        expect(error.message).toContain('token.temp');
        expect(error.message).toContain('expired');
      });
    });

    describe('keychainAccessDenied', () => {
      it('should create KEYCHAIN_ACCESS_DENIED error', () => {
        const error = SecretError.keychainAccessDenied();

        expect(error.code).toBe(SecretErrorCode.KEYCHAIN_ACCESS_DENIED);
        expect(error.message).toContain('denied');
      });
    });

    describe('keychainNotAvailable', () => {
      it('should create KEYCHAIN_NOT_AVAILABLE error', () => {
        const error = SecretError.keychainNotAvailable();

        expect(error.code).toBe(SecretErrorCode.KEYCHAIN_NOT_AVAILABLE);
        expect(error.message).toContain('not available');
      });
    });

    describe('encryptionFailed', () => {
      it('should create ENCRYPTION_FAILED error for encrypt', () => {
        const error = SecretError.encryptionFailed('encrypt');

        expect(error.code).toBe(SecretErrorCode.ENCRYPTION_FAILED);
        expect(error.message).toContain('encrypt');
      });

      it('should create ENCRYPTION_FAILED error for decrypt', () => {
        const error = SecretError.encryptionFailed('decrypt');

        expect(error.code).toBe(SecretErrorCode.ENCRYPTION_FAILED);
        expect(error.message).toContain('decrypt');
      });

      it('should include cause if provided', () => {
        const cause = new Error('Crypto error');
        const error = SecretError.encryptionFailed('encrypt', cause);

        expect(error.cause).toBe(cause);
      });
    });

    describe('invalidKey', () => {
      it('should create INVALID_KEY error with key and reason', () => {
        const error = SecretError.invalidKey('bad key!', 'contains invalid characters');

        expect(error.code).toBe(SecretErrorCode.INVALID_KEY);
        expect(error.message).toContain('bad key!');
        expect(error.message).toContain('invalid characters');
      });
    });

    describe('storageError', () => {
      it('should create STORAGE_ERROR with message', () => {
        const error = SecretError.storageError('Database connection failed');

        expect(error.code).toBe(SecretErrorCode.STORAGE_ERROR);
        expect(error.message).toBe('Database connection failed');
      });

      it('should include cause if provided', () => {
        const cause = new Error('ENOENT');
        const error = SecretError.storageError('File not found', cause);

        expect(error.cause).toBe(cause);
      });
    });
  });

  describe('wrap', () => {
    it('should return existing SecretError unchanged', () => {
      const original = SecretError.secretNotFound('test');
      const wrapped = SecretError.wrap(original);

      expect(wrapped).toBe(original);
    });

    it('should wrap regular Error', () => {
      const original = new Error('Something failed');
      const wrapped = SecretError.wrap(original);

      expect(wrapped).toBeInstanceOf(SecretError);
      expect(wrapped.code).toBe(SecretErrorCode.STORAGE_ERROR);
      expect(wrapped.message).toBe('Something failed');
      expect(wrapped.cause).toBe(original);
    });

    it('should wrap string', () => {
      const wrapped = SecretError.wrap('String error');

      expect(wrapped).toBeInstanceOf(SecretError);
      expect(wrapped.code).toBe(SecretErrorCode.STORAGE_ERROR);
      expect(wrapped.message).toBe('String error');
    });

    it('should wrap unknown types', () => {
      const wrapped = SecretError.wrap({ custom: 'object' });

      expect(wrapped).toBeInstanceOf(SecretError);
      expect(wrapped.code).toBe(SecretErrorCode.STORAGE_ERROR);
    });
  });
});

describe('SecretErrorCode', () => {
  it('should have all error codes defined', () => {
    expect(SecretErrorCode.NO_WRITABLE_PROVIDER).toBeDefined();
    expect(SecretErrorCode.PROVIDER_NOT_FOUND).toBeDefined();
    expect(SecretErrorCode.PROVIDER_READ_ONLY).toBeDefined();
    expect(SecretErrorCode.SECRET_NOT_FOUND).toBeDefined();
    expect(SecretErrorCode.SECRET_EXPIRED).toBeDefined();
    expect(SecretErrorCode.KEYCHAIN_ACCESS_DENIED).toBeDefined();
    expect(SecretErrorCode.KEYCHAIN_NOT_AVAILABLE).toBeDefined();
    expect(SecretErrorCode.ENCRYPTION_FAILED).toBeDefined();
    expect(SecretErrorCode.INVALID_KEY).toBeDefined();
    expect(SecretErrorCode.STORAGE_ERROR).toBeDefined();
  });

  it('should have unique values', () => {
    const codes = Object.values(SecretErrorCode);
    const uniqueCodes = new Set(codes);
    expect(codes.length).toBe(uniqueCodes.size);
  });
});
