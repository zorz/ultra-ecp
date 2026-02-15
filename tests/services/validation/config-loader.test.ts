/**
 * Configuration Loader Unit Tests
 *
 * Tests for YAML/JSON configuration loading.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import {
  ConfigLoader,
  createConfigLoader,
  parseConfigString,
} from '../../../src/services/validation/config-loader.ts';

describe('ConfigLoader', () => {
  const testDir = join(process.cwd(), '.test-config-loader');
  const testConfigPath = join(testDir, 'validators.yaml');

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

  describe('load', () => {
    it('should load JSON configuration', async () => {
      const config = {
        settings: {
          executionModel: 'parallel',
          defaultTimeout: 60000,
        },
        validators: [
          {
            id: 'typescript',
            name: 'TypeScript Check',
            type: 'static',
            command: 'tsc --noEmit',
            triggers: ['pre-write'],
          },
        ],
      };

      await writeFile(testConfigPath, JSON.stringify(config, null, 2));

      const loader = createConfigLoader({ configPath: `.test-config-loader/validators.yaml` });
      const { config: loaded, errors } = await loader.load();

      expect(errors).toHaveLength(0);
      expect(loaded.executionModel).toBe('parallel');
      expect(loaded.defaultTimeout).toBe(60000);
      expect(loaded.validators).toHaveLength(1);
      expect(loaded.validators![0]!.id).toBe('typescript');
    });

    it('should return defaults when file not found', async () => {
      const loader = createConfigLoader({ configPath: '.nonexistent/config.yaml' });
      const { config, errors } = await loader.load();

      expect(errors).toHaveLength(0);
      expect(config.executionModel).toBe('turn-based');
      expect(config.defaultTimeout).toBe(30000);
    });

    it('should validate validator types', async () => {
      const config = {
        validators: [
          {
            id: 'invalid',
            name: 'Invalid Type',
            type: 'invalid-type',
          },
        ],
      };

      await writeFile(testConfigPath, JSON.stringify(config));

      const loader = createConfigLoader({ configPath: `.test-config-loader/validators.yaml` });
      const { errors } = await loader.load();

      expect(errors.some((e) => e.includes('invalid type'))).toBe(true);
    });

    it('should validate required fields', async () => {
      const config = {
        validators: [
          {
            name: 'Missing ID',
            type: 'static',
          },
        ],
      };

      await writeFile(testConfigPath, JSON.stringify(config));

      const loader = createConfigLoader({ configPath: `.test-config-loader/validators.yaml` });
      const { errors } = await loader.load();

      expect(errors.some((e) => e.includes('missing'))).toBe(true);
    });
  });

  describe('consensus configuration', () => {
    it('should load consensus configuration', async () => {
      const config = {
        consensus: {
          strategy: 'unanimous',
          minimumResponses: 3,
          escalateToHuman: false,
        },
      };

      await writeFile(testConfigPath, JSON.stringify(config));

      const loader = createConfigLoader({ configPath: `.test-config-loader/validators.yaml` });
      const { config: loaded } = await loader.load();

      expect(loaded.consensus.strategy).toBe('unanimous');
      expect(loaded.consensus.minimumResponses).toBe(3);
      expect(loaded.consensus.escalateToHuman).toBe(false);
    });

    it('should validate consensus strategy', async () => {
      const config = {
        consensus: {
          strategy: 'invalid-strategy',
        },
      };

      await writeFile(testConfigPath, JSON.stringify(config));

      const loader = createConfigLoader({ configPath: `.test-config-loader/validators.yaml` });
      const { errors } = await loader.load();

      expect(errors.some((e) => e.includes('consensus strategy'))).toBe(true);
    });
  });

  describe('validator definitions', () => {
    it('should load static validator', async () => {
      const config = {
        validators: [
          {
            id: 'eslint',
            name: 'ESLint',
            type: 'static',
            command: 'eslint --format json {{files}}',
            triggers: ['pre-write'],
            filePatterns: ['**/*.ts'],
            behavior: {
              onFailure: 'warning',
              blockOnFailure: false,
            },
          },
        ],
      };

      await writeFile(testConfigPath, JSON.stringify(config));

      const loader = createConfigLoader({ configPath: `.test-config-loader/validators.yaml` });
      const { config: loaded } = await loader.load();

      const eslint = loaded.validators![0]!;
      expect(eslint.id).toBe('eslint');
      expect(eslint.type).toBe('static');
      expect(eslint.command).toBe('eslint --format json {{files}}');
      expect(eslint.behavior.onFailure).toBe('warning');
    });

    it('should load AI critic validator', async () => {
      const config = {
        validators: [
          {
            id: 'code-critic',
            name: 'Code Review',
            type: 'ai-critic',
            provider: 'claude',
            model: 'claude-3-sonnet',
            systemPrompt: 'Review this code.',
            triggers: ['pre-write'],
            contextConfig: {
              includeFullFile: true,
              includeDiff: true,
            },
          },
        ],
      };

      await writeFile(testConfigPath, JSON.stringify(config));

      const loader = createConfigLoader({ configPath: `.test-config-loader/validators.yaml` });
      const { config: loaded } = await loader.load();

      const critic = loaded.validators![0]!;
      expect(critic.id).toBe('code-critic');
      expect(critic.type).toBe('ai-critic');
      expect(critic.provider).toBe('claude');
      expect(critic.model).toBe('claude-3-sonnet');
      expect(critic.contextConfig?.includeFullFile).toBe(true);
    });

    it('should validate AI provider', async () => {
      const config = {
        validators: [
          {
            id: 'critic',
            name: 'Critic',
            type: 'ai-critic',
            provider: 'invalid-provider',
          },
        ],
      };

      await writeFile(testConfigPath, JSON.stringify(config));

      const loader = createConfigLoader({ configPath: `.test-config-loader/validators.yaml` });
      const { errors } = await loader.load();

      expect(errors.some((e) => e.includes('invalid provider'))).toBe(true);
    });
  });

  describe('getLastConfig', () => {
    it('should return the last loaded config', async () => {
      const config = {
        settings: {
          executionModel: 'parallel',
        },
      };

      await writeFile(testConfigPath, JSON.stringify(config));

      const loader = createConfigLoader({ configPath: `.test-config-loader/validators.yaml` });
      await loader.load();

      const lastConfig = loader.getLastConfig();
      expect(lastConfig).not.toBeNull();
      expect(lastConfig?.executionModel).toBe('parallel');
    });

    it('should return null before first load', () => {
      const loader = createConfigLoader();
      expect(loader.getLastConfig()).toBeNull();
    });
  });
});

