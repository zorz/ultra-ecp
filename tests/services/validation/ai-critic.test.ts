/**
 * AI Critic Unit Tests
 *
 * Tests for AI-based code review functionality.
 */

import { describe, it, expect } from 'bun:test';
import {
  buildCriticPrompt,
  createCodeReviewCritic,
  createSecurityCritic,
  createArchitectureCritic,
} from '../../../src/services/validation/ai-critic.ts';
import type { ValidationContext, ValidatorDefinition } from '../../../src/services/validation/types.ts';

describe('buildCriticPrompt', () => {
  const createContext = (
    files: Array<{ path: string; content: string; diff?: string }>
  ): ValidationContext => ({
    trigger: 'pre-write',
    timestamp: Date.now(),
    files,
    sessionId: 'test-session',
  });

  const createValidator = (
    systemPrompt: string,
    options: Partial<ValidatorDefinition> = {}
  ): ValidatorDefinition => ({
    id: 'test-critic',
    name: 'Test Critic',
    type: 'ai-critic',
    enabled: true,
    priority: 50,
    provider: 'claude',
    systemPrompt,
    triggers: ['pre-write'],
    behavior: {
      onFailure: 'warning',
      blockOnFailure: false,
      required: false,
      timeoutMs: 60000,
      onTimeout: 'warning',
      cacheable: true,
    },
    ...options,
  });

  describe('basic prompt building', () => {
    it('should include system prompt', () => {
      const validator = createValidator('Review this code for quality.');
      const context = createContext([{ path: 'test.ts', content: 'const x = 1;' }]);

      const prompt = buildCriticPrompt(validator, context);

      expect(prompt).toContain('Review this code for quality.');
    });

    it('should include file path', () => {
      const validator = createValidator('Review code.');
      const context = createContext([{ path: 'src/utils/helper.ts', content: 'export function foo() {}' }]);

      const prompt = buildCriticPrompt(validator, context);

      expect(prompt).toContain('src/utils/helper.ts');
    });

    it('should include file content when configured', () => {
      const validator = createValidator('Review code.', {
        contextConfig: {
          includeFullFile: true,
          includeDiff: false,
          includeGitDiff: false,
          includeRelatedFiles: false,
          relatedFileDepth: 0,
        },
      });
      const context = createContext([{ path: 'test.ts', content: 'const x = 1;' }]);

      const prompt = buildCriticPrompt(validator, context);

      expect(prompt).toContain('const x = 1;');
    });

    it('should include diff when provided', () => {
      const validator = createValidator('Review code.');
      const context = createContext([
        {
          path: 'test.ts',
          content: 'const x = 2;',
          diff: '+const x = 2;\n-const x = 1;',
        },
      ]);

      const prompt = buildCriticPrompt(validator, context);

      expect(prompt).toContain('+const x = 2;');
      expect(prompt).toContain('-const x = 1;');
    });

    it('should include response format instructions', () => {
      const validator = createValidator('Review code.');
      const context = createContext([{ path: 'test.ts', content: '' }]);

      const prompt = buildCriticPrompt(validator, context);

      expect(prompt).toContain('Response Format');
      expect(prompt).toContain('"status"');
      expect(prompt).toContain('approved');
      expect(prompt).toContain('rejected');
      expect(prompt).toContain('needs-revision');
    });
  });

  describe('hierarchical context', () => {
    it('should include patterns when hierarchical context is available', () => {
      const validator = createValidator('Review code.');
      const context = createContext([
        {
          path: 'test.ts',
          content: 'const x = 1;',
        },
      ]);
      context.files[0]!.hierarchicalContext = {
        patterns: [
          { id: 'p1', description: 'Use Result type for errors', source: 'global' },
          { id: 'p2', description: 'Always handle async errors', source: 'global' },
        ],
        antiPatterns: [],
        conventions: [],
        architectureNotes: '',
        overrides: [],
      };

      const prompt = buildCriticPrompt(validator, context);

      expect(prompt).toContain('Patterns to Enforce');
      expect(prompt).toContain('Use Result type for errors');
      expect(prompt).toContain('Always handle async errors');
    });

    it('should include anti-patterns when available', () => {
      const validator = createValidator('Review code.');
      const context = createContext([{ path: 'test.ts', content: '' }]);
      context.files[0]!.hierarchicalContext = {
        patterns: [],
        antiPatterns: [
          {
            id: 'ap1',
            pattern: 'console.log',
            alternative: 'Use debugLog instead',
            source: 'global',
          },
        ],
        conventions: [],
        architectureNotes: '',
        overrides: [],
      };

      const prompt = buildCriticPrompt(validator, context);

      expect(prompt).toContain('Anti-Patterns to Flag');
      expect(prompt).toContain('console.log');
      expect(prompt).toContain('Use debugLog instead');
    });

    it('should include conventions when available', () => {
      const validator = createValidator('Review code.');
      const context = createContext([{ path: 'test.ts', content: '' }]);
      context.files[0]!.hierarchicalContext = {
        patterns: [],
        antiPatterns: [],
        conventions: [
          { id: 'c1', description: 'File names: kebab-case', source: 'global' },
        ],
        architectureNotes: '',
        overrides: [],
      };

      const prompt = buildCriticPrompt(validator, context);

      expect(prompt).toContain('Conventions');
      expect(prompt).toContain('File names: kebab-case');
    });

    it('should include architecture notes when available', () => {
      const validator = createValidator('Review code.');
      const context = createContext([{ path: 'test.ts', content: '' }]);
      context.files[0]!.hierarchicalContext = {
        patterns: [],
        antiPatterns: [],
        conventions: [],
        architectureNotes: 'This module handles user authentication using JWT tokens.',
        overrides: [],
      };

      const prompt = buildCriticPrompt(validator, context);

      expect(prompt).toContain('Architecture Context');
      expect(prompt).toContain('JWT tokens');
    });
  });

  describe('git diff', () => {
    it('should include git diff when available and configured', () => {
      const validator = createValidator('Review code.', {
        contextConfig: {
          includeFullFile: false,
          includeDiff: false,
          includeGitDiff: true,
          includeRelatedFiles: false,
          relatedFileDepth: 0,
        },
      });
      const context = createContext([{ path: 'test.ts', content: '' }]);
      context.gitDiff = `diff --git a/test.ts b/test.ts
index abc..def 100644
--- a/test.ts
+++ b/test.ts
@@ -1 +1 @@
-const x = 1;
+const x = 2;`;

      const prompt = buildCriticPrompt(validator, context);

      expect(prompt).toContain('Git Diff');
      expect(prompt).toContain('-const x = 1;');
      expect(prompt).toContain('+const x = 2;');
    });
  });

  describe('multiple files', () => {
    it('should include all files in prompt', () => {
      const validator = createValidator('Review code.', {
        contextConfig: {
          includeFullFile: true,
          includeDiff: true,
          includeGitDiff: true,
          includeRelatedFiles: false,
          relatedFileDepth: 0,
        },
      });
      const context = createContext([
        { path: 'src/a.ts', content: 'export const a = 1;' },
        { path: 'src/b.ts', content: 'export const b = 2;' },
        { path: 'src/c.ts', content: 'export const c = 3;' },
      ]);

      const prompt = buildCriticPrompt(validator, context);

      expect(prompt).toContain('src/a.ts');
      expect(prompt).toContain('src/b.ts');
      expect(prompt).toContain('src/c.ts');
      expect(prompt).toContain('export const a = 1;');
      expect(prompt).toContain('export const b = 2;');
      expect(prompt).toContain('export const c = 3;');
    });
  });
});

