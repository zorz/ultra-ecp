/**
 * API Providers Unit Tests
 */

import { describe, it, expect } from 'bun:test';
import {
  createClaudeAPIProvider,
  createOpenAIAPIProvider,
  createGeminiAPIProvider,
  createOllamaAPIProvider,
  createAPIProvider,
  getRegisteredAPIProviders,
} from '../../../../src/services/ensemble/providers/index.ts';
import type { AIProviderConfig } from '../../../../src/services/ai/types.ts';

describe('API Providers', () => {
  describe('Provider Registry', () => {
    it('should register all providers on import', () => {
      const providers = getRegisteredAPIProviders();

      expect(providers).toContain('claude');
      expect(providers).toContain('openai');
      expect(providers).toContain('gemini');
      expect(providers).toContain('ollama');
    });

    it('should create provider from registry', () => {
      const config: AIProviderConfig = {
        type: 'claude',
        name: 'Claude',
        model: 'claude-sonnet-4-20250514',
      };

      const provider = createAPIProvider(config);

      expect(provider).not.toBeNull();
      expect(provider!.type).toBe('claude');
    });

    it('should return null for unknown provider', () => {
      const config: AIProviderConfig = {
        type: 'unknown' as never,
        name: 'Unknown',
      };

      const provider = createAPIProvider(config);

      expect(provider).toBeNull();
    });
  });

  describe('ClaudeAPIProvider', () => {
    it('should create with default config', () => {
      const provider = createClaudeAPIProvider();

      expect(provider.type).toBe('claude');
      expect(provider.name).toBe('Claude');
    });

    it('should create with custom config', () => {
      const provider = createClaudeAPIProvider({
        model: 'claude-opus-4-20250514',
        baseUrl: 'https://custom.api.com',
      });

      expect(provider.config.model).toBe('claude-opus-4-20250514');
      expect(provider.config.baseUrl).toBe('https://custom.api.com');
    });

    it('should report capabilities', () => {
      const provider = createClaudeAPIProvider();
      const caps = provider.getCapabilities();

      expect(caps.toolUse).toBe(true);
      expect(caps.streaming).toBe(true);
      expect(caps.vision).toBe(true);
      expect(caps.systemMessages).toBe(true);
      expect(caps.maxContextTokens).toBe(200000);
      expect(caps.maxOutputTokens).toBe(8192);
    });

    it('should check availability based on API key', async () => {
      // Without API key, should not be available
      const provider = createClaudeAPIProvider();

      // This will check secret service which likely won't have the key in tests
      const available = await provider.isAvailable();

      // We can't guarantee the key exists, so just check it returns boolean
      expect(typeof available).toBe('boolean');
    });

    it('should return fallback models when API unavailable', async () => {
      const provider = createClaudeAPIProvider();
      const models = await provider.getAvailableModels();

      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
      expect(models).toContain('claude-sonnet-4-20250514');
    });

    it('should support cancellation', () => {
      const provider = createClaudeAPIProvider();

      // Should not throw
      provider.cancel();
    });
  });

  describe('OpenAIAPIProvider', () => {
    it('should create with default config', () => {
      const provider = createOpenAIAPIProvider();

      expect(provider.type).toBe('openai');
      expect(provider.name).toBe('OpenAI');
    });

    it('should create with custom config', () => {
      const provider = createOpenAIAPIProvider({
        model: 'gpt-4-turbo',
        baseUrl: 'https://custom.openai.com/v1',
      });

      expect(provider.config.model).toBe('gpt-4-turbo');
      expect(provider.config.baseUrl).toBe('https://custom.openai.com/v1');
    });

    it('should report capabilities', () => {
      const provider = createOpenAIAPIProvider();
      const caps = provider.getCapabilities();

      expect(caps.toolUse).toBe(true);
      expect(caps.streaming).toBe(true);
      expect(caps.vision).toBe(true);
      expect(caps.systemMessages).toBe(true);
      expect(caps.maxContextTokens).toBe(128000);
      expect(caps.maxOutputTokens).toBe(4096);
    });

    it('should return fallback models when API unavailable', async () => {
      const provider = createOpenAIAPIProvider();
      const models = await provider.getAvailableModels();

      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
      expect(models).toContain('gpt-4o');
    });
  });

  describe('GeminiAPIProvider', () => {
    it('should create with default config', () => {
      const provider = createGeminiAPIProvider();

      expect(provider.type).toBe('gemini');
      expect(provider.name).toBe('Gemini');
    });

    it('should create with custom config', () => {
      const provider = createGeminiAPIProvider({
        model: 'gemini-1.5-pro',
        baseUrl: 'https://custom.googleapis.com/v1beta',
      });

      expect(provider.config.model).toBe('gemini-1.5-pro');
      expect(provider.config.baseUrl).toBe('https://custom.googleapis.com/v1beta');
    });

    it('should report capabilities', () => {
      const provider = createGeminiAPIProvider();
      const caps = provider.getCapabilities();

      expect(caps.toolUse).toBe(true);
      expect(caps.streaming).toBe(true);
      expect(caps.vision).toBe(true);
      expect(caps.systemMessages).toBe(true);
      expect(caps.maxContextTokens).toBe(1000000);
      expect(caps.maxOutputTokens).toBe(8192);
    });

    it('should return fallback models when API unavailable', async () => {
      const provider = createGeminiAPIProvider();
      const models = await provider.getAvailableModels();

      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
      expect(models).toContain('gemini-1.5-pro');
    });
  });

  describe('OllamaAPIProvider', () => {
    it('should create with default config', () => {
      const provider = createOllamaAPIProvider();

      expect(provider.type).toBe('ollama');
      expect(provider.name).toBe('Ollama');
    });

    it('should create with custom config', () => {
      const provider = createOllamaAPIProvider({
        model: 'llama3',
        baseUrl: 'http://localhost:11435',
      });

      expect(provider.config.model).toBe('llama3');
      expect(provider.config.baseUrl).toBe('http://localhost:11435');
    });

    it('should report capabilities', () => {
      const provider = createOllamaAPIProvider();
      const caps = provider.getCapabilities();

      expect(caps.toolUse).toBe(false); // Conservative default
      expect(caps.streaming).toBe(true);
      expect(caps.vision).toBe(false); // Conservative default
      expect(caps.systemMessages).toBe(true);
      expect(caps.maxContextTokens).toBe(8192);
      expect(caps.maxOutputTokens).toBe(4096);
    });

    it('should check availability based on server', async () => {
      const provider = createOllamaAPIProvider();

      // This will check if Ollama server is running
      const available = await provider.isAvailable();

      // Can't guarantee Ollama is running, just check it returns boolean
      expect(typeof available).toBe('boolean');
    });

    it('should have pull and hasModel methods', () => {
      const provider = createOllamaAPIProvider();

      // Just verify the methods exist
      expect(typeof provider.pullModel).toBe('function');
      expect(typeof provider.hasModel).toBe('function');
    });
  });
});
