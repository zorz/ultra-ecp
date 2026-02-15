/**
 * Framework Loader Unit Tests
 */

import { describe, it, expect } from 'bun:test';
import {
  createFrameworkLoader,
  parseFrameworkString,
} from '../../../src/services/ensemble/framework-loader.ts';

describe('FrameworkLoader', () => {
  describe('loadFromString - JSON', () => {
    it('should load valid JSON framework', () => {
      const json = JSON.stringify({
        id: 'test-framework',
        name: 'Test Framework',
        description: 'A test framework',
        settings: {
          contextSharing: 'shared',
          executionModel: 'turn-based',
          communicationPattern: 'shared-feed',
        },
        agents: [
          {
            id: 'coder',
            role: 'coder',
            provider: 'claude',
            model: 'claude-sonnet-4-20250514',
            systemPrompt: 'You are a coder.',
            tools: ['read', 'write', 'edit'],
          },
        ],
        validators: [],
        workflow: [
          {
            step: 'code',
            agent: 'coder',
            action: 'respond-to-task',
          },
        ],
        humanRole: {
          canInterrupt: true,
          canRedirect: true,
          promptForPermission: ['write', 'bash'],
          escalateOnDisagreement: true,
        },
      });

      const { framework, errors } = parseFrameworkString(json);

      expect(errors).toHaveLength(0);
      expect(framework).not.toBeNull();
      expect(framework!.id).toBe('test-framework');
      expect(framework!.agents).toHaveLength(1);
      expect(framework!.agents[0]!.role).toBe('coder');
    });

    it('should apply default settings', () => {
      const json = JSON.stringify({
        id: 'minimal',
        agents: [
          {
            id: 'agent',
            role: 'coder',
            provider: 'claude',
            model: 'claude-sonnet-4-20250514',
            tools: [],
          },
        ],
      });

      const { framework } = parseFrameworkString(json);

      expect(framework!.settings.contextSharing).toBe('shared');
      expect(framework!.settings.executionModel).toBe('turn-based');
      expect(framework!.settings.communicationPattern).toBe('shared-feed');
    });

    it('should apply default human role', () => {
      const json = JSON.stringify({
        id: 'minimal',
        agents: [
          {
            id: 'agent',
            role: 'coder',
            provider: 'claude',
            model: 'claude-sonnet-4-20250514',
            tools: [],
          },
        ],
      });

      const { framework } = parseFrameworkString(json);

      expect(framework!.humanRole.canInterrupt).toBe(true);
      expect(framework!.humanRole.escalateOnDisagreement).toBe(true);
    });
  });

  describe('loadFromString - simple YAML', () => {
    it('should load simple key-value YAML', () => {
      // The simple YAML parser handles basic key-value pairs
      // Complex nested arrays require JSON format
      const yaml = `
id: simple-framework
name: Simple Framework
`;

      const { errors } = parseFrameworkString(yaml);

      // Will fail validation (no agents) but should parse the basic structure
      expect(errors.some((e) => e.includes('agent'))).toBe(true);
    });

    it('should fall back to JSON for complex structures', () => {
      // For complex nested arrays (agents, workflow), use JSON
      const json = JSON.stringify({
        id: 'json-framework',
        settings: {
          executionModel: 'parallel',
        },
        agents: [
          {
            id: 'coder',
            role: 'coder',
            provider: 'openai',
            model: 'gpt-4',
            systemPrompt: 'Write code.',
            tools: ['read', 'write'],
          },
        ],
        workflow: [
          {
            step: 'code',
            agent: 'coder',
            action: 'respond-to-task',
          },
        ],
      });

      const { framework, errors } = parseFrameworkString(json);

      expect(errors).toHaveLength(0);
      expect(framework).not.toBeNull();
      expect(framework!.id).toBe('json-framework');
      expect(framework!.settings.executionModel).toBe('parallel');
    });

    it('should handle multiline strings in JSON', () => {
      const json = JSON.stringify({
        id: 'multiline-test',
        agents: [
          {
            id: 'agent',
            role: 'coder',
            provider: 'claude',
            model: 'claude-sonnet-4-20250514',
            tools: [],
            systemPrompt: 'You are a helpful assistant.\nWrite clean code.\nFollow best practices.',
          },
        ],
      });

      const { framework } = parseFrameworkString(json);

      expect(framework!.agents[0]!.systemPrompt).toContain('You are a helpful assistant.');
      expect(framework!.agents[0]!.systemPrompt).toContain('Write clean code.');
    });
  });

  describe('validation', () => {
    it('should require framework id', () => {
      const json = JSON.stringify({
        agents: [
          {
            id: 'agent',
            role: 'coder',
            provider: 'claude',
            model: 'model',
            tools: [],
          },
        ],
      });

      const { framework, errors } = parseFrameworkString(json);

      expect(framework).toBeNull();
      expect(errors.some((e) => e.includes('id'))).toBe(true);
    });

    it('should require at least one agent', () => {
      const json = JSON.stringify({
        id: 'no-agents',
        agents: [],
      });

      const { framework, errors } = parseFrameworkString(json);

      expect(framework).toBeNull();
      expect(errors.some((e) => e.includes('at least one agent'))).toBe(true);
    });

    it('should validate agent role', () => {
      const json = JSON.stringify({
        id: 'invalid-role',
        agents: [
          {
            id: 'agent',
            role: 'invalid-role',
            provider: 'claude',
            model: 'model',
            tools: [],
          },
        ],
      });

      const { framework, errors } = parseFrameworkString(json);

      expect(framework).toBeNull();
      expect(errors.some((e) => e.includes('invalid role'))).toBe(true);
    });

    it('should validate agent provider', () => {
      const json = JSON.stringify({
        id: 'invalid-provider',
        agents: [
          {
            id: 'agent',
            role: 'coder',
            provider: 'invalid-provider',
            model: 'model',
            tools: [],
          },
        ],
      });

      const { framework, errors } = parseFrameworkString(json);

      expect(framework).toBeNull();
      expect(errors.some((e) => e.includes('invalid provider'))).toBe(true);
    });

    it('should require agent model', () => {
      const json = JSON.stringify({
        id: 'no-model',
        agents: [
          {
            id: 'agent',
            role: 'coder',
            provider: 'claude',
            tools: [],
          },
        ],
      });

      const { framework, errors } = parseFrameworkString(json);

      expect(framework).toBeNull();
      expect(errors.some((e) => e.includes('model'))).toBe(true);
    });

    it('should validate validator type', () => {
      const json = JSON.stringify({
        id: 'invalid-validator',
        agents: [
          {
            id: 'agent',
            role: 'coder',
            provider: 'claude',
            model: 'model',
            tools: [],
          },
        ],
        validators: [
          {
            id: 'validator',
            type: 'invalid-type',
            triggers: [],
          },
        ],
      });

      const { framework, errors } = parseFrameworkString(json);

      expect(framework).toBeNull();
      expect(errors.some((e) => e.includes('invalid type'))).toBe(true);
    });

    it('should warn on invalid settings', () => {
      const json = JSON.stringify({
        id: 'invalid-settings',
        settings: {
          contextSharing: 'invalid',
          executionModel: 'invalid',
        },
        agents: [
          {
            id: 'agent',
            role: 'coder',
            provider: 'claude',
            model: 'model',
            tools: [],
          },
        ],
      });

      const { framework, warnings } = parseFrameworkString(json);

      expect(framework).not.toBeNull();
      expect(warnings.some((w) => w.includes('contextSharing'))).toBe(true);
      expect(warnings.some((w) => w.includes('executionModel'))).toBe(true);
      // Should use defaults
      expect(framework!.settings.contextSharing).toBe('shared');
    });
  });

  describe('getFramework', () => {
    it('should retrieve loaded framework by id', () => {
      const loader = createFrameworkLoader();

      loader.loadFromString(JSON.stringify({
        id: 'cached-framework',
        agents: [
          {
            id: 'agent',
            role: 'coder',
            provider: 'claude',
            model: 'model',
            tools: [],
          },
        ],
      }));

      const framework = loader.getFramework('cached-framework');
      expect(framework).toBeDefined();
      expect(framework!.id).toBe('cached-framework');
    });

    it('should return undefined for unknown id', () => {
      const loader = createFrameworkLoader();
      expect(loader.getFramework('unknown')).toBeUndefined();
    });
  });

  describe('getFrameworks', () => {
    it('should return all loaded frameworks', () => {
      const loader = createFrameworkLoader();

      loader.loadFromString(JSON.stringify({
        id: 'framework-1',
        agents: [{ id: 'a', role: 'coder', provider: 'claude', model: 'm', tools: [] }],
      }));

      loader.loadFromString(JSON.stringify({
        id: 'framework-2',
        agents: [{ id: 'a', role: 'coder', provider: 'claude', model: 'm', tools: [] }],
      }));

      const frameworks = loader.getFrameworks();
      expect(frameworks).toHaveLength(2);
    });
  });

  describe('parseFrameworkString', () => {
    it('should be a convenient standalone function', () => {
      const { framework, errors } = parseFrameworkString(JSON.stringify({
        id: 'standalone',
        agents: [
          {
            id: 'agent',
            role: 'coder',
            provider: 'claude',
            model: 'model',
            tools: [],
          },
        ],
      }));

      expect(errors).toHaveLength(0);
      expect(framework!.id).toBe('standalone');
    });
  });
});
