/**
 * Static Validator Unit Tests
 *
 * Tests for shell command execution and output parsing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import {
  runStaticValidator,
  createTypeScriptValidator,
  createESLintValidator,
  createTestValidator,
  createFormatterValidator,
  createStaticValidator,
} from '../../../src/services/validation/static-validator.ts';
import type { ValidationContext, ValidatorDefinition } from '../../../src/services/validation/types.ts';

describe('runStaticValidator', () => {
  const testDir = join(process.cwd(), '.test-static-validator');

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  const createContext = (files: Array<{ path: string; content: string }>): ValidationContext => ({
    trigger: 'pre-write',
    timestamp: Date.now(),
    files,
    sessionId: 'test-session',
  });

  const createValidator = (command: string, options: Partial<ValidatorDefinition> = {}): ValidatorDefinition => ({
    id: 'test-validator',
    name: 'Test Validator',
    type: 'static',
    enabled: true,
    priority: 10,
    command,
    triggers: ['pre-write'],
    behavior: {
      onFailure: 'warning',
      blockOnFailure: false,
      required: false,
      timeoutMs: 30000,
      onTimeout: 'warning',
      cacheable: true,
    },
    ...options,
  });

  describe('command execution', () => {
    it('should return approved for successful command', async () => {
      const validator = createValidator('echo "success"');
      const context = createContext([]);

      const result = await runStaticValidator(validator, context);

      expect(result.status).toBe('approved');
      expect(result.validator).toBe('test-validator');
    });

    it('should return rejected for failed command', async () => {
      const validator = createValidator('exit 1');
      const context = createContext([]);

      const result = await runStaticValidator(validator, context);

      expect(result.status).toBe('rejected');
    });

    it('should substitute {{files}} placeholder', async () => {
      const testFile = join(testDir, 'test.txt');
      await writeFile(testFile, 'content');

      const validator = createValidator('cat {{files}}');
      const context = createContext([{ path: testFile, content: 'content' }]);

      const result = await runStaticValidator(validator, context);

      expect(result.status).toBe('approved');
      expect(result.message).toContain('content');
    });

    it('should return skipped when no command provided', async () => {
      const validator = createValidator('');
      validator.command = undefined;
      const context = createContext([]);

      const result = await runStaticValidator(validator, context);

      expect(result.status).toBe('skipped');
      expect(result.message).toContain('no command');
    });
  });

  describe('TypeScript output parsing', () => {
    it('should parse TypeScript errors with (line,col) format', async () => {
      const output = 'src/test.ts(10,5): error TS2322: Type string is not assignable to type number';
      const validator = createValidator(`echo "${output}" && exit 1`);
      validator.command = 'tsc --noEmit';

      // Override command for test
      const context = createContext([{ path: 'src/test.ts', content: '' }]);
      const result = await runStaticValidator(
        { ...validator, command: `echo '${output}' && exit 1` },
        context
      );

      expect(result.status).toBe('rejected');
      expect(result.message).toContain('error');
    });

    it('should approve when no TypeScript errors', async () => {
      const validator = createValidator('echo "No errors" && exit 0');
      const context = createContext([]);

      const result = await runStaticValidator(validator, context);

      expect(result.status).toBe('approved');
    });
  });

  describe('text output parsing', () => {
    it('should extract error message from stderr', async () => {
      const validator = createValidator('echo "Error: something failed" >&2 && exit 1');
      const context = createContext([]);

      const result = await runStaticValidator(validator, context);

      expect(result.status).toBe('rejected');
      expect(result.message).toContain('Error');
    });

    it('should extract first line as message on failure', async () => {
      const validator = createValidator('echo -e "First line\\nSecond line" && exit 1');
      const context = createContext([]);

      const result = await runStaticValidator(validator, context);

      expect(result.status).toBe('rejected');
    });
  });
});

describe('createTypeScriptValidator', () => {
  it('should create validator with default options', () => {
    const validator = createTypeScriptValidator();

    expect(validator.id).toBe('typescript');
    expect(validator.type).toBe('static');
    expect(validator.command).toBe('tsc --noEmit');
    expect(validator.triggers).toContain('pre-write');
    expect(validator.triggers).toContain('pre-commit');
    expect(validator.filePatterns).toContain('**/*.ts');
    expect(validator.behavior.required).toBe(true);
    expect(validator.behavior.blockOnFailure).toBe(true);
  });

  it('should allow overriding options', () => {
    const validator = createTypeScriptValidator({
      id: 'custom-tsc',
      command: 'tsc --noEmit --project tsconfig.test.json',
      behavior: { required: false },
    });

    expect(validator.id).toBe('custom-tsc');
    expect(validator.command).toBe('tsc --noEmit --project tsconfig.test.json');
    expect(validator.behavior.required).toBe(false);
  });
});