describe('createCodeReviewCritic', () => {
  it('should create validator with default options', () => {
    const validator = createCodeReviewCritic({ provider: 'claude' });

    expect(validator.id).toBe('code-review-critic');
    expect(validator.type).toBe('ai-critic');
    expect(validator.provider).toBe('claude');
    expect(validator.triggers).toContain('pre-write');
    expect(validator.behavior.required).toBe(false);
    expect(validator.behavior.blockOnFailure).toBe(false);
  });

  it('should include system prompt for code review', () => {
    const validator = createCodeReviewCritic({ provider: 'claude' });

    expect(validator.systemPrompt).toContain('code reviewer');
    expect(validator.systemPrompt).toContain('quality');
    expect(validator.systemPrompt).toContain('bugs');
  });

  it('should allow custom system prompt', () => {
    const validator = createCodeReviewCritic({
      provider: 'claude',
      systemPrompt: 'Custom review prompt.',
    });

    expect(validator.systemPrompt).toBe('Custom review prompt.');
  });

  it('should allow custom model', () => {
    const validator = createCodeReviewCritic({
      provider: 'openai',
      model: 'gpt-4-turbo',
    });

    expect(validator.provider).toBe('openai');
    expect(validator.model).toBe('gpt-4-turbo');
  });
});

describe('createSecurityCritic', () => {
  it('should create validator with security-focused defaults', () => {
    const validator = createSecurityCritic({ provider: 'claude' });

    expect(validator.id).toBe('security-critic');
    expect(validator.type).toBe('ai-critic');
    expect(validator.provider).toBe('claude');
    expect(validator.triggers).toContain('pre-write');
    expect(validator.triggers).toContain('pre-commit');
    expect(validator.behavior.required).toBe(true);
    expect(validator.behavior.blockOnFailure).toBe(true);
    expect(validator.behavior.onFailure).toBe('error');
  });

  it('should include security-focused system prompt', () => {
    const validator = createSecurityCritic({ provider: 'claude' });

    expect(validator.systemPrompt).toContain('security');
    expect(validator.systemPrompt).toContain('Injection');
    expect(validator.systemPrompt).toContain('OWASP');
  });

  it('should have longer timeout for thorough review', () => {
    const validator = createSecurityCritic({ provider: 'claude' });

    expect(validator.behavior.timeoutMs).toBe(90000);
    expect(validator.behavior.onTimeout).toBe('error');
  });
});

describe('createArchitectureCritic', () => {
  it('should create validator with architecture-focused defaults', () => {
    const validator = createArchitectureCritic({ provider: 'claude' });

    expect(validator.id).toBe('architecture-critic');
    expect(validator.type).toBe('ai-critic');
    expect(validator.provider).toBe('claude');
    expect(validator.triggers).toContain('pre-commit');
    expect(validator.behavior.required).toBe(false);
    expect(validator.behavior.weight).toBe(2);
  });

  it('should include architecture-focused system prompt', () => {
    const validator = createArchitectureCritic({ provider: 'claude' });

    expect(validator.systemPrompt).toContain('architect');
    expect(validator.systemPrompt).toContain('Modularity');
    expect(validator.systemPrompt).toContain('Coupling');
  });

  it('should include related files for context', () => {
    const validator = createArchitectureCritic({ provider: 'claude' });

    expect(validator.contextConfig?.includeRelatedFiles).toBe(true);
    expect(validator.contextConfig?.relatedFileDepth).toBe(2);
  });
});