describe('parseConfigString', () => {
  it('should parse JSON configuration', () => {
    const json = JSON.stringify({
      settings: {
        executionModel: 'parallel',
      },
      validators: [
        { id: 'test', name: 'Test', type: 'static', command: 'echo test' },
      ],
    });

    const { config, errors } = parseConfigString(json);

    expect(errors).toHaveLength(0);
    expect(config.executionModel).toBe('parallel');
    expect(config.validators).toHaveLength(1);
  });

  it('should handle invalid JSON with defaults', () => {
    // The simple YAML parser treats 'invalid { json' as a simple value
    // This tests that even malformed content returns a usable config
    const { config } = parseConfigString('invalid { json');

    // Should return defaults even if parsing produces unexpected results
    expect(config.executionModel).toBe('turn-based'); // Default
  });
});

describe('ConfigLoader.validate', () => {
  it('should validate execution model', () => {
    const errors = ConfigLoader.validate({
      executionModel: 'invalid' as 'turn-based',
      defaultTimeout: 30000,
      cacheEnabled: true,
      cacheMaxAge: 300000,
      contextDir: '.validation',
      consensus: {
        strategy: 'majority',
        minimumResponses: 1,
        timeoutMs: 60000,
        escalateToHuman: true,
      },
    });

    expect(errors.some((e) => e.includes('executionModel'))).toBe(true);
  });

  it('should validate positive timeout', () => {
    const errors = ConfigLoader.validate({
      executionModel: 'turn-based',
      defaultTimeout: -1,
      cacheEnabled: true,
      cacheMaxAge: 300000,
      contextDir: '.validation',
      consensus: {
        strategy: 'majority',
        minimumResponses: 1,
        timeoutMs: 60000,
        escalateToHuman: true,
      },
    });

    expect(errors.some((e) => e.includes('defaultTimeout'))).toBe(true);
  });

  it('should validate AI critic has provider', () => {
    const errors = ConfigLoader.validate({
      executionModel: 'turn-based',
      defaultTimeout: 30000,
      cacheEnabled: true,
      cacheMaxAge: 300000,
      contextDir: '.validation',
      consensus: {
        strategy: 'majority',
        minimumResponses: 1,
        timeoutMs: 60000,
        escalateToHuman: true,
      },
      validators: [
        {
          id: 'critic',
          name: 'Critic',
          type: 'ai-critic',
          enabled: true,
          priority: 50,
          triggers: ['pre-write'],
          behavior: {
            onFailure: 'warning',
            blockOnFailure: false,
            required: false,
            timeoutMs: 30000,
            onTimeout: 'warning',
            cacheable: true,
          },
        },
      ],
    });

    expect(errors.some((e) => e.includes('provider'))).toBe(true);
  });

  it('should validate static validator has command', () => {
    const errors = ConfigLoader.validate({
      executionModel: 'turn-based',
      defaultTimeout: 30000,
      cacheEnabled: true,
      cacheMaxAge: 300000,
      contextDir: '.validation',
      consensus: {
        strategy: 'majority',
        minimumResponses: 1,
        timeoutMs: 60000,
        escalateToHuman: true,
      },
      validators: [
        {
          id: 'static',
          name: 'Static',
          type: 'static',
          enabled: true,
          priority: 50,
          triggers: ['pre-write'],
          behavior: {
            onFailure: 'warning',
            blockOnFailure: false,
            required: false,
            timeoutMs: 30000,
            onTimeout: 'warning',
            cacheable: true,
          },
        },
      ],
    });

    expect(errors.some((e) => e.includes('command'))).toBe(true);
  });
});