describe('createESLintValidator', () => {
  it('should create validator with default options', () => {
    const validator = createESLintValidator();

    expect(validator.id).toBe('eslint');
    expect(validator.type).toBe('static');
    expect(validator.command).toContain('eslint');
    expect(validator.command).toContain('--format json');
    expect(validator.triggers).toContain('pre-write');
    expect(validator.filePatterns).toContain('**/*.ts');
    expect(validator.behavior.required).toBe(false);
    expect(validator.behavior.blockOnFailure).toBe(false);
  });

  it('should allow custom configuration', () => {
    const validator = createESLintValidator({
      command: 'eslint --format json --config .eslintrc.custom.js {{files}}',
      behavior: { blockOnFailure: true },
    });

    expect(validator.command).toContain('.eslintrc.custom.js');
    expect(validator.behavior.blockOnFailure).toBe(true);
  });
});

describe('createTestValidator', () => {
  it('should create validator with default options', () => {
    const validator = createTestValidator();

    expect(validator.id).toBe('tests');
    expect(validator.type).toBe('static');
    expect(validator.command).toContain('bun test');
    expect(validator.triggers).toContain('pre-commit');
    expect(validator.behavior.required).toBe(true);
    expect(validator.behavior.cacheable).toBe(false);
    expect(validator.behavior.timeoutMs).toBe(300000);
  });

  it('should allow custom test command', () => {
    const validator = createTestValidator({
      command: 'npm test',
      behavior: { timeoutMs: 600000 },
    });

    expect(validator.command).toBe('npm test');
    expect(validator.behavior.timeoutMs).toBe(600000);
  });
});

describe('createFormatterValidator', () => {
  it('should create validator with default options', () => {
    const validator = createFormatterValidator();

    expect(validator.id).toBe('formatter');
    expect(validator.type).toBe('static');
    expect(validator.command).toContain('prettier');
    expect(validator.command).toContain('--check');
    expect(validator.triggers).toContain('pre-write');
    expect(validator.behavior.onTimeout).toBe('skip');
  });

  it('should allow custom formatter', () => {
    const validator = createFormatterValidator({
      id: 'biome',
      name: 'Biome Formatter',
      command: 'biome check {{files}}',
    });

    expect(validator.id).toBe('biome');
    expect(validator.command).toContain('biome');
  });
});

describe('createStaticValidator', () => {
  it('should create custom validator', () => {
    const validator = createStaticValidator(
      'custom-lint',
      'Custom Linter',
      'custom-lint --strict {{files}}'
    );

    expect(validator.id).toBe('custom-lint');
    expect(validator.name).toBe('Custom Linter');
    expect(validator.command).toBe('custom-lint --strict {{files}}');
    expect(validator.type).toBe('static');
    expect(validator.enabled).toBe(true);
  });

  it('should merge custom options', () => {
    const validator = createStaticValidator(
      'spell-check',
      'Spell Checker',
      'cspell {{files}}',
      {
        triggers: ['pre-commit'],
        filePatterns: ['**/*.md'],
        behavior: { onFailure: 'error' },
      }
    );

    expect(validator.triggers).toContain('pre-commit');
    expect(validator.filePatterns).toContain('**/*.md');
    expect(validator.behavior.onFailure).toBe('error');
  });
});

describe('output format detection', () => {
  const createContext = (): ValidationContext => ({
    trigger: 'pre-write',
    timestamp: Date.now(),
    files: [],
    sessionId: 'test',
  });

  it('should detect TypeScript format from command', async () => {
    const validator: ValidatorDefinition = {
      id: 'tsc',
      name: 'TSC',
      type: 'static',
      enabled: true,
      priority: 10,
      command: 'echo "test.ts(1,1): error TS2322: test" && exit 1',
      triggers: ['pre-write'],
      behavior: {
        onFailure: 'error',
        blockOnFailure: false,
        required: false,
        timeoutMs: 5000,
        onTimeout: 'skip',
        cacheable: false,
      },
    };

    const result = await runStaticValidator(validator, createContext());
    expect(result.status).toBe('rejected');
  });
});
